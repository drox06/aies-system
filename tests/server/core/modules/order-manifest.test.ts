import { describe, expect, it } from "vitest";
import { db } from "@/lib/db";
import { registry } from "@/server/core/manifests";
import { orderManifest } from "@/server/core/modules/order.manifest";
import { visibleNavFor } from "@/server/core/nav";

/**
 * Module 03's manifest, guarded the same way module 01's is.
 *
 * The join between a manifest and the seed is where a permission can be declared, pass boot-time
 * validation, and still never reach the database — leaving every procedure gated on it permanently
 * 403 with nothing visibly wrong. Same trap, second module.
 */
describe("order manifest", () => {
  it("declares every permission specs/03-order-procurement.md §10 lists for this session", () => {
    const declared = new Set(orderManifest.permissions.map((p) => p.key));
    for (const key of [
      "customer_po.record",
      "customer_po.view",
      "supplier.manage",
      "supplier.approve",
      "sales_order.view",
      "sales_order.view_all",
      "sales_order.create",
      "supplier_po.create",
      "supplier_po.approve",
      "procurement.override_downpayment_gate",
      "goods_receipt.create",
      "goods_receipt.inspect",
    ]) {
      expect(declared, `§10 requires ${key}`).toContain(key);
    }
  });

  it("does not declare §10's permissions whose sessions have not been built", () => {
    // `sales_order.edit`, `.close` and `.cancel` were declared here in session 1 on the reasoning
    // that "a permission that appears later means a role assignment that has to be redone". That
    // reasoning did not survive checking: prisma/seed.ts upserts a permission *and* its default
    // roles on every run, so a permission added later is granted automatically. What the early
    // declaration did produce was three entries in the admin role screen that granted access to
    // nothing. Removed 2026-08-16 — docs/DECISIONS.md #52.
    const declared = new Set(orderManifest.permissions.map((p) => p.key));
    for (const key of ["sales_order.edit", "sales_order.close", "sales_order.cancel"]) {
      expect(declared, `${key} belongs to the session that gates something with it`).not.toContain(
        key,
      );
    }
  });

  it("keeps booking goods in wider than certifying them", () => {
    const roles = (key: string) =>
      orderManifest.permissions.find((p) => p.key === key)?.defaultRoles ?? [];

    // Whoever is at the gate when the truck arrives can book it in…
    expect(roles("goods_receipt.create")).toContain("technician");
    // …but the clause 8.4.2 signature is somebody else's. The person who unloaded the crate should
    // not also be the one certifying it.
    expect(roles("goods_receipt.inspect")).not.toContain("technician");
  });

  it("keeps buying and approving apart, and the override narrower still", () => {
    const roles = (key: string) =>
      orderManifest.permissions.find((p) => p.key === key)?.defaultRoles ?? [];

    // §5 puts an approval between raising the customer's order and committing AIES's money, so
    // sales is deliberately not granted `supplier_po.create`.
    expect(roles("supplier_po.create")).not.toContain("sales");
    expect(roles("supplier_po.create")).toContain("admin_manager");
    // §5: "the Vice President approves supplier POs."
    expect(roles("supplier_po.approve")).toEqual(["president", "vice_president"]);
    // §4's override is the officers' alone.
    expect(roles("procurement.override_downpayment_gate")).toEqual(["president", "vice_president"]);
  });

  it("keeps approving a supplier narrower than maintaining the directory", () => {
    // ISO 9001 clause 8.4's whole point: the people who can type a vendor in are not automatically
    // the people who decide AIES may buy from it.
    const roles = (key: string) =>
      orderManifest.permissions.find((p) => p.key === key)?.defaultRoles ?? [];

    expect(roles("supplier.approve")).toEqual(["president", "vice_president"]);
    expect(roles("supplier.manage")).toContain("admin_manager");
    expect(roles("supplier.manage").length).toBeGreaterThan(roles("supplier.approve").length);
  });

  it("keeps sales_order.view_all off the sales grant, so record scoping means something", () => {
    const viewAll = orderManifest.permissions.find((p) => p.key === "sales_order.view_all");
    expect(viewAll?.defaultRoles).not.toContain("sales");
    // But plain viewing is wide: procurement, operations and finance all act on the obligation.
    const view = orderManifest.permissions.find((p) => p.key === "sales_order.view");
    expect(view?.defaultRoles).toContain("operations_manager");
    expect(view?.defaultRoles).toContain("finance_officer");
  });

  it("emits sales_order.created, which is module 04's signal", () => {
    expect(orderManifest.emits).toContain("sales_order.created");
    expect(orderManifest.emits).toContain("customer_po.received");
  });

  it("emits §5's procurement events now that something emits them", () => {
    // These were deliberately absent in session 1 and are declared here in the same change that
    // emits them — the rule this manifest follows is that `emits` describes reality.
    expect(orderManifest.emits).toContain("supplier_po.created");
    expect(orderManifest.emits).toContain("supplier_po.sent");
    expect(orderManifest.emits).toContain("supplier_po.approved");
  });

  it("emits §6's receipt events now that goods can be received", () => {
    expect(orderManifest.emits).toContain("goods.received");
    expect(orderManifest.emits).toContain("goods.rejected");
  });

  it("does not declare events nothing can emit yet", () => {
    // §9 lists nine events for the finished module. The registry rejects a subscription to an event
    // nothing emits, so declaring one early lets a later module subscribe to something that never
    // fires — worse than a boot error, because it fails silently.
    //
    // Delivery is module 04's ticket-gated lane: §7 says "a DR is never issued without a ticket to
    // execute it", and module 04 does not exist. So these two stay undeclared, and this pin names
    // the work on the day it lands.
    expect(orderManifest.emits).not.toContain("sales_order.goods_delivered");
    expect(orderManifest.emits).not.toContain("delivery.dr_signed");
    // §4's downpayment event needs module 05's `PaymentTerm` to have a percentage on it.
    expect(orderManifest.emits).not.toContain("downpayment.required");
  });

  it("consumes principal.appointed — §5c's conversion, finally wired", () => {
    // Module 01 has emitted this with the right payload since its session 3, and
    // createSupplierFromPrincipalService sat waiting for a caller. The dependency runs downward:
    // module 03 subscribes to module 01, never the reverse.
    const consumed = orderManifest.consumes.map((c) => c.event);
    expect(consumed).toContain("principal.appointed");
  });

  it("is registered, so its permissions reach the seed", () => {
    const keys = new Set(registry.permissions.map((p) => p.key));
    expect(keys).toContain("supplier.approve");
    expect(keys).toContain("sales_order.create");
  });

  it("shows /suppliers only to somebody who may maintain the directory", () => {
    expect(visibleNavFor(new Set<string>()).map((e) => e.href)).not.toContain("/suppliers");
    expect(visibleNavFor(new Set(["supplier.manage"])).map((e) => e.href)).toContain("/suppliers");
  });

  it("gates the sales order and procurement entries on their own permissions", () => {
    const none = visibleNavFor(new Set<string>()).map((e) => e.href);
    expect(none).not.toContain("/sales-orders");
    expect(none).not.toContain("/procurement");

    // Everybody who touches the obligation sees sales orders; only a buyer sees procurement.
    const viewer = visibleNavFor(new Set(["sales_order.view"])).map((e) => e.href);
    expect(viewer).toContain("/sales-orders");
    expect(viewer).not.toContain("/procurement");

    expect(visibleNavFor(new Set(["supplier_po.create"])).map((e) => e.href)).toContain(
      "/procurement",
    );
  });
});

describe("seeded numbering for module 03", () => {
  it("has a supplier code with no year segment, like an account", async () => {
    const format = await db.numberingFormat.findUnique({ where: { documentType: "supplier" } });
    expect(format, "run `npm run seed`").not.toBeNull();
    // A supplier relationship is a permanent identifier, not a dated document, so the counter must
    // never reset the way a quotation's does.
    expect(format?.format).toBe("AIESSUP-{####}");
  });

  it("has a sales order series", async () => {
    const format = await db.numberingFormat.findUnique({ where: { documentType: "sales_order" } });
    expect(format, "run `npm run seed`").not.toBeNull();
    expect(format?.format).toBe("AIESSO-{YY}{####}");
  });

  it("has a goods receipt series the warehouse will recognise", async () => {
    const format = await db.numberingFormat.findUnique({
      where: { documentType: "goods_receipt" },
    });
    expect(format, "run `npm run seed`").not.toBeNull();
    // "GRN" and not "GR": goods received note is what the piece of paper is called, and a prefix
    // nobody recognises is one people write the wrong number on.
    expect(format?.format).toBe("AIESGRN-{YY}{####}");
  });
});
