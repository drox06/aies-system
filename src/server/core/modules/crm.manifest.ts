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
    {
      key: "crm.view",
      label: "View CRM records",
      group: "CRM",
      // Technical staff are included because §5 sends them to site: an inspection request is
      // assigned to a technician, and somebody who cannot open the inquiry cannot read the
      // questions the visit is supposed to answer. They do **not** get `crm.view_all`, so record
      // scoping still applies — see inquiryScopeWhere, which lets them reach exactly the inquiries
      // they have been assigned an inspection on and nothing else.
      defaultRoles: [...OWNERS_AND_SALES(), "operations_manager", "technician"],
    },
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
      key: "inquiry.assign",
      label: "Assign inquiries to an owner",
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
    {
      key: "principal.appoint",
      label: "Appoint a principal supplier",
      group: "CRM",
      // The company's own instruction, and it matches what the act is: EM runs the pipeline, but
      // appointing commits AIES to represent a manufacturer and is what unlocks quoting from them.
      // See PRINCIPAL_APPOINT_PERMISSION in principal-lifecycle.ts.
      defaultRoles: ["president", "vice_president"],
    },
    {
      key: "principal.correct",
      label: "Correct or delete a principal prospect, outside the normal stage order",
      group: "CRM",
      // The President alone, at the company's request on 2026-08-16 — narrower than appointing,
      // which the Vice President shares. §5c's stage machine has no reverse gear, so a stage entered
      // by mistake is otherwise permanent; this is the way back, and it always writes a reason.
      defaultRoles: ["president"],
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

  /**
   * §8: the inquiry mirrors its quotation's outcome.
   *
   * `quotation.sent` is wired now that module 02 emits it. `quotation.accepted` and
   * `quotation.rejected` follow when module 02's negotiation flow emits them — the registry rejects
   * a subscription to an event no module emits, which is the boot-time check that keeps this
   * honest rather than a list of hopeful strings.
   *
   * `sales_order.goods_delivered` is wired as of module 04 §13, and closes half of §3's last open
   * transition. See the handler for which half, and why the other one cannot be closed yet.
   */
  consumes: [
    {
      event: "quotation.sent",
      // Dynamically imported so registering the manifest does not pull Prisma into every consumer
      // of manifests.ts, including prisma/seed.ts and the nav tests.
      handler: async (payload) => {
        const { inquiryId } = payload as { inquiryId?: string | null };
        if (!inquiryId) return;

        const { transitionInquiryService } = await import("@/server/core/crm/inquiry-service");
        try {
          await transitionInquiryService(
            { actorId: "system", actorLabel: "System (quotation sent)" },
            // §3: `quoted` is set by the quotation's outcome, never by hand. This is the only
            // caller allowed to pass bySystem, and the router deliberately cannot.
            { inquiryId, to: "quoted", bySystem: true },
          );
        } catch (error) {
          // The inquiry may legitimately not be in `quoting` — somebody disqualified it, or a
          // second revision was sent after it already moved. The quotation is still sent either
          // way, and throwing here would dead-letter a job whose real work is done.
          console.warn(
            `[crm] quotation.sent could not move inquiry ${inquiryId} to quoted:`,
            error instanceof Error ? error.message : error,
          );
        }
      },
    },
    {
      /**
       * §3's `po_received → won`, for the deals where "won" is now decidable.
       *
       * A received PO is not a won deal — module 01 made that call deliberately, against module 03
       * §7's shorter reading, because the work still has to be performed. This is the event that
       * says it has been.
       *
       * **Only for supply-only orders.** An order with execution lines is not finished when the
       * goods arrive; somebody still has to install and commission them, and §12's close-out is what
       * says that happened. That half cannot be wired yet: `executionStatus` is set to `pending`
       * when tickets are generated and nothing in the platform ever moves it off, so there is no
       * honest signal to read. Leaving those deals in `po_received` is the correct answer until
       * there is — a deal marked won on delivery of the box, with the installation still owed, would
       * be a false claim in the one report the company reads for its own performance.
       */
      event: "sales_order.goods_delivered",
      handler: async (payload) => {
        const { salesOrderId } = payload as { salesOrderId?: string | null };
        if (!salesOrderId) return;

        const { db } = await import("@/lib/db");
        const order = await db.salesOrder.findUnique({
          where: { id: salesOrderId },
          select: {
            executionStatus: true,
            quotation: { select: { inquiryId: true } },
          },
        });

        const inquiryId = order?.quotation?.inquiryId;
        if (!inquiryId) return;
        if (order.executionStatus !== "not_required") return;

        const { transitionInquiryService } = await import("@/server/core/crm/inquiry-service");
        try {
          await transitionInquiryService(
            { actorId: "system", actorLabel: "System (goods delivered)" },
            { inquiryId, to: "won", bySystem: true },
          );
        } catch (error) {
          // Same tolerance as `quotation.sent` above: the inquiry may have been disqualified, or
          // this may be the second delivery on an order already marked won. The goods still
          // arrived, and dead-lettering a job whose real work is done helps nobody.
          console.warn(
            `[crm] goods_delivered could not move inquiry ${inquiryId} to won:`,
            error instanceof Error ? error.message : error,
          );
        }
      },
    },
  ],

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
      // §6's My Day first: it is the screen a salesperson should open before anything else, and
      // nav order is a statement about what the app thinks the day starts with.
      label: "My day",
      href: "/crm/my-day",
      icon: "sun",
      permission: "crm.view",
      order: 1,
    },
    {
      label: "Pipeline",
      href: "/crm/pipeline",
      icon: "columns",
      permission: "crm.view",
      group: "Sales",
      order: 10,
    },
    {
      label: "Accounts",
      href: "/crm/accounts",
      icon: "building",
      permission: "crm.view",
      group: "Customers",
      order: 20,
    },
    {
      label: "Inquiries",
      href: "/crm/inquiries",
      icon: "inbox",
      permission: "crm.view",
      group: "Sales",
      order: 11,
    },
    {
      label: "Accreditations",
      href: "/crm/accreditations",
      icon: "badge-check",
      permission: "accreditation.manage",
      group: "Customers",
      order: 21,
    },
    // The nav entry that stood here (2026-08-17 – 2026-09-01) is gone, not just moved: the company
    // asked for Principals and Suppliers to share one button, and that button is the order
    // module's own "Principals & Suppliers" entry at /suppliers (order.manifest.ts). `/crm/principals`
    // still works as a URL — it redirects rather than 404s — but no longer has its own place in the
    // sidebar. `principal_prospect.manage` still gates every principal procedure; it just isn't a
    // nav permission by itself anymore.
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
