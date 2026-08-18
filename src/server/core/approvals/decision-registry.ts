import type { AuthedUser } from "@/server/core/rbac/types";
import type { ActorMeta } from "@/server/core/crm/account-service";

/**
 * What a decision on an approval request *means* for the record it is about.
 *
 * ## The bug this exists to make impossible
 *
 * The generic inbox at `/approvals` decided approval requests by calling `decideApprovalRequest`
 * and nothing else. That updates the engine's own row — and the engine has no idea that approving a
 * cash advance should release it for payment, or that approving a quotation should let it be
 * issued. So the request went to `approved` and the business record stayed exactly where it was.
 *
 * AIESCA-260127, 2026-08-18: approved from this screen at 14:35:47, advance still
 * `pending_approval` afterwards. Both exits then sealed — approving refused because no request was
 * pending any more, re-submitting refused because it was no longer a draft. The company found it
 * within a day of the screen being used in anger for the first time.
 *
 * It was never a race or a timeout. It is deterministic, and it applied to **every** approval type
 * decided from the inbox: quotations, supplier POs, cash advances, liquidation extensions. Each
 * module had a correct service that did the whole job, and the one screen most likely to be used —
 * the one the notification points at — bypassed all of them.
 *
 * ## Why a registry rather than a switch
 *
 * A `switch` on entity type in the approvals router would invert the dependency and make module 00
 * import every business module. The platform already solved this shape once, for file access
 * (`registerFileAccessChecker`), and the same reasoning applies: modules own their own meaning, the
 * core holds a map, and a barrel guarantees registration has happened before a request is served.
 *
 * ## Failing closed
 *
 * An unregistered entity type is **refused**, not silently decided. The old behaviour was the
 * dangerous default — a decision that half-applied and looked complete. Refusing is loud, recoverable
 * and cannot leave a record stranded. It also means the next module to add an approval type finds
 * out at the first press rather than at the first audit.
 */

export interface ApprovalDecisionContext {
  requestId: string;
  entityId: string;
  approver: AuthedUser;
  actor: ActorMeta;
  decision: "approved" | "rejected";
  comment?: string;
}

/**
 * Applies the decision to the business record **and** the approval request, in one transaction.
 *
 * Handlers are the module's existing service — the same code path the module's own screen uses, so
 * there is exactly one definition of what approving something does. A handler that reimplemented
 * the service would be a second definition, and the second definition is always the one that drifts.
 */
export type ApprovalDecisionHandler = (context: ApprovalDecisionContext) => Promise<unknown>;

const handlers = new Map<string, ApprovalDecisionHandler>();

export function registerApprovalDecisionHandler(
  entityType: string,
  handler: ApprovalDecisionHandler,
): void {
  handlers.set(entityType, handler);
}

export function getApprovalDecisionHandler(
  entityType: string,
): ApprovalDecisionHandler | undefined {
  return handlers.get(entityType);
}

/** Exported for the registration test, which asserts every approval entity type has a handler. */
export function registeredApprovalEntityTypes(): string[] {
  return [...handlers.keys()].sort();
}
