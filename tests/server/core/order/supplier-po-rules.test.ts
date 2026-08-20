import { describe, expect, it } from "vitest";
import {
  allocateLandedCost,
  daysLate,
  downpaymentGate,
  isSupplierPoEditable,
  supplierApprovalGate,
  supplierPoTotal,
} from "@/server/core/order/supplier-po-rules";

/**
 * specs/03-order-procurement.md §4 and §5, as pure functions.
 *
 * §11 names two of these outright: "Downpayment gate blocks supplier PO send" and "Landed cost
 * allocation by value sums exactly to the total charge (no rounding leakage)". The second is the
 * one worth over-testing — a centavo lost per shipment is a margin report that never quite
 * reconciles, which is worse than a visible error because nobody can find it.
 */

describe("§5's landed cost allocation", () => {
  it("sums exactly to the total charge, even when it does not divide", () => {
    // Three equal lines and ₱1,000 of freight: the naive answer is 333.33 three times, which loses
    // a centavo. §11 asks for exactness, so the remainder has to land somewhere.
    const result = allocateLandedCost(
      [
        { lineNo: 1, lineTotal: 1000 },
        { lineNo: 2, lineTotal: 1000 },
        { lineNo: 3, lineTotal: 1000 },
      ],
      { freight: 1000 },
    );

    const allocated = result.reduce((sum, row) => sum + row.allocatedCharges, 0);
    expect(allocated).toBeCloseTo(1000, 10);
    // Exactly, in centavos — the assertion above passes for 999.9999999 too.
    expect(Math.round(allocated * 100)).toBe(100_000);
  });

  it("gives the remainder to the largest line, deterministically", () => {
    const result = allocateLandedCost(
      [
        { lineNo: 1, lineTotal: 100 },
        { lineNo: 2, lineTotal: 500 },
        { lineNo: 3, lineTotal: 100 },
      ],
      { freight: 100 },
    );

    // 100/700, 500/700, 100/700 of 10,000 centavos = 1428, 7142, 1428 → 9998, remainder 2.
    expect(result.map((row) => Math.round(row.allocatedCharges * 100))).toEqual([1428, 7144, 1428]);
    // Running it again gives the same answer — no floating-point drift, no arbitrary tie-break.
    const again = allocateLandedCost(
      [
        { lineNo: 1, lineTotal: 100 },
        { lineNo: 2, lineTotal: 500 },
        { lineNo: 3, lineTotal: 100 },
      ],
      { freight: 100 },
    );
    expect(again).toEqual(result);
  });

  it("breaks a tie on the lowest line number", () => {
    // Two identical lines and an odd remainder. Either could take it; which one must not vary.
    const result = allocateLandedCost(
      [
        { lineNo: 1, lineTotal: 100 },
        { lineNo: 2, lineTotal: 100 },
      ],
      { freight: 0.01 },
    );
    expect(Math.round(result[0]!.allocatedCharges * 100)).toBe(1);
    expect(Math.round(result[1]!.allocatedCharges * 100)).toBe(0);
  });

  it("adds freight, duties and other charges together", () => {
    const result = allocateLandedCost([{ lineNo: 1, lineTotal: 1000 }], {
      freight: 100,
      duties: 50,
      otherCharges: 25.5,
    });
    expect(result[0]!.allocatedCharges).toBeCloseTo(175.5, 10);
    expect(result[0]!.landedTotal).toBeCloseTo(1175.5, 10);
  });

  it("spreads charges evenly when every line is worth nothing", () => {
    // A PO of free-of-charge replacements with real freight on it. Allocating by value would
    // divide by zero and hide the charge entirely, which is the one outcome §5 rules out.
    const result = allocateLandedCost(
      [
        { lineNo: 1, lineTotal: 0 },
        { lineNo: 2, lineTotal: 0 },
      ],
      { freight: 300 },
    );
    expect(result.map((row) => row.allocatedCharges)).toEqual([150, 150]);
  });

  it("allocates nothing when there are no charges", () => {
    const result = allocateLandedCost([{ lineNo: 1, lineTotal: 4000 }], {});
    expect(result[0]!.allocatedCharges).toBe(0);
    expect(result[0]!.landedTotal).toBe(4000);
  });

  it("returns nothing for a PO with no lines rather than throwing", () => {
    expect(allocateLandedCost([], { freight: 500 })).toEqual([]);
  });

  it("survives the awkward decimals that break float arithmetic", () => {
    // 0.1 + 0.2 !== 0.3 in binary floating point. Every value here is chosen to expose that.
    const result = allocateLandedCost(
      [
        { lineNo: 1, lineTotal: 0.1 },
        { lineNo: 2, lineTotal: 0.2 },
      ],
      { freight: 0.3 },
    );
    const total = result.reduce((sum, row) => sum + Math.round(row.allocatedCharges * 100), 0);
    expect(total).toBe(30);
  });
});

