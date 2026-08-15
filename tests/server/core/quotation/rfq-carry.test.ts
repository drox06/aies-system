import { randomUUID } from "node:crypto";
import { afterAll, describe, expect, it } from "vitest";
import { db } from "@/lib/db";
import {
  createSupplierRfqsService,
  markRfqSentService,
  recordRfqResponseService,
} from "@/server/core/quotation/rfq-service";
import { saveQuotationLinesService } from "@/server/core/quotation/quotation-line-service";
import { createQuotationService } from "@/server/core/quotation/quotation-service";

/**
 * Two things the company asked for after using supplier pricing in anger.
 *
 * **"Make it so that a line item is requested to a selected supplier."** Asking two manufacturers
 * about a two-line job used to send both lines to both, so each came back having priced its own item
 * and written a zero against the other — a comparison matrix full of holes, and a document showing a
 * supplier an item they do not sell.
 *
 * **"The recorded response for unit price is not reflected on the lines."** It was not: §3.5's Apply
 * was a second button, on a panel that gave no sign it was waiting. Now an *uncontested* price is
 * carried straight onto the line, and a contested one still waits for a person — because with two
 * offers on one line there is a real decision, and §3.6's matrix exists so somebody makes it.
 */

const suffix = randomUUID().slice(0, 8);
const OWNER = `carry-${suffix}`;
const actor = { actorId: OWNER, actorLabel: "PD" };

const accountIds: string[] = [];
const quotationIds: string[] = [];
const prospectIds: string[] = [];
const rfqIds: string[] = [];

/**
 * A principal in module 03's supplier directory.
 *
 * Was a `PrincipalProspect` at stage `appointed`, because until module 03 landed there was no
 * supplier model and an appointed prospect stood in for one. `SupplierQuoteRequest.supplierId` is a
 * real foreign key to `Supplier` now, so the fixture creates what the column points at.
 */
async function makePrincipal(name: string) {
  const supplier = await db.supplier.create({
    data: {
      code: `SUP-T${randomUUID().slice(0, 10)}`,
      name: `${name} ${randomUUID().slice(0, 6)}`,
      isPrincipal: true,
      isApproved: true,
    },
  });
  prospectIds.push(supplier.id);
  return supplier;
}

/** A two-line quotation: a flowmeter and a valve, from different manufacturers in real life. */
async function makeQuotation() {
  const account = await db.customerAccount.create({
    data: { code: `CY-${randomUUID().slice(0, 12)}`, name: `Carry Co ${suffix}`, ownerId: OWNER },
  });
  accountIds.push(account.id);

  const quotation = await createQuotationService(actor, {
    accountId: account.id,
    title: "Skid instrumentation",
  });
  quotationIds.push(quotation.id);

  await saveQuotationLinesService(actor, {
    quotationId: quotation.id,
    version: quotation.version,
    canSeeCost: true,
    lines: [
      { description: "DN100 flowmeter", quantity: "1", unitCost: "0", markupPct: "25" },
      { description: "DN100 control valve", quantity: "1", unitCost: "0", markupPct: "25" },
    ],
  });

  return db.quotation.findUniqueOrThrow({ where: { id: quotation.id } });
}

async function lineCosts(quotationId: string) {
  const lines = await db.quotationLine.findMany({
    where: { quotationId },
    orderBy: { lineNo: "asc" },
  });
  return lines.map((line) => line.unitCost.toString());
}

afterAll(async () => {
  await db.auditLog.deleteMany({
    where: { entityId: { in: [...quotationIds, ...prospectIds, ...rfqIds] } },
  });
  await db.eventOutbox.deleteMany({ where: { actorId: OWNER } });
  await db.supplierQuoteLine.deleteMany({ where: { requestId: { in: rfqIds } } });
  await db.supplierQuoteRequest.deleteMany({ where: { id: { in: rfqIds } } });
  await db.quotationLine.deleteMany({ where: { quotationId: { in: quotationIds } } });
  await db.searchIndex.deleteMany({ where: { entityId: { in: quotationIds } } });
  await db.quotation.deleteMany({ where: { id: { in: quotationIds } } });
  await db.customerAccount.deleteMany({ where: { id: { in: accountIds } } });
  await db.supplier.deleteMany({ where: { id: { in: prospectIds } } });
});

