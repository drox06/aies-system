import { defineManifest } from "@/server/core/module-registry";

/**
 * Module 03 — Customer PO (specs/03-order-procurement.md), **opening act only**.
 *
 * This is not module 03. There is no sales order, no supplier, no supplier PO, no goods receipt, no
 * ticket generation — the four workstreams §1 fans out into are all still unbuilt, and this manifest
 * declares one model and one event.
 *
 * It exists because the company asked for a pipeline column a deal enters when the customer's
 * purchase order arrives, and §1 names PO receipt as exactly that moment: "this module is where the
 * deal stops being a sales artifact and becomes an obligation". Building it as module 03's
 * `CustomerPO` rather than as fields on `Inquiry` means module 03's own session extends this row
 * instead of migrating away from a second mechanism — the trap already refused for module 05's
 * `PaymentTerm` and ISO 8.4's supplier register.
 *
 * What that session inherits: the model, this manifest to grow, `customer_po.received` already
 * flowing, and module 02 already reacting to it. What it must add is everything §2 lists below
 * `CustomerPO`, plus the verification that makes `status` more than one value.
 */
export const orderManifest = defineManifest({
  key: "order",
  name: "Orders",
  version: "0.1.0",
  models: ["CustomerPO"],

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
  ],

  /**
   * specs/02-quotation.md §10 already names this event as one module 02 consumes: "`customer_po
   * .received` (module 03 → sets `accepted`)". Nothing emitted it, so the subscription could not
   * exist — the registry rejects a subscription to an event no module emits. It can now.
   */
  emits: ["customer_po.received"],

  // Nothing. Module 03's real session subscribes to plenty — `quotation.accepted` to raise the
  // sales order, and its own PO receipt to fan out to finance, procurement and operations (§1).
  // None of those have anywhere to go yet.
  consumes: [],

  // Nothing yet. A PO is reached from the inquiry it belongs to and from the pipeline board; a
  // top-level "Orders" screen belongs to module 03's session, when there is a sales order to put
  // on it.
  nav: [],
});
