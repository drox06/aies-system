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
    for (const key of ["ticket.view", "ticket.view_all", "ticket.generate", "project.view_cost"]) {
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
      "delivery.execute",
      // Declared in session 1 and removed the same day: they gated nothing either.
      "ticket.cancel",
      "project.view",
      // `project.manage` was on this list until session 3, which gave it §6.1's inspection sign-off.
      // That is the rule working in the intended direction: a permission comes back the moment
      // something gates it, not before.
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

  /**
   * Pinned rather than merely "contains", so adding an event forces a look at this list.
   *
   * §18 names twenty-eight; four are emitted. The registry rejects a subscription to an event
   * nothing emits, so an early declaration lets a later module subscribe to something that never
   * fires — a silent failure, worse than a boot error.
   */
  it("emits only what the sessions so far actually emit", () => {
    expect(operationsManifest.emits).toEqual([
      "ticket.generated",
      "cash_advance.requested",
      "cash_advance.released",
      "cash_advance.liquidation_overdue",
      "site_inspection.completed",
      "scope_change.identified",
      "methodology.approved",
      "material_request.raised",
      "material.purchase_required",
      "material.issued",
      "ticket.mobilized",
      "ticket.started",
      "ticket.demobilized",
      "qa.passed",
      "qa.failed",
      "tc.completed",
      "punch_item.raised",
      "warranty.claim_raised",
      "warranty.expiring",
    ]);
  });

  /** §5's four-working-hour window is the shortest in the build, "because a crew is standing by". */
  it("leaves cash_advance.approve to module 00, which seeded the rule with its 4-hour window", () => {
    const keys = operationsManifest.permissions.map((p) => p.key);
    expect(keys).not.toContain("cash_advance.approve");
    expect(keys).not.toContain("cash_advance.approve_extension");
  });

  /**
   * §5 makes release a separate act from approval because the gap between them is the thing nobody
   * could see. Granting one person both would close the gap by hiding it.
   */
  it("keeps approving an advance and releasing the money in different hands", () => {
    const roles = (key: string) =>
      operationsManifest.permissions.find((p) => p.key === key)?.defaultRoles ?? [];
    expect(roles("cash_advance.release")).not.toContain("vice_president");
    expect(roles("operations.override_ca_gate")).toEqual(["president", "vice_president"]);
  });

  /**
   * §4's rule, pinned by naming the event rather than by counting subscriptions.
   *
   * This used to assert `consumes` was empty, which was true in session 1 and would have failed in
   * session 3 for the wrong reason — the `inspection.requested` subscription is legitimate, and an
   * emptiness assertion cannot tell the two apart. What actually matters is the specific absence, so
   * that is what is asserted now.
   */
  it("never subscribes to sales_order.created, which is §4's rule", () => {
    // §4 forbids it outright: "Do not auto-generate silently — one PO can legitimately be one
    // ticket or eight, and only a human knows which." A subscriber would be a quiet way of doing
    // the thing the spec rules out.
    const events = operationsManifest.consumes.map((c) => c.event);
    expect(events).not.toContain("sales_order.created");
    expect(events).not.toContain("customer_po.received");
  });

  /**
   * specs/01-crm-inquiry.md §5: "Module 04 subscribes and creates a scheduled field task."
   *
   * crm.prisma has carried that promise in a comment since module 01 was built. Pinned so a later
   * refactor cannot quietly drop it and leave the comment lying.
   */
  it("subscribes to inspection.requested, which module 01 has been waiting for", () => {
    expect(operationsManifest.consumes.map((c) => c.event)).toContain("inspection.requested");
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
