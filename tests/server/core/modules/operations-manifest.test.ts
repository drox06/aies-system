import { describe, expect, it } from "vitest";
import { db } from "@/lib/db";
import { registry } from "@/server/core/manifests";
import { operationsManifest } from "@/server/core/modules/operations.manifest";
import { visibleNavFor } from "@/server/core/nav";

/**
 * Module 04's manifest, guarded the way modules 01 and 03 are.
 *
 * The pins that matter most here are about what is **absent**: §19 lists thirty permissions and §18
 * twenty-eight events, and declaring them before the sessions that use them would put dead
 * permissions in every role screen and let a later module subscribe to an event that never fires.
 */
describe("operations manifest", () => {
  it("declares the permissions session 1 actually uses", () => {
    const declared = new Set(operationsManifest.permissions.map((p) => p.key));
    for (const key of [
      "ticket.view",
      "ticket.view_all",
      "ticket.generate",
      "ticket.cancel",
      "project.view",
      "project.manage",
      "project.view_cost",
    ]) {
      expect(declared, `session 1 needs ${key}`).toContain(key);
    }
  });

  it("holds back the permissions whose gates do not exist", () => {
    // Module 03 declared its later sessions' permissions up front, deliberately; module 04 does the
    // opposite, and for a reason worth keeping straight. Module 03's sessions were days apart, and a
    // permission appearing later means a role assignment redone. Module 04's gates are whole
    // sessions each — `cash_advance.approve` declared now would sit in the role screen granting
    // access to nothing for weeks, and somebody would assign it and wonder why nothing happened.
    const declared = new Set(operationsManifest.permissions.map((p) => p.key));
    for (const key of [
      "cash_advance.approve",
      "material_request.raise",
      "methodology.approve",
      "qa.record",
      "delivery.execute",
    ]) {
      expect(declared, `${key} belongs to the session that builds its gate`).not.toContain(key);
    }
  });

  it("keeps ticket.view_all off the technician grant, so §19's scoping means something", () => {
    const roles = (key: string) =>
      operationsManifest.permissions.find((p) => p.key === key)?.defaultRoles ?? [];

    // §19: "Technicians are scoped to tickets where they are assigned."
    expect(roles("ticket.view")).toContain("technician");
    expect(roles("ticket.view_all")).not.toContain("technician");
    // "…never contract value or margin."
    expect(roles("project.view_cost")).not.toContain("technician");
    expect(roles("project.view_cost")).not.toContain("operations_manager");
  });

  it("emits ticket.generated and nothing else yet", () => {
    expect(operationsManifest.emits).toEqual(["ticket.generated"]);
  });

  it("subscribes to nothing, which is §4's rule rather than an omission", () => {
    // The obvious wiring is `sales_order.created` → generate. §4 forbids it outright: "Do not
    // auto-generate silently — one PO can legitimately be one ticket or eight, and only a human
    // knows which." A subscriber here would be a quiet way of doing the thing the spec rules out.
    expect(operationsManifest.consumes).toEqual([]);
  });

  it("is registered, so its permissions reach the seed", () => {
    const keys = new Set(registry.permissions.map((p) => p.key));
    expect(keys).toContain("ticket.generate");
    expect(keys).toContain("project.view_cost");
  });

  it("shows /tickets to anybody who may see one, and hides it otherwise", () => {
    expect(visibleNavFor(new Set<string>()).map((e) => e.href)).not.toContain("/tickets");
    expect(visibleNavFor(new Set(["ticket.view"])).map((e) => e.href)).toContain("/tickets");
  });
});

describe("seeded numbering for module 04", () => {
  it("has the ticket series the company insists on calling a ticket", async () => {
    // §2: "This is the company's own term — use it in the UI, the code, and the numbering."
    const format = await db.numberingFormat.findUnique({ where: { documentType: "ticket" } });
    expect(format, "run `npm run seed`").not.toBeNull();
    expect(format?.format).toBe("AIESTKT-{YY}{####}");
  });

  it("has a project series, which Spec.md §5's table does not list", async () => {
    // Added because §3 gives `Project` a `code`, and several tickets need to say which project they
    // roll up to.
    const format = await db.numberingFormat.findUnique({ where: { documentType: "project" } });
    expect(format, "run `npm run seed`").not.toBeNull();
    expect(format?.format).toBe("AIESPRJ-{YY}{####}");
  });
});
