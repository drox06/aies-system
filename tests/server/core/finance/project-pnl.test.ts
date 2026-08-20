import { randomUUID } from "node:crypto";
import { afterAll, describe, expect, it } from "vitest";
import { db } from "@/lib/db";
import {
  projectPnl,
  rateOn,
  timesheetCost,
  type CostLine,
} from "@/server/core/finance/project-pnl-rules";
import { projectPnlService } from "@/server/core/finance/project-pnl-service";

/**
 * §6's project profitability.
 *
 * §6 states the purpose plainly: *"The gap between quoted margin and actual margin is the single
 * most useful number the platform can give management, because today it is unknowable."* These tests
 * pin the arithmetic of that gap, and — more importantly — the cases where the honest answer is to
 * refuse to produce a number.
 */

const line = (category: CostLine["category"], amount: number): CostLine => ({
  category,
  amount,
  source: "test",
});

describe("the gap between quoted and actual", () => {
  it("reports the variance in percentage points, negative when the job earned less", () => {
    // Sold for 1,000,000 against a quoted cost of 700,000 — 30% quoted.
    // It actually cost 820,000, so 18% actual: twelve points down.
    const pnl = projectPnl({
      contractValue: 1_000_000,
      quotedCost: 700_000,
      costs: [line("materials", 600_000), line("labour", 220_000)],
    });

    expect(pnl.quotedMarginPct).toBeCloseTo(30);
    expect(pnl.actualMarginPct).toBeCloseTo(18);
    expect(pnl.marginVariancePts).toBeCloseTo(-12);
  });

  it("reports a job that beat its quote as positive", () => {
    const pnl = projectPnl({
      contractValue: 500_000,
      quotedCost: 400_000,
      costs: [line("materials", 350_000)],
    });
    expect(pnl.marginVariancePts).toBeGreaterThan(0);
  });

  /**
   * The case that would otherwise put a spectacular lie on a screen.
   *
   * A project nobody has costed yet has, arithmetically, a 100% margin. Rendering that would tell
   * management the job is the most profitable they have ever done, on the day it starts.
   */
  it("says nothing has been costed rather than reporting a 100% margin", () => {
    const pnl = projectPnl({ contractValue: 250_000, quotedCost: 200_000, costs: [] });
    expect(pnl.noCostsYet).toBe(true);
  });

  it("does not divide by zero on a project with no contract value", () => {
    // Internal work, or a goodwill job. Percentages are meaningless rather than infinite.
    const pnl = projectPnl({ contractValue: 0, quotedCost: 0, costs: [line("labour", 40_000)] });
    expect(Number.isFinite(pnl.actualMarginPct)).toBe(true);
    expect(pnl.actualMarginPct).toBe(0);
  });

  it("keeps every category, including the empty ones", () => {
    /*
      A breakdown that hides its zeroes makes "we spent nothing on subcontractors" and "nobody has
      entered the subcontractors yet" look identical, and only one of those is good news.
    */
    const pnl = projectPnl({
      contractValue: 100_000,
      quotedCost: 60_000,
      costs: [line("labour", 50_000)],
    });
    expect(pnl.byCategory).toHaveLength(8);
    expect(pnl.byCategory.find((row) => row.category === "subcontract")?.amount).toBe(0);
  });

  it("reports rework on its own as well as inside the total", () => {
    // §6: "tracked separately — this is the cost of poor quality and it should be reportable on its
    // own, not buried in project cost." Both, not either.
    const pnl = projectPnl({
      contractValue: 100_000,
      quotedCost: 60_000,
      costs: [line("labour", 50_000), line("rework", 12_000)],
    });
    expect(pnl.reworkCost).toBe(12_000);
    expect(pnl.actualCost).toBe(62_000);
  });
});

