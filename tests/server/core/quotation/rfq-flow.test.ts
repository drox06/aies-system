import { randomUUID } from "node:crypto";
import { afterAll, describe, expect, it } from "vitest";
import { db } from "@/lib/db";
import {
  applyRfqToQuotationService,
  buildRequestBody,
  compareRfqsForQuotationService,
  createSupplierRfqService,
  listRfqSuppliersService,
  markRfqSentService,
  recordRfqResponseService,
  RFQ_ENTITY_TYPE,
  sweepOverdueRfqs,
} from "@/server/core/quotation/rfq-service";
import { saveQuotationLinesService } from "@/server/core/quotation/quotation-line-service";
import { createQuotationService } from "@/server/core/quotation/quotation-service";

/**
 * specs/02-quotation.md §3's supplier RFQ sub-flow.
 *
 * §3 exists to stop supplier coordination being "an email nobody can find", so the load-bearing
 * assertions are the ones about the *record*: that the request captured what was asked, that the
 * response is attributable, and above all §3.5's link — "the link is what lets anyone later answer
 * 'where did this cost come from?'"
 *
 * Against the real database, because the interesting failures are all persistence-shaped: whether
 * the line mapping survives a save that deletes and recreates every line, and whether applying costs
 * as a user who cannot see cost destroys them.
 */

const suffix = randomUUID().slice(0, 8);
const PD = `pd-${suffix}`;
const actor = { actorId: PD, actorLabel: "PD (admin manager)" };

const accountIds: string[] = [];
const quotationIds: string[] = [];
const principalIds: string[] = [];
const rfqIds: string[] = [];
const fileIds: string[] = [];

async function makePrincipal(stage = "appointed", name = `Krohne ${randomUUID().slice(0, 6)}`) {
  const principal = await db.principalProspect.create({
    data: {
      companyName: name,
      stage,
      ownerId: PD,
      contactName: "Anna Weber",
      email: "sales@example.test",
      productLines: ["flow", "level"],
    },
  });
  principalIds.push(principal.id);
  return principal;
}

/** A draft quotation with three lines, so a partial RFQ has something to be partial about. */
async function makeQuotation() {
  const account = await db.customerAccount.create({
    data: {
      code: `RQ-${randomUUID().slice(0, 12)}`,
      name: `RFQ Water District ${suffix}`,
      ownerId: PD,
    },
  });
  accountIds.push(account.id);

  const quotation = await createQuotationService(actor, {
    accountId: account.id,
    title: "Supply of flow instrumentation",
  });
  quotationIds.push(quotation.id);

  await saveQuotationLinesService(actor, {
    quotationId: quotation.id,
    version: quotation.version,
    canSeeCost: true,
    lines: [
      { description: "DN100 electromagnetic flow meter", manufacturer: "Krohne", quantity: "2" },
      { description: "Ultrasonic level transmitter", manufacturer: "Krohne", quantity: "1" },
      { description: "Installation and commissioning", quantity: "1", unitCost: "20000.00" },
    ],
  });

  return db.quotation.findUniqueOrThrow({ where: { id: quotation.id } });
}

afterAll(async () => {
  await db.supplierQuoteLine.deleteMany({ where: { requestId: { in: rfqIds } } });
  await db.supplierQuoteRequest.deleteMany({ where: { id: { in: rfqIds } } });
  await db.fileObject.deleteMany({ where: { id: { in: fileIds } } });
  await db.notification.deleteMany({ where: { recipientId: PD } });
  await db.auditLog.deleteMany({
    where: { entityId: { in: [...quotationIds, ...accountIds, ...rfqIds] } },
  });
  await db.eventOutbox.deleteMany({ where: { actorId: PD } });
  await db.quotationLine.deleteMany({ where: { quotationId: { in: quotationIds } } });
  await db.quotation.deleteMany({ where: { id: { in: quotationIds } } });
  await db.customerAccount.deleteMany({ where: { id: { in: accountIds } } });
  await db.principalProspect.deleteMany({ where: { id: { in: principalIds } } });
});

async function raise(quotationId: string, supplierId: string, sourceLineNos?: number[]) {
  const rfq = await createSupplierRfqService(actor, { quotationId, supplierId, sourceLineNos });
  rfqIds.push(rfq.id);
  return rfq;
}