describe("the header total", () => {
  it("adds the charges without rounding leakage", () => {
    expect(supplierPoTotal({ subtotal: 0.1, freight: 0.2 })).toBe(0.3);
    expect(
      supplierPoTotal({ subtotal: 1000, freight: 12.35, duties: 4.44, otherCharges: 1.11 }),
    ).toBe(1017.9);
  });
});

describe("§4's downpayment gate", () => {
  const order = { currency: "PHP", downpaymentAmount: 250_000 };

  it("does not block when no downpayment was agreed", () => {
    // Today's real state: `PaymentTerm` is module 05's, so every sales order is created this way.
    // The gate reporting "not required" is it working, not it failing.
    const gate = downpaymentGate({ ...order, financeStatus: "not_required", downpaymentPct: 0 });
    expect(gate.state).toBe("not_required");
    expect(gate.blocks).toBe(false);
  });

  it("blocks while the money is outstanding, and says how much", () => {
    const gate = downpaymentGate({
      ...order,
      financeStatus: "awaiting_downpayment",
      // A whole percent, as `PaymentTerm` stores it. This read 0.5 until 2026-08-20, which agreed
      // with a bug in the caller rather than with any row the seed has ever written.
      downpaymentPct: 50,
    });
    expect(gate.state).toBe("blocked");
    expect(gate.blocks).toBe(true);
    expect(gate.message).toMatch(/50% downpayment of PHP 250000\.00/);
    // §4 wants the override discoverable from the message, not from tribal knowledge.
    expect(gate.message).toMatch(/President or Vice President overrides/);
  });

  it("clears once finance records the payment", () => {
    for (const financeStatus of [
      "downpayment_received",
      "partially_billed",
      "fully_billed",
      "paid",
    ]) {
      const gate = downpaymentGate({ ...order, financeStatus, downpaymentPct: 50 });
      expect(gate.blocks, financeStatus).toBe(false);
      expect(gate.state, financeStatus).toBe("satisfied");
    }
  });

  it("does not block on a percentage of zero even if finance says awaiting", () => {
    // A stale column, which is exactly the case where a gate that read only `financeStatus` would
    // hold procurement for money nobody ever asked for.
    const gate = downpaymentGate({
      ...order,
      financeStatus: "awaiting_downpayment",
      downpaymentPct: 0,
    });
    expect(gate.blocks).toBe(false);
  });
});

describe("clause 8.4's gate", () => {
  it("blocks an unapproved supplier and names the way through", () => {
    const gate = supplierApprovalGate({
      name: "Bearing Traders",
      isApproved: false,
      approvalExpiry: null,
    });
    expect(gate.blocks).toBe(true);
    expect(gate.message).toMatch(/not an approved supplier/);
    expect(gate.message).toMatch(/override here with a reason/);
  });

  it("blocks an approval that has lapsed, and says so differently", () => {
    // "Expired" and "never approved" mean opposite things about whether anybody did the work, and
    // the person reading this has to know which conversation to have.
    const gate = supplierApprovalGate({
      name: "Plotork",
      isApproved: true,
      approvalExpiry: new Date("2020-01-01"),
    });
    expect(gate.blocks).toBe(true);
    expect(gate.message).toMatch(/approval expired on 2020-01-01/);
  });

  it("lets an approved supplier through", () => {
    expect(
      supplierApprovalGate({ name: "Plotork", isApproved: true, approvalExpiry: null }).blocks,
    ).toBe(false);
    expect(
      supplierApprovalGate({
        name: "Plotork",
        isApproved: true,
        approvalExpiry: new Date(Date.now() + 86_400_000),
      }).blocks,
    ).toBe(false);
  });
});

describe("editability and lateness", () => {
  it("closes editing at approval, not at send", () => {
    // Editing after approval silently changes what the VP agreed to.
    expect(isSupplierPoEditable("draft")).toBe(true);
    for (const status of ["pending_approval", "approved", "sent", "acknowledged", "received"]) {
      expect(isSupplierPoEditable(status), status).toBe(false);
    }
  });

  it("reports no arrival date as null, not as on time", () => {
    // An undated PO is the one nobody is chasing, which is what the expediting view is for.
    expect(daysLate(null)).toBeNull();
    expect(daysLate(undefined)).toBeNull();
  });

  it("counts whole days either side of the promised date", () => {
    const now = new Date("2026-08-16T09:00:00Z");
    expect(daysLate(new Date("2026-08-16T23:00:00Z"), now)).toBe(0);
    expect(daysLate(new Date("2026-08-13T01:00:00Z"), now)).toBe(3);
    expect(daysLate(new Date("2026-08-20T01:00:00Z"), now)).toBe(-4);
  });
});