describe("what an hour costs", () => {
  const rate = {
    hourlyCost: 200,
    overtimeMultiplier: 1.25,
    travelMultiplier: 1,
    standbyMultiplier: 1,
  };

  it("applies each multiplier to its own kind of hour", () => {
    const cost = timesheetCost(
      { regularHours: 8, overtimeHours: 2, travelHours: 3, standbyHours: 1 },
      rate,
    );
    // 8×200 + 2×200×1.25 + 3×200 + 1×200
    expect(cost).toBe(1600 + 500 + 600 + 200);
  });

  /**
   * The one that keeps the margin honest.
   *
   * A day worked by somebody with no rate on file costs zero here — and the *service* counts those
   * days and says so on screen. Guessing a rate would put a fabricated figure into the one number
   * §6 says management cannot get anywhere else.
   */
  it("costs nothing when no rate is in force, so the caller must report it", () => {
    expect(
      timesheetCost({ regularHours: 8, overtimeHours: 0, travelHours: 0, standbyHours: 0 }, null),
    ).toBe(0);
  });
});

describe("which rate applied on the day", () => {
  const rates = [
    { effectiveFrom: "2025-01-01", hourlyCost: 150 },
    { effectiveFrom: "2026-03-01", hourlyCost: 200 },
  ];

  it("uses the newest rate starting on or before the day worked", () => {
    expect(rateOn(rates, "2026-06-15")?.hourlyCost).toBe(200);
    expect(rateOn(rates, "2026-03-01")?.hourlyCost).toBe(200);
  });

  /**
   * Rates are a history, not a setting.
   *
   * A job costed in February must keep February's rate however many rises have happened since, or
   * last year's margins move every time payroll does — and a report whose past changes is a report
   * nobody can act on.
   */
  it("keeps an old job on the old rate", () => {
    expect(rateOn(rates, "2026-02-28")?.hourlyCost).toBe(150);
  });

  it("returns nothing for work done before any rate existed", () => {
    expect(rateOn(rates, "2024-11-01")).toBeNull();
  });
});

/**
 * The service half, which had no test at all until 2026-08-20.
 *
 * Everything above pins `projectPnl`, a pure function fed hand-written numbers. It was correct. The
 * **service** feeding it was not: it passed `SalesOrder.total`, which is VAT-inclusive, against
 * `totalCost`, which is not — so a 708,960 order with 500,000 of quoted cost reported a 29.5% quoted
 * margin while the quotation itself said 21.0%. Two screens, one deal, eight and a half points apart.
 *
 * The same shape as docs/DECISIONS.md #129: a pure function proved right by a fixture it controls,
 * and nothing checking what the real caller hands it. So this test builds an order with VAT on it
 * and asserts on the boundary rather than on the arithmetic.
 */