describe("who can be asked", () => {
  it("offers appointed principals only", async () => {
    // §5c makes `appointed` the stage at which a distributor agreement exists. Quoting on pricing
    // from a supplier you have no agreement with commits AIES to a price it may not be able to buy.
    const appointed = await makePrincipal("appointed");
    const prospect = await makePrincipal("samples_pricing");

    const ids = (await listRfqSuppliersService()).map((s) => s.id);
    expect(ids).toContain(appointed.id);
    expect(ids).not.toContain(prospect.id);
  }, 60_000);

  it("refuses to raise one against a principal that is not appointed", async () => {
    const prospect = await makePrincipal("agreement_draft");
    const quotation = await makeQuotation();

    await expect(
      createSupplierRfqService(actor, { quotationId: quotation.id, supplierId: prospect.id }),
    ).rejects.toThrow(/not an appointed principal/);
  }, 60_000);
});

describe("raising a request", () => {
  it("copies the chosen lines and remembers which quotation line each came from", async () => {
    const supplier = await makePrincipal();
    const quotation = await makeQuotation();

    const rfq = await raise(quotation.id, supplier.id, [2, 3]);

    expect(rfq.number).toMatch(/^RFQ-\d{2}-\d{4}$/);
    expect(rfq.status).toBe("draft");
    expect(rfq.lines).toHaveLength(2);
    // RFQ lines are numbered 1..n; the mapping back to quotation lines 2 and 3 is what makes §3.5
    // possible at all, and it cannot be recovered from position.
    expect(rfq.lines.map((l) => l.lineNo)).toEqual([1, 2]);
    expect(rfq.lines.map((l) => l.sourceLineNo)).toEqual([2, 3]);
  }, 60_000);

  it("takes every line when none are named", async () => {
    const supplier = await makePrincipal();
    const quotation = await makeQuotation();

    const rfq = await raise(quotation.id, supplier.id);
    expect(rfq.lines).toHaveLength(3);
  }, 60_000);

  it("stores the request body, rather than regenerating it later", async () => {
    // The quotation keeps moving. A body regenerated next week would be a different document
    // wearing the same number, and the supplier answered the one that was actually sent.
    const supplier = await makePrincipal();
    const quotation = await makeQuotation();

    const rfq = await raise(quotation.id, supplier.id, [1]);
    expect(rfq.requestBody).toContain("DN100 electromagnetic flow meter");
    expect(rfq.requestBody).toContain(rfq.number);
    expect(rfq.requestBody).toContain("Anna Weber");

    await saveQuotationLinesService(actor, {
      quotationId: quotation.id,
      version: (await db.quotation.findUniqueOrThrow({ where: { id: quotation.id } })).version,
      canSeeCost: true,
      lines: [{ description: "Something else entirely", quantity: "1" }],
    });

    const stored = await db.supplierQuoteRequest.findUniqueOrThrow({ where: { id: rfq.id } });
    expect(stored.requestBody).toContain("DN100 electromagnetic flow meter");
  }, 60_000);

  it("refuses line numbers that are not on the quotation", async () => {
    const supplier = await makePrincipal();
    const quotation = await makeQuotation();

    await expect(
      createSupplierRfqService(actor, {
        quotationId: quotation.id,
        supplierId: supplier.id,
        sourceLineNos: [99],
      }),
    ).rejects.toThrow(/None of those line numbers/);
  }, 60_000);
});