describe("asking each supplier about its own lines", () => {
  it("gives each principal only the lines chosen for it", async () => {
    const quotation = await makeQuotation();
    const flowSupplier = await makePrincipal("Krohne");
    const valveSupplier = await makePrincipal("Samson");

    const result = await createSupplierRfqsService(actor, {
      quotationId: quotation.id,
      asks: [
        { supplierId: flowSupplier.id, sourceLineNos: [1] },
        { supplierId: valveSupplier.id, sourceLineNos: [2] },
      ],
    });
    rfqIds.push(...result.created.map((r) => r.id));

    expect(result.created).toHaveLength(2);
    expect(result.failed).toHaveLength(0);

    const flowRfq = await db.supplierQuoteRequest.findFirstOrThrow({
      where: { id: result.created.find((r) => r.supplierId === flowSupplier.id)!.id },
      include: { lines: true },
    });
    const valveRfq = await db.supplierQuoteRequest.findFirstOrThrow({
      where: { id: result.created.find((r) => r.supplierId === valveSupplier.id)!.id },
      include: { lines: true },
    });

    // The whole point: a valve maker is never shown the flowmeter.
    expect(flowRfq.lines).toHaveLength(1);
    expect(flowRfq.lines[0]!.sourceLineNo).toBe(1);
    expect(valveRfq.lines).toHaveLength(1);
    expect(valveRfq.lines[0]!.sourceLineNo).toBe(2);
  }, 60_000);

  it("still asks about everything when no lines are named", async () => {
    const quotation = await makeQuotation();
    const supplier = await makePrincipal("Endress");

    const result = await createSupplierRfqsService(actor, {
      quotationId: quotation.id,
      asks: [{ supplierId: supplier.id }],
    });
    rfqIds.push(...result.created.map((r) => r.id));

    expect(result.created[0]!.lineCount).toBe(2);
  }, 60_000);
});

