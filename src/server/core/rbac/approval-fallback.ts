/**
 * The automatic approval fallback (Spec.md §4.4). Pure and stateless — module 00 session 4's
 * generic approvals service (ApprovalWorkflow/ApprovalRequest/ApprovalAction) calls this to
 * decide inbox visibility and to stamp decisions; it owns "first decision wins" and the
 * VP-queue-never-clears behavior, which need request state this module doesn't have.
 *
 * Two distinct questions, because the spec draws a real line between them:
 *  - Whose default "Awaiting my approval" inbox shows this request right now? Gated by the
 *    escalation window — only the primary approver, until the window elapses.
 *  - Who is actually allowed to decide it right now? The fallback approver (the President) can
 *    always act immediately on anything, window or not ("no nomination step" — it's not a
 *    delegation someone has to grant, it's standing authority).
 *
 * **The window counts working hours, not wall-clock hours.** Spec.md §4.4 says "24 working hours"
 * and specs/02-quotation.md §12 tests for it by name. This file originally compared wall-clock
 * elapsed time, documented as a deliberate simplification because no working calendar existed;
 * module 01 built one (`src/server/core/calendar/business-days.ts`), so the simplification is now
 * just a bug — a quotation submitted at 5pm Friday would otherwise reach the President's queue on
 * Saturday evening, before anybody has had a working hour to look at it. See docs/DECISIONS.md #29.
 */

import { addBusinessMs, businessMsBetween } from "@/server/core/calendar/business-days";

const HOUR_MS = 60 * 60 * 1000;

export interface ApprovalRuleConfig {
  primaryApproverRole: string;
  fallbackApproverRole: string;
  escalateAfterHours: number;
}

export interface FallbackResolution {
  /** Working hours elapsed since the request — weekends and holidays do not count. */
  elapsedHours: number;
  isFallbackWindowElapsed: boolean;
  /**
   * The instant the window elapses, so a queue can say "the President can act from Tuesday 09:00"
   * rather than leaving the reader to do working-calendar arithmetic in their head.
   */
  fallbackAvailableAt: Date;
  /** Roles whose default "Awaiting my approval" inbox should list this request. */
  inboxRoles: readonly string[];
  /** Roles allowed to decide this request right now. */
  eligibleToDecideRoles: readonly string[];
}

export function resolveApprovalFallback(
  rule: ApprovalRuleConfig,
  requestedAt: Date,
  now: Date = new Date(),
): FallbackResolution {
  const elapsedHours = businessMsBetween(requestedAt, now) / HOUR_MS;
  const isFallbackWindowElapsed = elapsedHours >= rule.escalateAfterHours;

  return {
    elapsedHours,
    isFallbackWindowElapsed,
    fallbackAvailableAt: addBusinessMs(requestedAt, rule.escalateAfterHours * HOUR_MS),
    inboxRoles: isFallbackWindowElapsed
      ? [rule.primaryApproverRole, rule.fallbackApproverRole]
      : [rule.primaryApproverRole],
    // The fallback approver can always act, independent of the window (Spec.md §4.4: "The
    // President can always act immediately, without waiting for the window, on anything.").
    eligibleToDecideRoles: [rule.primaryApproverRole, rule.fallbackApproverRole],
  };
}

/**
 * Whether a decision made by `decidingRole` under `rule` must be stamped as a fallback approval.
 * Based on who decided, not on elapsed time — the President can act before the window elapses
 * and that is still a fallback decision, since it wasn't the primary approver who decided
 * (Spec.md §4.4: "the audit trail must never show a fallback approval as though the VP made it").
 */
export function isFallbackDecision(decidingRole: string, rule: ApprovalRuleConfig): boolean {
  return decidingRole === rule.fallbackApproverRole && decidingRole !== rule.primaryApproverRole;
}
