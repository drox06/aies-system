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

  models: [
    "BillingSchedule",
    "BillingMilestone",
    "BillingStatement",
    "CollectionActivity",
    "CollectionReminder",
    "BillingStatementLine",
    "ServiceInvoice",
    "Payment",
    "PaymentAllocation",
  ],

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
    {
      key: "billing_statement.issue",
      label: "Send a billing statement to a customer",
      group: "Finance",
      // Separate from drafting one. Drafting is arithmetic somebody can check; issuing creates a
      // receivable and puts a demand in front of a customer, which is the act with consequences.
      defaultRoles: ["president", "vice_president", "finance_officer"],
    },
    {
      key: "payment.record",
      label: "Record a payment received",
      group: "Finance",
      /**
       * The heaviest permission in this module, and it does not look it.
       *
       * §3.1: recording a payment **issues a BIR document**. Whoever holds this can create a service
       * invoice, and a service invoice is a declaration to the government that a sale happened. It is
       * not a bookkeeping note and it is not reversible by deleting anything.
       */
      defaultRoles: ["president", "vice_president", "finance_officer"],
    },
    {
      key: "invoice.cancel",
      label: "Cancel a service invoice",
      group: "Finance",
      // The officers only. A cancelled BIR document is retained forever with its reason attached,
      // and the reason is the company's answer if anybody asks about the gap in the series.
      defaultRoles: ["president", "vice_president"],
    },
    {
      key: "finance.override_billing_gate",
      label: "Raise a final statement before the work is signed off",
      group: "Finance",
      /**
       * §4 names the holders: "the president and vice president only".
       *
       * The gate's seven conditions are the things a customer can point at when disputing a final
       * bill, so setting them aside is a commercial risk rather than an administrative shortcut —
       * and the reason it demands is what AIES has to stand on if the dispute comes.
       */
      defaultRoles: ["president", "vice_president"],
    },
    {
      key: "payables.manage",
      label: "Record and approve supplier bills",
      group: "Finance",
      /*
        §7 does not build a payment run, so this is "cleared to pay" rather than "paid" — but it is
        still the act that lets money leave, and the override on a failed three-way match sits behind
        it. Held where the other money permissions are held.
      */
      defaultRoles: ["president", "vice_president", "finance_officer"],
    },
    {
      key: "pnl.view",
      label: "See project profitability",
      group: "Finance",
      /*
        Narrow, and narrower than most finance permissions.

        A project P&L shows labour cost, and labour cost divided by hours is close enough to what
        somebody is paid that treating it as an ordinary report would leak pay across the company.
        §6 gates this explicitly. Operations managers are deliberately out: they own the job, not
        its margin, and the number they would act on — budget against actual hours — is on the
        ticket already.
      */
      defaultRoles: ["president", "vice_president", "finance_officer"],
    },
    {
      key: "ar.view",
      label: "See what customers owe",
      group: "Finance",
      defaultRoles: ["president", "vice_president", "finance_officer"],
    },
  ],

  emits: [
    // A milestone became billable because an event elsewhere in the platform said the work it bills
    // for is done. The payload carries the reason, so whoever raises the bill knows what happened
    // without going to look — which is the point of §2.
    "milestone.ready_to_bill",
    // §3's two documents and the money between them.
    "billing_statement.issued",
    "payment.received",
    "payment.cleared",
    "service_invoice.issued",
    "billing_statement.overdue",
  ],

  /**
   * §2's triggers, wired to the events the platform actually emits.
   *
   * Every handler is dynamically imported for the same reason module 04's is: registering a manifest
   * must not pull Prisma into every consumer of `manifests.ts`, which includes `prisma/seed.ts` and
   * the nav tests.
   *
   * **`ticket.completed` is not among them.** §2's table names it for `on_installation` and module 04
   * has never emitted it — see BILLING_TRIGGERS in billing-rules.ts for what was used instead and
   * why. Subscribing to a name nothing fires would have produced a milestone that looks configured
   * and silently never bills.
   */
  consumes: [
    {
      event: "project.closed",
      handler: async (payload) => {
        const { onProjectClosed } = await import("@/server/core/finance/billing-service");
        await onProjectClosed(payload as { projectId?: string; projectCode?: string });
      },
    },
    {
      // §2: "with result accepted". A failed commissioning is not a billing event — the handler
      // checks, because the event fires either way.
      event: "tc.completed",
      handler: async (payload) => {
        const { onTcCompleted } = await import("@/server/core/finance/billing-service");
        await onTcCompleted(payload as { ticketId?: string; number?: string; result?: string });
      },
    },
    {
      event: "delivery.dr_signed",
      handler: async (payload) => {
        const { onDeliveryReceiptSigned } = await import("@/server/core/finance/billing-service");
        await onDeliveryReceiptSigned(
          payload as { salesOrderId?: string; number?: string; recipientName?: string },
        );
      },
    },
    {
      event: "sales_order.goods_delivered",
      handler: async (payload) => {
        const { onGoodsDelivered } = await import("@/server/core/finance/billing-service");
        await onGoodsDelivered(payload as { salesOrderId?: string; salesOrderNumber?: string });
      },
    },
    {
      // The customer's acceptance is what starts the bill — see BILLING_TRIGGERS.on_installation.
      event: "qa.passed",
      handler: async (payload) => {
        const { onQaPassed } = await import("@/server/core/finance/billing-service");
        await onQaPassed(payload as { ticketId?: string; qaApprovalId?: string; number?: string });
      },
    },
    {
      event: "supplier_po.sent",
      handler: async (payload) => {
        const { onSupplierPoSent } = await import("@/server/core/finance/billing-service");
        await onSupplierPoSent(payload as { salesOrderId?: string | null; number?: string });
      },
    },
  ],

  /*
    All of module 05's screens under one heading.

    They were ungrouped, so they sat loose at the top of the sidebar among "My day" and "Approvals"
    — three money screens with nothing saying they belonged together, and nothing to fold away for
    the people who never open them. The nav groups collapse now, which makes an ungrouped entry a
    permanent one.

    **Cash advances joins them**, moved out of Operations. It is raised on a ticket, which is why it
    started there, but the *register* is a finance screen: it is gated on `cash_advance.view_register`
    rather than on requesting one, and the company settled in this round that finance alone reviews
    liquidations. A technician's own advance is on their ticket, where they are already looking. The
    money view belongs with the money.
  */
  nav: [
    {
      // §5b's release queue. First in the group because it is the only one of these where somebody
      // is standing still waiting for an answer — a crew cannot leave until finance acts.
      label: "Cash to release",
      href: "/finance/releases",
      icon: "banknote",
      permission: "cash_advance.view_register",
      group: "Finance",
      order: 1,
    },
    {
      label: "Ready to bill",
      href: "/finance/billing",
      icon: "receipt",
      group: "Finance",
      order: 2,
    },
    {
      label: "Receivables",
      href: "/finance/receivables",
      icon: "wallet",
      group: "Finance",
      order: 3,
    },
    {
      label: "Collections",
      href: "/finance/collections",
      icon: "phone",
      group: "Finance",
      order: 4,
    },
    {
      // §7's payables. Last in the group: money out is checked less often than money in, and the
      // ordering follows how a finance day actually runs.
      label: "Payables",
      href: "/finance/payables",
      icon: "clipboard-list",
      permission: "payables.manage",
      group: "Finance",
      order: 5,
    },
  ],
});