describe("sending and answering", () => {
  it("starts the clock when a person says it went, not when it was drafted", async () => {
    // Same shape as §7's issuance: the app produces the document, a person sends it. A draft
    // sitting unsent should not be counted against the supplier.
    const supplier = await makePrincipal();
    const quotation = await makeQuotation();
    const rfq = await raise(quotation.id, supplier.id);

    expect(rfq.sentAt).toBeNull();

    const dueBy = new Date(Date.now() + 5 * 86_400_000);
    const sent = await markRfqSentService(actor, { rfqId: rfq.id, dueBy });
    expect(sent.status).toBe("sent");
    expect(sent.sentAt).toBeTruthy();
    expect(sent.dueBy?.toISOString()).toBe(dueBy.toISOString());

    const event = await db.eventOutbox.findFirst({
      where: { event: "supplier_rfq.sent", actorId: PD },
      orderBy: { createdAt: "desc" },
    });
    expect(JSON.stringify(event?.payload)).toContain(rfq.id);
  }, 60_000);

  it("will not record a response to a request nobody sent", async () => {
    const supplier = await makePrincipal();
    const quotation = await makeQuotation();
    const rfq = await raise(quotation.id, supplier.id, [1]);

    await expect(
      recordRfqResponseService(actor, {
        rfqId: rfq.id,
        lines: [{ lineNo: 1, unitCost: "1000.00" }],
      }),
    ).rejects.toThrow(/has not been sent yet/);
  }, 60_000);

  it("captures the figures and emits supplier_rfq.responded", async () => {
    const supplier = await makePrincipal();
    const quotation = await makeQuotation();
    const rfq = await raise(quotation.id, supplier.id, [1, 2]);
    await markRfqSentService(actor, { rfqId: rfq.id });

    const responded = await recordRfqResponseService(actor, {
      rfqId: rfq.id,
      currency: "EUR",
      validUntil: new Date(Date.now() + 30 * 86_400_000),
      lines: [
        { lineNo: 1, unitCost: "1450.00", currency: "EUR", leadTimeDays: 42 },
        { lineNo: 2, unitCost: "980.50", currency: "EUR", leadTimeDays: 35 },
      ],
      responseNotes: "Ex-works Duisburg.",
    });

    expect(responded.status).toBe("responded");
    expect(responded.respondedAt).toBeTruthy();

    const lines = await db.supplierQuoteLine.findMany({
      where: { requestId: rfq.id },
      orderBy: { lineNo: "asc" },
    });
    expect(lines[0]!.unitCost.toString()).toBe("1450");
    expect(lines[0]!.currency).toBe("EUR");
    expect(lines[0]!.leadTimeDays).toBe(42);

    const event = await db.eventOutbox.findFirst({
      where: { event: "supplier_rfq.responded", actorId: PD },
      orderBy: { createdAt: "desc" },
    });
    expect(event).not.toBeNull();
  }, 60_000);

  it("refuses a response file uploaded against something else", async () => {
    const supplier = await makePrincipal();
    const quotation = await makeQuotation();
    const rfq = await raise(quotation.id, supplier.id, [1]);
    await markRfqSentService(actor, { rfqId: rfq.id });

    const stray = await db.fileObject.create({
      data: {
        entityType: RFQ_ENTITY_TYPE,
        entityId: "some-other-request",
        storageKey: `SupplierQuoteRequest/${randomUUID()}-quote.pdf`,
        filename: "quote.pdf",
        mimeType: "application/pdf",
        size: 100,
        sha256: randomUUID().replace(/-/g, ""),
        uploaderId: PD,
      },
    });
    fileIds.push(stray.id);

    await expect(
      recordRfqResponseService(actor, {
        rfqId: rfq.id,
        lines: [{ lineNo: 1, unitCost: "1000.00" }],
        responseFileId: stray.id,
      }),
    ).rejects.toThrow(/not uploaded against this request/);
  }, 60_000);

  it("refuses a unit cost that is not a plain number", async () => {
    const supplier = await makePrincipal();
    const quotation = await makeQuotation();
    const rfq = await raise(quotation.id, supplier.id, [1]);
    await markRfqSentService(actor, { rfqId: rfq.id });

    await expect(
      recordRfqResponseService(actor, {
        rfqId: rfq.id,
        lines: [{ lineNo: 1, unitCost: "EUR 1,450" }],
      }),
    ).rejects.toThrow(/plain number/);
  }, 60_000);
});

