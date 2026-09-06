/**
 * specs/05-finance-billing.md §5 — collections, as pure functions.
 *
 * Ageing says what is late. This says what to do about it first, and when to have said it.
 */

export type CollectionCycleState = "matured" | "dunning" | "awaiting_timeline" | "closed";

/**
 * docs/DECISIONS.md #188's dunning schedule — the numbers out of EA's own cycle, named so the state
 * machine below reads as her sentence rather than a pile of day counts:
 *
 * *"once billed, maturity is tracked then finance is notified upon maturity, if closing is not done
 * within 5 days, it triggers tracking of due collectibles, notification is sent every week until
 * payment is received. when 2 notifications is sent and still no payment, it opens a when is payment
 * expected prompt, which is filled by admin. 2 days after the set date of expected to receive payment
 * notif is sent to finance and admin again if this is collected. if no payment prompt is opened
 * again, cycle repeats until payment is received."*
 */
export const DUNNING_GRACE_DAYS = 5;
export const DUNNING_WEEKLY_INTERVAL_DAYS = 7;
export const DUNNING_NOTICES_BEFORE_TIMELINE = 2;
export const DUNNING_CHECKPOINT_DAYS_AFTER_PROMISE = 2;

export interface CollectionCycleSnapshot {
  state: CollectionCycleState;
  dueDate: Date;
  balance: number;
  maturedNotifiedAt: Date | null;
  weeklyNotifiedCount: number;
  lastWeeklyNotifiedAt: Date | null;
  expectedPaymentDate: Date | null;
  lastEscalationNotifiedAt: Date | null;
  missedDateCount: number;
}

/** What the sweep should do on this tick — one step, never a batch, so a night that gets interrupted
 *  loses nothing: the next run reads the same snapshot and reaches the same decision. */
export type DunningStep =
  | { action: "close" }
  | { action: "notify_matured" }
  | { action: "start_dunning_and_notify" }
  | { action: "send_weekly_notice"; count: number }
  | { action: "open_timeline_prompt" }
  | { action: "escalate_unfilled_timeline" }
  | { action: "record_missed_date_and_reopen"; missedCount: number }
  | { action: "none" };

const DAY_MS = 24 * 60 * 60 * 1000;
const daysBetween = (from: Date, to: Date) => Math.floor((to.getTime() - from.getTime()) / DAY_MS);
const sameCalendarDay = (a: Date, b: Date) =>
  a.toISOString().slice(0, 10) === b.toISOString().slice(0, 10);

/**
 * One tick of EA's cycle. See the constants above for the schedule and finance-collections.prisma's
 * `CollectionCycle` for the model it reads and the states it moves between.
 *
 * Pure on purpose: the nightly sweep is the only writer of a `CollectionCycle` row, and "what happens
 * next" has to be provably right without a database in front of it — a wrong branch here would either
 * chase a customer who already paid or, worse, go quiet on one who has not. Never mutates its input
 * and never knows what a notification looks like; it names the step, the service sends it.
 */
