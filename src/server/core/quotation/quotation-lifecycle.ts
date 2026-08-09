/**
 * The quotation lifecycle (specs/02-quotation.md §2's status list, §5's revisions, §6's approval).
 *
 * Pure — no Prisma — so the builder greys out the actions the server would refuse, using the same
 * map the server enforces. Same split as inquiry-lifecycle.ts.
 *
 * §5 states the rule that shapes everything here: **"A `sent` quotation is immutable."** Editing one
 * does not change it; it creates revision n+1 in `draft`, and the prior revision becomes
 * `superseded` when the new one is sent. That is ISO 9001 clause 8.2.4 evidence, and it is the
 * reason `sent` has no edge back to `draft`.
 */

export const QUOTATION_STATUSES = [
  "draft",
  "pending_approval",
  "approved",
  "sent",
  "under_negotiation",
  "accepted",
  "rejected",
  "expired",
  "superseded",
  "cancelled",
] as const;

export type QuotationStatus = (typeof QUOTATION_STATUSES)[number];

/** Nothing moves out of these without creating a new revision. */
export const QUOTATION_TERMINAL_STATUSES: readonly QuotationStatus[] = [
  "accepted",
  "rejected",
  "superseded",
  "cancelled",
];

/** §5's picklist. Free text accompanies it, but the category is what makes revisions reportable. */
export const REVISION_REASONS = [
  "customer_scope_change",
  "price_negotiation",
  "supplier_cost_change",
  "error_correction",
  "validity_extension",
] as const;

export type RevisionReason = (typeof REVISION_REASONS)[number];

interface TransitionDef {
  to: QuotationStatus;
  /**
   * Set by a subscriber reacting to a domain event, never by a person.
   *
   * `accepted` mirrors module 03's `customer_po.received` (§10) and `expired` is the auto-expire job
   * in §7. Both are facts about the world rather than decisions somebody makes in this screen.
   */
  systemOnly?: boolean;
  /** §6: "Approval is required before a quotation can move to `sent`. No exceptions in v1." */
  requiresApproval?: boolean;
}

/**
 * §2's status list as a transition map.
 *
 * The shape worth noticing is what is *missing*: nothing returns to `draft` from `sent`. §5 makes a
 * sent quotation immutable, so the way back is a revision — a new row sharing the base number, not
 * a mutation of the one the customer already has.
 */
export const QUOTATION_TRANSITIONS: Readonly<Record<QuotationStatus, readonly TransitionDef[]>> = {
  draft: [{ to: "pending_approval" }, { to: "cancelled" }],
  // §6: rejection returns it to draft with a mandatory comment.
  pending_approval: [{ to: "approved" }, { to: "draft" }, { to: "cancelled" }],
  approved: [{ to: "sent", requiresApproval: true }, { to: "draft" }, { to: "cancelled" }],
  sent: [
    { to: "under_negotiation" },
    { to: "accepted", systemOnly: true },
    { to: "rejected" },
    { to: "expired", systemOnly: true },
    { to: "superseded", systemOnly: true },
  ],
  under_negotiation: [
    { to: "accepted", systemOnly: true },
    { to: "rejected" },
    { to: "expired", systemOnly: true },
    { to: "superseded", systemOnly: true },
  ],
  accepted: [],
  rejected: [],
  expired: [],
  superseded: [],
  cancelled: [],
};

export interface QuotationTransitionCheck {
  ok: boolean;
  reason?: string;
  definition?: TransitionDef;
}

export function humanQuotationStatus(status: string): string {
  return status.replace(/_/g, " ");
}

export function checkQuotationTransition(
  from: string,
  to: string,
  options: { bySystem?: boolean } = {},
): QuotationTransitionCheck {
  if (from === to) {
    return { ok: false, reason: `This quotation is already ${humanQuotationStatus(to)}.` };
  }
  if (!QUOTATION_STATUSES.includes(to as QuotationStatus)) {
    return { ok: false, reason: `"${to}" is not a quotation status.` };
  }

  const allowed = QUOTATION_TRANSITIONS[from as QuotationStatus];
  if (!allowed) return { ok: false, reason: `"${from}" is not a quotation status.` };

  const definition = allowed.find((t) => t.to === to);
  if (!definition) {
    if (QUOTATION_TERMINAL_STATUSES.includes(from as QuotationStatus)) {
      return {
        ok: false,
        reason:
          `This quotation is ${humanQuotationStatus(from)}. ` +
          `Create a revision rather than reopening it — a sent quotation is immutable.`,
      };
    }
    const options_ = allowed.map((t) => humanQuotationStatus(t.to)).join(", ") || "nothing";
    return {
      ok: false,
      reason: `A ${humanQuotationStatus(from)} quotation can only move to: ${options_}.`,
    };
  }

  if (definition.systemOnly && !options.bySystem) {
    return {
      ok: false,
      reason:
        to === "accepted"
          ? "Acceptance is recorded when the customer's PO arrives, not set by hand."
          : `${humanQuotationStatus(to)} is set by the system, not by hand.`,
    };
  }

  return { ok: true, definition };
}

/** The moves a person may make from here, for building the UI's action list. */
export function quotationTransitionsFrom(status: string): QuotationStatus[] {
  const allowed = QUOTATION_TRANSITIONS[status as QuotationStatus] ?? [];
  return allowed.filter((t) => !t.systemOnly).map((t) => t.to);
}

/**
 * §5: a `sent` quotation is immutable, so editing means revising.
 *
 * Returns true for the statuses whose content may still change. Everything else needs a revision,
 * and the service refuses the edit rather than the UI merely hiding the field — §12: "Sent
 * quotations reject edit attempts at the service layer, not just in the UI."
 */
export function isEditable(status: string): boolean {
  return status === "draft";
}

/** Whether a revision may be created from this status (§5). */
export function isRevisable(status: string): boolean {
  return (
    status === "sent" ||
    status === "under_negotiation" ||
    status === "rejected" ||
    status === "expired"
  );
}