describe("§3.5: applying the pricing back", () => {
  async function respondedRfq() {
    const supplier = await makePrincipal();
    const quotation = await makeQuotation();
    const rfq = await raise(quotation.id, supplier.id, [1, 2]);
    await markRfqSentService(actor, { rfqId: rfq.id });
    await recordRfqResponseService(actor, {
      rfqId: rfq.id,
      lines: [
        { lineNo: 1, unitCost: "1450.00", leadTimeDays: 42 },
        { lineNo: 2, unitCost: "980.00", leadTimeDays: 35 },
      ],
    });
    return { rfq, quotation };
  }

  it("sets cost, lead time and the link that answers 'where did this come from?'", async () => {
    const { rfq, quotation } = await respondedRfq();

    const result = await applyRfqToQuotationService(actor, { rfqId: rfq.id });
    expect(result.applied).toBe(2);

    const lines = await db.quotationLine.findMany({
      where: { quotationId: quotation.id },
      orderBy: { lineNo: "asc" },
    });
    expect(lines[0]!.unitCost.toString()).toBe("1450");
    expect(lines[0]!.leadTimeDays).toBe(42);
    expect(lines[1]!.unitCost.toString()).toBe("980");

    // §3.5's link, and the reason `sourceLineNo` exists.
    const rfqLines = await db.supplierQuoteLine.findMany({
      where: { requestId: rfq.id },
      orderBy: { lineNo: "asc" },
    });
    expect(lines[0]!.supplierQuoteLineId).toBe(rfqLines[0]!.id);
    expect(lines[1]!.supplierQuoteLineId).toBe(rfqLines[1]!.id);

    // The untouched third line keeps its own cost — applying an RFQ is not a whole-quotation reset.
    expect(lines[2]!.unitCost.toString()).toBe("20000");
    expect(lines[2]!.supplierQuoteLineId).toBeNull();
  }, 60_000);

  it("does not zero the costs when applied by somebody who cannot see cost", async () => {
    // The trap this flow was always going to fall into. §3 gives supplier pricing to PD, who by
    // Spec.md §4.3 does not hold `finance.view_cost`; the line service zeroes cost for a caller who
    // cannot see it. That guard is about a *browser* posting back figures it was never shown — here
    // the figures come off the RFQ rows on the server.
    const { rfq, quotation } = await respondedRfq();

    await applyRfqToQuotationService(actor, { rfqId: rfq.id });

    const stored = await db.quotation.findUniqueOrThrow({ where: { id: quotation.id } });
    expect(Number(stored.totalCost)).toBeGreaterThan(0);
  }, 60_000);

  it("applies only the lines asked for", async () => {
    const { rfq, quotation } = await respondedRfq();

    const result = await applyRfqToQuotationService(actor, { rfqId: rfq.id, lineNos: [1] });
    expect(result.applied).toBe(1);

    const lines = await db.quotationLine.findMany({
      where: { quotationId: quotation.id },
      orderBy: { lineNo: "asc" },
    });
    expect(lines[0]!.unitCost.toString()).toBe("1450");
    expect(lines[1]!.unitCost.toString()).toBe("0");
  }, 60_000);

  it("refuses to apply to a sent quotation, supplier pricing or not", async () => {
    const { rfq, quotation } = await respondedRfq();
    await db.quotation.update({ where: { id: quotation.id }, data: { status: "sent" } });

    await expect(applyRfqToQuotationService(actor, { rfqId: rfq.id })).rejects.toThrow(
      /Create a revision/,
    );
  }, 60_000);

  it("refuses a foreign-currency cost when no exchange rate has been set", async () => {
    // The defect this test exists for: a EUR 1,450 part was being stored as a cost of 1,450 *pesos*
    // — about a sixty-fifth of the truth. The margin then looked enormous, the floor never tripped,
    // and the quotation reached the VP's queue looking like the best deal of the year.
    const supplier = await makePrincipal();
    const quotation = await makeQuotation(); // PHP, with the default rate of 1
    const rfq = await raise(quotation.id, supplier.id, [1]);
    await markRfqSentService(actor, { rfqId: rfq.id });
    await recordRfqResponseService(actor, {
      rfqId: rfq.id,
      currency: "EUR",
      lines: [{ lineNo: 1, unitCost: "1450.00", currency: "EUR" }],
    });

    await expect(applyRfqToQuotationService(actor, { rfqId: rfq.id })).rejects.toThrow(
      /no exchange rate has been set/,
    );

    // And nothing was written — a refusal that half-applied would be worse than the bug.
    const line = await db.quotationLine.findFirstOrThrow({
      where: { quotationId: quotation.id, lineNo: 1 },
    });
    expect(line.unitCost.toString()).toBe("0");
  }, 60_000);

  it("converts at the rate it is given, and records the rate it used", async () => {
    const supplier = await makePrincipal();
    const quotation = await makeQuotation();
    const rfq = await raise(quotation.id, supplier.id, [1]);
    await markRfqSentService(actor, { rfqId: rfq.id });
    await recordRfqResponseService(actor, {
      rfqId: rfq.id,
      currency: "EUR",
      lines: [{ lineNo: 1, unitCost: "1450.00", currency: "EUR" }],
    });

    await applyRfqToQuotationService(actor, { rfqId: rfq.id, fxRate: "65" });

    const line = await db.quotationLine.findFirstOrThrow({
      where: { quotationId: quotation.id, lineNo: 1 },
    });
    expect(line.unitCost.toString()).toBe("94250"); // 1,450 × 65
    expect(line.costCurrency).toBe("EUR");
    // §4: "Never overwrite a historical rate" — the rate used is on the line, so the arithmetic can
    // be checked later even though the stored cost is already converted.
    expect(Number(line.costFxRate)).toBe(65);
  }, 60_000);

  it("applies the FX buffer once, and does not compound it on a later apply", async () => {
    const supplier = await makePrincipal();
    const quotation = await makeQuotation();
    await db.quotation.update({ where: { id: quotation.id }, data: { fxBufferPct: "3" } });

    const rfq = await raise(quotation.id, supplier.id, [1]);
    await markRfqSentService(actor, { rfqId: rfq.id });
    await recordRfqResponseService(actor, {
      rfqId: rfq.id,
      lines: [{ lineNo: 1, unitCost: "1000.00" }],
    });

    await applyRfqToQuotationService(actor, { rfqId: rfq.id });
    const first = await db.quotationLine.findFirstOrThrow({
      where: { quotationId: quotation.id, lineNo: 1 },
    });
    expect(first.unitCost.toString()).toBe("1030"); // §4's buffer, applied once

    // Applying the same request again must land on the same number, not 1,060.90.
    await applyRfqToQuotationService(actor, { rfqId: rfq.id });
    const second = await db.quotationLine.findFirstOrThrow({
      where: { quotationId: quotation.id, lineNo: 1 },
    });
    expect(second.unitCost.toString()).toBe("1030");

    // And the quotation's own buffer setting survives — applying supplier pricing says nothing
    // about it.
    const stored = await db.quotation.findUniqueOrThrow({ where: { id: quotation.id } });
    expect(Number(stored.fxBufferPct)).toBe(3);
  }, 60_000);

  it("refuses to apply a request with no recorded response", async () => {
    const supplier = await makePrincipal();
    const quotation = await makeQuotation();
    const rfq = await raise(quotation.id, supplier.id, [1]);
    await markRfqSentService(actor, { rfqId: rfq.id });

    await expect(applyRfqToQuotationService(actor, { rfqId: rfq.id })).rejects.toThrow(
      /no recorded response/,
    );
  }, 60_000);
});

