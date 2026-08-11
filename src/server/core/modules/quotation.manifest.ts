import { defineManifest } from "@/server/core/module-registry";

/**
 * Module 02 — Quotation (specs/02-quotation.md).
 *
 * §11 lists thirteen permissions, and this declares eleven. `quotation.approve` and
 * `finance.view_cost` are **foundation** permissions, seeded by module 00 in prisma/seed.ts
 * (`finance.view_cost` because Spec.md §4.3 makes cost visibility a system-wide rule rather than a
 * quotation feature, and `quotation.approve` because module 00 needed it to seed the approval rule
 * with its 24-hour escalation window). Redeclaring either here would be a second owner for one key,
 * which is exactly what the registry's collision check exists to catch.
 */
export const quotationManifest = defineManifest({
  key: "quotation",
  name: "Quotations",
  version: "0.1.0",
  models: [
    "Quotation",
    "QuotationLine",
    "SupplierQuoteRequest",
    "SupplierQuoteLine",
    "Product",
    "PaymentTerm",
  ],

  permissions: [
    {
      key: "quotation.view",
      label: "View quotations",
      group: "Quotation",
      defaultRoles: QUOTING_ROLES(),
    },
    {
      key: "quotation.view_all",
      label: "View all quotations, not just their own",
      group: "Quotation",
      // Narrow, so §11's record scoping means something. The VP needs it to run the approval queue.
      defaultRoles: ["president", "vice_president"],
    },
    {
      key: "quotation.create",
      label: "Create quotations",
      group: "Quotation",
      defaultRoles: QUOTING_ROLES(),
    },
    {
      key: "quotation.edit",
      label: "Edit draft quotations",
      group: "Quotation",
      defaultRoles: QUOTING_ROLES(),
    },
    {
      key: "quotation.send",
      label: "Issue an approved quotation to the customer",
      group: "Quotation",
      // §6: approval is required before `sent`, so sending is the act of releasing something the VP
      // already cleared. It stays with the people who own the customer relationship.
      defaultRoles: ["president", "vice_president", "marketing_manager", "sales"],
    },
    {
      key: "quotation.revise",
      label: "Create a revision of a sent quotation",
      group: "Quotation",
      defaultRoles: QUOTING_ROLES(),
    },
    {
      key: "quotation.cancel",
      label: "Cancel a quotation",
      group: "Quotation",
      defaultRoles: ["president", "vice_president"],
    },
    {
      key: "quotation.override_margin_floor",
      label: "Send a quotation with a line below the margin floor",
      group: "Quotation",
      // §4's floor is a warning to the preparer and a decision for the people who carry the P&L.
      defaultRoles: ["president", "vice_president"],
    },
    {
      key: "supplier_rfq.manage",
      label: "Raise and record supplier price requests",
      group: "Quotation",
      // §3: "the Admin Manager (PD) handles supplier price inquiries."
      defaultRoles: ["admin_manager", "president", "vice_president"],
    },
    {
      key: "product.manage",
      label: "Maintain the product catalogue",
      group: "Quotation",
      defaultRoles: ["president", "vice_president", "marketing_manager", "admin_manager"],
    },
    {
      key: "approval.act_as_fallback",
      label: "Act on an approval as the fallback approver",
      group: "Approvals",
      // Spec.md §4.4: "The President can always act immediately, without waiting for the window."
      // The resolver already implements the window; this is the permission that names who may.
      defaultRoles: ["president"],
    },
  ],

  // specs/02-quotation.md §10.
  emits: [
    "quotation.created",
    "quotation.submitted_for_approval",
    "quotation.approved",
    "quotation.rejected_internally",
    "quotation.sent",
    "quotation.revised",
    "quotation.accepted",
    "quotation.rejected",
    "quotation.expired",
    "supplier_rfq.sent",
    "supplier_rfq.responded",
  ],

  /**
   * §10 also lists `inspection.completed` and `customer_po.received`.
   *
   * `inspection.completed` is not emitted by anything — module 01 emits `inspection.requested` and
   * records completion as an audit action rather than a domain event. Adding it there is a module
   * 01 change, and it belongs to the session that pulls inspection findings into the scope of work.
   * `customer_po.received` is module 03's, which does not exist. The registry rejects a subscription
   * to an event no module emits, so both are declared when their emitter lands.
   */
  consumes: [
    {
      event: "inquiry.quoting_started",
      // Dynamically imported so registering the manifest does not pull Prisma into every consumer
      // of manifests.ts — which includes prisma/seed.ts and the nav tests. The service loads only
      // when an event is actually dispatched.
      handler: async (payload) => {
        const { createDraftForInquiry } = await import("@/server/core/quotation/quotation-service");
        const { inquiryId, actorId } = payload as { inquiryId?: string; actorId?: string };
        if (!inquiryId) return;
        await createDraftForInquiry({ inquiryId, actorId });
      },
    },
  ],

  nav: [
    {
      label: "Quotations",
      href: "/quotations",
      icon: "file-text",
      permission: "quotation.view",
      // After the CRM block (10-13), because a quotation follows an inquiry.
      order: 20,
    },
    {
      label: "Awaiting approval",
      href: "/quotations/approvals",
      icon: "check-circle",
      // §6's queue is the VP's screen (and the President's, once §4.4's window elapses). Gated on
      // the approval permission rather than `quotation.view`, so the other three roles are not
      // given a menu item that is empty for them by construction. The procedure behind it is gated
      // more loosely and returns only what the caller is eligible to see, so the nav is a
      // convenience here, not the access control.
      permission: "quotation.approve",
      order: 21,
    },
  ],
});

/**
 * The roles that prepare quotations.
 *
 * `sales` is still seeded-but-unassigned (Spec.md §4.2), listed so the grants are right on the day
 * AIES hires. `admin_manager` is deliberately absent from preparation — PD's part in §3 is supplier
 * pricing, which has its own permission.
 */
function QUOTING_ROLES(): string[] {
  return ["president", "vice_president", "marketing_manager", "sales"];
}
