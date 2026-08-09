import { registerFileAccessChecker } from "@/server/core/storage/access";
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
