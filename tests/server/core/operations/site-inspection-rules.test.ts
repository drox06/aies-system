import { describe, expect, it } from "vitest";
import {
  UTILITIES,
  canOpenSiteInspection,
  canReviseInspection,
  canSeeAnySiteInspection,
  inspectionCompleteness,
  inspectionRequiredForTicket,
  isInspectionEditable,
  describeAttendees,
  readUtilities,
  scopeChangeVerdict,
} from "@/server/core/operations/site-inspection-rules";

/**
 * specs/04-operations-projects.md §6.1, as pure functions.
 *
 * The rule that carries the most weight here is the scope-change one, because §6.1 says so: "This
 * link is one of the highest-value things the platform does." A link that fires twice is one people
 * stop reading, and a link that fires on an empty flag tells sales nothing they can act on.
 */

const BASE = {
  inspectedAt: new Date("2026-08-20T00:00:00.000Z"),
  inspectedByIds: ["tech-1"],
  attendees: [{ party: "sales" }, { party: "technical" }],
  findings: "Existing flow meter is a DN100, not the DN150 on the drawing.",
  photoCount: 1,
  scopeChangeIdentified: false,
  scopeChangeNotes: null as string | null,
};

/**
 * Who attended, as the company redrew it on 2026-08-17: departments for AIES's own people, names for
 * everybody else. The rule that carries weight is the last one — "others" with nothing after it
 * records nothing at all, the same failure §9's unexplained waiver and §10's absent witness are
 * refused for.
 */
describe("§6.1's attendance", () => {
  it("completes on a department alone", () => {
    expect(inspectionCompleteness({ ...BASE, attendees: [{ party: "sales" }] }).complete).toBe(
      true,
    );
  });

  it("refuses an inspection nobody attended", () => {
    const check = inspectionCompleteness({ ...BASE, attendees: [] });
    expect(check.complete).toBe(false);
    expect(check.missing.join(" ")).toMatch(/who attended/);
  });

  it("refuses an unnamed guest", () => {
    const check = inspectionCompleteness({
      ...BASE,
      attendees: [{ party: "technical" }, { party: "other", name: "  " }],
    });
    expect(check.complete).toBe(false);
    expect(check.missing.join(" ")).toMatch(/recorded as "others"/);
  });

  it("accepts a named guest", () => {
    const check = inspectionCompleteness({
      ...BASE,
      attendees: [{ party: "other", name: "Plant engineer, ACME" }],
    });
    expect(check.complete).toBe(true);
  });

  it("says the attendance back in words, name first", () => {
    expect(
      describeAttendees([
        { party: "sales" },
        { party: "technical", name: "DJ" },
        { party: "customer_rep", name: "Juan dela Cruz" },
        { party: "other", name: "Plant engineer" },
      ]),
    ).toBe("Sales, DJ (Technical), Juan dela Cruz (Customer Representative), Plant engineer");
  });
});

describe("§6.1 — revising an accomplished report", () => {
  it("lets the person who conducted the inspection revise a completed report", () => {
    expect(canReviseInspection({ status: "completed", inspectedByIds: ["tech-1"] }, "tech-1")).toBe(
      true,
    );
  });

  it("refuses anyone not named as having conducted it", () => {
    expect(
      canReviseInspection({ status: "completed", inspectedByIds: ["tech-1"] }, "bystander"),
    ).toBe(false);
  });

  it("refuses revision once approved, even for the person who conducted it", () => {
    expect(canReviseInspection({ status: "approved", inspectedByIds: ["tech-1"] }, "tech-1")).toBe(
      false,
    );
  });

  it("refuses revision before it is even completed", () => {
    expect(canReviseInspection({ status: "scheduled", inspectedByIds: ["tech-1"] }, "tech-1")).toBe(
      false,
    );
  });
});

describe("§6.1's completeness", () => {
  it("accepts a report with a date, an attendee and findings", () => {
    expect(inspectionCompleteness(BASE).complete).toBe(true);
  });

  it("names each missing field rather than refusing generically", () => {
    const check = inspectionCompleteness({
      ...BASE,
      inspectedAt: null,
      inspectedByIds: [],
      attendees: [],
      findings: "  ",
    });
    expect(check.complete).toBe(false);
    expect(check.missing).toHaveLength(3);
    expect(check.missing.join(" ")).toMatch(/who attended/);
  });

  /**
   * The deliberate non-rule.
   *
   * A refused-entry visit produces no photographs and is still a real inspection whose finding is
   * "we could not get in". Blocking on photographs would make that unrecordable, and a gate people
   * cannot satisfy honestly gets satisfied dishonestly — one meaningless photograph to clear it.
   */
  it("warns about missing photographs without blocking", () => {
    const check = inspectionCompleteness({ ...BASE, photoCount: 0 });
    expect(check.complete).toBe(true);
    expect(check.warnings.join(" ")).toMatch(/No photographs/);
  });

  /** The one hard rule beyond the three: a scope-change flag with nothing sales can act on. */
  it("refuses a scope change flagged with no explanation", () => {
    const check = inspectionCompleteness({
      ...BASE,
      scopeChangeIdentified: true,
      scopeChangeNotes: null,
    });
    expect(check.complete).toBe(false);
    expect(check.missing.join(" ")).toMatch(/what changed about the scope/);
  });

  it("accepts a scope change that is explained", () => {
    const check = inspectionCompleteness({
      ...BASE,
      scopeChangeIdentified: true,
      scopeChangeNotes: "Two extra tie-in points not on the drawing.",
    });
    expect(check.complete).toBe(true);
  });
});

