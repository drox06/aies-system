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
      "sales_order.edit",
      "sales_order.close",
      "sales_order.cancel",
    ]) {
      expect(declared, `§10 requires ${key}`).toContain(key);
    }
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

  it("does not declare events nothing can emit yet", () => {
    // §9 lists nine events for the finished module. The registry rejects a subscription to an event
    // nothing emits, so declaring `goods.received` before anything can receive goods would let a
    // later module subscribe to something that never fires — worse than a boot error, because it
    // fails silently. When sessions 2 and 3 land, this pin names the work.
    expect(orderManifest.emits).not.toContain("goods.received");
    expect(orderManifest.emits).not.toContain("supplier_po.issued");
    expect(orderManifest.emits).not.toContain("delivery.completed");
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
});

describe("seeded numbering for module 03", () => {
  it("has a supplier code with no year segment, like an account", async () => {
    const format = await db.numberingFormat.findUnique({ where: { documentType: "supplier" } });
    expect(format, "run `npm run seed`").not.toBeNull();
    // A supplier relationship is a permanent identifier, not a dated document, so the counter must
    // never reset the way a quotation's does.
    expect(format?.format).toBe("SUP-{####}");
  });

  it("has a sales order series", async () => {
    const format = await db.numberingFormat.findUnique({ where: { documentType: "sales_order" } });
    expect(format, "run `npm run seed`").not.toBeNull();
    expect(format?.format).toBe("SO-{YY}-{#####}");
  });
});
