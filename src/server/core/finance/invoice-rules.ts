/**
 * specs/05-finance-billing.md §3 — the two-document model, as pure functions.
 *
 * ## The fact everything here turns on
 *
 * **AIES issues a Service Invoice upon payment, not upon billing.** §3 says getting this wrong
 * "creates a VAT liability on money that has not arrived", and that is not a figure of speech: VAT
 * becomes payable on the invoice, so an invoice raised at billing time hands the BIR twelve per cent
 * of money the customer has not sent, months before it turns up — if it ever does.
 *
 * So: a billing statement demands money and triggers nothing. A service invoice records that money
 * arrived, and it is the taxable event.
 */

/** §3.3. The rate is a constant rather than a setting because a change to it is a change to the law. */
export const VAT_RATE_PCT = 12;

/** §3.2's ordinary rate for services. Per-account, and overridable — some customers differ. */
export const DEFAULT_EWT_RATE_PCT = 2;

export const VAT_MODES = ["exclusive", "inclusive", "zero_rated", "exempt"] as const;
export type VatMode = (typeof VAT_MODES)[number];

export const VAT_MODE_LABELS: Readonly<Record<VatMode, string>> = {
  exclusive: "VAT added on top",
  inclusive: "VAT already inside the price",
  zero_rated: "Zero-rated",
  exempt: "VAT exempt",
};

export const STATEMENT_TYPES = [
  "downpayment",
  "progress",
  "final",
  "service",
  "credit_note",
] as const;
export type StatementType = (typeof STATEMENT_TYPES)[number];

export const STATEMENT_STATUSES = [
  "draft",
  "issued",
  "partially_paid",
  "paid",
  "overdue",
  "cancelled",
  "written_off",
] as const;
export type StatementStatus = (typeof STATEMENT_STATUSES)[number];

export const PAYMENT_METHODS = ["bank_transfer", "check", "cash", "online", "gcash"] as const;
export type PaymentMethod = (typeof PAYMENT_METHODS)[number];

export const PAYMENT_METHOD_LABELS: Readonly<Record<PaymentMethod, string>> = {
  bank_transfer: "Bank transfer",
  check: "Cheque",
  cash: "Cash",
  online: "Online",
  gcash: "GCash",
};

export interface StatementLineInput {
  description: string;
  /** A string: quantities cross the wire and must not become floats. */
  quantity: string | number;
  /** Integer centavos. */
  unitPrice: number;
  vatable?: boolean;
}

export interface StatementTotals {
  subtotal: number;
  vatAmount: number;
  total: number;
  /** What the lines say is subject to VAT, exempt, and zero-rated — §3.3's invoice breakdown. */
  vatableSales: number;
  vatExemptSales: number;
  zeroRatedSales: number;
  lineTotals: number[];
}

function centavos(value: number, what: string): number {
  if (!Number.isInteger(value)) throw new Error(`${what} must be integer centavos: ${value}`);
  return value;
}

/**
 * What a set of lines comes to, under a VAT mode.
 *
 * ## Inclusive is the one that gets mishandled
 *
 * With `inclusive`, the price the customer sees **already contains** the VAT, so the tax is extracted
 * rather than added: `vat = total − total / 1.12`. Adding 12% to an inclusive price overcharges by
 * twelve per cent, and computing the subtotal as the full amount understates output VAT — one of
 * those errors that is invisible until a BIR examination.
 *
 * `zero_rated` and `exempt` are not the same thing and are reported separately on the invoice, which
 * is why the breakdown is returned rather than a single subtotal.
 */
export function computeStatementTotals(
  lines: readonly StatementLineInput[],
  vatMode: VatMode,
): StatementTotals {
  const lineTotals = lines.map((line) => {
    const quantity = Number(line.quantity);
    if (!Number.isFinite(quantity)) throw new Error(`Not a quantity: ${line.quantity}`);
    return Math.round(centavos(line.unitPrice, "A unit price") * quantity);
  });

  const gross = lineTotals.reduce((sum, amount) => sum + amount, 0);

  if (vatMode === "zero_rated") {
    return {
      subtotal: gross,
      vatAmount: 0,
      total: gross,
      vatableSales: 0,
      vatExemptSales: 0,
      zeroRatedSales: gross,
      lineTotals,
    };
  }

  if (vatMode === "exempt") {
    return {
      subtotal: gross,
      vatAmount: 0,
      total: gross,
      vatableSales: 0,
      vatExemptSales: gross,
      zeroRatedSales: 0,
      lineTotals,
    };
  }

  // Per-line, because a statement can mix vatable and non-vatable lines.
  let vatableGross = 0;
  let exemptGross = 0;
  for (const [index, line] of lines.entries()) {
    if (line.vatable === false) exemptGross += lineTotals[index]!;
    else vatableGross += lineTotals[index]!;
  }

  if (vatMode === "inclusive") {
    // The VAT is already inside `vatableGross`; extract it rather than adding to it.
    const net = Math.round(vatableGross / (1 + VAT_RATE_PCT / 100));
    const vat = vatableGross - net;
    return {
      subtotal: net + exemptGross,
      vatAmount: vat,
      total: gross,
      vatableSales: net,
      vatExemptSales: exemptGross,
      zeroRatedSales: 0,
      lineTotals,
    };
  }

  const vat = Math.round((vatableGross * VAT_RATE_PCT) / 100);
  return {
    subtotal: gross,
    vatAmount: vat,
    total: gross + vat,
    vatableSales: vatableGross,
    vatExemptSales: exemptGross,
    zeroRatedSales: 0,
    lineTotals,
  };
}

