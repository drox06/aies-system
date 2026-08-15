import { registerFileAccessChecker, registerFileManageChecker } from "@/server/core/storage/access";

/**
 * Who may see, and who may remove, what a site visit brought back.
 *
 * The entity type is spelled out rather than imported from inspection-service.ts for the reason
 * principal-lifecycle.ts records at length: a checker imported by a service for its registration
 * side effect must not read a constant *from* that service, or the two form a cycle that
 * `next build` reports as "Cannot access 'k' before initialization".
 */
const INSPECTION_ENTITY_TYPE = "InspectionRequest";

/**
 * Read follows `crm.view`, which is deliberately the broadest CRM permission.
 *
 * specs/01-crm-inquiry.md §5's whole point is that a visit answers questions somebody else asked:
 * the technician goes, the salesperson writes the quotation from what came back. Photographs only
 * the uploader can open would leave the person who needs them looking at a filename.
 *
 * Record scoping still applies upstream — a salesperson without `crm.view_all` cannot open an
 * inquiry that is not theirs, so they never reach these files in the first place.
 */
registerFileAccessChecker(INSPECTION_ENTITY_TYPE, (user) => user.permissions.has("crm.view"));

/**
 * Removal is narrower: the person who took the photograph, or somebody who can edit CRM records.
 *
 * A technician standing in a plant will upload the wrong shot and needs to fix it without ringing
 * the office, which the module 00 default (uploader only) already allows. `crm.edit` is added
 * because the salesperson writing the quotation is the one who notices that four of the eleven
 * photographs are of the wrong skid.
 */
registerFileManageChecker(
  INSPECTION_ENTITY_TYPE,
  (user, file) => file.uploaderId === user.id || user.permissions.has("crm.edit"),
);
