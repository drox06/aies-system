import { registerFileAccessChecker, registerFileManageChecker } from "@/server/core/storage/access";
import { PRINCIPAL_ENTITY_TYPE } from "@/server/core/crm/principal-lifecycle";

/**
 * Who may download a distributor agreement or a principal's price list.
 *
 * Module 00's default is "only the uploader", which would mean EM uploads a price list and nobody
 * else can open it — including the two people who need it most. But this is not the accreditation
 * case either, where read follows the broad `crm.view`: a principal's price list is AIES's *cost*
 * side, and Spec.md §4.3 is explicit that "cost and margin are visible only to `president` and
 * `vice_president`".
 *
 * So the rule is narrower than the rest of CRM on purpose: whoever manages principals (EM, per §9),
 * plus the two roles that already hold `finance.view_cost`. A salesperson with `crm.view` can see
 * that a principal exists and that its price list is current; they cannot open the prices.
 */
registerFileAccessChecker(PRINCIPAL_ENTITY_TYPE, (user) =>
  Promise.resolve(
    user.permissions.has("principal_prospect.manage") || user.permissions.has("finance.view_cost"),
  ),
);

/**
 * Who may take a file back off a prospect.
 *
 * Whoever manages principals, which is narrower than who may read them: `finance.view_cost` is on
 * the read rule so the president and vice-president can open a price list, and being able to read a
 * document is not a reason to be able to remove it from somebody else's record.
 *
 * The company asked for this because of the obvious failure: the wrong PDF gets attached as the
 * distributor agreement, and until now the only remedy was to overwrite it with the right one and
 * leave the wrong one in the bucket, unreferenced and invisible.
 */
registerFileManageChecker(PRINCIPAL_ENTITY_TYPE, (user) =>
  user.permissions.has("principal_prospect.manage"),
);