/**
 * What the customer will withhold, and what will therefore actually arrive.
 *
 * ## Withholding is computed on the net of VAT, not the gross
 *
 * EWT is a tax on income, and the VAT is not AIES's income — it is collected on the BIR's behalf.
 * Withholding 2% of a VAT-inclusive total over-deducts, and the difference is money AIES never sees
 * and cannot credit. This is the single most common arithmetic error in Philippine billing and it
 * always favours the customer.
 */
export function expectedWithholding(
  totals: { subtotal: number; vatAmount: number; total: number },
  account: { withholdsEWT: boolean; ewtRate: string | number },
): { withholding: number; netCollectible: number } {
  if (!account.withholdsEWT) {
    return { withholding: 0, netCollectible: totals.total };
  }

  const rate = Number(account.ewtRate);
  if (!Number.isFinite(rate) || rate < 0) {
    throw new Error(`Not a withholding rate: ${account.ewtRate}`);
  }

  // The base is sales net of VAT.
  const base = totals.total - totals.vatAmount;
  const withholding = Math.round((base * rate) / 100);
  return { withholding, netCollectible: totals.total - withholding };
}

export interface WithholdingCheck {
  ok: boolean;
  /** Set when what was withheld differs from what the account's setting predicts. */
  message?: string;
}

/**
 * Whether the amount actually withheld matches what was expected.
 *
 * §3.1 step 2: "The system checks it against the expected figure and **flags a mismatch rather than
 * accepting it silently**." Flagged, not refused — the customer's accounting department is the one
 * who decided, and their figure is what arrived whether AIES agrees or not. What must not happen is
 * nobody noticing, because a customer quietly withholding 5% instead of 2% is a standing loss.
 *
 * One peso of tolerance, because both sides round.
 */
export function checkWithholding(
  actual: number,
  expected: number,
  currencyLabel = "PHP",
): WithholdingCheck {
  if (Math.abs(actual - expected) <= 100) return { ok: true };

  const format = (value: number) =>
    `${currencyLabel} ${(value / 100).toLocaleString("en-PH", { minimumFractionDigits: 2 })}`;

  return {
    ok: false,
    message:
      `The customer withheld ${format(actual)}; this account's setting predicts ` +
      `${format(expected)}. Recorded as it arrived — check whether their rate has changed or the ` +
      `account's setting is out of date.`,
  };
}

export interface AllocationTarget {
  billingStatementId: string;
  /** Integer centavos still outstanding on that statement. */
  balance: number;
  dueDate: Date | string;
  number?: string;
}

export interface Allocation {
  billingStatementId: string;
  amount: number;
}

/**
 * Spreads a payment across open statements, oldest due first.
 *
 * §3.1 step 3: "suggested oldest-first, **editable**". A suggestion, not a rule — a customer paying
 * a specific statement says so on the remittance advice, and overriding that would misreport which
 * bill is still open. So this is what the screen offers before somebody changes it.
 *
 * Oldest-first is the right default because it minimises how much of the ageing report is wrong, and
 * because an old unpaid statement is the one that turns into a collections problem.
 */
export function suggestAllocation(
  paymentAmount: number,
  targets: readonly AllocationTarget[],
): { allocations: Allocation[]; unallocated: number } {
  centavos(paymentAmount, "A payment");

  const ordered = [...targets]
    .filter((target) => target.balance > 0)
    .sort((a, b) => new Date(a.dueDate).getTime() - new Date(b.dueDate).getTime());

  const allocations: Allocation[] = [];
  let remaining = paymentAmount;

  for (const target of ordered) {
    if (remaining <= 0) break;
    const amount = Math.min(remaining, target.balance);
    allocations.push({ billingStatementId: target.billingStatementId, amount });
    remaining -= amount;
  }

  return { allocations, unallocated: remaining };
}

