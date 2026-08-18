/**
 * Loads every module that registers an approval decision handler.
 *
 * Same mechanism, and the same reason, as `storage/register-checkers.ts`: registration happens as a
 * side effect of importing the owning module, and **nothing guarantees that import has happened**
 * on a serverless route whose bundle does not include that module. The approvals router imports the
 * registry and nothing else, so without this barrel the map would be empty and every decision from
 * the global inbox would be refused as an unregistered type.
 *
 * Refusing is the safe failure — nothing gets stranded — but it is still a broken screen, so the
 * barrel exists to make sure it never happens.
 *
 * **Add a line here when a module registers a new approval type.**
 * `approval-decision-registration.test.ts` asserts that every entity type with an approval workflow
 * has a handler, so forgetting is a red test rather than a VP who cannot approve anything.
 */

import "@/server/core/operations/cash-advance-service";
import "@/server/core/order/supplier-po-approval";
import "@/server/core/quotation/approval-service";

export const APPROVAL_DECISION_HANDLERS_REGISTERED = true;
