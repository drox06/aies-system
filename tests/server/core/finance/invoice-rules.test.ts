import { describe, expect, it } from "vitest";
import {
  ageingBucket,
  checkAllocation,
  checkWithholding,
  computeStatementTotals,
  expectedWithholding,
  isCollected,
  statementStatusFor,
  suggestAllocation,
} from "@/server/core/finance/invoice-rules";

/**
 * specs/05-finance-billing.md §3, as pure functions.
 *
 * Every case here is one where getting it wrong costs real money in a direction nobody notices: VAT
 * added to a price that already contained it, withholding computed on the gross, a cheque counted as
 * cash before it cleared, ageing run on documents that only exist once the debt is gone.
 */

const line = (unitPrice: number, over: Record<string, unknown> = {}) => ({
  description: "Work",
  quantity: 1,
  unitPrice,
  ...over,
});

describe("what a statement comes to", () => {
  it("adds VAT on top when the price is exclusive", () => {
    const totals = computeStatementTotals([line(100_000)], "exclusive");
    expect(totals.subtotal).toBe(100_000);
    expect(totals.vatAmount).toBe(12_000);
    expect(totals.total).toBe(112_000);
    expect(totals.vatableSales).toBe(100_000);
  });

  /**
   * The one that gets mishandled. An inclusive price **already contains** the VAT, so it is
   * extracted rather than added — adding 12% overcharges by twelve per cent, and treating the whole
   * amount as the net understates output VAT.
   */
  it("extracts VAT from an inclusive price rather than adding to it", () => {
    const totals = computeStatementTotals([line(112_000)], "inclusive");
    expect(totals.total).toBe(112_000);
    expect(totals.vatAmount).toBe(12_000);
    expect(totals.vatableSales).toBe(100_000);
    expect(totals.subtotal).toBe(100_000);
  });

  it("keeps zero-rated and exempt apart, because the invoice reports them separately", () => {
    const zero = computeStatementTotals([line(50_000)], "zero_rated");
    expect(zero.zeroRatedSales).toBe(50_000);
    expect(zero.vatExemptSales).toBe(0);
    expect(zero.vatAmount).toBe(0);

    const exempt = computeStatementTotals([line(50_000)], "exempt");
    expect(exempt.vatExemptSales).toBe(50_000);
    expect(exempt.zeroRatedSales).toBe(0);
  });

  it("charges VAT per line, so one statement can mix vatable and not", () => {
    const totals = computeStatementTotals(
      [line(100_000), line(50_000, { vatable: false })],
      "exclusive",
    );
    expect(totals.vatableSales).toBe(100_000);
    expect(totals.vatExemptSales).toBe(50_000);
    expect(totals.vatAmount).toBe(12_000);
    expect(totals.total).toBe(162_000);
  });

  it("multiplies by quantity", () => {
    const totals = computeStatementTotals([line(25_000, { quantity: "4" })], "exclusive");
    expect(totals.lineTotals).toEqual([100_000]);
  });

  it("refuses a price that is not whole centavos", () => {
    expect(() => computeStatementTotals([line(100.5)], "exclusive")).toThrow(/integer centavos/);
  });
});

describe("what the customer will withhold", () => {
  it("withholds nothing when the account does not", () => {
    const totals = computeStatementTotals([line(100_000)], "exclusive");
    const result = expectedWithholding(totals, { withholdsEWT: false, ewtRate: 2 });
    expect(result.withholding).toBe(0);
    expect(result.netCollectible).toBe(112_000);
  });

  /**
   * The most common arithmetic error in Philippine billing, and it always favours the customer: EWT
   * is a tax on income, and the VAT is not AIES's income. Withholding 2% of ₱1,120 rather than of
   * ₱1,000 over-deducts by ₱2.40 on every thousand, and the difference is money AIES never sees and
   * cannot credit.
   */
  it("computes withholding on sales net of VAT, not on the gross", () => {
    const totals = computeStatementTotals([line(100_000)], "exclusive");
    const result = expectedWithholding(totals, { withholdsEWT: true, ewtRate: 2 });

    expect(result.withholding).toBe(2_000);
    expect(result.netCollectible).toBe(110_000);

    // What it would have been on the gross — the wrong answer, named so the intent is unmistakable.
    expect(result.withholding).not.toBe(Math.round((112_000 * 2) / 100));
  });

  it("honours a per-account rate, because government agencies differ", () => {
    const totals = computeStatementTotals([line(100_000)], "exclusive");
    expect(expectedWithholding(totals, { withholdsEWT: true, ewtRate: 5 }).withholding).toBe(5_000);
  });
});

describe("when what arrived is not what was expected", () => {
  it("passes a difference of a peso or less, since both sides round", () => {
    expect(checkWithholding(2_000, 2_050).ok).toBe(true);
  });

  /**
   * §3.1: "flags a mismatch rather than accepting it silently." Flagged, not refused — their figure
   * is what arrived whether AIES agrees or not. What must not happen is nobody noticing that a
   * customer has quietly moved to 5%.
   */
  it("flags a real difference, and says what to look at", () => {
    const check = checkWithholding(5_000, 2_000);
    expect(check.ok).toBe(false);
    expect(check.message).toMatch(/their rate has changed/);
  });
});