describe("§3.6: comparing suppliers", () => {
  it("lines up the same quotation line across every supplier asked", async () => {
    const quotation = await makeQuotation();
    const krohne = await makePrincipal("appointed", `Krohne ${randomUUID().slice(0, 6)}`);
    const endress = await makePrincipal("appointed", `Endress ${randomUUID().slice(0, 6)}`);

    for (const [supplier, price] of [
      [krohne, "1450.00"],
      [endress, "1290.00"],
    ] as const) {
      const rfq = await raise(quotation.id, supplier.id, [1, 2]);
      await markRfqSentService(actor, { rfqId: rfq.id });
      await recordRfqResponseService(actor, {
        rfqId: rfq.id,
        lines: [
          { lineNo: 1, unitCost: price, leadTimeDays: supplier === krohne ? 42 : 70 },
          { lineNo: 2, unitCost: "980.00", leadTimeDays: 35 },
        ],
      });
    }

    const rows = await compareRfqsForQuotationService(quotation.id);
    expect(rows.map((r) => r.sourceLineNo)).toEqual([1, 2]);

    const first = rows[0]!;
    expect(first.offers).toHaveLength(2);
    // Cheapest is flagged, not chosen: §3.6 asks for a matrix of cost, lead time and validity so a
    // person can weigh them — and here the cheaper offer is four weeks slower.
    const cheapest = first.offers.find((o) => o.isCheapest)!;
    expect(cheapest.unitCost).toBe("1290");
    expect(cheapest.leadTimeDays).toBe(70);
    expect(first.offers.filter((o) => o.isCheapest)).toHaveLength(1);
  }, 120_000);

  it("does not flag a cheapest across mixed currencies", async () => {
    // Comparing a EUR offer against a PHP one needs the quotation's rate. Flagging a winner without
    // it would name the wrong one with total confidence.
    const quotation = await makeQuotation();
    const a = await makePrincipal("appointed", `A ${randomUUID().slice(0, 6)}`);
    const b = await makePrincipal("appointed", `B ${randomUUID().slice(0, 6)}`);

    for (const [supplier, price, currency] of [
      [a, "1450.00", "EUR"],
      [b, "90000.00", "PHP"],
    ] as const) {
      const rfq = await raise(quotation.id, supplier.id, [1]);
      await markRfqSentService(actor, { rfqId: rfq.id });
      await recordRfqResponseService(actor, {
        rfqId: rfq.id,
        lines: [{ lineNo: 1, unitCost: price, currency }],
      });
    }

    const rows = await compareRfqsForQuotationService(quotation.id);
    expect(rows[0]!.offers).toHaveLength(2);
    expect(rows[0]!.offers.filter((o) => o.isCheapest)).toHaveLength(0);
  }, 120_000);

  it("marks which offer is the one actually costed onto the line", async () => {
    const quotation = await makeQuotation();
    const supplier = await makePrincipal();
    const rfq = await raise(quotation.id, supplier.id, [1]);
    await markRfqSentService(actor, { rfqId: rfq.id });
    await recordRfqResponseService(actor, {
      rfqId: rfq.id,
      lines: [{ lineNo: 1, unitCost: "1450.00" }],
    });
    await applyRfqToQuotationService(actor, { rfqId: rfq.id });

    const rows = await compareRfqsForQuotationService(quotation.id);
    expect(rows[0]!.offers[0]!.isApplied).toBe(true);
  }, 60_000);
});

