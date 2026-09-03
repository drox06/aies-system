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
      // already cleared. It stays with the people who own the customer relationship — widened
      // 2026-09-04 to match `QUOTING_ROLES()`, docs/DECISIONS.md #151.
      defaultRoles: [
        "president",
        "vice_president",
        "marketing_manager",
        "sales",
        "admin_manager",
        "operations_manager",
      ],
    },
    {
      key: "quotation.revise",
      label: "Create a revision of a sent quotation",
      group: "Quotation",
      defaultRoles: QUOTING_ROLES(),
    },
    {
      key: "quotation.delete",
      label: "Delete a quotation",
      group: "Quotation",
      // Originally the two officers only, and separate from `quotation.cancel` because they are
      // different acts: cancelling records that a live quotation is no longer being pursued, which
      // is history worth keeping; deleting takes it off the screens entirely. Widened to the full
      // quoting roster 2026-09-04 — EA's rebuild table gives PD, DJ and EM delete alongside the rest
      // of the lifecycle. docs/DECISIONS.md #151.
      defaultRoles: [
        "president",
        "vice_president",
        "admin_manager",
        "operations_manager",
        "marketing_manager",
      ],
    },
    {
      key: "quotation.view_archive",
      label: "See archived quotations",
      group: "Quotation",
      // Originally EA and KJ by name. The archive is every won deal the company has ever done, with
      // its margin — management history rather than working material. See
      // QUOTATION_ARCHIVE_PERMISSION in archive-rules.ts for why it gates the list and not the
      // record. Widened to the full quoting roster 2026-09-04, same reasoning as `quotation.delete`
      // above. docs/DECISIONS.md #151.
      defaultRoles: [
        "president",
        "vice_president",
        "admin_manager",
        "operations_manager",
        "marketing_manager",
      ],
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
    // `approval.act_as_fallback` was declared here and removed on 2026-08-16. It never gated
    // anything, and it could not have: Spec.md §4.4's fallback is resolved from
    // `ApprovalRule.fallbackApproverRole`, so the rule row already names who may act and a second
    // answer to the same question is a way for the two to disagree.
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
   * §10 also lists `inspection.completed`.
   *
   * `inspection.completed` is not emitted by anything — module 01 emits `inspection.requested` and
   * records completion as an audit action rather than a domain event. Adding it there is a module
   * 01 change, and it belongs to the session that pulls inspection findings into the scope of work.
   * It is declared when its emitter lands — the registry rejects a subscription to an event no
   * module emits.
   */
  consumes: [
    {
      /**
       * specs/04-operations-projects.md §6.1: "Module 02 subscribes and prompts sales to raise a
       * quotation revision… **This link is one of the highest-value things the platform does.**"
       *
       * It **prompts**. See promptRevisionOnScopeChange for why raising the revision automatically
       * would be wrong: only a human knows whether extra scope is chargeable, absorbed, or a
       * misunderstanding, and a revision that appears by itself still has to be priced by somebody
       * who was not told why.
       */
      event: "scope_change.identified",
      handler: async (payload) => {
        const { promptRevisionOnScopeChange } =
          await import("@/server/core/quotation/scope-change-service");
        await promptRevisionOnScopeChange(
          payload as {
            siteInspectionId?: string;
            number?: string;
            ticketId?: string | null;
            inquiryId?: string | null;
            notes?: string | null;
          },
        );
      },
    },
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
    {
      /**
       * §10: "`customer_po.received` (module 03 → sets `accepted`)."
       *
       * This subscription is the whole reason the customer PO was built as module 03's model rather
       * than as fields on the inquiry — the spec already said what should happen, and it could not
       * happen while nothing emitted the event.
       *
       * It matters beyond tidiness: a quotation the customer has actually ordered against must stop
       * being a live document. Left `sent`, §7's nightly sweep would expire it and tell the owner a
       * won deal had lapsed.
       */
      event: "customer_po.received",
      handler: async (payload) => {
        const { quotationId } = payload as { quotationId?: string | null };
        if (!quotationId) return;

        const { acceptQuotationOnCustomerPo } =
          await import("@/server/core/quotation/quotation-service");
        await acceptQuotationOnCustomerPo(quotationId);
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
      group: "Sales",
      order: 12,
    },
    {
      label: "Quotations for Approval",
      href: "/quotations/approvals",
      icon: "check-circle",
      // §6's queue is the VP's screen (and the President's, once §4.4's window elapses). Gated on
      // the approval permission rather than `quotation.view`, so the other three roles are not
      // given a menu item that is empty for them by construction. The procedure behind it is gated
      // more loosely and returns only what the caller is eligible to see, so the nav is a
      // convenience here, not the access control.
      permission: "quotation.approve",
      group: "Sales",
      order: 13,
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
  // Widened 2026-09-04 at EA's instruction for the rebuild (docs/DECISIONS.md #151): quoting stops
  // being gated by role. PD and DJ join KJ, EM and sales in authoring a quotation; `quotation.approve`
  // stays with only the president and vice-president, everywhere, unaffected by this list.
  return [
    "president",
    "vice_president",
    "marketing_manager",
    "sales",
    "admin_manager",
    "operations_manager",
  ];
}