export interface AllocationCheck {
  ok: boolean;
  errors: string[];
}

/**
 * Whether an allocation is one the platform will accept.
 *
 * §11 asks that "over-allocation is rejected", and there are two ways to over-allocate: giving out
 * more than the payment carried, and putting more on a statement than it is owed. Both are refused
 * — the second because it would make a statement show a negative balance, which reads as a credit
 * the customer does not have.
 */
export function checkAllocation(
  paymentAmount: number,
  allocations: readonly Allocation[],
  targets: readonly AllocationTarget[],
): AllocationCheck {
  const errors: string[] = [];
  const byId = new Map(targets.map((target) => [target.billingStatementId, target]));

  const allocated = allocations.reduce((sum, allocation) => sum + allocation.amount, 0);
  if (allocated > paymentAmount) {
    errors.push(
      `The allocation comes to more than the payment: ${allocated} centavos against ` +
        `${paymentAmount} received.`,
    );
  }

  for (const allocation of allocations) {
    if (allocation.amount <= 0) {
      errors.push("An allocation of nothing is not an allocation.");
      continue;
    }
    const target = byId.get(allocation.billingStatementId);
    if (!target) {
      errors.push(`Nothing open to allocate to on statement ${allocation.billingStatementId}.`);
      continue;
    }
    if (allocation.amount > target.balance) {
      errors.push(
        `${target.number ?? "That statement"} is owed ${target.balance} centavos and ` +
          `${allocation.amount} was allocated to it. A statement cannot be overpaid into credit.`,
      );
    }
  }

  return { ok: errors.length === 0, errors };
}

/**
 * Whether a payment settles anything yet.
 *
 * §3.3: "A received PDC is *not* collected cash." A cheque dated next month has arrived in the sense
 * that it is in the drawer, and has not arrived in the sense that matters — so it does not settle a
 * statement and it does not issue an invoice until it clears.
 *
 * Everything else settles on receipt: a bank transfer that has landed is money.
 */
export function isCollected(payment: {
  method: string;
  clearedAt?: Date | null;
  bouncedAt?: Date | null;
}): boolean {
  if (payment.bouncedAt) return false;
  if (payment.method === "check") return Boolean(payment.clearedAt);
  return true;
}

/** The status a statement should hold, given what has been paid against it. */
export function statementStatusFor(statement: {
  total: number;
  amountPaid: number;
  /**
   * Withheld tax credited once the 2307 is in hand — settles the statement without being cash.
   *
   * Optional so every existing caller keeps working and reads zero, which is the state of any
   * statement whose customer does not withhold. Added 2026-08-20 with the column.
   */
  amountWithheldCredited?: number;
  dueDate: Date | string;
  status: string;
  now?: Date;
}): StatementStatus {
  if (statement.status === "cancelled" || statement.status === "written_off") {
    return statement.status;
  }
  if (statement.status === "draft") return "draft";

  /*
    Settled is cash plus credited withholding.

    A customer who pays in full and withholds 2% has sent every peso they owe — the rest is with the
    BIR, and the 2307 is how AIES gets it. Judging "paid" on cash alone would leave that statement
    outstanding forever and overstate receivables by the withheld amount on every job.
  */
  const settled = statement.amountPaid + (statement.amountWithheldCredited ?? 0);
  if (settled >= statement.total) return "paid";

  const now = statement.now ?? new Date();
  if (new Date(statement.dueDate).getTime() < now.getTime()) return "overdue";

  return settled > 0 ? "partially_paid" : "issued";
}

/**
 * §5's ageing buckets, run on **billing statements** rather than invoices.
 *
 * §5 is explicit about why: "the invoice only exists once the money is in". Ageing receivables off
 * invoices would report a debt of zero however much is owed, because an unpaid bill has no invoice
 * behind it. It is the kind of mistake that makes a system look healthy precisely when it is not.
 */
export const AGEING_BUCKETS = ["current", "1-30", "31-60", "61-90", "90+"] as const;
export type AgeingBucket = (typeof AGEING_BUCKETS)[number];

export function ageingBucket(dueDate: Date | string, now: Date = new Date()): AgeingBucket {
  const due = new Date(dueDate).getTime();
  const days = Math.floor((now.getTime() - due) / (24 * 60 * 60 * 1000));

  if (days <= 0) return "current";
  if (days <= 30) return "1-30";
  if (days <= 60) return "31-60";
  if (days <= 90) return "61-90";
  return "90+";
}
