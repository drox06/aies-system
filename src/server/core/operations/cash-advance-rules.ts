/**
 * Cash advance rules (specs/04-operations-projects.md §5).
 *
 * Pure — no Prisma, no node builtins — so the screen shows exactly what the server enforces. On
 * `UI_SAFE_SERVER_MODULES` in eslint.config.mjs, same split as ticket-rules.ts.
 *
 * §5 explains why any of this is modelled at all, and the sentence is worth keeping in front of
 * whoever changes this file: the constraint is "**currently invisible to everyone until a
 * technician can't board a bus**". Everything here exists to make it visible earlier — the gate
 * before mobilization, the deadline counted on the working calendar, and a register that can tell
 * an extension apart from being late.
 */

import { addBusinessDays } from "@/server/core/calendar/business-days";

export const CASH_ADVANCE_ENTITY_TYPE = "CashAdvance";
export const CASH_ADVANCE_DOCUMENT_TYPE = "cash_advance";

/** The approval rule key module 00 seeded, with §5's four-working-hour fallback window. */
export const CASH_ADVANCE_APPROVAL_RULE = "cash_advance.approve";
/** Requesting an extension routes through its own rule, seeded with a 24-hour window. */
export const CASH_ADVANCE_EXTENSION_RULE = "cash_advance.approve_extension";

/**
 * Seeing advances that are not your own.
 *
 * Gates the register *and* the record, not merely the nav entry. A permission that only hides a
 * menu item is not a control — the URL is still there to type — and the permission audit test
 * (tests/server/core/modules/permissions-are-used.test.ts) is what caught it being used that way.
 */
export const CA_REGISTER_PERMISSION = "cash_advance.view_register";

/**
 * §5's eight categories, verbatim.
 *
 * A closed list rather than free text because the liquidation is reconciled against the request
 * category by category, and module 09 reports on them. "Fuel" and "gas" as two spellings of one
 * thing is how a cost report stops being addable.
 */
export const CASH_ADVANCE_CATEGORIES = [
  "transport",
  "fuel",
  "meals",
  "accommodation",
  "tolls_and_parking",
  "permits_and_gate_passes",
  "consumables",
  "contingency",
] as const;

export type CashAdvanceCategory = (typeof CASH_ADVANCE_CATEGORIES)[number];

export const CATEGORY_LABELS: Record<CashAdvanceCategory, string> = {
  transport: "Transport",
  fuel: "Fuel",
  meals: "Meals",
  accommodation: "Accommodation",
  tolls_and_parking: "Tolls and parking",
  permits_and_gate_passes: "Permits and gate passes",
  consumables: "Consumables",
  contingency: "Contingency",
};

/** §5's release methods. Recorded because "the money was released" and "how" are different audits. */
export const RELEASE_METHODS = ["cash", "bank_transfer", "gcash", "petty_cash"] as const;
export type ReleaseMethod = (typeof RELEASE_METHODS)[number];

export const RELEASE_METHOD_LABELS: Record<ReleaseMethod, string> = {
  cash: "Cash",
  bank_transfer: "Bank transfer",
  gcash: "GCash",
  petty_cash: "Petty cash",
};

/** §5's status vocabulary, in the order an advance moves through it. */
export const CASH_ADVANCE_STATUSES = [
  "draft",
  "pending_approval",
  "approved",
  "rejected",
  "released",
  "partially_liquidated",
  "liquidated",
  "overdue_liquidation",
  "extended",
] as const;

export type CashAdvanceStatus = (typeof CASH_ADVANCE_STATUSES)[number];

/**
 * Statuses where money is out of the company and not yet accounted for.
 *
 * This is the set the register counts and the set that blocks a new request. `extended` is in it —
 * an extension moves the deadline, it does not settle the advance. That distinction is the whole
 * point of §5's warning that "an indefinitely extendable deadline becomes no deadline unless the
 * extension itself is visible and counted".
 */
export const OUTSTANDING_STATUSES: readonly CashAdvanceStatus[] = [
  "released",
  "partially_liquidated",
  "overdue_liquidation",
  "extended",
];

/** Editable only in draft: once the VP is looking at it, an edit changes what they are approving. */
export function isCashAdvanceEditable(status: string): boolean {
  return status === "draft";
}

// ---- §1's Gate 1 --------------------------------------------------------------------------------

export type CaGateState = "not_required" | "satisfied" | "blocked";

export interface CashAdvanceGate {
  state: CaGateState;
  /** True when the crew may not mobilize without an override. */
  blocks: boolean;
  /** Shown on the ticket header, so nobody discovers this at the bus terminal. */
  message: string;
}

