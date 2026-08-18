/**
 * specs/04-operations-projects.md §16's hours and field spend, as pure functions.
 *
 * ## Why the four hour buckets stay apart
 *
 * §16 lists `regularHours, overtimeHours, travelHours, standbyHours` as separate columns, and the
 * fourth is the reason. §8 already makes standby a fact the platform records and argues about — a
 * crew waiting at a gate for a permit that never came is a cost, and often one the customer owes.
 * A total that has absorbed it cannot be broken back out when somebody asks three weeks later, and
 * "how much of this was waiting?" is exactly the question that gets asked.
 *
 * ## Why an expense knows about its cash advance
 *
 * §16: "field expenses linked to a cash advance flow into its liquidation automatically." §5's
 * liquidation currently asks somebody to sit down with a pile of receipts and retype what they
 * spent. An expense recorded where it happened, against the advance it came from, is the same fact
 * captured once instead of twice — and the second capture is the one that goes wrong.
 */

// ---- hours ---------------------------------------------------------------------------------------

export const TIMESHEET_STATUSES = ["draft", "submitted", "approved", "rejected"] as const;
export type TimesheetStatus = (typeof TIMESHEET_STATUSES)[number];

export const TIMESHEET_STATUS_LABELS: Record<TimesheetStatus, string> = {
  draft: "Draft",
  submitted: "Waiting for approval",
  approved: "Approved",
  rejected: "Sent back",
};

export interface Hours {
  regularHours: number;
  overtimeHours: number;
  travelHours: number;
  standbyHours: number;
}

/**
 * A day nobody could have worked.
 *
 * Twenty-four is the only bound that is certainly wrong rather than merely unusual. A fourteen-hour
 * day on a shutdown is real and refusing it would teach people to split the day across two records,
 * which is worse than the number being high — the record would then lie about both days.
 */
export const MAX_HOURS_PER_DAY = 24;

export interface HoursCheck {
  ok: boolean;
  errors: string[];
  warnings: string[];
  total: number;
}

export function checkHours(hours: Hours): HoursCheck {
  const errors: string[] = [];
  const warnings: string[] = [];

  const entries: [keyof Hours, string][] = [
    ["regularHours", "regular"],
    ["overtimeHours", "overtime"],
    ["travelHours", "travel"],
    ["standbyHours", "standby"],
  ];

  for (const [key, label] of entries) {
    const value = hours[key];
    if (!Number.isFinite(value) || value < 0) {
      errors.push(`${label} hours cannot be negative.`);
    }
    // Quarter hours. Anything finer is a false precision nobody is measuring on a site.
    if (Number.isFinite(value) && Math.abs(value * 4 - Math.round(value * 4)) > 1e-9) {
      errors.push(`${label} hours go in quarter hours.`);
    }
  }

  const total = totalHours(hours);

  if (total > MAX_HOURS_PER_DAY) {
    errors.push(`That is ${total} hours in one day. Split it across the days it actually covers.`);
  }
  if (total === 0) {
    errors.push("A timesheet with no hours on it records nothing.");
  }
  if (total > 12 && total <= MAX_HOURS_PER_DAY) {
    warnings.push(
      `${total} hours is a long day — worth checking it is right before it is approved.`,
    );
  }
  if (hours.standbyHours > 0 && hours.standbyHours >= hours.regularHours) {
    warnings.push(
      "More standby than work. §8 treats standby as a cost somebody may owe — make sure the cause is " +
        "recorded on the ticket, or it cannot be charged on.",
    );
  }

  return { ok: errors.length === 0, errors, warnings, total };
}

export function totalHours(hours: Hours): number {
  return (
    (hours.regularHours || 0) +
    (hours.overtimeHours || 0) +
    (hours.travelHours || 0) +
    (hours.standbyHours || 0)
  );
}

/** What a week or a ticket cost in hours, with the buckets kept apart. */
export function sumHours(rows: readonly Hours[]): Hours & { total: number } {
  const summed = rows.reduce<Hours>(
    (acc, row) => ({
      regularHours: acc.regularHours + (row.regularHours || 0),
      overtimeHours: acc.overtimeHours + (row.overtimeHours || 0),
      travelHours: acc.travelHours + (row.travelHours || 0),
      standbyHours: acc.standbyHours + (row.standbyHours || 0),
    }),
    { regularHours: 0, overtimeHours: 0, travelHours: 0, standbyHours: 0 },
  );
  return { ...summed, total: totalHours(summed) };
}

// ---- field spend ----------------------------------------------------------------------------------

