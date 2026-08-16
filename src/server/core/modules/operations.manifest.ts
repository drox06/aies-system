import { defineManifest } from "@/server/core/module-registry";

/**
 * Module 04 — Operations and Projects (specs/04-operations-projects.md).
 *
 * The largest module in the build: four gates, a delivery lane, an offline-first field application,
 * digital checklists and dispatch scheduling. This manifest declares **session 1 only** — the ticket
 * itself and §4's proposal.
 *
 * §19 lists thirty permissions for the finished module; four are here, because four gate something.
 * **A permission is declared in the change that uses it** — the same rule `emits` follows, enforced
 * by tests/server/core/modules/permissions-are-used.test.ts. `cash_advance.approve` declared now
 * would sit in the admin role screen granting access to nothing for weeks; somebody would assign it
 * and wonder why nothing happened. docs/DECISIONS.md #52.
 */
export const operationsManifest = defineManifest({
  key: "operations",
  name: "Operations",
  version: "0.1.0",
  models: ["Ticket", "TicketSalesOrderLine", "Project", "CashAdvance", "CashAdvanceLiquidation"],

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
      key: "operations.override_ca_gate",
      label: "Mobilize a crew before the cash advance is released",
      group: "Operations",
      // §5 allows the override "with a log". The two officers only — this is a decision to send
      // people to site on their own money, and it should sit with somebody who can answer for it.
      defaultRoles: ["president", "vice_president"],
    },
  ],

  /**
   * §18 lists twenty-eight events. Four are emitted today.
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
  ],

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
  ],
});
