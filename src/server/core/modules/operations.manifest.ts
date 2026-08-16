import { defineManifest } from "@/server/core/module-registry";

/**
 * Module 04 — Operations and Projects (specs/04-operations-projects.md).
 *
 * The largest module in the build: four gates, a delivery lane, an offline-first field application,
 * digital checklists and dispatch scheduling. This manifest declares **session 1 only** — the ticket
 * itself and §4's proposal.
 *
 * §19 lists thirty permissions for the finished module and they are deliberately *not* all here.
 * That is the opposite of the choice module 03 made, and for a reason: module 03's later sessions
 * were days away and a permission appearing later means a role assignment that has to be redone.
 * Module 04's gates are whole sessions each, several of them, and declaring `cash_advance.approve`
 * now would put a permission in every role screen that grants access to nothing at all for weeks.
 * Somebody would assign it, and then wonder why it did nothing.
 */
export const operationsManifest = defineManifest({
  key: "operations",
  name: "Operations",
  version: "0.1.0",
  models: ["Ticket", "TicketSalesOrderLine", "Project"],

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
      key: "ticket.cancel",
      label: "Cancel a ticket",
      group: "Operations",
      defaultRoles: ["president", "vice_president", "operations_manager"],
    },
    {
      key: "project.view",
      label: "View projects",
      group: "Operations",
      defaultRoles: [
        "president",
        "vice_president",
        "operations_manager",
        "admin_manager",
        "sales",
        "finance_officer",
        "technician",
      ],
    },
    {
      key: "project.manage",
      label: "Manage a project's schedule, team and scope",
      group: "Operations",
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
  ],

  /**
   * §18 lists twenty-eight events. One is emitted today.
   *
   * The registry rejects a subscription to an event nothing emits, so declaring the rest now would
   * let a later module subscribe to something that never fires — which fails silently, and is worse
   * than a boot error. Each is declared in the change that emits it.
   */
  emits: ["ticket.generated"],

  /**
   * Nothing yet, and that is §4's rule rather than an omission.
   *
   * The obvious wiring is to subscribe to `sales_order.created` and generate tickets. §4 forbids it:
   * "**Do not auto-generate silently — one PO can legitimately be one ticket or eight, and only a
   * human knows which.**" So the proposal is computed on demand when somebody opens the sales order,
   * and a subscriber here would be a way of quietly doing the thing the spec rules out.
   *
   * `goods.received` and `payment.received` arrive when the gates that read them do.
   */
  consumes: [],

  nav: [
    {
      label: "Tickets",
      href: "/tickets",
      icon: "wrench",
      permission: "ticket.view",
      // After procurement (29) and suppliers (30): a ticket is what a delivered order becomes work.
      order: 40,
    },
  ],
});