export const EXPENSE_CATEGORIES = [
  "fuel",
  "toll_parking",
  "meals",
  "accommodation",
  "transport_fare",
  "materials",
  "permit_fees",
  "other",
] as const;
export type ExpenseCategory = (typeof EXPENSE_CATEGORIES)[number];

export const EXPENSE_CATEGORY_LABELS: Record<ExpenseCategory, string> = {
  fuel: "Fuel",
  toll_parking: "Toll and parking",
  meals: "Meals",
  accommodation: "Accommodation",
  transport_fare: "Transport fare",
  materials: "Materials bought on site",
  permit_fees: "Permit and gate fees",
  other: "Other",
};

export const EXPENSE_STATUSES = [
  "draft",
  "submitted",
  "approved",
  "rejected",
  "reimbursed",
] as const;
export type ExpenseStatus = (typeof EXPENSE_STATUSES)[number];

/**
 * Above this, a receipt is required. Integer centavos, so ₱499.
 *
 * A threshold rather than "always", because a ₱20 gate fee with no receipt is a real thing that
 * happens and refusing it means the cost silently goes unrecorded — which is worse for the project's
 * margin than a small unreceipted line somebody can see and question.
 *
 * **₱499 is the company's number**, set 2026-08-18 in answer to the module 04 review. The draft used
 * ₱500, which was mine; theirs is the one that governs what people actually have to photograph.
 */
export const RECEIPT_REQUIRED_ABOVE = 49_900;

export interface ExpenseCheck {
  ok: boolean;
  errors: string[];
  warnings: string[];
}

export function checkExpense(expense: {
  category: string;
  amount: number;
  description?: string | null;
  receiptFileIds?: readonly string[];
}): ExpenseCheck {
  const errors: string[] = [];
  const warnings: string[] = [];

  if (!Number.isInteger(expense.amount) || expense.amount <= 0) {
    errors.push("An expense needs an amount above zero, in whole centavos.");
  }
  if (!(EXPENSE_CATEGORIES as readonly string[]).includes(expense.category)) {
    errors.push(`"${expense.category}" is not one of §16's expense categories.`);
  }
  if (!expense.description?.trim()) {
    errors.push("Say what it was for. A category alone does not survive an audit or an argument.");
  }

  const receipts = expense.receiptFileIds?.length ?? 0;
  if (expense.amount > RECEIPT_REQUIRED_ABOVE && receipts === 0) {
    errors.push(
      `Anything over ${formatPesos(RECEIPT_REQUIRED_ABOVE)} needs its receipt attached before it can ` +
        `be claimed.`,
    );
  }
  if (expense.amount <= RECEIPT_REQUIRED_ABOVE && receipts === 0) {
    warnings.push("No receipt. Fine at this amount, but it will be taken on trust.");
  }

  return { ok: errors.length === 0, errors, warnings };
}

/**
 * §16's automatic flow into §5's liquidation.
 *
 * Only *approved* expenses count. A submitted one is a claim, and letting claims reduce an
 * outstanding advance would mean somebody could clear their own balance by typing — the whole point
 * of §5's liquidation is that a second person agreed.
 */
export function liquidationFromExpenses(expenses: readonly { amount: number; status: string }[]): {
  approved: number;
  pending: number;
  count: number;
} {
  let approved = 0;
  let pending = 0;
  let count = 0;

  for (const expense of expenses) {
    if (expense.status === "approved" || expense.status === "reimbursed") {
      approved += expense.amount;
      count += 1;
    } else if (expense.status === "submitted") {
      pending += expense.amount;
    }
  }

  return { approved, pending, count };
}

/**
 * What is left on an advance once approved expenses are counted.
 *
 * A negative `outstanding` means the person spent more than they were given and is owed the
 * difference — a real and common case, and one a `Math.max(0, …)` would have hidden.
 */
export function advanceStanding(input: {
  released: number;
  expenses: readonly { amount: number; status: string }[];
}) {
  const { approved, pending, count } = liquidationFromExpenses(input.expenses);
  const outstanding = input.released - approved;

  return {
    released: input.released,
    liquidated: approved,
    pending,
    expenseCount: count,
    outstanding,
    /** True when AIES owes the person, rather than the other way round. */
    overspent: outstanding < 0,
  };
}

function formatPesos(centavos: number): string {
  return `₱${(centavos / 100).toLocaleString("en-PH", { minimumFractionDigits: 2 })}`;
}

export const TIMESHEET_ENTITY_TYPE = "Timesheet";
export const FIELD_EXPENSE_ENTITY_TYPE = "FieldExpense";
export const MAINTENANCE_CONTRACT_ENTITY_TYPE = "MaintenanceContract";
