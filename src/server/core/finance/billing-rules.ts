/**
 * specs/05-finance-billing.md §2's billing model, as pure functions.
 *
 * ## What this file is for
 *
 * §2 states the coordination failure the whole module exists to fix:
 *
 * > Finance never has to ask operations whether a project is done — this is the core coordination
 * > failure the platform exists to fix.
 *
 * Which means the important thing is not the arithmetic. It is that **a milestone becomes billable
 * because an event happened**, and the event comes from the module that owns the fact. Finance does
 * not decide that a delivery was signed for; §13 does, and finance reads it.
 *
 * Everything here is pure so the UI can show a schedule before it exists and the service can write
 * the same numbers the screen promised.
 */

/**
 * The events that make a milestone billable, and who fires each one.
 *
 * Every trigger maps to a domain event another module already emits. That is deliberate and it is
 * the difference between a billing schedule and a diary: nothing here is on a timer that hopes the
 * work finished.
 *
 * The one exception is `net_days_after_close`, which is genuinely a clock — but it starts from
 * `project.closed` rather than from nothing, so it is still an event with a delay rather than a date
 * somebody typed.
 */
export const BILLING_TRIGGERS = {
  on_order: "sales_order.created",
  on_supplier_order: "supplier_po.sent",
  on_delivery: "sales_order.goods_delivered",
  on_installation: "ticket.completed",
  on_tc_accepted: "tc.completed",
  on_dr_signed: "delivery.dr_signed",
  on_project_close: "project.closed",
  net_days_after_close: "project.closed",
} as const;

export type BillingTrigger = keyof typeof BILLING_TRIGGERS;

export const BILLING_TRIGGER_LABELS: Readonly<Record<BillingTrigger, string>> = {
  on_order: "When the order is raised",
  on_supplier_order: "When the supplier order goes out",
  on_delivery: "When the goods are delivered",
  on_installation: "When the installation ticket is finished",
  on_tc_accepted: "When the customer accepts commissioning",
  on_dr_signed: "When the delivery receipt is signed",
  on_project_close: "When the project closes",
  net_days_after_close: "A number of days after the project closes",
};

/**
 * Why each trigger is worth having, in the words a person would use.
 *
 * On screen next to the choice, because picking a trigger is a commercial decision and the
 * difference between `on_delivery` and `on_dr_signed` is exactly the kind of thing that looks like a
 * technicality until an unsigned delivery holds up an invoice for a month.
 */
export const BILLING_TRIGGER_NOTES: Readonly<Record<BillingTrigger, string>> = {
  on_order: "A downpayment. Falls due as soon as the order exists, before anything is bought.",
  on_supplier_order:
    "For orders where AIES has to commit money to a principal first. Bills when that commitment is made, not when the goods arrive.",
  on_delivery:
    "When the quantities move. Faster than waiting for a signature, and weaker to argue with.",
  on_installation:
    "The work on site is finished. Use this when the scope is fitting rather than commissioning.",
  on_tc_accepted:
    "The customer's own engineer signed the commissioning certificate. The strongest billing artefact this platform produces.",
  on_dr_signed:
    "Somebody at the customer signed for the goods. Slower than on_delivery and much harder to dispute — the right choice for goods-only orders.",
  on_project_close: "Everything is done and the close-out pack exists.",
  net_days_after_close: "A retention or a payment term that runs from completion.",
};

export const MILESTONE_STATUSES = ["pending", "ready_to_bill", "invoiced", "cancelled"] as const;
export type MilestoneStatus = (typeof MILESTONE_STATUSES)[number];

export interface TermMilestone {
  label: string;
  /** Percentage of the order value. A string, because it crosses the wire and must not be a float. */
  pct: string;
  trigger: BillingTrigger;
  /** Only meaningful for `net_days_after_close`; ignored otherwise. */
  daysAfter?: number;
}

export interface TermCheck {
  ok: boolean;
  errors: string[];
  warnings: string[];
}

/** Parses a percentage without letting a float in through the back door. */
function pct(value: string | number): number {
  const n = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(n)) throw new Error(`Not a percentage: ${JSON.stringify(value)}`);
  return n;
}

/**
 * Whether a set of milestones is a payment term somebody can be billed under.
 *
 * ## Why 100% is an error and not a warning
 *
 * A term whose milestones sum to 90% leaves a tenth of the contract with no milestone to bill it on.
 * Nobody notices until the project closes and the final statement is short — at which point the
 * money is months old and the customer has moved on. There is no reading under which that is
 * acceptable, so it is refused rather than flagged.
 *
 * Over 100% is refused for the mirror reason: billing 110% of a contract is not a rounding problem,
 * it is an invoice the customer will reject and a conversation that costs more than the error.
 */