describe("§6's service, against a real order", () => {
  const suffix = randomUUID().slice(0, 8);
  const actor = `pnl-${suffix}`;

  const accountIds: string[] = [];
  const quotationIds: string[] = [];
  const poIds: string[] = [];
  const fileIds: string[] = [];
  const orderIds: string[] = [];
  const projectIds: string[] = [];
  const ticketIds: string[] = [];

  afterAll(async () => {
    await db.ticket.deleteMany({ where: { id: { in: ticketIds } } });
    await db.project.deleteMany({ where: { id: { in: projectIds } } });
    await db.salesOrder.deleteMany({ where: { id: { in: orderIds } } });
    await db.customerPO.deleteMany({ where: { id: { in: poIds } } });
    await db.fileObject.deleteMany({ where: { id: { in: fileIds } } });
    await db.quotation.deleteMany({ where: { id: { in: quotationIds } } });
    await db.customerAccount.deleteMany({ where: { id: { in: accountIds } } });
  });

  it("measures margin against revenue net of VAT, not the VAT-inclusive total", async () => {
    // The FIN5 walkthrough deal's own figures: 633,000 net, 12% VAT, 500,000 of quoted cost.
    const NET = 633_000;
    const VAT = 75_960;
    const TOTAL = NET + VAT;
    const QUOTED_COST = 500_000;

    const account = await db.customerAccount.create({
      data: { code: `PNL-${randomUUID().slice(0, 12)}`, name: `PnL Co ${suffix}`, ownerId: actor },
    });
    accountIds.push(account.id);

    const quotation = await db.quotation.create({
      data: {
        number: `TEST-PNL-LQ-${randomUUID().slice(0, 8)}`,
        accountId: account.id,
        title: "P&L fixture",
        scopeOfWork: "Something with VAT on it.",
        validUntil: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000),
        preparedById: actor,
        subtotal: String(NET),
        vatAmount: String(VAT),
        total: String(TOTAL),
        totalCost: String(QUOTED_COST),
      },
    });
    quotationIds.push(quotation.id);

    const file = await db.fileObject.create({
      data: {
        entityType: "CustomerPO",
        entityId: account.id,
        filename: "po.pdf",
        mimeType: "application/pdf",
        size: 1024,
        sha256: randomUUID().replace(/-/g, ""),
        storageKey: `test/${randomUUID()}.pdf`,
        uploaderId: actor,
      },
    });
    fileIds.push(file.id);

    const po = await db.customerPO.create({
      data: {
        accountId: account.id,
        quotationId: quotation.id,
        poNumber: `PO-${randomUUID().slice(0, 8)}`,
        poDate: new Date(),
        amount: String(TOTAL),
        fileId: file.id,
        receivedById: actor,
      },
    });
    poIds.push(po.id);

    const order = await db.salesOrder.create({
      data: {
        number: `TEST-PNL-SO-${randomUUID().slice(0, 8)}`,
        accountId: account.id,
        quotationId: quotation.id,
        customerPOId: po.id,
        ownerId: actor,
        status: "open",
        currency: "PHP",
        subtotal: String(NET),
        vatAmount: String(VAT),
        total: String(TOTAL),
        totalCost: String(QUOTED_COST),
      },
    });
    orderIds.push(order.id);

    const project = await db.project.create({
      data: {
        code: `PNL-${randomUUID().slice(0, 10)}`,
        name: `P&L project ${suffix}`,
        accountId: account.id,
        scopeOfWork: "Something with VAT on it.",
      },
    });
    projectIds.push(project.id);

    // The service finds orders through their tickets, so the link has to be real.
    const ticket = await db.ticket.create({
      data: {
        number: `TEST-PNL-TKT-${randomUUID().slice(0, 8)}`,
        accountId: account.id,
        projectId: project.id,
        salesOrderId: order.id,
        type: "installation",
        title: "P&L fixture ticket",
        scopeOfWork: "Something with VAT on it.",
        raisedById: actor,
      },
    });
    ticketIds.push(ticket.id);

    const pnl = await projectPnlService(project.id);

    // The whole point: 633,000, not 708,960.
    expect(pnl.contractValue).toBe(NET);
    expect(pnl.contractValue).not.toBe(TOTAL);

    // And therefore the quoted margin agrees with what the quotation itself prints — costing.ts
    // divides by `netAmount`, and these two must not be able to drift apart.
    expect(pnl.quotedMarginPct).toBeCloseTo(((NET - QUOTED_COST) / NET) * 100, 4);
  }, 60_000);
});

/**
 * Cash released and not yet liquidated.
 *
 * Found by the company on 2026-08-20, walking the FIN5 job: ₱24,000 released that morning, the P&L
 * reading 22.41% against a 21.01% quote, and nothing anywhere to say that liquidating the advance
 * takes it to 18.6% — flipping the job from above its estimate to below it.
 *
 * The rule being pinned is a **pair**, and both halves matter: the released cash must not be counted
 * as cost, and it must not be silent either. §5b is explicit that only approved liquidation lines
 * post, so folding it into `actualCost` would be wrong — but a margin about to move four points is
 * not one somebody should decide on unaware.
 */
