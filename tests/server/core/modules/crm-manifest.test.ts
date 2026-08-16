import { existsSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { db } from "@/lib/db";
import { registry } from "@/server/core/manifests";
import { crmManifest } from "@/server/core/modules/crm.manifest";
import { visibleNavFor } from "@/server/core/nav";

/**
 * Module 01 is the first module to own permissions through its manifest rather than through
 * prisma/seed.ts, so these tests guard the join between the two. Without it a module can declare
 * a permission, pass boot-time collision validation, and still never reach the database — leaving
 * every procedure gated on it permanently 403 with nothing visibly wrong.
 */
describe("crm manifest", () => {
  it("declares every permission specs/01-crm-inquiry.md §9 lists", () => {
    const declared = new Set(crmManifest.permissions.map((p) => p.key));
    for (const key of [
      "crm.view",
      "crm.view_all",
      "crm.create",
      "crm.edit",
      "crm.delete",
      "crm.merge",
      "inquiry.assign",
      "inspection.request",
      "accreditation.manage",
      "principal_prospect.manage",
    ]) {
      expect(declared, `§9 requires ${key}`).toContain(key);
    }
  });

  it("does not declare §9's permissions that nothing gates", () => {
    // `crm.export` and `inquiry.disqualify` are in §9's list and were declared from the start, with
    // nothing behind either. §7's CSV export goes through the shared DataTable and is gated by being
    // able to see the rows at all; disqualifying is a status transition under `crm.edit`. Both
    // removed 2026-08-16 — a permission in the role screen that grants access to nothing teaches
    // people that permissions here do not mean anything. docs/DECISIONS.md #52.
    const declared = new Set(crmManifest.permissions.map((p) => p.key));
    expect(declared).not.toContain("crm.export");
    expect(declared).not.toContain("inquiry.disqualify");
  });

  it("declares every event specs/01-crm-inquiry.md §8 says it emits", () => {
    const emits = new Set(crmManifest.emits);
    for (const event of [
      "account.created",
      "inquiry.created",
      "inquiry.acknowledged",
      "inquiry.assigned",
      "inquiry.status_changed",
      "inquiry.quoting_started",
      "inquiry.lost",
      "inspection.requested",
      "activity.logged",
    ]) {
      expect(emits, `§8 requires ${event}`).toContain(event);
    }
  });

  it("subscribes to quotation.sent, which is how an inquiry reaches `quoted`", () => {
    // This assertion used to be the opposite: module 02 did not exist, declaring the subscription
    // would have made buildModuleRegistry throw at boot ("consumes unknown event"), and the test
    // was written to fail the moment module 02 landed so the failure would name the work. It did
    // exactly that. This is its second life.
    //
    // §3 of module 01 makes `quoted` a system-only transition — the quotation's outcome sets it,
    // never a person — so this subscription is the *only* route to that status.
    const consumed = crmManifest.consumes.map((c) => c.event);
    expect(consumed).toContain("quotation.sent");
  });

  it("does not yet subscribe to quotation.accepted or .rejected", () => {
    // Module 02 declares both in its `emits`, so the registry would accept the subscription — but
    // nothing emits them until §8's negotiation flow lands in session 4, and a subscriber for an
    // event that is never sent is a promise the pipeline silently fails to keep. Same pin, one
    // session further on: when that flow lands, this failure names the work.
    const consumed = crmManifest.consumes.map((c) => c.event);
    expect(consumed).not.toContain("quotation.accepted");
    expect(consumed).not.toContain("quotation.rejected");
  });

  it("is registered, so its permissions reach the seed", () => {
    const keys = new Set(registry.permissions.map((p) => p.key));
    expect(keys).toContain("crm.view");
    expect(keys).toContain("accreditation.manage");
  });

  it("§9: accreditation sits with admin_manager, principals with marketing_manager", () => {
    const roles = (key: string) =>
      crmManifest.permissions.find((p) => p.key === key)?.defaultRoles ?? [];
    expect(roles("accreditation.manage")).toContain("admin_manager");
    expect(roles("principal_prospect.manage")).toContain("marketing_manager");
    // "Both are visible to president and vice_president."
    for (const key of ["accreditation.manage", "principal_prospect.manage"]) {
      expect(roles(key)).toContain("president");
      expect(roles(key)).toContain("vice_president");
    }
  });

  it("keeps crm.view_all off the default sales grant, so record scoping means something", () => {
    // §10's scoping test requires salesperson A cannot read salesperson B's inquiry. If sales held
    // crm.view_all by default that test could only ever pass by accident.
    const viewAll = crmManifest.permissions.find((p) => p.key === "crm.view_all")?.defaultRoles;
    expect(viewAll).not.toContain("sales");
  });

  it("hides its nav from someone with no CRM permissions", () => {
    const nav = visibleNavFor(new Set<string>());
    const hrefs = nav.map((e) => e.href);
    expect(hrefs).not.toContain("/crm/accounts");
    expect(hrefs).not.toContain("/crm/accreditations");
  });

  it("shows accounts but not accreditations to a plain CRM user", () => {
    const hrefs = visibleNavFor(new Set(["crm.view"])).map((e) => e.href);
    expect(hrefs).toContain("/crm/accounts");
    expect(hrefs).not.toContain("/crm/accreditations");
  });
});

describe("navigation integrity", () => {
  /**
   * Every nav entry must point at a route that exists.
   *
   * This module's first manifest listed all four CRM sections before any of their pages were
   * built, so the sidebar offered Inquiries, Accreditations and Principals and all three 404'd.
   * In dev that presents as a long pause while Next compiles the not-found page rather than as an
   * obvious error, which is exactly how it survived review — it was reported as "empty pages load
   * slowly". A nav entry is a promise that the route works, so the promise is now checked.
   */
  it("every registered nav href resolves to an app route", () => {
    const appDir = join(process.cwd(), "src", "app");

    for (const entry of registry.nav) {
      const segments = entry.href.split("/").filter(Boolean);
      const candidates = [
        join(appDir, ...segments, "page.tsx"),
        // Route groups and dynamic segments would need a real route resolver; nothing uses them
        // yet, so a miss here means the page genuinely does not exist.
        join(appDir, ...segments, "page.ts"),
      ];
      expect(
        candidates.some((c) => existsSync(c)),
        `Nav entry "${entry.label}" points at ${entry.href}, but no page exists for it. ` +
          `Either build the page or remove the nav entry until you do.`,
      ).toBe(true);
    }
  });
});

describe("seeded numbering", () => {
  it("has an account format — §2's ACC-{####}, now under the house prefix", async () => {
    const format = await db.numberingFormat.findUnique({ where: { documentType: "account" } });
    expect(format, "run `npm run seed`").not.toBeNull();
    // No year segment: an account code identifies a customer relationship permanently, so the
    // counter must never reset the way a dated document's does.
    expect(format?.format).toBe("AIESACC-{####}");
  });
});