describe("carrying a recorded price onto the quotation", () => {
  it("costs the line as soon as the response is recorded, with no second button", async () => {
    const quotation = await makeQuotation();
    const supplier = await makePrincipal("Krohne");

    const created = await createSupplierRfqsService(actor, {
      quotationId: quotation.id,
      asks: [{ supplierId: supplier.id, sourceLineNos: [1] }],
    });
    rfqIds.push(...created.created.map((r) => r.id));
    const rfqId = created.created[0]!.id;
    await markRfqSentService(actor, { rfqId });

    const result = await recordRfqResponseService(actor, {
      rfqId,
      lines: [{ lineNo: 1, unitCost: "35000.00" }],
    });

    expect(result.autoApplied).toEqual([1]);
    expect(result.awaitingChoice).toEqual([]);
    expect(result.notCarriedReason).toBeNull();
    expect(await lineCosts(quotation.id)).toEqual(["35000", "0"]);
  }, 60_000);

  it("links the line back to the supplier line it was costed from", async () => {
    // §3.5's "where did this cost come from?" must survive the shortcut.
    const quotation = await makeQuotation();
    const supplier = await makePrincipal("Krohne");

    const created = await createSupplierRfqsService(actor, {
      quotationId: quotation.id,
      asks: [{ supplierId: supplier.id, sourceLineNos: [1] }],
    });
    rfqIds.push(...created.created.map((r) => r.id));
    const rfqId = created.created[0]!.id;
    await markRfqSentService(actor, { rfqId });
    await recordRfqResponseService(actor, {
      rfqId,
      lines: [{ lineNo: 1, unitCost: "35000.00", leadTimeDays: 42 }],
    });

    const line = await db.quotationLine.findFirstOrThrow({
      where: { quotationId: quotation.id, lineNo: 1 },
    });
    expect(line.supplierQuoteLineId).not.toBeNull();
    expect(line.leadTimeDays).toBe(42);
  }, 60_000);

  it("waits when a second supplier has priced the same line", async () => {
    // The case the explicit Apply exists for: two offers, and choosing between them is a purchasing
    // decision, not something the last save should settle.
    const quotation = await makeQuotation();
    const first = await makePrincipal("Krohne");
    const second = await makePrincipal("Endress");

    const created = await createSupplierRfqsService(actor, {
      quotationId: quotation.id,
      asks: [
        { supplierId: first.id, sourceLineNos: [1] },
        { supplierId: second.id, sourceLineNos: [1] },
      ],
    });
    rfqIds.push(...created.created.map((r) => r.id));
    const [a, b] = created.created;

    await markRfqSentService(actor, { rfqId: a!.id });
    const firstResult = await recordRfqResponseService(actor, {
      rfqId: a!.id,
      lines: [{ lineNo: 1, unitCost: "35000.00" }],
    });
    // Nothing to weigh yet, so it carries.
    expect(firstResult.autoApplied).toEqual([1]);

    await markRfqSentService(actor, { rfqId: b!.id });
    const secondResult = await recordRfqResponseService(actor, {
      rfqId: b!.id,
      lines: [{ lineNo: 1, unitCost: "31000.00" }],
    });

    expect(secondResult.autoApplied).toEqual([]);
    expect(secondResult.awaitingChoice).toEqual([1]);
    // The first supplier's price is left standing rather than silently replaced by the cheaper one.
    expect(await lineCosts(quotation.id)).toEqual(["35000", "0"]);
  }, 60_000);

  it("records the response and explains itself when it cannot carry the cost", async () => {
    // A foreign-currency price with no rate on the quotation. Recording what a supplier said is a
    // fact about the outside world and must survive; converting it is what needs the rate.
    const quotation = await makeQuotation();
    const supplier = await makePrincipal("Samson");

    const created = await createSupplierRfqsService(actor, {
      quotationId: quotation.id,
      asks: [{ supplierId: supplier.id, sourceLineNos: [1] }],
    });
    rfqIds.push(...created.created.map((r) => r.id));
    const rfqId = created.created[0]!.id;
    await markRfqSentService(actor, { rfqId });

    const result = await recordRfqResponseService(actor, {
      rfqId,
      currency: "EUR",
      lines: [{ lineNo: 1, unitCost: "1450.00", currency: "EUR" }],
    });

    expect(result.autoApplied).toEqual([]);
    expect(result.notCarriedReason).toMatch(/exchange rate/i);
    // The response itself is safely on the record.
    const stored = await db.supplierQuoteLine.findFirstOrThrow({
      where: { requestId: rfqId, lineNo: 1 },
    });
    expect(stored.unitCost.toString()).toBe("1450");
    expect(await lineCosts(quotation.id)).toEqual(["0", "0"]);
  }, 60_000);

  it("keeps a sent quotation's costs fixed, and says why", async () => {
    const quotation = await makeQuotation();
    const supplier = await makePrincipal("Krohne");

    const created = await createSupplierRfqsService(actor, {
      quotationId: quotation.id,
      asks: [{ supplierId: supplier.id, sourceLineNos: [1] }],
    });
    rfqIds.push(...created.created.map((r) => r.id));
    const rfqId = created.created[0]!.id;
    await markRfqSentService(actor, { rfqId });
    await db.quotation.update({ where: { id: quotation.id }, data: { status: "sent" } });

    const result = await recordRfqResponseService(actor, {
      rfqId,
      lines: [{ lineNo: 1, unitCost: "35000.00" }],
    });

    // §5 makes a sent quotation immutable. The response is still recorded.
    expect(result.autoApplied).toEqual([]);
    expect(result.notCarriedReason).toMatch(/revision/i);
    expect(await lineCosts(quotation.id)).toEqual(["0", "0"]);
  }, 60_000);
});
