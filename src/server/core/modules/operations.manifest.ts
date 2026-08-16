import { defineManifest } from "@/server/core/module-registry";

/**
 * Module 04 — Operations and Projects (specs/04-operations-projects.md).
 *
 * The largest module in the build: four gates, a delivery lane, an offline-first field application,
 * digital checklists and dispatch scheduling. Three sessions are in: §4's ticket and proposal, §5's
 * cash advance gate, §6.1's site inspection and §6.2's methodology.
 *
 * §19 lists thirty permissions for the finished module; thirteen are here, because nine gate something.
 * **A permission is declared in the change that uses it** — the same rule `emits` follows, enforced
 * by tests/server/core/modules/permissions-are-used.test.ts. A permission declared ahead of its gate
 * sits in the admin role screen granting access to nothing; somebody assigns it and wonders why
 * nothing happened. docs/DECISIONS.md #52.
 *
 * `cash_advance.approve` and `cash_advance.approve_extension` are **not** here — they are foundation
 * permissions seeded by module 00, which needed them to seed the approval rules with §5's
 * four-working-hour escalation window. Redeclaring either would be a second owner for one key.
 */
export const operationsManifest = defineManifest({
  key: "operations",
  name: "Operations",
  version: "0.1.0",
  models: [
    "Ticket",
    "TicketSalesOrderLine",
    "Project",
    "CashAdvance",
    "CashAdvanceLiquidation",
    "SiteInspection",
    "Methodology",
  ],

  permissions: [
    {
      key: "ticket.view",
      label: "View tickets",
      group: "Operations",
      // Wide: sales is asked when a job is happening, finance bills against it, procurement
      // supplies it. §19 scopes technicians to their own assignments — that is record scoping on
      // top of this, not a narrower grant.
      defaultRoles: [
        "president",
        "vice_president",
        "operations_manager",
        "admin_manager",
        "marketing_manager",
        "sales",
        "finance_officer",
        "technician",
      ],
    },
    {
      key: "ticket.view_all",
      label: "View every ticket, not just their own",
      group: "Operations",
      // §19: "Technicians are scoped to tickets where they are assigned." Kept off the technician
      // grant so that scoping means something.
      defaultRoles: [
        "president",
        "vice_president",
        "operations_manager",
        "admin_manager",
        "finance_officer",
      ],
    },
    {
      key: "ticket.generate",
      label: "Generate tickets from a sales order",
      group: "Operations",
      // §4: "Operations confirms or edits the proposed set before generation." DJ's job, and the
      // two officers as always.
      defaultRoles: ["president", "vice_president", "operations_manager"],
    },
    {
      key: "project.view_cost",
      label: "View a project's contract value, budget and actual cost",
      group: "Operations",
      // §19 is explicit that technicians "see scope, site data, and their own cash advances —
      // **never contract value or margin**". This is the permission that enforces that sentence.
      defaultRoles: ["president", "vice_president", "finance_officer"],
    },
    {
      key: "cash_advance.request",
      label: "Request a cash advance",
      group: "Operations",
      // §5: "The request comes from the assigned team leader or the Operations Manager." Technicians
      // hold it because a team leader is a technician — §19 scopes what they can *see* to their own
      // advances, which is record scoping on top of this rather than a narrower grant.
      defaultRoles: [
        "president",
        "vice_president",
        "operations_manager",
        "technician",
        "admin_manager",
      ],
    },
    {
      key: "cash_advance.release",
      label: "Hand over the money for an approved cash advance",
      group: "Finance",
      // Deliberately **not** the same people who approve. §5 makes release a separate act from
      // approval because the gap between the two is the thing nobody could see; giving one person
      // both would close the gap by hiding it. This is the finance officer's, and PD's, since she
      // runs petty cash.
      defaultRoles: ["president", "finance_officer", "admin_manager"],
    },
    {
      key: "cash_advance.review_liquidation",
      label: "Check the physical receipts and settle a liquidation",
      group: "Finance",
      // §19 names this permission. §5 gives the liquidation a review cycle and it is finance's: the
      // app can record that receipts were filed, but only somebody holding the paper can say a BIR
      // official receipt exists. The VP too, since a five-person company has no clean cover.
      defaultRoles: ["president", "vice_president", "finance_officer", "admin_manager"],
    },
    {
      key: "cash_advance.view_register",
      label: "See every cash advance and what is outstanding",
      group: "Finance",
      // The register is who is holding company money right now. Management and finance; a
      // technician sees their own without this.
      defaultRoles: [
        "president",
        "vice_president",
        "finance_officer",
        "admin_manager",
        "operations_manager",
      ],
    },
    {
      key: "ticket.execute",
      label: "Record field work — site inspections and findings",
      group: "Operations",
      // §19: technicians do the work, so they hold this. The officers and DJ hold it because in a
      // five-person company they go to site too (Spec.md §1.2).
      defaultRoles: [
        "president",
        "vice_president",
        "operations_manager",
        "technician",
        "admin_manager",
      ],
    },
    {
      key: "project.manage",
      label: "Plan a project and sign off its site inspection",
      group: "Operations",
      // §6.1's `approved` state. See INSPECTION_APPROVE_PERMISSION in site-inspection-rules.ts for
      // why an existing §19 key is reused rather than a new `inspection.approve` invented.
      defaultRoles: ["president", "vice_president", "operations_manager"],
    },
    {
      key: "methodology.prepare",
      label: "Write and revise method statements",
      group: "Operations",
      // §19. The people who plan the work; technicians included, because the team leader who will
      // run the job is usually the one who knows how it is actually done.
      defaultRoles: [
        "president",
        "vice_president",
        "operations_manager",
        "technician",
        "admin_manager",
      ],
    },
    {
      key: "methodology.approve",
      label: "Approve a method statement internally, before the client sees it",
      group: "Operations",
      // §6.2's internal sign-off. Deliberately not the technician who wrote it — the whole value of
      // a review is that somebody else read it.
      defaultRoles: ["president", "vice_president", "operations_manager"],
    },
    {
      key: "operations.override_methodology_gate",
      label: "Mobilize before the client has approved the method statement",
      group: "Operations",
      // §6.2: "president and VP only", and logged with a reason.
      defaultRoles: ["president", "vice_president"],
    },
    {
      key: "operations.override_ca_gate",
      label: "Mobilize a crew before the cash advance is released",
      group: "Operations",
      // §5 allows the override "with a log". The two officers only — this is a decision to send
      // people to site on their own money, and it should sit with somebody who can answer for it.
      defaultRoles: ["president", "vice_president"],
    },
  ],

  /**
   * §18 lists twenty-eight events. Seven are emitted today.
   *
   * The registry rejects a subscription to an event nothing emits, so declaring the rest now would
   * let a later module subscribe to something that never fires — which fails silently, and is worse
   * than a boot error. Each is declared in the change that emits it.
   */
  emits: [
    "ticket.generated",
    "cash_advance.requested",
    "cash_advance.released",
    "cash_advance.liquidation_overdue",
    "site_inspection.completed",
    "scope_change.identified",
    "methodology.approved",
  ],

  /**
   * One subscription, and a deliberate absence.
   *
   * **Still absent: `sales_order.created`.** The obvious wiring is to subscribe to it and generate
   * tickets, and §4 forbids exactly that: "**Do not auto-generate silently — one PO can legitimately
   * be one ticket or eight, and only a human knows which.**" The proposal is computed on demand when
   * somebody opens the sales order, and a subscriber here would be a quiet way of doing the thing
   * the spec rules out. `operations-manifest.test.ts` pins its absence by name.
   *
   * `goods.received` and `payment.received` arrive when the gates that read them do.
   */
  consumes: [
    {
      /**
       * specs/01-crm-inquiry.md §5: "Module 04 subscribes and creates a scheduled field task."
       *
       * crm.prisma has carried that promise in a comment since module 01 was built — "when module 04
       * lands it consumes `inspection.requested` and this becomes the request of record with the
       * field task alongside it". This is module 04 landing.
       *
       * Unlike `sales_order.created`, there is no judgement being skipped here: somebody has already
       * decided a site needs visiting and said so on a form. Scheduling the visit they asked for is
       * mechanical, and §5 asks for it in as many words.
       */
      event: "inspection.requested",
      // Dynamically imported so registering the manifest does not pull Prisma into every consumer
      // of manifests.ts — which includes prisma/seed.ts and the nav tests.
      handler: async (payload) => {
        const { scheduleFromInspectionRequest } =
          await import("@/server/core/operations/site-inspection-service");
        await scheduleFromInspectionRequest(
          payload as {
            inspectionRequestId?: string;
            inquiryId?: string;
            siteId?: string | null;
            assignedToId?: string | null;
            dueAt?: string | null;
          },
        );
      },
    },
  ],

  nav: [
    {
      label: "Tickets",
      href: "/tickets",
      icon: "wrench",
      permission: "ticket.view",
      // After procurement (29) and suppliers (30): a ticket is what a delivered order becomes work.
      order: 40,
    },
    {
      label: "Cash advances",
      href: "/cash-advances",
      icon: "wallet",
      // §5's register. Gated on the register permission rather than `cash_advance.request`, so a
      // technician is not given a menu item that shows them one row — their own advances are on
      // their ticket, where they are looking anyway.
      permission: "cash_advance.view_register",
      order: 41,
    },
    {
      label: "Site inspections",
      href: "/inspections",
      icon: "clipboard-check",
      permission: "ticket.execute",
      order: 42,
    },
    {
      label: "Method statements",
      href: "/methodologies",
      icon: "file-text",
      // §6.2's "with the client" view is the one that earns the nav entry — it is what somebody
      // reads before a progress meeting to see whose delay a wait actually was.
      permission: "methodology.prepare",
      order: 43,
    },
  ],
});