export function advanceDunningCycle(
  cycle: CollectionCycleSnapshot,
  now: Date = new Date(),
): DunningStep {
  // Paid, at any stage of the cycle, ends it — "until payment is received" is the one condition
  // that overrides every other rule here.
  if (cycle.balance <= 0) return { action: "close" };
  if (cycle.state === "closed") return { action: "none" };

  if (cycle.state === "matured") {
    if (!cycle.maturedNotifiedAt) return { action: "notify_matured" };
    if (daysBetween(cycle.dueDate, now) >= DUNNING_GRACE_DAYS) {
      return { action: "start_dunning_and_notify" };
    }
    return { action: "none" };
  }

  if (cycle.state === "dunning") {
    const since = cycle.lastWeeklyNotifiedAt ?? cycle.dueDate;
    if (daysBetween(since, now) < DUNNING_WEEKLY_INTERVAL_DAYS) return { action: "none" };

    const count = cycle.weeklyNotifiedCount + 1;
    // The Nth reminder that reaches the threshold *is* the moment the prompt opens — one notice
    // carrying both facts, not two separate messages on the same day.
    if (count >= DUNNING_NOTICES_BEFORE_TIMELINE) return { action: "open_timeline_prompt" };
    return { action: "send_weekly_notice", count };
  }

  // awaiting_timeline: either nobody has answered yet, or somebody's answer just came due.
  if (!cycle.expectedPaymentDate) {
    // Once a day, not once a sweep — the sweep can run more than once a night in dev, and the
    // escalation reads as noise the moment it fires twice for the same unanswered day.
    if (!cycle.lastEscalationNotifiedAt || !sameCalendarDay(cycle.lastEscalationNotifiedAt, now)) {
      return { action: "escalate_unfilled_timeline" };
    }
    return { action: "none" };
  }

  const checkpoint = new Date(
    cycle.expectedPaymentDate.getTime() + DUNNING_CHECKPOINT_DAYS_AFTER_PROMISE * DAY_MS,
  );
  if (now.getTime() < checkpoint.getTime()) return { action: "none" };
  // Still unpaid two days past the date somebody promised — the cycle's own repeat. The state stays
  // `awaiting_timeline`; only the date itself resets, waiting for a new one.
  return { action: "record_missed_date_and_reopen", missedCount: cycle.missedDateCount + 1 };
}

export const COLLECTION_ACTIVITY_TYPES = [
  "call",
  "email",
  "visit",
  "letter",
  "promise_broken",
  "note",
] as const;
export type CollectionActivityType = (typeof COLLECTION_ACTIVITY_TYPES)[number];

export const COLLECTION_ACTIVITY_LABELS: Readonly<Record<CollectionActivityType, string>> = {
  call: "Called them",
  email: "Emailed them",
  visit: "Went to see them",
  letter: "Sent a letter",
  promise_broken: "They missed a promised date",
  note: "Note",
};

export const COLLECTION_OUTCOMES = [
  "reached",
  "no_answer",
  "promised",
  "disputed",
  "refused",
  "left_message",
] as const;
export type CollectionOutcome = (typeof COLLECTION_OUTCOMES)[number];

export const COLLECTION_OUTCOME_LABELS: Readonly<Record<CollectionOutcome, string>> = {
  reached: "Spoke to them",
  no_answer: "No answer",
  promised: "Promised a date",
  disputed: "They dispute it",
  refused: "Refused to pay",
  left_message: "Left a message",
};

export function daysOverdue(dueDate: Date | string, now: Date = new Date()): number {
  const days = Math.floor((now.getTime() - new Date(dueDate).getTime()) / (24 * 60 * 60 * 1000));
  return Math.max(0, days);
}

/**
 * §5's ranking: "sorted by amount × days overdue".
 *
 * ## Why the product rather than either alone
 *
 * Sorting by amount puts a ₱2,000,000 bill that went overdue yesterday above a ₱50,000 one nobody
 * has chased in four months — but the first is probably in somebody's payment run and the second has
 * been forgotten. Sorting by age does the opposite and buries the amounts that matter.
 *
 * The product is what a collections person is actually optimising: peso-days of money not in the
 * bank. It is also the number that keeps a small old debt above a large fresh one, which is right —
 * the old one is the one that turns into a write-off.
 */
export function collectionPriority(
  statement: { balance: number; dueDate: Date | string },
  now: Date = new Date(),
): number {
  return statement.balance * daysOverdue(statement.dueDate, now);
}

export interface ChaseSuggestion {
  /** What to do, in the words somebody would use. */
  action: string;
  /** Why now, rather than a generic instruction. */
  because: string;
  urgent: boolean;
}