/**
 * §5: "If `cashAdvanceRequired` is true, the ticket status is `cash_advance_pending` and
 * **mobilization is blocked** until the advance reaches `released`."
 *
 * Note the word: **released**, not approved. An approved advance the finance officer has not handed
 * over is money the technician does not have, and §5's whole complaint is about the gap between a
 * decision and cash in a pocket. Approving is not releasing, and this gate does not treat them as
 * the same thing.
 *
 * `advances` is every advance on the ticket, not one — §5 allows a project-level advance covering
 * several tickets and a top-up on top of the first, so the question is whether *any* released
 * advance covers this crew, not whether the newest one happens to be released.
 *
 * ## Why this returns a verdict instead of throwing
 *
 * Mobilization is §8's, and §8 does not exist. Built now and inert, exactly as module 03's
 * downpayment gate was: the ticket screen shows the verdict from today, and §8 calls this same
 * function rather than writing a second, subtly different answer to the same question.
 */
export function cashAdvanceGate(
  ticket: { cashAdvanceRequired: boolean },
  advances: readonly { status: string }[],
): CashAdvanceGate {
  if (!ticket.cashAdvanceRequired) {
    return {
      state: "not_required",
      blocks: false,
      // §3 explains why the flag is a boolean and not an absence: somebody answered "no", and that
      // answer is a decision worth showing back to them.
      message: "No cash advance is needed for this ticket. Nothing is holding up mobilization.",
    };
  }

  const released = advances.some((a) =>
    OUTSTANDING_STATUSES.includes(a.status as CashAdvanceStatus),
  );
  if (released) {
    return {
      state: "satisfied",
      blocks: false,
      message: "The cash advance has been released. The crew can mobilize.",
    };
  }

  // A liquidated advance also clears the gate — the money went out and came back accounted for.
  if (advances.some((a) => a.status === "liquidated")) {
    return {
      state: "satisfied",
      blocks: false,
      message: "The cash advance was released and liquidated. Nothing is holding up mobilization.",
    };
  }

  const pending = advances.find(
    (a) => a.status === "pending_approval" || a.status === "approved" || a.status === "draft",
  );

  return {
    state: "blocked",
    blocks: true,
    message: pending
      ? pending.status === "approved"
        ? "The advance is approved but the money has not been handed over. Mobilization waits on release, not approval."
        : pending.status === "pending_approval"
          ? "The advance is with the Vice President. Mobilization is blocked until it is approved and released."
          : "The advance is still a draft. Submit it — mobilization is blocked until it is released."
      : "This ticket needs a cash advance and none has been requested. Mobilization is blocked until one is released.",
  };
}

// ---- §5's deadline ------------------------------------------------------------------------------

/** §5: "Liquidation is due **3 working days after demobilization**." */
export const LIQUIDATION_WORKING_DAYS = 3;

/**
 * The liquidation deadline, counted on the working calendar.
 *
 * §5 says "counted on the working calendar" rather than in calendar days, and the difference is not
 * pedantry: an advance released on the Thursday before a long weekend is due the following
 * Wednesday, and a system that said Sunday would mark a technician late for not filing paperwork on
 * a holiday. `addBusinessDays` already carries the Philippine holiday list.
 *
 * ## Why this takes a date rather than reading demobilization
 *
 * Demobilization is §8's and does not exist yet. Rather than invent a column §8 will own, the
 * caller passes what it has: today the release records an *expected* end drawn from the ticket's
 * required-by date, and when §8 lands it calls this again with the actual demobilization timestamp
 * and writes the corrected deadline. One function, one definition of "3 working days", two callers.
 */
export function liquidationDueFrom(demobilisedAt: Date): Date {
  return addBusinessDays(demobilisedAt, LIQUIDATION_WORKING_DAYS);
}

// ---- §5's register ------------------------------------------------------------------------------

/**
 * §5: "The register must always distinguish *outstanding*, *formally extended and why*, and *simply
 * late*."
 *
 * Three states rather than a boolean, because the three call for three different actions from the
 * finance officer: wait, note the reason and wait, chase. Collapsing the middle one into either
 * neighbour is how an approved extension turns into an accusation, or how being late turns into
 * nobody noticing.
 */
export type LiquidationState = "not_released" | "settled" | "outstanding" | "extended" | "late";

export interface ExtensionRecord {
  requestedAt: string;
  requestedById: string;
  reason: string;
  newDueAt: string;
  approvedById?: string | null;
  approvedAt?: string | null;
}

