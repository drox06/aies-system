import { db } from "@/lib/db";
import { isFallbackDecision, resolveApprovalFallback } from "@/server/core/rbac/approval-fallback";
import type { AuthedUser } from "@/server/core/rbac/types";
import type { ApprovalStepDef } from "./types";

export interface StepEligibility {
  /** Can this user decide the step right now? */
  isEligibleToDecide: (user: AuthedUser) => boolean;
  /** Should this step show up in this user's default "Awaiting my approval" inbox right now? */
  isInInbox: (user: AuthedUser) => boolean;
  /** Would a decision by this user be a fallback decision (Spec.md §4.4)? */
  isFallbackDecision: (user: AuthedUser) => boolean;
}

export async function resolveStepEligibility(
  step: ApprovalStepDef,
  requestedAt: Date,
  now: Date = new Date(),
): Promise<StepEligibility> {
  if (step.approvalRuleKey) {
    const rule = await db.approvalRule.findUniqueOrThrow({ where: { key: step.approvalRuleKey } });
    const fallback = resolveApprovalFallback(rule, requestedAt, now);

    return {
      isEligibleToDecide: (user) =>
        fallback.eligibleToDecideRoles.some((role) => user.roleKeys.includes(role)),
      isInInbox: (user) => fallback.inboxRoles.some((role) => user.roleKeys.includes(role)),
      isFallbackDecision: (user) => user.roleKeys.some((role) => isFallbackDecision(role, rule)),
    };
  }

  const check = (user: AuthedUser): boolean => {
    if (step.specificUserId) return user.id === step.specificUserId;
    if (step.requiredPermission) return user.permissions.has(step.requiredPermission);
    if (step.requiredRole) return user.roleKeys.includes(step.requiredRole);
    return false;
  };

  return { isEligibleToDecide: check, isInInbox: check, isFallbackDecision: () => false };
}