/**
 * What the next move on a statement should be.
 *
 * ## Why a suggestion rather than an automation
 *
 * §5 asks for reminders, and reminders are automatic. *Chasing* is not — the decision to phone
 * somebody, or to stop phoning and escalate, depends on the relationship and on what they said last
 * time, which is knowledge the person has and the platform does not. So this puts the facts in one
 * sentence and leaves the judgement where it belongs.
 *
 * The one thing it is firm about is a **broken promise**. A customer who said they would pay on the
 * 15th and did not has changed the situation: the polite assumption has been used up, and the next
 * call is a different conversation. That is the case people most often miss, because nothing on a
 * normal ageing report distinguishes it.
 */
export function suggestChase(statement: {
  balance: number;
  dueDate: Date | string;
  lastContactAt?: Date | string | null;
  promisedDate?: Date | string | null;
  now?: Date;
}): ChaseSuggestion {
  const now = statement.now ?? new Date();
  const overdue = daysOverdue(statement.dueDate, now);

  if (statement.promisedDate) {
    const promised = new Date(statement.promisedDate);
    if (promised.getTime() < now.getTime()) {
      return {
        action: "Call them — they missed the date they promised",
        because:
          `They said they would pay by ${promised.toISOString().slice(0, 10)} and did not. ` +
          `That is a different conversation from a first chase.`,
        urgent: true,
      };
    }
    return {
      action: "Leave it until the date they promised",
      because:
        `They have said ${promised.toISOString().slice(0, 10)}. Chasing before then costs ` +
        `goodwill and gains nothing.`,
      urgent: false,
    };
  }

  if (overdue === 0) {
    return {
      action: "Nothing yet",
      because: "Not overdue. The reminder before the due date does this work.",
      urgent: false,
    };
  }

  if (!statement.lastContactAt) {
    return {
      action: overdue > 30 ? "Call them — nobody has chased this at all" : "Send a reminder",
      because:
        overdue > 30
          ? `${overdue} days overdue and no contact recorded. This is the kind of debt that becomes a write-off.`
          : `${overdue} days overdue and no contact recorded.`,
      urgent: overdue > 30,
    };
  }

  const sinceContact = Math.floor(
    (now.getTime() - new Date(statement.lastContactAt).getTime()) / (24 * 60 * 60 * 1000),
  );

  if (sinceContact >= 7) {
    return {
      action: "Chase again",
      because: `Last contact was ${sinceContact} days ago and nothing has arrived.`,
      urgent: overdue > 60,
    };
  }

  return {
    action: "Give it a few days",
    because: `Contacted ${sinceContact} day${sinceContact === 1 ? "" : "s"} ago.`,
    urgent: false,
  };
}

export interface CreditCheck {
  ok: boolean;
  /** The company's exposure if this order goes ahead. */
  exposure: number;
  limit: number | null;
  message?: string;
}

/**
 * §5's credit limit check at order creation: "warn (default) or block (setting)".
 *
 * ## Why the default is a warning
 *
 * A credit limit is a judgement made at a moment, usually months earlier, and the person raising the
 * order often knows something it does not — that the customer has just paid, or that this order is
 * the one funding the overdue one. Blocking by default would mean the platform refusing business the
 * company wants, and the way people deal with that is to raise the limit until it never bites, at
 * which point the control is gone.
 *
 * A warning that names the number, in front of somebody about to commit, is the version that keeps
 * working.
 */
export function checkCreditLimit(input: {
  openReceivables: number;
  newOrderAmount: number;
  creditLimit: number | null;
}): CreditCheck {
  const exposure = input.openReceivables + input.newOrderAmount;

  if (input.creditLimit === null || input.creditLimit <= 0) {
    return { ok: true, exposure, limit: null };
  }

  if (exposure <= input.creditLimit) {
    return { ok: true, exposure, limit: input.creditLimit };
  }

  const pesos = (centavos: number) =>
    `₱${(centavos / 100).toLocaleString("en-PH", { minimumFractionDigits: 2 })}`;

  return {
    ok: false,
    exposure,
    limit: input.creditLimit,
    message:
      `This account already owes ${pesos(input.openReceivables)}. With this order it would owe ` +
      `${pesos(exposure)}, against a credit limit of ${pesos(input.creditLimit)}.`,
  };
}