describe("§3.3's overdue sweep", () => {
  it("chases the person who raised it on the day it falls due", async () => {
    const supplier = await makePrincipal();
    const quotation = await makeQuotation();
    const rfq = await raise(quotation.id, supplier.id, [1]);
    await markRfqSentService(actor, {
      rfqId: rfq.id,
      dueBy: new Date(Date.now() - 60_000),
    });

    const result = await sweepOverdueRfqs();
    expect(result.notified.map((r) => r.rfqId)).toContain(rfq.id);

    const notifications = await db.notification.findMany({ where: { recipientId: PD } });
    expect(notifications.some((n) => n.title.includes(rfq.number))).toBe(true);
  }, 60_000);

  it("leaves a request that has been answered alone", async () => {
    const supplier = await makePrincipal();
    const quotation = await makeQuotation();
    const rfq = await raise(quotation.id, supplier.id, [1]);
    await markRfqSentService(actor, { rfqId: rfq.id, dueBy: new Date(Date.now() - 86_400_000) });
    await recordRfqResponseService(actor, {
      rfqId: rfq.id,
      lines: [{ lineNo: 1, unitCost: "1000.00" }],
    });

    const result = await sweepOverdueRfqs();
    expect(result.notified.map((r) => r.rfqId)).not.toContain(rfq.id);
  }, 60_000);

  it("chases weekly rather than daily", async () => {
    // A supplier who has not answered in three days will not answer faster for being chased every
    // morning, and a daily notification is one people filter.
    const supplier = await makePrincipal();
    const quotation = await makeQuotation();
    const rfq = await raise(quotation.id, supplier.id, [1]);
    await markRfqSentService(actor, {
      rfqId: rfq.id,
      dueBy: new Date(Date.now() - 3 * 86_400_000),
    });

    const result = await sweepOverdueRfqs();
    expect(result.notified.map((r) => r.rfqId)).not.toContain(rfq.id);
  }, 60_000);
});

describe("the request body PD pastes into an email", () => {
  it("carries the items, the quantities and what is being asked for", () => {
    const body = buildRequestBody({
      number: "RFQ-26-0007",
      quotationNumber: "AIESLQ260012",
      title: "Sludge level metering",
      supplierName: "Krohne Messtechnik",
      contactName: null,
      dueBy: new Date("2026-09-01T00:00:00Z"),
      notes: "The line is DN100, flanged to DIN.",
      lines: [
        {
          description: "Electromagnetic flow meter",
          manufacturer: "Krohne",
          modelNumber: "OPTIFLUX 4300",
          quantity: "2",
          unit: "unit",
        },
      ],
    });

    expect(body).toContain("Dear Krohne Messtechnik,");
    expect(body).toContain("RFQ-26-0007");
    expect(body).toContain("OPTIFLUX 4300");
    expect(body).toContain("Quantity: 2 unit");
    expect(body).toContain("DN100, flanged to DIN");
    expect(body).toContain("2026-09-01");
    // The four things a response has to contain for anything downstream to use it.
    expect(body).toContain("unit price, currency, lead time");
    expect(body).toContain("valid");
  });
});