describe("§5b's cash, out but not yet accounted for", () => {
  const suffix = randomUUID().slice(0, 8);
  const actor = `adv-${suffix}`;

  const accountIds: string[] = [];
  const projectIds: string[] = [];
  const ticketIds: string[] = [];
  const advanceIds: string[] = [];

  afterAll(async () => {
    await db.cashAdvance.deleteMany({ where: { id: { in: advanceIds } } });
    await db.ticket.deleteMany({ where: { id: { in: ticketIds } } });
    await db.project.deleteMany({ where: { id: { in: projectIds } } });
    await db.customerAccount.deleteMany({ where: { id: { in: accountIds } } });
  });

  it("reports it without counting it, and says what the margin would become", async () => {
    const account = await db.customerAccount.create({
      data: { code: `ADV-${randomUUID().slice(0, 12)}`, name: `Adv Co ${suffix}`, ownerId: actor },
    });
    accountIds.push(account.id);

    const project = await db.project.create({
      data: {
        code: `ADV-${randomUUID().slice(0, 10)}`,
        name: `Advance project ${suffix}`,
        accountId: account.id,
        scopeOfWork: "A job with cash out on it.",
      },
    });
    projectIds.push(project.id);

    const ticket = await db.ticket.create({
      data: {
        number: `ADV-TKT-${randomUUID().slice(0, 8)}`,
        accountId: account.id,
        projectId: project.id,
        type: "installation",
        title: "Advance fixture",
        scopeOfWork: "A job with cash out on it.",
        raisedById: actor,
      },
    });
    ticketIds.push(ticket.id);

    const advance = await db.cashAdvance.create({
      data: {
        number: `ADV-CA-${randomUUID().slice(0, 8)}`,
        ticketId: ticket.id,
        projectId: project.id,
        requestedById: actor,
        purpose: "Per diem and fuel",
        amountRequested: "24000.00",
        amountApproved: "24000.00",
        neededBy: new Date(),
        status: "released",
        releasedById: actor,
        releasedAt: new Date(),
        liquidationDueAt: new Date(Date.now() + 5 * 24 * 60 * 60 * 1000),
      },
    });
    advanceIds.push(advance.id);

    const pnl = await projectPnlService(project.id);

    // Reported...
    expect(pnl.caveats.advancesOutstanding).toBe(1);
    expect(pnl.caveats.advancedNotLiquidated).toBe(24_000);
    expect(pnl.caveats.earliestLiquidationDue).not.toBeNull();

    // ...and not counted. §5b: only approved liquidation lines post as project cost.
    expect(pnl.actualCost).toBe(0);
  }, 60_000);

  it("says nothing when the advance has been liquidated", async () => {
    const account = await db.customerAccount.create({
      data: {
        code: `ADV2-${randomUUID().slice(0, 11)}`,
        name: `Adv2 Co ${suffix}`,
        ownerId: actor,
      },
    });
    accountIds.push(account.id);

    const project = await db.project.create({
      data: {
        code: `ADV2-${randomUUID().slice(0, 9)}`,
        name: `Liquidated project ${suffix}`,
        accountId: account.id,
        scopeOfWork: "A job whose cash came back as receipts.",
      },
    });
    projectIds.push(project.id);

    const advance = await db.cashAdvance.create({
      data: {
        number: `ADV2-CA-${randomUUID().slice(0, 8)}`,
        projectId: project.id,
        requestedById: actor,
        purpose: "Per diem",
        amountRequested: "10000.00",
        amountApproved: "10000.00",
        neededBy: new Date(),
        status: "released",
        releasedById: actor,
        releasedAt: new Date(),
        // The receipts came back. Nothing is in the air any more, so the warning must go quiet —
        // a caveat that never clears is one people stop reading.
        liquidatedAt: new Date(),
      },
    });
    advanceIds.push(advance.id);

    const pnl = await projectPnlService(project.id);
    expect(pnl.caveats.advancesOutstanding).toBe(0);
    expect(pnl.caveats.advancedNotLiquidated).toBe(0);
  }, 60_000);
});
