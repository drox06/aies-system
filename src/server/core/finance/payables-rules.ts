/**
 * §7's three-way match and payables ageing.
 *
 * §7 is deliberately narrow — "payables (light)", no payment run, no bank integration — and the one
 * thing it does buy is the question that actually costs money: **are we about to pay for something we
 * did not receive, at a price we did not agree?**
 *
 * Doing that by eye across a purchase order, a receiving report and an invoice is exactly where an
 * overcharge survives, because each document is correct on its own and only the comparison is wrong.
 *
 * Pure — no Prisma. On `UI_SAFE_SERVER_MODULES` in eslint.config.mjs.
 */

export const MATCH_KINDS = ["price", "quantity", "no_receipt", "no_order"] as const;
export type MatchKind = (typeof MATCH_KINDS)[number];

export interface MatchFinding {
  kind: MatchKind;
  /** What the order or the receipt says. */
  expected: number;
  /** What the invoice says. */
  actual: number;
  note: string;
}

export interface MatchResult {
  matched: boolean;
  findings: MatchFinding[];
}

/**
 * How much of a difference is worth stopping a payment for.
 *
 * A peso. Not zero, because rounding on a multi-line invoice legitimately lands a centavo or two out
 * and an ERP that disputes every invoice is one whose disputes stop meaning anything. Not larger,
 * because on a ₱1,800 consumable order a "small" tolerance is the whole margin.
 *
 * Deliberately absolute rather than a percentage: a 1% tolerance on a ₱2,000,000 supply order is
 * ₱20,000, which is a sum somebody should have to explain rather than one the system waves through.
 */
export const MATCH_TOLERANCE = 1;

/**
 * PO ↔ goods receipt ↔ supplier invoice.
 *
 * ## What each finding means, and why they are separate
 *
 * - **`price`** — the invoice total does not agree with what was ordered. Usually a price increase
 *   nobody told AIES about, or freight added that was quoted as included.
 * - **`quantity`** — the invoice is for more than was received. The expensive one: goods invoiced
 *   and never delivered are money out for nothing, and it looks identical to a price rise on a
 *   summary screen.
 * - **`no_receipt`** — nothing has been received against this order at all. Not a discrepancy in the
 *   arithmetic sense, and the single most important thing to say before somebody pays.
 * - **`no_order`** — an invoice with no purchase order behind it. §3's clause 8.4 exists to stop AIES
 *   buying from unapproved suppliers, and an invoice with no PO is how that gets bypassed after the
 *   fact. It is reported rather than refused, because the goods may genuinely have arrived and
 *   somebody has to be able to record the liability — but it is never silent.
 *
 * They are kept apart rather than summed into one "difference" because the conversation with the
 * supplier is different in each case, and a single number tells nobody which conversation to have.
 */
export function threeWayMatch(input: {
  invoiceAmount: number;
  /** The order's own total, including freight and duties as §5 of module 03 allocates them. */
  orderTotal: number | null;
  /** Value of what has actually been accepted on goods receipts against this order. */
  receivedValue: number | null;
}): MatchResult {
  const findings: MatchFinding[] = [];

  if (input.orderTotal === null) {
    findings.push({
      kind: "no_order",
      expected: 0,
      actual: input.invoiceAmount,
      note:
        "No purchase order behind this invoice. Clause 8.4 approves suppliers before AIES buys from " +
        "them, and an invoice with no order is how that gets settled after the fact.",
    });
    // Nothing further can be compared — there is no expectation to compare against.
    return { matched: false, findings };
  }

  if (Math.abs(input.invoiceAmount - input.orderTotal) > MATCH_TOLERANCE) {
    findings.push({
      kind: "price",
      expected: input.orderTotal,
      actual: input.invoiceAmount,
      note:
        input.invoiceAmount > input.orderTotal
          ? "The invoice is for more than the order. Ask what changed before paying it."
          : "The invoice is for less than the order — usually a partial delivery, sometimes a credit.",
    });
  }

  if (input.receivedValue === null || input.receivedValue === 0) {
    findings.push({
      kind: "no_receipt",
      expected: 0,
      actual: input.invoiceAmount,
      note: "Nothing has been received against this order yet. Paying now is paying for a promise.",
    });
  } else if (input.invoiceAmount - input.receivedValue > MATCH_TOLERANCE) {
    findings.push({
      kind: "quantity",
      expected: input.receivedValue,
      actual: input.invoiceAmount,
      note:
        "The invoice is for more than has been received and accepted. Either goods are still to " +
        "come, or AIES is being billed for something that never arrived.",
    });
  }

  return { matched: findings.length === 0, findings };
}

export const AGEING_BUCKETS = ["not_due", "1-30", "31-60", "61-90", "90+"] as const;
export type AgeingBucket = (typeof AGEING_BUCKETS)[number];

/**
 * How overdue a supplier invoice is.
 *
 * Mirrors §5's receivables ageing deliberately: the same buckets on both sides of the ledger means
 * "we are owed 400,000 at 60 days and we owe 300,000 at 60 days" is a comparison somebody can make
 * at a glance, which is the whole point of ageing a payables list at all.
 *
 * An invoice with no due date counts as **not due** rather than as overdue. Absent is not late — the
 * supplier may not have stated terms, and treating silence as a demand would put invoices at the top
 * of a chase list on no evidence.
 */
export function payableAgeing(
  dueDate: Date | string | null,
  asOf: Date = new Date(),
): AgeingBucket {
  if (!dueDate) return "not_due";

  const due = new Date(dueDate);
  due.setHours(0, 0, 0, 0);
  const today = new Date(asOf);
  today.setHours(0, 0, 0, 0);

  const days = Math.floor((today.getTime() - due.getTime()) / 86_400_000);
  if (days <= 0) return "not_due";
  if (days <= 30) return "1-30";
  if (days <= 60) return "31-60";
  if (days <= 90) return "61-90";
  return "90+";
}

/**
 * The two figures behind a finding, labelled for the kind of comparison it actually is.
 *
 * ## Why this exists
 *
 * `threeWayMatch` computed `expected` and `actual` on every finding from the first commit, and the
 * payables screen rendered only `note` — throwing both away. So a `quantity` finding read *"the
 * invoice is for more than has been received"* with no indication of how much more, and the comment
 * above that render claimed the opposite. The company asked whether the wording was enough to ring a
 * supplier about; it was not, and the missing part was already sitting in the record.
 *
 * ## Why the labels differ by kind
 *
 * "Expected" means a different document each time, and a generic *expected / actual* pair would be
 * the same mistake as summing the findings into one variance — technically true and useless on the
 * telephone. A price finding compares the **order**; a quantity finding compares the **goods
 * receipt**. Those are two different people to ring.
 *
 * Returns null where there is nothing to compare: `no_receipt` and `no_order` have no expectation,
 * and printing "expected ₱0.00" would invent a comparison that was never made.
 */
export function findingComparison(
  finding: MatchFinding,
): { expectedLabel: string; actualLabel: string; difference: number } | null {
  if (finding.kind === "price") {
    return {
      expectedLabel: "Ordered",
      actualLabel: "Invoiced",
      difference: finding.actual - finding.expected,
    };
  }

  if (finding.kind === "quantity") {
    return {
      expectedLabel: "Received and accepted",
      actualLabel: "Invoiced",
      // The number to quote down the phone: what AIES is being asked to pay for that has not
      // arrived. Positive by construction — `quantity` only fires when the invoice is the larger.
      difference: finding.actual - finding.expected,
    };
  }

  return null;
}