describe("§6's branch", () => {
  it("says a new project wants a survey", () => {
    expect(inspectionRequiredForTicket({ type: "new_project" })).toBe(true);
  });

  it("does not require one for the other three types", () => {
    for (const type of ["installation", "after_sales", "delivery"]) {
      expect(inspectionRequiredForTicket({ type })).toBe(false);
    }
  });
});

describe("editability", () => {
  it("allows edits while scheduled or completed", () => {
    expect(isInspectionEditable("scheduled")).toBe(true);
    expect(isInspectionEditable("completed")).toBe(true);
  });

  it("closes an approved report — a signature does not get rewritten", () => {
    expect(isInspectionEditable("approved")).toBe(false);
  });
});

describe("§6.1's scope-change link", () => {
  it("does not fire when nothing was flagged", () => {
    expect(
      scopeChangeVerdict({
        scopeChangeIdentified: false,
        scopeChangeNotes: null,
        scopeChangeReportedAt: null,
      }).shouldReport,
    ).toBe(false);
  });

  it("fires on the first save that flags it with an explanation", () => {
    expect(
      scopeChangeVerdict({
        scopeChangeIdentified: true,
        scopeChangeNotes: "Two extra tie-in points.",
        scopeChangeReportedAt: null,
      }).shouldReport,
    ).toBe(true);
  });

  /**
   * The rule that keeps the warning worth reading.
   *
   * A surveyor correcting a measurement re-saves the record. If that sent a second "the job is
   * bigger than quoted" notification, sales would learn to close them unread — which is precisely
   * the warning §6.1 says must land.
   */
  it("never fires twice for one inspection", () => {
    const verdict = scopeChangeVerdict({
      scopeChangeIdentified: true,
      scopeChangeNotes: "Two extra tie-in points.",
      scopeChangeReportedAt: new Date("2026-08-20T00:00:00.000Z"),
    });
    expect(verdict.shouldReport).toBe(false);
    expect(verdict.reason).toMatch(/already been told/);
  });

  it("holds back a flag with no explanation, so a half-filled draft does not page sales", () => {
    const verdict = scopeChangeVerdict({
      scopeChangeIdentified: true,
      scopeChangeNotes: "   ",
      scopeChangeReportedAt: null,
    });
    expect(verdict.shouldReport).toBe(false);
    expect(verdict.reason).toMatch(/Say what changed/);
  });
});

describe("§6.1's utilities", () => {
  it("reports all five, whatever the record holds", () => {
    expect(readUtilities({}).map((u) => u.key)).toEqual([...UTILITIES]);
  });

  /**
   * Absent is not "not available", and the difference is a wasted day.
   *
   * A planner who reads "no crane" brings one. A planner who reads "nobody checked" asks. Collapsing
   * the two into a boolean would turn every unanswered question into a confident "no".
   */
  it("keeps unchecked distinct from unavailable", () => {
    const utilities = readUtilities({ power: { available: false }, water: { available: true } });
    const byKey = Object.fromEntries(utilities.map((u) => [u.key, u.available]));
    expect(byKey.power).toBe(false);
    expect(byKey.water).toBe(true);
    expect(byKey.crane).toBeNull();
  });

  it("carries a note when one was left", () => {
    const utilities = readUtilities({ power: { available: true, note: "415V, 60A spare way" } });
    expect(utilities.find((u) => u.key === "power")?.note).toBe("415V, 60A spare way");
  });

  it("survives a malformed column rather than throwing at a surveyor", () => {
    expect(readUtilities(null)).toHaveLength(5);
    expect(readUtilities("nonsense")).toHaveLength(5);
    expect(readUtilities({ power: "yes" }).find((u) => u.key === "power")?.available).toBeNull();
  });
});

describe("canOpenSiteInspection", () => {
  const inspection = { inspectedByIds: ["inspector-1"], requestedById: "requester-1" };

  it("lets in whoever attended", () => {
    expect(
      canOpenSiteInspection(inspection, { id: "inspector-1", email: "someone@test.local" }),
    ).toBe(true);
  });

  it("lets in whoever asked for it", () => {
    expect(
      canOpenSiteInspection(inspection, { id: "requester-1", email: "someone@test.local" }),
    ).toBe(true);
  });

  it("refuses a bystander with none of those, whatever permission they hold elsewhere", () => {
    expect(
      canOpenSiteInspection(inspection, { id: "bystander-1", email: "bystander@test.local" }),
    ).toBe(false);
  });

  /**
   * The company's own instruction (2026-09-03): "make it downloadable and online viewing by ea, kj,
   * dj, person who raised the site inspection, and by the person that conducted the inspection." —
   * named by email rather than a role, same reasoning as ARCHIVE_FULL_ACCESS_EMAILS: the
   * practice-authority grant gives all five named users the president role, so PD and EM must stay
   * out even though they hold exactly the same role EA does today.
   */
  it("lets EA, KJ and DJ in by name, uninvolved in the record entirely", () => {
    for (const address of [
      "ea@aieselectromech.com",
      "kj@aieselectromech.com",
      "dj@aieselectromech.com",
    ]) {
      expect(canOpenSiteInspection(inspection, { id: "stranger", email: address })).toBe(true);
    }
    // Case-insensitive, the same as ARCHIVE_FULL_ACCESS_EMAILS — a session claim is not guaranteed
    // to arrive lower-cased.
    expect(canSeeAnySiteInspection("EA@AIESELECTROMECH.COM")).toBe(true);

    // Two people who hold the identical practice-period "president" role EA does, and are still not
    // one of the three named — the whole reason this is an email list and not a role check.
    expect(canOpenSiteInspection(inspection, { id: "pd", email: "pd@aieselectromech.com" })).toBe(
      false,
    );
    expect(canOpenSiteInspection(inspection, { id: "em", email: "em@aieselectromech.com" })).toBe(
      false,
    );
  });
});
