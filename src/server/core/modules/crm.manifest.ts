import { defineManifest } from "@/server/core/module-registry";

/**
 * Module 01 — CRM and Inquiry Intake (specs/01-crm-inquiry.md).
 *
 * This is the first module to declare permissions through a manifest rather than have them
 * hand-written into prisma/seed.ts, which is what the manifest system in §3 exists for. The seed
 * reads `registry.permissions` so these reach the database on `npm run seed`.
 */
export const crmManifest = defineManifest({
  key: "crm",
  name: "CRM & Inquiries",
  version: "0.1.0",
  models: [
    "Account",
    "Site",
    "Contact",
    "Inquiry",
    "InquiryItem",
    "Activity",
    "AccreditationRecord",
    "PrincipalProspect",
  ],

  // specs/01-crm-inquiry.md §9. Default role grants follow §9's two explicit assignments
  // (accreditation → admin_manager, principal prospects → marketing_manager, both also visible to
  // president and vice_president) and Spec.md §4.3 otherwise.
  permissions: [
    { key: "crm.view", label: "View CRM records", group: "CRM", defaultRoles: OWNERS_AND_SALES() },
    {
      key: "crm.view_all",
      label: "View all CRM records, not just their own",
      group: "CRM",
      // Deliberately narrow: without this, §10's scoping test requires salesperson A cannot read
      // salesperson B's inquiry.
      defaultRoles: ["president", "vice_president", "marketing_manager"],
    },
    {
      key: "crm.create",
      label: "Create accounts, contacts and inquiries",
      group: "CRM",
      defaultRoles: OWNERS_AND_SALES(),
    },
    { key: "crm.edit", label: "Edit CRM records", group: "CRM", defaultRoles: OWNERS_AND_SALES() },
    {
      key: "crm.delete",
      label: "Delete CRM records",
      group: "CRM",
      defaultRoles: ["president", "vice_president"],
    },
    {
      key: "crm.merge",
      label: "Merge duplicate accounts",
      group: "CRM",
      // §7's merge repoints every child record and cannot be undone from the UI, so it stays with
      // the two roles that can already delete.
      defaultRoles: ["president", "vice_president"],
    },
    {
      key: "crm.export",
      label: "Export CRM data",
      group: "CRM",
      defaultRoles: ["president", "vice_president", "marketing_manager"],
    },
    {
      key: "inquiry.assign",
      label: "Assign inquiries to an owner",
      group: "CRM",
      defaultRoles: ["president", "vice_president", "marketing_manager"],
    },
    {
      key: "inquiry.disqualify",
      label: "Disqualify an inquiry",
      group: "CRM",
      defaultRoles: ["president", "vice_president", "marketing_manager"],
    },
    {
      key: "inspection.request",
      label: "Raise a site inspection request",
      group: "CRM",
      defaultRoles: OWNERS_AND_SALES(),
    },
    {
      key: "accreditation.manage",
      label: "Manage customer accreditations",
      group: "CRM",
      defaultRoles: ["admin_manager", "president", "vice_president"],
    },
    {
      key: "principal_prospect.manage",
      label: "Manage principal supplier prospects",
      group: "CRM",
      defaultRoles: ["marketing_manager", "president", "vice_president"],
    },
  ],

  // specs/01-crm-inquiry.md §8.
  emits: [
    "account.created",
    "inquiry.created",
    "inquiry.acknowledged",
    "inquiry.assigned",
    "inquiry.status_changed",
    "inquiry.quoting_started",
    "inquiry.lost",
    "inspection.requested",
    "activity.logged",
    // Not in §8's list, which names no principal event at all — but §5c requires the appointment to
    // convert into a module 03 Supplier "with no re-keying", and a cross-module side effect goes
    // through the event bus by Spec.md §3.6. Declared here because this module owns the emitting
    // record. See docs/DECISIONS.md #22.
    "principal.stage_changed",
    "principal.appointed",
  ],

  // §8 also lists `quotation.sent` / `quotation.accepted` / `quotation.rejected` as consumed, so
  // the inquiry can mirror its quotation's outcome. They are NOT declared here yet: the registry
  // rejects a subscription to an event no module emits (a deliberate boot-time check against
  // typos), and module 02 does not exist. Wire these up when it lands — the subscription belongs
  // to this module, not that one.
  consumes: [],

  /**
   * Only routes that actually exist.
   *
   * The first version of this manifest listed all four CRM sections before any of their pages were
   * built, so the sidebar advertised Inquiries, Accreditations and Principals and every one of them
   * dead-ended on a 404 — which in dev presents as a long pause while Next compiles the not-found
   * page, not as an obvious error. A nav entry is a promise that the route works, and
   * tests/server/core/modules/crm-manifest.test.ts now enforces it.
   *
   * All four sections now have pages. Add the entry in the same change as the page, never before.
   */
  nav: [
    {
      label: "Accounts",
      href: "/crm/accounts",
      icon: "building",
      permission: "crm.view",
      order: 10,
    },
    {
      label: "Inquiries",
      href: "/crm/inquiries",
      icon: "inbox",
      permission: "crm.view",
      order: 11,
    },
    {
      label: "Accreditations",
      href: "/crm/accreditations",
      icon: "badge-check",
      permission: "accreditation.manage",
      order: 12,
    },
    {
      label: "Principals",
      href: "/crm/principals",
      icon: "handshake",
      permission: "principal_prospect.manage",
      order: 13,
    },
  ],
});

/**
 * The roles that do day-to-day CRM work.
 *
 * `sales` is seeded-but-unassigned today (Spec.md §4.2) — nobody holds it yet. It is listed
 * anyway so the grants are already correct on the day AIES hires a salesperson, rather than
 * someone having to remember which permissions to backfill.
 */
function OWNERS_AND_SALES(): string[] {
  return ["president", "vice_president", "marketing_manager", "sales"];
}