export function checkTermMilestones(milestones: readonly TermMilestone[]): TermCheck {
  const errors: string[] = [];
  const warnings: string[] = [];

  if (milestones.length === 0) {
    errors.push("A payment term needs at least one milestone, or there is nothing to bill on.");
    return { ok: false, errors, warnings };
  }

  for (const [index, milestone] of milestones.entries()) {
    if (!milestone.label?.trim()) {
      errors.push(`Milestone ${index + 1} has no label. "50%" is not a label; "Downpayment" is.`);
    }
    if (!(milestone.trigger in BILLING_TRIGGERS)) {
      errors.push(`Milestone ${index + 1} has no recognised trigger (${milestone.trigger}).`);
    }
    const value = pct(milestone.pct);
    if (!(value > 0)) {
      errors.push(`Milestone ${index + 1} is ${value}% of the order, which bills nothing.`);
    }
    if (
      milestone.trigger === "net_days_after_close" &&
      !(milestone.daysAfter && milestone.daysAfter > 0)
    ) {
      errors.push(
        `Milestone ${index + 1} bills a number of days after close and does not say how many.`,
      );
    }
  }

  const total = milestones.reduce((sum, milestone) => sum + pct(milestone.pct), 0);
  // Four decimal places is what the column stores, so compare at that precision rather than exactly.
  if (Math.abs(total - 100) > 0.0001) {
    errors.push(
      `The milestones come to ${total.toFixed(4)}% of the order. They have to come to 100% — ` +
        `anything less leaves part of the contract with no milestone to bill it on, and anything ` +
        `more bills the customer for work nobody sold.`,
    );
  }

  const triggers = milestones.map((milestone) => milestone.trigger);
  if (new Set(triggers).size !== triggers.length) {
    // Legal, and worth a word: two milestones on one trigger both become billable at the same
    // instant, which is usually a term somebody meant to write as one milestone.
    warnings.push(
      "Two milestones share a trigger, so both become billable at the same moment. That is allowed, " +
        "but check it is not one milestone written twice.",
    );
  }

  return { ok: errors.length === 0, errors, warnings };
}

export interface PlannedMilestone {
  sequence: number;
  label: string;
  pct: string;
  trigger: BillingTrigger;
  /** Integer centavos. */
  amount: number;
  daysAfter: number | null;
}

/**
 * Splits an order's value across a term's milestones.
 *
 * ## The remainder goes to the last milestone
 *
 * ₱10,000.01 split 50/50 is ₱5,000.005 twice, which does not exist. Rounding each milestone
 * independently loses or invents a centavo, and a schedule whose milestones do not sum to the
 * contract is a schedule that will be short at the end — the same failure as a term summing to 90%,
 * arrived at through arithmetic instead of configuration.
 *
 * So every milestone but the last is rounded, and the last one takes whatever is left. The last
 * milestone is also, by convention and by every seeded term, the one that bills on completion —
 * which is the right place for a centavo of imprecision, because it is the bill somebody checks
 * against the contract total.
 */
export function planMilestones(
  orderTotalCentavos: number,
  milestones: readonly TermMilestone[],
): PlannedMilestone[] {
  if (!Number.isInteger(orderTotalCentavos) || orderTotalCentavos < 0) {
    throw new Error(`Not an order total in centavos: ${orderTotalCentavos}`);
  }

  const planned: PlannedMilestone[] = [];
  let allocated = 0;

  for (const [index, milestone] of milestones.entries()) {
    const isLast = index === milestones.length - 1;
    const amount = isLast
      ? orderTotalCentavos - allocated
      : Math.round((orderTotalCentavos * pct(milestone.pct)) / 100);
    allocated += amount;

    planned.push({
      sequence: index + 1,
      label: milestone.label,
      pct: pct(milestone.pct).toFixed(4),
      trigger: milestone.trigger,
      amount,
      daysAfter:
        milestone.trigger === "net_days_after_close" ? (milestone.daysAfter ?? null) : null,
    });
  }

  return planned;
}

/**
 * The due date for a milestone that has just become billable.
 *
 * `net_days_after_close` is the odd one: its `daysAfter` is a delay before the money is *due*, and
 * the term's own `netDays` then does not apply on top — otherwise "30 days after close, net 30"
 * quietly means sixty.
 */
export function dueDateFor(
  readyAt: Date,
  termNetDays: number,
  milestone: { trigger: BillingTrigger; daysAfter: number | null },
): Date {
  const days =
    milestone.trigger === "net_days_after_close"
      ? (milestone.daysAfter ?? termNetDays)
      : termNetDays;
  const due = new Date(readyAt);
  due.setUTCDate(due.getUTCDate() + days);
  return due;
}

/**
 * Which milestones an arriving event makes billable.
 *
 * Pure, and takes the event name rather than the trigger, because that is what the subscriber has.
 * Matching many triggers to one event is normal: `on_project_close` and `net_days_after_close` both
 * listen to `project.closed` and differ only in when the money is due.
 *
 * **Only `pending` milestones are returned.** §11 asks that a trigger fires "exactly once per event",
 * and the honest way to guarantee that is to make the transition itself the record of having fired —
 * anything already `ready_to_bill`, `invoiced` or `cancelled` has had its turn.
 */
export function milestonesTriggeredBy<T extends { trigger: string; status: string }>(
  eventName: string,
  milestones: readonly T[],
): T[] {
  const triggers = (Object.keys(BILLING_TRIGGERS) as BillingTrigger[]).filter(
    (trigger) => BILLING_TRIGGERS[trigger] === eventName,
  );
  return milestones.filter(
    (milestone) =>
      milestone.status === "pending" && triggers.includes(milestone.trigger as BillingTrigger),
  );
}
