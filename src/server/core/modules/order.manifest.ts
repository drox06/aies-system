import { defineManifest } from "@/server/core/module-registry";

/**
 * Module 03 — Customer PO, Sales Order, Procurement and Delivery
 * (specs/03-order-procurement.md).
 *
 * §1 names what this module is: "where the deal stops being a sales artifact and becomes an
 * obligation", with three fan-outs that run in parallel — finance may want a downpayment,
 * procurement places the supplier order, operations generates tickets.
 *
 * **Session 1 builds the spine:** the supplier directory, the sales order, and §3's verification.
 * Supplier PO, goods receipt and delivery are sessions 2 and 3; their permissions are declared here
 * anyway, because §10 lists them and a permission that appears later means a role assignment that
 * has to be redone. The ones with nothing behind them yet are marked.
 */
export const orderManifest = defineManifest({
  key: "order",
  name: "Orders",
  version: "0.2.0",
  models: ["CustomerPO", "Supplier", "SalesOrder", "SalesOrderLine"],

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
      key: "supplier.approve",
      label: "Approve a supplier under ISO 9001 clause 8.4",
      group: "Orders",
      // Narrower than maintaining the directory on purpose: approving a vendor is the control an
      // auditor asks about, and "who decided this" should be a short list.
      defaultRoles: ["president", "vice_president"],
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
    {
      key: "sales_order.edit",
      label: "Edit a sales order",
      group: "Orders",
      defaultRoles: ["president", "vice_president", "marketing_manager", "sales", "admin_manager"],
    },
    {
      key: "sales_order.close",
      label: "Close a completed sales order",
      group: "Orders",
      defaultRoles: ["president", "vice_president"],
    },
    {
      key: "sales_order.cancel",
      label: "Cancel a sales order",
      group: "Orders",
      defaultRoles: ["president", "vice_president"],
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
  emits: ["customer_po.received", "sales_order.created"],

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
      label: "Suppliers",
      href: "/suppliers",
      icon: "truck",
      permission: "supplier.manage",
      // After the quotation block (20-21), because a supplier is who you buy from once a quotation
      // has been won.
      order: 30,
    },
  ],
});