export interface LiquidationStanding {
  state: LiquidationState;
  /** The deadline actually in force — the newest approved extension, or the original. */
  dueAt: Date | null;
  /** Negative while there is time left; positive once the deadline has passed. */
  daysOverdue: number;
  /** The reason on the extension in force, so the register can show it without a second query. */
  extensionReason: string | null;
  message: string;
}

/**
 * Where one advance stands, on a given day.
 *
 * `now` is a parameter rather than `Date.now()` so the nightly sweep, the screen and the tests all
 * agree, and so a test for "overdue" does not have to wait three days.
 */
export function liquidationStanding(
  advance: {
    status: string;
    liquidationDueAt: Date | string | null;
    extensions?: unknown;
  },
  now: Date,
): LiquidationStanding {
  if (advance.status === "liquidated") {
    return {
      state: "settled",
      dueAt: null,
      daysOverdue: 0,
      extensionReason: null,
      message: "Liquidated and closed.",
    };
  }

  if (!OUTSTANDING_STATUSES.includes(advance.status as CashAdvanceStatus)) {
    return {
      state: "not_released",
      dueAt: null,
      daysOverdue: 0,
      extensionReason: null,
      message: "No money has gone out, so nothing is owed back.",
    };
  }

  const approved = approvedExtensions(advance.extensions);
  const latest = approved.at(-1) ?? null;

  const original = advance.liquidationDueAt ? new Date(advance.liquidationDueAt) : null;
  const dueAt = latest ? new Date(latest.newDueAt) : original;

  if (!dueAt) {
    // Released without a deadline: possible only if the release path is changed to skip setting one.
    // Reported honestly rather than silently treated as "on time" — an advance nobody has to
    // liquidate is precisely the failure §5 is about.
    return {
      state: "outstanding",
      dueAt: null,
      daysOverdue: 0,
      extensionReason: latest?.reason ?? null,
      message: "Released with no liquidation deadline recorded. Set one — this is not tracked.",
    };
  }

  const overdue = now.getTime() > dueAt.getTime();
  const daysOverdue = Math.floor((now.getTime() - dueAt.getTime()) / 86_400_000);

  if (!overdue) {
    return latest
      ? {
          state: "extended",
          dueAt,
          daysOverdue,
          extensionReason: latest.reason,
          message: `Extended to ${iso(dueAt)} — ${latest.reason}`,
        }
      : {
          state: "outstanding",
          dueAt,
          daysOverdue,
          extensionReason: null,
          message: `Due ${iso(dueAt)}.`,
        };
  }

  return {
    state: "late",
    dueAt,
    daysOverdue,
    extensionReason: latest?.reason ?? null,
    message: latest
      ? `${daysOverdue} day${daysOverdue === 1 ? "" : "s"} past an extended deadline of ${iso(dueAt)}.`
      : `${daysOverdue} day${daysOverdue === 1 ? "" : "s"} overdue. Due was ${iso(dueAt)}.`,
  };
}

/**
 * The approved extensions, oldest first.
 *
 * A requested-but-not-yet-approved extension moves nothing. §5: "Build it as a request → approve
 * record" — so an unapproved row in this array is a person asking, not a deadline that has moved,
 * and reading it as the latter would let anybody extend their own deadline by filing a form.
 */
export function approvedExtensions(raw: unknown): ExtensionRecord[] {
  if (!Array.isArray(raw)) return [];
  return raw
    .filter((e): e is ExtensionRecord => {
      if (!e || typeof e !== "object") return false;
      const rec = e as Partial<ExtensionRecord>;
      return (
        typeof rec.newDueAt === "string" &&
        typeof rec.reason === "string" &&
        typeof rec.approvedAt === "string" &&
        rec.approvedAt.length > 0
      );
    })
    .sort((a, b) => new Date(a.newDueAt).getTime() - new Date(b.newDueAt).getTime());
}

/** The pending extension request, if somebody has asked and nobody has answered. */
export function pendingExtension(raw: unknown): ExtensionRecord | null {
  if (!Array.isArray(raw)) return null;
  const found = raw.find((e) => {
    if (!e || typeof e !== "object") return false;
    const rec = e as Partial<ExtensionRecord>;
    return typeof rec.newDueAt === "string" && !rec.approvedAt;
  });
  return (found as ExtensionRecord | undefined) ?? null;
}

// ---- §5's block on the next advance -------------------------------------------------------------

export interface RequestEligibility {
  allowed: boolean;
  /** The advances standing in the way, so the message can name them rather than just refusing. */
  blockingNumbers: string[];
  message: string;
}

