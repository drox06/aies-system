export type ConditionOperator = ">" | "<" | ">=" | "<=" | "==" | "!=";

export interface ApprovalCondition {
  field: string;
  operator: ConditionOperator;
  value: number;
}

export interface ApprovalStepDef {
  name: string;
  requiredRole?: string;
  requiredPermission?: string;
  specificUserId?: string;
  /** Layers specs/00-foundation.md §4.4's automatic fallback on top of this step — see
   *  src/server/core/rbac/approval-fallback.ts. When set, `requiredRole` is ignored in favor of
   *  the referenced ApprovalRule's own primary/fallback roles. */
  approvalRuleKey?: string;
  /** Step only applies if this evaluates true against the request's entitySnapshot; absent means
   *  the step always applies. */
  condition?: ApprovalCondition;
  /** "parallel": any one eligible approver's decision resolves the step (first decision wins —
   *  same vocabulary as ApprovalRule.escalationMode). "sequential": every eligible approver must
   *  approve; any single rejection rejects the whole request. See docs/DECISIONS.md for why this
   *  is per-step approver unanimity, not concurrent multi-step execution. */
  mode: "parallel" | "sequential";
}

export function evaluateCondition(
  condition: ApprovalCondition | undefined,
  snapshot: Record<string, unknown>,
): boolean {
  if (!condition) return true;

  const raw = snapshot[condition.field];
  if (typeof raw !== "number") return false;

  switch (condition.operator) {
    case ">":
      return raw > condition.value;
    case "<":
      return raw < condition.value;
    case ">=":
      return raw >= condition.value;
    case "<=":
      return raw <= condition.value;
    case "==":
      return raw === condition.value;
    case "!=":
      return raw !== condition.value;
  }
}
