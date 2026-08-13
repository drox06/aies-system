import { randomUUID } from "node:crypto";
import { afterAll, describe, expect, it } from "vitest";
import { db } from "@/lib/db";
import {
  addProductFromLineService,
  catalogueCandidatesService,
  duplicateQuotationService,
  staleCostReportService,
  STALE_COST_DAYS,
} from "@/server/core/quotation/reuse-service";
import { saveQuotationLinesService } from "@/server/core/quotation/quotation-line-service";
import { createQuotationService } from "@/server/core/quotation/quotation-service";
import { CUSTOMER_TOKEN } from "@/server/core/quotation/terms";

/**
 * specs/02-quotation.md §9's reuse.
 *
 * §9's point is that the system should get easier the longer it is used — "the catalogue thus builds
 * itself from real work rather than requiring a data-entry project up front". So the assertions here
 * are mostly about what *does not* happen automatically: a duplicate does not join the source's
 * revision chain, does not carry its supplier links, and does not refresh costs behind anybody's
 * back.
 */

const suffix = randomUUID().slice(0, 8);
const OWNER = `reuse-${suffix}`;
const actor = { actorId: OWNER, actorLabel: "EM" };

const accountIds: string[] = [];
const quotationIds: string[] = [];
const productIds: string[] = [];

async function makeAccount(name: string) {
  const account = await db.customerAccount.create({
    data: { code: `RU-${randomUUID().slice(0, 12)}`, name, ownerId: OWNER },
  });
  accountIds.push(account.id);
  return account;
}

/**
 * `modelNumber` is a parameter because the catalogue is global.
 *
 * A test that adds "Krohne OPTIFLUX 4300" to `Product` changes what every later test in this file
 * sees — the first version of this suite failed exactly that way, and the failure looked like a bug
 * in the candidate query rather than one test leaking into the next.
 */
async function makeQuotation(
  accountId: string,
  modelNumber = `OPTIFLUX ${randomUUID().slice(0, 6)}`,
) {
  const quotation = await createQuotationService(actor, {
    accountId,
    title: "Annual preventive maintenance, 12 loops",
  });
  quotationIds.push(quotation.id);

  await saveQuotationLinesService(actor, {
    quotationId: quotation.id,
    version: quotation.version,
    canSeeCost: true,
    lines: [
      {
        description: "DN100 electromagnetic flow meter",
        manufacturer: "Krohne",
        modelNumber,
        quantity: "2",
        unitCost: "50000",
        markupPct: "25",
        supplierQuoteLineId: null,
      },
      {
        description: "Annual calibration visit",
        quantity: "1",
        unitCost: "15000",
        markupPct: "30",
      },
    ],
  });

  return db.quotation.findUniqueOrThrow({
    where: { id: quotation.id },
    include: { lines: { orderBy: { lineNo: "asc" } } },
  });
}

afterAll(async () => {
  await db.auditLog.deleteMany({
    where: { entityId: { in: [...quotationIds, ...accountIds, ...productIds] } },
  });
  await db.eventOutbox.deleteMany({ where: { actorId: OWNER } });
  await db.quotationLine.deleteMany({ where: { quotationId: { in: quotationIds } } });
  await db.quotation.deleteMany({ where: { id: { in: quotationIds } } });
  await db.customerAccount.deleteMany({ where: { id: { in: accountIds } } });
  await db.product.deleteMany({ where: { id: { in: productIds } } });
});