/**
 * §5: "Overdue liquidation blocks that person from requesting a new advance."
 *
 * The one rule in §5 with teeth against a person rather than a document, and the only lever the
 * company has: an unliquidated advance is money already gone, and the sole remaining leverage is
 * the next one. So this is a hard block with no override — deliberately. Every other gate in this
 * build can be overridden by somebody accountable; this one is a matter of the requester's own
 * paperwork, and an override would be the same person routing around themselves.
 *
 * *Late* blocks. *Formally extended* does not — that is what an extension is for, and treating an
 * approved extension as a block would make the approval meaningless.
 */
export function canRequestAdvance(
  openAdvances: readonly {
    number: string;
    status: string;
    liquidationDueAt: Date | string | null;
    extensions?: unknown;
  }[],
  now: Date,
): RequestEligibility {
  const late = openAdvances.filter((a) => liquidationStanding(a, now).state === "late");

  if (late.length === 0) {
    return { allowed: true, blockingNumbers: [], message: "" };
  }

  const numbers = late.map((a) => a.number);
  return {
    allowed: false,
    blockingNumbers: numbers,
    message:
      `${numbers.join(", ")} ${numbers.length === 1 ? "is" : "are"} past the liquidation ` +
      `deadline. Liquidate ${numbers.length === 1 ? "it" : "them"}, or ask the Vice President for ` +
      `an extension, before requesting another advance.`,
  };
}

// ---- money --------------------------------------------------------------------------------------

export interface BreakdownLine {
  category: string;
  description: string;
  /** Centavos. Integer, for the same reason everything else in this build is. */
  amount: number;
}

export interface LiquidationLine {
  date: string;
  category: string;
  description: string;
  /** Centavos. */
  amount: number;
  receiptFileId?: string | null;
  hasOfficialReceipt: boolean;
}

/** Sum of a breakdown, in centavos. */
export function breakdownTotal(lines: readonly { amount: number }[]): number {
  return lines.reduce((sum, line) => sum + Math.round(line.amount), 0);
}

export interface LiquidationTotals {
  /** Centavos. */
  totalSpent: number;
  /** Lines with no BIR official receipt — the ones that will not be deductible. */
  withoutOfficialReceipt: number;
}

/** What one submission of receipts adds up to. Says nothing about whether the advance is settled. */
export function liquidationTotals(lines: readonly LiquidationLine[]): LiquidationTotals {
  return {
    totalSpent: lines.reduce((sum, line) => sum + Math.round(line.amount), 0),
    withoutOfficialReceipt: lines.filter((line) => !line.hasOfficialReceipt).length,
  };
}

export interface Reconciliation {
  /** Money that went out and has neither a receipt against it nor been handed back. Centavos. */
  unaccounted: number;
  /** What the company owes the technician, because they spent more than they were given. */
  balanceReimbursable: number;
  /** Nothing is unaccounted for: every peso is either receipted or back in the drawer. */
  settled: boolean;
}

/**
 * Reconciles an advance against everything filed against it (§5).
 *
 * ## Why `amountReturned` is an input rather than a calculation
 *
 * The obvious version computes the balance to return as `released − spent` and calls the advance
 * settled. That is wrong in a way that would have been invisible: it treats money the technician is
 * still holding as though it were already back in the drawer, so every advance would show as
 * settled the moment any receipt was filed, and §5's `partially_liquidated` would be unreachable.
 *
 * Cash actually handed back is a **fact somebody records**, not a subtraction. So an advance is
 * settled when receipts plus returned cash account for what went out, and until then the remainder
 * is `unaccounted` — which is exactly the number a finance officer is chasing.
 *
 * The two balances stay separate fields rather than one signed number. §5 asks for "**balance to
 * return** or **reimbursement due**", and they are different transactions handled by different
 * people — one is cash coming in, the other is a payment out. A signed column would make "how much
 * is sitting in technicians' pockets" depend on a sign test somebody eventually gets backwards.
 */
export function reconcile(input: {
  /** Centavos actually released. */
  amountReleased: number;
  /** Cumulative receipted spend across every non-rejected liquidation. */
  totalSpent: number;
  /** Cumulative cash handed back. */
  amountReturned: number;
}): Reconciliation {
  const accountedFor = input.totalSpent + input.amountReturned;
  const difference = input.amountReleased - accountedFor;

  return {
    unaccounted: difference > 0 ? difference : 0,
    // Overspend is measured against the release alone: returned cash cannot both come back and be
    // owed out again.
    balanceReimbursable:
      input.totalSpent > input.amountReleased ? input.totalSpent - input.amountReleased : 0,
    settled: difference <= 0,
  };
}

function iso(date: Date): string {
  return date.toISOString().slice(0, 10);
}
