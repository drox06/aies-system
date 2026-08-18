import { describe, expect, it } from "vitest";
import {
  EXPENSE_CATEGORIES,
  MAX_HOURS_PER_DAY,
  RECEIPT_REQUIRED_ABOVE,
  advanceStanding,
  checkExpense,
  checkHours,
  liquidationFromExpenses,
  sumHours,
  totalHours,
} from "@/server/core/operations/timesheet-rules";

/**
 * specs/04-operations-projects.md §16's hours and field spend.
 *
 * The cases that matter here are the ones where a plausible simplification loses a fact somebody
 * later needs: standby folded into a total, an unapproved claim reducing an advance, an overspend
 * clamped to zero.
 */

const hours = (over: Partial<Parameters<typeof checkHours>[0]> = {}) => ({
  regularHours: 8,
  overtimeHours: 0,
  travelHours: 0,
  standbyHours: 0,
  ...over,
});

describe("a day's hours", () => {
  it("accepts an ordinary day", () => {
    const check = checkHours(hours());
    expect(check.ok).toBe(true);
    expect(check.total).toBe(8);
  });

  it("refuses a day nobody could have worked", () => {
    const check = checkHours(hours({ regularHours: 20, overtimeHours: 8 }));
    expect(check.ok).toBe(false);
    expect(check.errors.join(" ")).toMatch(/28 hours in one day/);
    expect(MAX_HOURS_PER_DAY).toBe(24);
  });

  /**
   * A long day on a shutdown is real. Refusing it would teach people to split one day across two
   * records, and then both days lie — worse than a high number somebody can question.
   */
  it("warns about a long day rather than refusing it", () => {
    const check = checkHours(hours({ regularHours: 8, overtimeHours: 6 }));
    expect(check.ok).toBe(true);
    expect(check.warnings.join(" ")).toMatch(/long day/);
  });

  it("refuses an empty sheet, which records nothing", () => {
    const check = checkHours(hours({ regularHours: 0 }));
    expect(check.ok).toBe(false);
    expect(check.errors.join(" ")).toMatch(/records nothing/);
  });

  it("refuses negative hours and anything finer than a quarter", () => {
    expect(checkHours(hours({ travelHours: -1 })).ok).toBe(false);
    expect(checkHours(hours({ travelHours: 1.1 })).ok).toBe(false);
    expect(checkHours(hours({ travelHours: 1.25 })).ok).toBe(true);
  });

  /**
   * §8 treats standby as a cost somebody may owe. A day that was mostly waiting is worth flagging
   * while the cause can still be recorded on the ticket — afterwards it cannot be charged on.
   */
  it("flags a day that was mostly waiting", () => {
    const check = checkHours(hours({ regularHours: 2, standbyHours: 6 }));
    expect(check.ok).toBe(true);
    expect(check.warnings.join(" ")).toMatch(/More standby than work/);
  });
});

describe("adding hours up", () => {
  /**
   * The reason §16 lists four columns rather than a total. "How much of this was waiting?" is asked
   * three weeks later, and a total that absorbed standby cannot answer it.
   */
  it("keeps the four buckets apart while totalling them", () => {
    const summed = sumHours([
      hours({ regularHours: 8, travelHours: 2 }),
      hours({ regularHours: 4, standbyHours: 4 }),
    ]);
    expect(summed.regularHours).toBe(12);
    expect(summed.travelHours).toBe(2);
    expect(summed.standbyHours).toBe(4);
    expect(summed.total).toBe(18);
  });

  it("totals an empty week as zero rather than throwing", () => {
    expect(sumHours([]).total).toBe(0);
    expect(totalHours({ regularHours: 0, overtimeHours: 0, travelHours: 0, standbyHours: 0 })).toBe(
      0,
    );
  });
});

describe("a field expense", () => {
  const expense = (over: Record<string, unknown> = {}) => ({
    category: "fuel",
    amount: 25_000,
    description: "Diesel, Batangas run",
    receiptFileIds: [] as string[],
    ...over,
  });

  it("is the eight categories the platform knows", () => {
    expect(EXPENSE_CATEGORIES).toHaveLength(8);
    expect(checkExpense(expense({ category: "bribes" })).ok).toBe(false);
  });

  it("needs an amount and a description", () => {
    expect(checkExpense(expense({ amount: 0 })).ok).toBe(false);
    expect(checkExpense(expense({ amount: 1.5 })).ok).toBe(false);
    expect(checkExpense(expense({ description: "  " })).ok).toBe(false);
  });

  it("requires a receipt above the threshold and merely notes its absence below", () => {
    const big = checkExpense(expense({ amount: RECEIPT_REQUIRED_ABOVE + 1 }));
    expect(big.ok).toBe(false);
    expect(big.errors.join(" ")).toMatch(/needs its receipt attached/);

    const small = checkExpense(expense({ amount: 2_000 }));
    expect(small.ok).toBe(true);
    expect(small.warnings.join(" ")).toMatch(/taken on trust/);
  });

  it("is satisfied by a receipt", () => {
    expect(checkExpense(expense({ amount: 500_000, receiptFileIds: ["file-1"] })).ok).toBe(true);
  });
});

describe("§16's flow into §5's liquidation", () => {
  /**
   * Only approved expenses reduce an advance. Letting a submitted claim count would mean somebody
   * clears their own balance by typing — and the whole point of §5's liquidation is that a second
   * person agreed.
   */
  it("counts approved expenses and holds submitted ones separately", () => {
    const result = liquidationFromExpenses([
      { amount: 10_000, status: "approved" },
      { amount: 5_000, status: "reimbursed" },
      { amount: 8_000, status: "submitted" },
      { amount: 3_000, status: "rejected" },
      { amount: 1_000, status: "draft" },
    ]);
    expect(result.approved).toBe(15_000);
    expect(result.pending).toBe(8_000);
    expect(result.count).toBe(2);
  });

  it("says what is left on the advance", () => {
    const standing = advanceStanding({
      released: 100_000,
      expenses: [{ amount: 40_000, status: "approved" }],
    });
    expect(standing.liquidated).toBe(40_000);
    expect(standing.outstanding).toBe(60_000);
    expect(standing.overspent).toBe(false);
  });

  /**
   * A technician who spent more than they were given is owed the difference — a real and common
   * case. Clamping the total at zero would hide a debt the company owes a person.
   */
  it("reports an overspend as a negative balance rather than hiding it", () => {
    const standing = advanceStanding({
      released: 50_000,
      expenses: [{ amount: 72_000, status: "approved" }],
    });
    expect(standing.outstanding).toBe(-22_000);
    expect(standing.overspent).toBe(true);
  });

  it("treats an advance with no expenses as fully outstanding", () => {
    const standing = advanceStanding({ released: 30_000, expenses: [] });
    expect(standing.outstanding).toBe(30_000);
    expect(standing.expenseCount).toBe(0);
  });
});
