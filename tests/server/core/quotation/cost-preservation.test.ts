import { randomUUID } from "node:crypto";
import { afterAll, describe, expect, it } from "vitest";
import { db } from "@/lib/db";
import { saveQuotationLinesService } from "@/server/core/quotation/quotation-line-service";
import {
  createQuotationService,
  getQuotationService,
} from "@/server/core/quotation/quotation-service";

/**
 * What happens when somebody who cannot see cost edits a quotation.
 *
 * This is not a spec-named test; it is a hazard the builder created. §11 gives `quotation.edit` to
 * the sales roles, and Spec.md §4.3 withholds `finance.view_cost` from all of them — so a
 * salesperson legitimately opens a quotation whose lines arrive with `unitCost`, `markupPct` and
 * `costFxRate` stripped, edits a description, and saves.
 *
 * Posting those lines back verbatim would write zero cost, and the quotation would show a fictional
 * 100% margin on its way to the VP's approval queue. Nothing would look wrong on screen. The
 * service therefore carries the existing costs across by line number.
 */

const suffix = randomUUID().slice(0, 8);
const OWNER = `cp-${suffix}`;
const actor = { actorId: OWNER, actorLabel: "Cost Preservation Test" };

const SALES = new Set(["quotation.view", "quotation.edit"]);
const FINANCE = new Set(["quotation.view", "quotation.edit", "finance.view_cost"]);

const accountIds: string[] = [];
const quotationIds: string[] = [];

async function makeCostedQuotation() {
  const account = await db.customerAccount.create({
    data: { code: `CP-${randomUUID().slice(0, 12)}`, name: `CP Co ${suffix}`, ownerId: OWNER },
  });
  accountIds.push(account.id);

  const quotation = await createQuotationService(actor, {
    accountId: account.id,
    title: "Costed quotation",
  });
  quotationIds.push(quotation.id);

  const saved = await saveQuotationLinesService(actor, {
    quotationId: quotation.id,
    version: quotation.version,
    canSeeCost: true,
    lines: [
      { description: "Flow meter", quantity: "2", unitCost: "1000.00", markupPct: "25" },
      { description: "Install kit", quantity: "1", unitCost: "500.00", markupPct: "20" },
    ],
  });

  return { quotation, version: saved.version };
}

afterAll(async () => {
  await db.auditLog.deleteMany({ where: { entityId: { in: [...quotationIds, ...accountIds] } } });
  await db.eventOutbox.deleteMany({ where: { actorId: OWNER } });
  await db.quotationLine.deleteMany({ where: { quotationId: { in: quotationIds } } });
  await db.quotation.deleteMany({ where: { id: { in: quotationIds } } });
  await db.customerAccount.deleteMany({ where: { id: { in: accountIds } } });
});