describe("duplicating a quotation", () => {
  it("makes a new quotation, not a revision of the old one", async () => {
    // The distinction the whole feature turns on. A revision shares the base number and supersedes
    // what came before; a duplicate is a different document that happens to start from one.
    const account = await makeAccount(`Source Co ${suffix}`);
    const source = await makeQuotation(account.id);

    const copy = await duplicateQuotationService(actor, { sourceQuotationId: source.id });
    quotationIds.push(copy.id);

    expect(copy.number).not.toBe(source.number);
    expect(copy.revision).toBe(0);
    expect(copy.parentQuotationId).toBeNull();
    expect(copy.status).toBe("draft");
  }, 60_000);

  it("copies the lines and their costs", async () => {
    const account = await makeAccount(`Lines Co ${suffix}`);
    const source = await makeQuotation(account.id);

    const copy = await duplicateQuotationService(actor, { sourceQuotationId: source.id });
    quotationIds.push(copy.id);

    const lines = await db.quotationLine.findMany({
      where: { quotationId: copy.id },
      orderBy: { lineNo: "asc" },
    });
    expect(lines).toHaveLength(2);
    expect(lines[0]!.unitCost.toString()).toBe(source.lines[0]!.unitCost.toString());
    expect(lines[0]!.modelNumber).toBe(source.lines[0]!.modelNumber);
  }, 60_000);

  it("drops the supplier link, because the answer to 'where did this cost come from' has changed", async () => {
    const account = await makeAccount(`Link Co ${suffix}`);
    const source = await makeQuotation(account.id);
    // Pretend the source had been costed from a supplier quote.
    await db.quotationLine.updateMany({
      where: { quotationId: source.id, lineNo: 1 },
      data: { supplierQuoteLineId: "some-supplier-line" },
    });

    const copy = await duplicateQuotationService(actor, { sourceQuotationId: source.id });
    quotationIds.push(copy.id);

    const line = await db.quotationLine.findFirstOrThrow({
      where: { quotationId: copy.id, lineNo: 1 },
    });
    expect(line.supplierQuoteLineId).toBeNull();
  }, 60_000);

  it("re-seeds the terms for the new customer, rather than naming the old one", async () => {
    // Clause 1 names the client. A duplicate to a different company that still names the previous
    // one is a contract with somebody else's name in it.
    const source = await makeAccount(`First Customer ${suffix}`);
    const other = await makeAccount(`Second Customer ${suffix}`);
    const quotation = await makeQuotation(source.id);

    const copy = await duplicateQuotationService(actor, {
      sourceQuotationId: quotation.id,
      accountId: other.id,
    });
    quotationIds.push(copy.id);

    const terms = copy.termsAndConditions as string[];
    expect(terms[0]).toContain(other.name);
    expect(terms[0]).not.toContain(source.name);
    expect(terms.join(" ")).not.toContain(CUSTOMER_TOKEN);
  }, 60_000);

  it("gives it a fresh validity date and no inquiry", async () => {
    const account = await makeAccount(`Fresh Co ${suffix}`);
    const source = await makeQuotation(account.id);
    await db.quotation.update({
      where: { id: source.id },
      data: { validUntil: new Date(Date.now() - 40 * 86_400_000) },
    });

    const copy = await duplicateQuotationService(actor, { sourceQuotationId: source.id });
    quotationIds.push(copy.id);

    // Copying the old date would produce a quotation that is already expired.
    expect(copy.validUntil.getTime()).toBeGreaterThan(Date.now());
    // The source's inquiry is a different customer conversation.
    expect(copy.inquiryId).toBeNull();
  }, 60_000);

  it("does not carry site and contact to a different customer", async () => {
    const source = await makeAccount(`Site Co ${suffix}`);
    const other = await makeAccount(`Other Co ${suffix}`);
    const site = await db.site.create({
      data: { accountId: source.id, name: "Plant 2" },
    });
    const quotation = await makeQuotation(source.id);
    await db.quotation.update({ where: { id: quotation.id }, data: { siteId: site.id } });

    const copy = await duplicateQuotationService(actor, {
      sourceQuotationId: quotation.id,
      accountId: other.id,
    });
    quotationIds.push(copy.id);

    expect(copy.siteId).toBeNull();
    await db.site.deleteMany({ where: { id: site.id } });
  }, 60_000);
});