describe("spreading a payment across statements", () => {
  const target = (id: string, balance: number, dueDate: string) => ({
    billingStatementId: id,
    balance,
    dueDate,
    number: id,
  });

  it("suggests oldest first", () => {
    const { allocations, unallocated } = suggestAllocation(150_000, [
      target("newer", 100_000, "2026-03-01"),
      target("older", 100_000, "2026-01-01"),
    ]);

    expect(allocations).toEqual([
      { billingStatementId: "older", amount: 100_000 },
      { billingStatementId: "newer", amount: 50_000 },
    ]);
    expect(unallocated).toBe(0);
  });

  it("reports what it could not place rather than forcing it somewhere", () => {
    const { allocations, unallocated } = suggestAllocation(200_000, [
      target("only", 50_000, "2026-01-01"),
    ]);
    expect(allocations).toHaveLength(1);
    expect(unallocated).toBe(150_000);
  });

  it("skips a statement that is already settled", () => {
    const { allocations } = suggestAllocation(50_000, [
      target("settled", 0, "2026-01-01"),
      target("open", 50_000, "2026-02-01"),
    ]);
    expect(allocations).toEqual([{ billingStatementId: "open", amount: 50_000 }]);
  });
});

describe("whether an allocation is acceptable", () => {
  const targets = [
    { billingStatementId: "a", balance: 50_000, dueDate: "2026-01-01", number: "AIESBS-1" },
  ];

  it("accepts one that fits", () => {
    expect(checkAllocation(50_000, [{ billingStatementId: "a", amount: 50_000 }], targets).ok).toBe(
      true,
    );
  });

  it("refuses giving out more than the payment carried", () => {
    const check = checkAllocation(30_000, [{ billingStatementId: "a", amount: 50_000 }], targets);
    expect(check.ok).toBe(false);
    expect(check.errors.join(" ")).toMatch(/more than the payment/);
  });

  /** Overpaying a statement would show a negative balance, which reads as a credit nobody has. */
  it("refuses putting more on a statement than it is owed", () => {
    const check = checkAllocation(80_000, [{ billingStatementId: "a", amount: 80_000 }], targets);
    expect(check.ok).toBe(false);
    expect(check.errors.join(" ")).toMatch(/cannot be overpaid into credit/);
  });

  it("refuses an allocation to a statement that is not open", () => {
    expect(
      checkAllocation(10_000, [{ billingStatementId: "ghost", amount: 10_000 }], targets).ok,
    ).toBe(false);
  });
});

describe("whether the money has actually arrived", () => {
  it("counts a bank transfer immediately", () => {
    expect(isCollected({ method: "bank_transfer" })).toBe(true);
  });

  /**
   * §3.3: "A received PDC is *not* collected cash." Counting it early overstates collections and
   * issues a BIR document against money that may bounce.
   */
  it("does not count a cheque until it clears", () => {
    expect(isCollected({ method: "check" })).toBe(false);
    expect(isCollected({ method: "check", clearedAt: new Date() })).toBe(true);
  });

  it("stops counting one that bounced", () => {
    expect(isCollected({ method: "check", clearedAt: new Date(), bouncedAt: new Date() })).toBe(
      false,
    );
  });
});

describe("what a statement's status should be", () => {
  const base = { total: 100_000, dueDate: "2099-01-01", status: "issued" };

  it("is paid once the full amount is in", () => {
    expect(statementStatusFor({ ...base, amountPaid: 100_000 })).toBe("paid");
  });

  it("is partially paid on something less", () => {
    expect(statementStatusFor({ ...base, amountPaid: 40_000 })).toBe("partially_paid");
  });

  it("is overdue past the due date, even with something paid", () => {
    expect(statementStatusFor({ ...base, dueDate: "2020-01-01", amountPaid: 40_000 })).toBe(
      "overdue",
    );
  });

  /** Paid in full stays paid, whatever the date — a settled bill is not overdue. */
  it("does not call a settled statement overdue", () => {
    expect(statementStatusFor({ ...base, dueDate: "2020-01-01", amountPaid: 100_000 })).toBe(
      "paid",
    );
  });

  it("leaves a cancelled or written-off statement alone", () => {
    expect(statementStatusFor({ ...base, amountPaid: 0, status: "cancelled" })).toBe("cancelled");
    expect(statementStatusFor({ ...base, amountPaid: 0, status: "written_off" })).toBe(
      "written_off",
    );
  });
});

describe("ageing", () => {
  const now = new Date("2026-06-30T00:00:00.000Z");

  it("puts a bill not yet due in current", () => {
    expect(ageingBucket("2026-07-15", now)).toBe("current");
  });

  it("buckets by how long it has been overdue", () => {
    expect(ageingBucket("2026-06-15", now)).toBe("1-30");
    expect(ageingBucket("2026-05-15", now)).toBe("31-60");
    expect(ageingBucket("2026-04-15", now)).toBe("61-90");
    expect(ageingBucket("2026-01-15", now)).toBe("90+");
  });

  it("is correct across a year boundary", () => {
    expect(ageingBucket("2025-12-20", new Date("2026-01-10T00:00:00.000Z"))).toBe("1-30");
  });

  it("treats the due date itself as current", () => {
    expect(ageingBucket("2026-06-30", now)).toBe("current");
  });
});
