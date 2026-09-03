import { defineManifest } from "@/server/core/module-registry";

/**
 * Module 03 — Customer PO, Sales Order, Procurement and Delivery
 * (specs/03-order-procurement.md).
 *
 * §1 names what this module is: "where the deal stops being a sales artifact and becomes an
 * obligation", with three fan-outs that run in parallel — finance may want a downpayment,
 * procurement places the supplier order, operations generates tickets.
 *
 * **Permissions are declared in the change that gates something with them** — the same rule `emits`
 * follows, and enforced by tests/server/core/modules/permissions-are-used.test.ts.
 *
 * This manifest originally declared all of §10 up front, on the reasoning that "a permission that
 * appears later means a role assignment that has to be redone". That reasoning did not survive being
 * checked: prisma/seed.ts upserts a permission *and* its `defaultRoles` on every run, so one added
 * in a later session is granted automatically. What the early declaration did produce was three
 * entries in the admin role screen granting access to nothing. docs/DECISIONS.md #52.
 */
export const orderManifest = defineManifest({
  key: "order",
  name: "Orders",
  version: "0.2.0",
  models: [
    "CustomerPO",
    "Supplier",
    "SalesOrder",
    "SalesOrderLine",
    // §7's delivery receipt. The document is this module's; the lane that executes it is module
    // 04 §13, which is why neither could be built without the other.
    "DeliveryReceipt",
    "DeliveryReceiptLine",
  ],

  permissions: [
    {
      key: "customer_po.record",
      label: "Record a customer purchase order",
      group: "Orders",
      // Whoever owns the customer relationship receives the PO — it arrives by email to the
      // salesperson, not to a back office. `admin_manager` is included because PD handles the
      // paperwork when sales is on site.
      defaultRoles: ["president", "vice_president", "marketing_manager", "sales", "admin_manager"],
    },
    {
      key: "customer_po.remove",
      label: "Remove a recorded customer purchase order",
      group: "Orders",
      /*
        The two officers, and nobody else.

        Recording a PO is routine and widely held; taking one off is not. A recorded PO is what §4's
        downpayment gate and §3's verification both read, and what module 02 reacted to when it moved
        the deal to "PO received" — removing it walks all of that backwards. The company set this at
        president and VP on 2026-08-19, and the narrowness is the point rather than an oversight.
      */
      defaultRoles: ["president", "vice_president"],
    },
    {
      key: "customer_po.view",
      label: "View customer purchase orders",
      group: "Orders",
      // Wider than recording: operations and finance both need to see that a PO landed, and both
      // will need it in earnest when modules 04 and 05 arrive.
      defaultRoles: [
        "president",
        "vice_president",
        "marketing_manager",
        "sales",
        "admin_manager",
        "operations_manager",
        "finance_officer",
      ],
    },
    // ---- §10's supplier and sales-order permissions ------------------------------------------
    {
      key: "supplier.manage",
      label: "Maintain the supplier directory",
      group: "Orders",
      // §2: "this directory is maintained by users". PD does the paperwork, EM brings the
      // principals in, and the two officers can always act.
      defaultRoles: ["president", "vice_president", "admin_manager", "marketing_manager"],
    },
    {
      key: "supplier.delete",
      label: "Delete a supplier from the directory",
      group: "Orders",
      // The President alone, at the company's request on 2026-08-16. §2 makes the directory
      // deliberately easy to add to, which means duplicates and typos get in too — and a directory
      // that only ever grows is one people stop trusting. Narrower than approving, because removing
      // a vendor takes its whole history off the working list.
      defaultRoles: ["president"],
    },
    {
      key: "supplier.approve",
      label: "Approve a supplier under ISO 9001 clause 8.4",
      group: "Orders",
      // Narrower than maintaining the directory on purpose: approving a vendor is the control an
      // auditor asks about, and "who decided this" should be a short list. `admin_manager` joined
      // 2026-09-04 — EA's rebuild table gives PD "supplier accreditation" by name, alongside the
      // title change to Admin Manager and Purchaser. docs/DECISIONS.md #151.
      defaultRoles: ["president", "vice_president", "admin_manager"],
    },
    {
      key: "sales_order.view",
      label: "View sales orders",
      group: "Orders",
      // Everybody who touches the obligation: sales owns the customer, procurement buys, operations
      // executes, finance bills.
      defaultRoles: [
        "president",
        "vice_president",
        "marketing_manager",
        "sales",
        "admin_manager",
        "operations_manager",
        "finance_officer",
      ],
    },
    {
      key: "sales_order.view_all",
      label: "View all sales orders, not just their own",
      group: "Orders",
      defaultRoles: ["president", "vice_president", "operations_manager", "finance_officer"],
    },
    {
      key: "sales_order.create",
      label: "Raise a sales order from a verified customer PO",
      group: "Orders",
      defaultRoles: ["president", "vice_president", "marketing_manager", "sales", "admin_manager"],
    },
    // ---- §5's procurement permissions ----------------------------------------------------------
    {
      key: "supplier_po.create",
      label: "Raise and edit supplier purchase orders",
      group: "Orders",
      // PD does the buying. Sales is deliberately absent: raising the customer's order and
      // committing AIES's money are different jobs, and §5 puts an approval between them.
      // `operations_manager` withdrawn 2026-09-04 — EA's rebuild table names "raise a supplier PO"
      // explicitly as something DJ cannot do; buying stays PD's alone among the four widened roles.
      // docs/DECISIONS.md #151.
      defaultRoles: ["president", "vice_president", "admin_manager"],
    },
    {
      key: "supplier_po.delete",
      label: "Delete a supplier purchase order raised in error",
      group: "Orders",
      // Asked for by the company on 2026-08-17: "there could be mistakes for double entries." EA, KJ
      // and PD — president, vice-president and admin manager. Deliberately not procurement's own
      // `supplier_po.create`: the person who typed the duplicate is not the person who should be able
      // to make it disappear. The service refuses to delete anything already sent or received.
      defaultRoles: ["president", "vice_president", "admin_manager"],
    },
    {
      key: "supplier_po.approve",
      label: "Approve a supplier purchase order",
      group: "Orders",
      // §5: "the Vice President approves supplier POs, matching quotation approval." The President
      // is here as the fallback Spec.md §4.4 gives every approval, resolved from the rule rather
      // than from this list.
      defaultRoles: ["president", "vice_president"],
    },
    {
      key: "procurement.override_downpayment_gate",
      label: "Order before the customer's downpayment has arrived",
      group: "Orders",
      // §4: the override "happens in real life, and pretending otherwise means people work around
      // the system instead of through it". Narrow, and it always writes a reason.
      defaultRoles: ["president", "vice_president"],
    },
    // ---- §6's goods receipt ---------------------------------------------------------------------
    {
      key: "goods_receipt.create",
      label: "Book in goods arriving against a supplier PO",
      group: "Orders",
      // Whoever is at the gate when the truck arrives. Wider than inspecting, because counting
      // boxes and certifying paperwork are different acts — see goods-receipt-service.ts.
      // `operations_manager` withdrawn 2026-09-04 — EA's rebuild table names "record a goods
      // receipt" explicitly as something DJ cannot do. `goods_receipt.inspect` is untouched: DJ's
      // list still records QA outcomes, and inspecting is the separate act. docs/DECISIONS.md #151.
      defaultRoles: ["president", "vice_president", "admin_manager", "technician"],
    },
    {
      key: "goods_receipt.inspect",
      label: "Record the ISO 9001 clause 8.4.2 incoming inspection",
      group: "Orders",
      // Narrower: this is the signature that says the goods were verified, and an auditor asks who
      // gave it. Technicians are absent deliberately — the person who unloaded the crate should not
      // also be the one certifying it.
      defaultRoles: ["president", "vice_president", "admin_manager", "operations_manager"],
    },
  ],

  /**
   * `customer_po.received` was already flowing and module 02 already reacts to it.
   * `sales_order.created` is new, and module 04 is the consumer §3 describes: "module 04 proposes a
   * ticket set… Each ticket links back to the specific sales order lines it covers."
   *
   * Only these two. §9 lists nine events for the finished module, and the registry rejects a
   * subscription to an event nothing emits — declaring `goods.received` before anything can receive
   * goods would let a later module subscribe to something that never fires, which is worse than a
   * boot error.
   */
  emits: [
    "customer_po.received",
    "sales_order.created",
    // §5's procurement events. `supplier_po.approved` is not in §9's list and is emitted anyway:
    // §9 names the nine events *other modules* need, and this one is what module 05 will read to
    // know a commitment exists before the invoice does. Declared because it is emitted — the rule
    // this manifest follows is that `emits` describes reality, not intentions.
    "supplier_po.created",
    "supplier_po.approved",
    "supplier_po.sent",
    // §6. `goods.rejected` fires only when something actually was rejected — module 08 raises its
    // NCR from it, so an event on every clean delivery would be an NCR queue nobody could read.
    "goods.received",
    "goods.rejected",
  ],

  /**
   * §5c's promise, finally kept: "On `stage = appointed`, the prospect converts into a `Supplier`
   * (module 03) with `isPrincipal = true`, carrying the agreement, price list, and contacts across.
   * No re-keying."
   *
   * Module 01 has emitted `principal.appointed` since session 3 with exactly this payload, and
   * `linkPrincipalSupplierService` has sat waiting for a caller. This is the caller. The dependency
   * runs downward — module 03 subscribes to module 01, never the reverse.
   */
  consumes: [
    {
      event: "principal.appointed",
      // Dynamically imported so the manifest stays free of Prisma, which prisma/seed.ts and the
      // nav tests both depend on.
      handler: async (payload) => {
        const { prospectId } = payload as { prospectId?: string };
        if (!prospectId) return;

        const { createSupplierFromPrincipalService } =
          await import("@/server/core/order/supplier-service");
        // `"system"` rather than null, matching the crm manifest's `quotation.sent` subscriber —
        // `ActorMeta.actorId` is a string, and the audit log's null actor is reserved for the
        // nightly sweeps that no request triggered at all.
        await createSupplierFromPrincipalService(
          { actorId: "system", actorLabel: "System (principal appointed)" },
          prospectId,
        );
      },
    },
  ],

  nav: [
    {
      label: "Sales orders",
      href: "/sales-orders",
      icon: "clipboard-list",
      permission: "sales_order.view",
      // Immediately after the quotation block: a sales order is what a won quotation becomes, and
      // it is the screen procurement, finance and operations all start from.
      group: "Orders",
      order: 30,
    },
    {
      label: "Procurement",
      href: "/procurement",
      icon: "package",
      permission: "supplier_po.create",
      // §5's expediting view. Its own entry rather than a tab on sales orders, because the question
      // it answers — "what is late, and whose delivery does it delay?" — is asked across every
      // order at once.
      group: "Orders",
      order: 31,
    },
    {
      // One button for what used to be two nav entries (2026-09-01, the company's own instruction).
      // The screen behind it also holds the §5c prospect pipeline, previously module 01's own
      // "Principals" entry — gated here on `supplier.manage` rather than a second permission a nav
      // entry cannot carry two of; in practice the same people hold both.
      label: "Principals & Suppliers",
      href: "/suppliers",
      icon: "truck",
      permission: "supplier.manage",
      // After the quotation block (20-21), because a supplier is who you buy from once a quotation
      // has been won.
      group: "Orders",
      order: 33,
    },
  ],
});