describe("§9's refresh-costs prompt", () => {
  it("flags a line the catalogue has never costed", async () => {
    // Stronger than "this is three months old", and silence would read as approval.
    const account = await makeAccount(`Stale Co ${suffix}`);
    const quotation = await makeQuotation(account.id);

    const report = await staleCostReportService(quotation.id);
    expect(report).toHaveLength(2);
    expect(report[0]!.isStale).toBe(true);
    expect(report[0]!.lastCostAt).toBeNull();
    expect(report[0]!.daysSinceCost).toBeNull();
  }, 60_000);

  it("does not flag a line the catalogue costed recently, and reports a newer price", async () => {
    const account = await makeAccount(`Recent Co ${suffix}`);
    const model = `OPTIFLUX ${randomUUID().slice(0, 6)}`;
    const quotation = await makeQuotation(account.id, model);

    const product = await db.product.create({
      data: {
        name: model,
        manufacturer: "Krohne",
        modelNumber: model,
        lastCost: "52000",
        lastCostCurrency: "PHP",
        lastCostAt: new Date(),
      },
    });
    productIds.push(product.id);

    const report = await staleCostReportService(quotation.id);
    const flowMeter = report.find((r) => r.modelNumber === model)!;
    expect(flowMeter.isStale).toBe(false);
    expect(flowMeter.catalogueCost).toBe("52000");
    // The quotation is costed at 50,000 and the catalogue has since seen 52,000.
    expect(flowMeter.hasNewerCost).toBe(true);
  }, 60_000);

  it("flags one the catalogue has not seen in a quarter", async () => {
    const account = await makeAccount(`Quarter Co ${suffix}`);
    const model = `OPTIFLUX ${randomUUID().slice(0, 6)}`;
    const quotation = await makeQuotation(account.id, model);

    const product = await db.product.create({
      data: {
        name: model,
        manufacturer: "Krohne",
        modelNumber: model,
        lastCost: "50000",
        lastCostCurrency: "PHP",
        lastCostAt: new Date(Date.now() - (STALE_COST_DAYS + 5) * 86_400_000),
      },
    });
    productIds.push(product.id);

    const report = await staleCostReportService(quotation.id);
    const flowMeter = report.find((r) => r.modelNumber === model)!;
    expect(flowMeter.isStale).toBe(true);
    expect(flowMeter.daysSinceCost).toBeGreaterThan(STALE_COST_DAYS);
  }, 60_000);

  it("changes nothing", async () => {
    // §9 asks for a prompt, not an automatic update: replacing a cost without asking rewrites the
    // basis of a quotation somebody is about to send.
    const account = await makeAccount(`NoWrite Co ${suffix}`);
    const quotation = await makeQuotation(account.id);
    const before = await db.quotationLine.findFirstOrThrow({
      where: { quotationId: quotation.id, lineNo: 1 },
    });

    await staleCostReportService(quotation.id);

    const after = await db.quotationLine.findFirstOrThrow({
      where: { quotationId: quotation.id, lineNo: 1 },
    });
    expect(after.unitCost.toString()).toBe(before.unitCost.toString());
  }, 60_000);
});

describe("§9's self-building catalogue", () => {
  it("offers the manufacturer + model pairs that are not in the catalogue yet", async () => {
    const account = await makeAccount(`Cat Co ${suffix}`);
    const quotation = await makeQuotation(account.id);

    const candidates = await catalogueCandidatesService(quotation.id);
    // Only the line that names a manufacturer and a model — "Annual calibration visit" is a service,
    // not a product, and a catalogue full of those would be noise.
    expect(candidates).toHaveLength(1);
    expect(candidates[0]!.manufacturer).toBe("Krohne");
    expect(candidates[0]!.modelNumber).toMatch(/^OPTIFLUX /);
    expect(candidates[0]!.unitCost).toBe("50000");
  }, 60_000);

  it("stops offering one that has been added", async () => {
    const account = await makeAccount(`Added Co ${suffix}`);
    const quotation = await makeQuotation(account.id);

    const [candidate] = await catalogueCandidatesService(quotation.id);
    const product = await addProductFromLineService(actor, candidate!);
    productIds.push(product.id);

    expect(product.lastCost?.toString()).toBe("50000");
    // The moment a real price for a real thing entered the system, which is what staleness is
    // measured against later.
    expect(product.lastCostAt).toBeTruthy();

    expect(await catalogueCandidatesService(quotation.id)).toHaveLength(0);
  }, 60_000);

  it("refuses a duplicate catalogue entry", async () => {
    const account = await makeAccount(`Dupe Co ${suffix}`);
    const quotation = await makeQuotation(account.id);
    const [candidate] = await catalogueCandidatesService(quotation.id);

    const product = await addProductFromLineService(actor, candidate!);
    productIds.push(product.id);

    await expect(addProductFromLineService(actor, candidate!)).rejects.toThrow(
      /already in the catalogue/,
    );
  }, 60_000);
});