describe("a salesperson editing a quotation cannot destroy its costs", () => {
  it("carries existing costs across when the saver cannot see them", async () => {
    const { quotation, version } = await makeCostedQuotation();

    // What the salesperson's browser actually received: no cost fields at all.
    const asSales = (await getQuotationService(
      { id: OWNER, permissions: SALES },
      quotation.id,
    )) as {
      lines: Record<string, unknown>[];
    };
    expect(asSales.lines[0]).not.toHaveProperty("unitCost");

    // They rename a line and save exactly what they were given.
    await saveQuotationLinesService(actor, {
      quotationId: quotation.id,
      version,
      canSeeCost: false,
      lines: [
        { description: "Flow meter (renamed)", quantity: "2" },
        { description: "Install kit", quantity: "1" },
      ],
    });

    const stored = await db.quotation.findUniqueOrThrow({ where: { id: quotation.id } });
    // The cost survived. Without the carry-over this reads 0 and the margin reads 100%.
    expect(stored.totalCost.toString()).toBe("2500");
    expect(stored.subtotal.toString()).toBe("3100");
    expect(stored.marginAmount.toString()).toBe("600");

    const lines = await db.quotationLine.findMany({
      where: { quotationId: quotation.id },
      orderBy: { lineNo: "asc" },
    });
    expect(lines[0]!.description).toBe("Flow meter (renamed)");
    expect(lines[0]!.unitCost.toString()).toBe("1000");
    expect(lines[0]!.markupPct?.toString()).toBe("25");
  });

  it("does not re-apply FX or the buffer on a price-only save", async () => {
    // The preserved cost is already landed. Applying the buffer again would inflate it a little
    // more on every save — a slow leak that would only ever be noticed as shrinking margin.
    const account = await db.customerAccount.create({
      data: { code: `CX-${randomUUID().slice(0, 12)}`, name: `CX Co ${suffix}`, ownerId: OWNER },
    });
    accountIds.push(account.id);
    const quotation = await createQuotationService(actor, {
      accountId: account.id,
      title: "Imported",
    });
    quotationIds.push(quotation.id);

    const first = await saveQuotationLinesService(actor, {
      quotationId: quotation.id,
      version: quotation.version,
      canSeeCost: true,
      lines: [
        {
          description: "Transmitter",
          quantity: "1",
          unitCost: "100.00",
          costFxRate: "58.5",
          markupPct: "20",
        },
      ],
      fxBufferPct: "3",
    });

    const landed = (
      await db.quotationLine.findFirstOrThrow({
        where: { quotationId: quotation.id },
      })
    ).unitCost.toString();
    expect(landed).toBe("6025.5");

    // Three price-only saves in a row must not move the cost at all.
    let version = first.version;
    for (let i = 0; i < 3; i += 1) {
      const saved = await saveQuotationLinesService(actor, {
        quotationId: quotation.id,
        version,
        canSeeCost: false,
        lines: [{ description: "Transmitter", quantity: "1" }],
      });
      version = saved.version;
    }

    const after = await db.quotationLine.findFirstOrThrow({ where: { quotationId: quotation.id } });
    expect(after.unitCost.toString()).toBe("6025.5");
    expect(after.costFxRate.toString()).toBe("1");
  });

  it("gives a line the salesperson added no cost, rather than inventing one", async () => {
    // Honest: nobody has costed it. The margin panel shows the gap to whoever can see it.
    const { quotation, version } = await makeCostedQuotation();

    await saveQuotationLinesService(actor, {
      quotationId: quotation.id,
      version,
      canSeeCost: false,
      lines: [
        { description: "Flow meter", quantity: "2" },
        { description: "Install kit", quantity: "1" },
        { description: "Extra site visit", quantity: "1", unitPrice: "5000.00" },
      ],
    });

    const lines = await db.quotationLine.findMany({
      where: { quotationId: quotation.id },
      orderBy: { lineNo: "asc" },
    });
    expect(lines).toHaveLength(3);
    expect(lines[2]!.unitCost.toString()).toBe("0");
    // The first two kept theirs.
    expect(lines[0]!.unitCost.toString()).toBe("1000");
  });

  it("still lets somebody who can see cost change it", async () => {
    const { quotation, version } = await makeCostedQuotation();

    await saveQuotationLinesService(actor, {
      quotationId: quotation.id,
      version,
      canSeeCost: true,
      lines: [{ description: "Flow meter", quantity: "2", unitCost: "1200.00", markupPct: "25" }],
    });

    const line = await db.quotationLine.findFirstOrThrow({ where: { quotationId: quotation.id } });
    expect(line.unitCost.toString()).toBe("1200");
  });

  it("the finance view still shows what the sales view hid", async () => {
    const { quotation } = await makeCostedQuotation();
    const asFinance = (await getQuotationService(
      { id: OWNER, permissions: FINANCE },
      quotation.id,
    )) as { lines: Record<string, unknown>[]; totalCost?: string };

    expect(asFinance.totalCost).toBe("2500");
    expect(asFinance.lines[0]).toHaveProperty("unitCost");
  });
});
