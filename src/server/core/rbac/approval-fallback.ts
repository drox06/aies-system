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
 * Working-hours note: `escalateAfterHours` is compared against wall-clock elapsed hours, not a
 * working-calendar-aware count. Spec.md §10 calls out that cash advance/SLA clocks should count
 * working days once the working-calendar setting exists; that setting isn't built yet (module 00
 * session 5+), so this is a deliberate simplification — see docs/DECISIONS.md.
 */

export interface ApprovalRuleConfig {
  primaryApproverRole: string;
  fallbackApproverRole: string;
  escalateAfterHours: number;
}

export interface FallbackResolution {
  elapsedHours: number;
  isFallbackWindowElapsed: boolean;
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
  const elapsedHours = Math.max(0, (now.getTime() - requestedAt.getTime()) / (1000 * 60 * 60));
  const isFallbackWindowElapsed = elapsedHours >= rule.escalateAfterHours;

  return {
    elapsedHours,
    isFallbackWindowElapsed,
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
