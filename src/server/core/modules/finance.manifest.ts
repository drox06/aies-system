import { defineManifest } from "@/server/core/module-registry";

/**
 * Module 05 — Finance, Billing and Collections (specs/05-finance-billing.md).
 *
 * §1 draws the boundary before anything else: this module does **not** build double-entry
 * accounting. No chart of accounts, no journals, no trial balance. It builds the billing and
 * collection workflow the company's actual process needs, and exports to whoever keeps the books.
 *
 * ## Session 1's scope
 *
 * §2 only: the billing schedule and the milestone triggers. That is the piece the rest of the module
 * hangs from, and it is where §2 locates the problem the platform exists to solve —
 *
 * > Finance never has to ask operations whether a project is done.
 *
 * §3's two-document model (billing statement vs service invoice) is the next session and is the more
 * delicate half: AIES issues a Service Invoice **upon payment**, so getting it wrong creates a VAT
 * liability on money that has not arrived.
 *
 * ## Permissions are declared in the session that gates something with them
 *
 * The same rule module 03's manifest follows, and enforced by `permissions-are-used.test.ts`.
 * Declaring §10's full list up front would put entries in the admin role screen that grant access to
 * nothing (docs/DECISIONS.md #52).
 *
 * §10 is emphatic about the defaults, and it is right: "Money is the most sensitive data in the
 * system. Default every finance permission to **off**." So nothing here defaults to a manager role
 * except where the spec names one — the president and vice-president hold approval and cost, the
 * finance officer holds the day-to-day billing work, and everybody else gets nothing until somebody
 * grants it deliberately.
 */
export const financeManifest = defineManifest({
  key: "finance",
  name: "Finance",
  version: "0.1.0",

  models: ["BillingSchedule", "BillingMilestone"],

  permissions: [
    {
      key: "finance.view",
      label: "See the finance screens",
      group: "Finance",
      // The finance officer's job, and the two officers who answer for the numbers. Deliberately not
      // the operations or marketing managers: §10 says every finance permission starts off, and
      // "can see what we have billed" is not something an operations manager needs to do their job.
      defaultRoles: ["president", "vice_president", "finance_officer"],
    },
    {
      key: "billing_statement.create",
      label: "Raise a billing statement",
      group: "Finance",
      // Whoever holds this is who the "ready to bill" notification reaches — see
      // billing-service.ts's notifyFinance. The two are the same list on purpose: a notification to
      // somebody who cannot act on it is noise, and an actionable list nobody is told about is a
      // list nobody reads.
      defaultRoles: ["president", "vice_president", "finance_officer"],
    },
    {
      key: "billing_schedule.manage",
      label: "Plan how an order will be billed",
      group: "Finance",
      /**
       * Separate from `billing_statement.create` because it is a different decision.
       *
       * Raising a statement bills what the plan already says. Planning *sets* what will be billed and
       * when — including a downpayment that becomes billable the instant it is planned. §2 makes the
       * schedule derive from the payment term, which is a commercial position somebody negotiated, so
       * the people who can change it are the people who negotiate.
       */
      defaultRoles: ["president", "vice_president", "finance_officer"],
    },
  ],

  emits: [
    // A milestone became billable because an event elsewhere in the platform said the work it bills
    // for is done. The payload carries the reason, so whoever raises the bill knows what happened
    // without going to look — which is the point of §2.
    "milestone.ready_to_bill",
  ],

  /**
   * Nothing subscribed yet, and that is a real gap rather than a design.
   *
   * §2's triggers map to `sales_order.goods_delivered`, `ticket.completed`, `tc.completed`,
   * `delivery.dr_signed`, `supplier_po.sent` and `project.closed` — every one of which modules 03 and
   * 04 already emit. `applyTriggerToOrdersService` is the function they call. Wiring them is the
   * first half of session 2, and until it happens only `on_order` fires.
   *
   * Recorded here rather than half-wired, because a subscription that reaches the wrong service is
   * worse than one that does not exist: the milestone would flip and finance would be told, with
   * nothing behind it.
   */
  consumes: [],

  nav: [{ label: "Ready to bill", href: "/finance/billing", icon: "receipt", order: 1 }],
});
