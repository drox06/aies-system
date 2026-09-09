import { describe, expect, it } from "vitest";
import {
  demobChecklist,
  mobilizationReadiness,
  type ReadinessInput,
} from "@/server/core/operations/mobilization-rules";

/**
 * specs/04-operations-projects.md §8's readiness check, as a pure function.
 *
 * docs/DECISIONS.md #197 (2026-09-09): only `downpayment` and `cash_advance` are mandatory now —
 * method statement and materials moved upstream to quoting, and the crew/PPE/gate-pass/permits/
 * customer-contact rows the checklist used to block on are shown but no longer stop a mobilisation.
 * So the assertions that matter are which two items can still block, and that nothing else can.
 */

const CLEAR: ReadinessInput = {
  ticketType: "installation",
  downpayment: { blocks: false, message: "received" },
  cashAdvance: { blocks: false, message: "released" },
  materials: { blocks: false, message: "issued" },
  methodology: { blocks: false, message: "approved" },
  crewIds: ["tech-1", "tech-2"],
  gatePassStatus: "obtained",
  permitStatus: "not_required",
  inductionCompleted: true,
  toolsChecklist: [{ label: "Torque wrench", checked: true }],
  ppeChecklist: [{ label: "Harness", checked: true }],
  customerContactConfirmed: true,
};

const itemFor = (input: ReadinessInput, key: string) =>
  mobilizationReadiness(input).items.find((item) => item.key === key)!;

describe("§8's readiness check", () => {
  it("is ready when everything mandatory passes", () => {
    const readiness = mobilizationReadiness(CLEAR);
    expect(readiness.ready).toBe(true);
    expect(readiness.blockers).toEqual([]);
  });

  it("blocks on each of the two money gates in turn", () => {
    for (const gate of ["downpayment", "cashAdvance"] as const) {
      const readiness = mobilizationReadiness({
        ...CLEAR,
        [gate]: { blocks: true, message: "not yet" },
      });
      expect(readiness.ready, gate).toBe(false);
    }
  });

  /**
   * docs/DECISIONS.md #197: method statement and materials moved to quoting and stopped blocking —
   * on any ticket type, not only the ones §6 used to excuse.
   */
  it("shows a blocked method statement or materials line without blocking on it", () => {
    const readiness = mobilizationReadiness({
      ...CLEAR,
      ticketType: "new_project",
      methodology: { blocks: true, message: "not approved" },
      materials: { blocks: true, message: "not issued" },
    });
    expect(readiness.ready).toBe(true);
    const methodology = readiness.items.find((item) => item.key === "methodology")!;
    expect(methodology.state).toBe("fail");
    expect(methodology.mandatory).toBe(false);
    const materials = readiness.items.find((item) => item.key === "materials")!;
    expect(materials.state).toBe("fail");
    expect(materials.mandatory).toBe(false);
  });

  /**
   * The overrides built in sessions 2 and 4 move the ticket's status but the gate functions still
   * read the underlying record and still say no. Without this they would open nothing — an escape
   * hatch that does not open is worse than none, because somebody uses it and believes they are
   * through.
   */
  it("lets an officer's override clear the gate it was made against", () => {
    const blocked = { ...CLEAR, cashAdvance: { blocks: true, message: "not released" } };
    expect(mobilizationReadiness(blocked).ready).toBe(false);

    const overridden = mobilizationReadiness({
      ...blocked,
      overrides: { cash_advance: "Typhoon repair; crew fronting costs." },
    });
    expect(overridden.ready).toBe(true);
    // The reason travels onto the list, so a dispatcher sees why the line is green.
    const item = overridden.items.find((entry) => entry.key === "cash_advance")!;
    expect(item.state).toBe("pass");
    expect(item.detail).toMatch(/Typhoon repair/);
  });

  /** docs/DECISIONS.md #186's own escape hatch, the same shape as the other three. */
  it("lets an officer's downpayment override clear the gate it was made against", () => {
    const blocked = { ...CLEAR, downpayment: { blocks: true, message: "awaiting downpayment" } };
    expect(mobilizationReadiness(blocked).ready).toBe(false);

    const overridden = mobilizationReadiness({
      ...blocked,
      overrides: { downpayment: "Long-standing client; VP approved sending the crew ahead." },
    });
    expect(overridden.ready).toBe(true);
    const item = overridden.items.find((entry) => entry.key === "downpayment")!;
    expect(item.state).toBe("pass");
    expect(item.detail).toMatch(/Long-standing client/);
  });

  it("shows a crew of nobody without blocking on it", () => {
    const readiness = mobilizationReadiness({ ...CLEAR, crewIds: [] });
    expect(readiness.ready).toBe(true);
    const crew = readiness.items.find((item) => item.key === "crew")!;
    expect(crew.state).toBe("fail");
    expect(crew.mandatory).toBe(false);
  });

  it("shows an unconfirmed customer contact without blocking on it", () => {
    const readiness = mobilizationReadiness({ ...CLEAR, customerContactConfirmed: false });
    expect(readiness.ready).toBe(true);
    const contact = readiness.items.find((item) => item.key === "customer_contact")!;
    expect(contact.state).toBe("fail");
    expect(contact.mandatory).toBe(false);
  });
});

describe("§8's rows that are shown but no longer block, docs/DECISIONS.md #197", () => {
  /** Same shape as §7's N/A: "needs none" and "nobody asked" must not look alike, even unenforced. */
  it("tells a gate pass recorded as not required apart from one still pending", () => {
    expect(itemFor({ ...CLEAR, gatePassStatus: "not_required" }, "gate_pass").state).toBe(
      "not_applicable",
    );
    expect(mobilizationReadiness({ ...CLEAR, gatePassStatus: "not_required" }).ready).toBe(true);

    expect(itemFor({ ...CLEAR, gatePassStatus: "pending" }, "gate_pass").state).toBe("fail");
    expect(mobilizationReadiness({ ...CLEAR, gatePassStatus: "pending" }).ready).toBe(true);
  });

  /**
   * An empty PPE list is not a crew that needs none — it is a checklist nobody filled in, and this
   * is the one place where an absence is treated as a failure rather than as "not applicable" — but
   * since #197 it is shown, not enforced.
   */
  it("shows an empty PPE checklist as a failure without blocking on it", () => {
    const readiness = mobilizationReadiness({ ...CLEAR, ppeChecklist: [] });
    expect(readiness.ready).toBe(true);
    expect(itemFor({ ...CLEAR, ppeChecklist: [] }, "ppe").detail).toMatch(/not the same as/);
  });

  it("shows an unticked tool as a failure without blocking, and no tools list as merely unknown", () => {
    const unticked = mobilizationReadiness({
      ...CLEAR,
      toolsChecklist: [{ label: "Wrench", checked: false }],
    });
    expect(unticked.ready).toBe(true);
    expect(unticked.items.find((item) => item.key === "tools")!.state).toBe("fail");
    // No checklist at all is not a failure: plenty of jobs take nothing from the store.
    expect(mobilizationReadiness({ ...CLEAR, toolsChecklist: [] }).ready).toBe(true);
    expect(itemFor({ ...CLEAR, toolsChecklist: [] }, "tools").state).toBe("unknown");
  });

  /**
   * Module 08 owns competence and does not exist. Asserting a pass would be a lie; asserting a fail
   * would block every mobilisation. Unknown and non-blocking is the honest third option, and it is
   * on the list so its absence is visible rather than mistaken for a tick.
   */
  it("shows crew competence as unknown without blocking on it", () => {
    const item = itemFor(CLEAR, "competence");
    expect(item.state).toBe("unknown");
    expect(item.mandatory).toBe(false);
    expect(mobilizationReadiness(CLEAR).ready).toBe(true);
  });

  it("shows a missing induction without blocking", () => {
    const readiness = mobilizationReadiness({ ...CLEAR, inductionCompleted: false });
    expect(readiness.ready).toBe(true);
    expect(itemFor({ ...CLEAR, inductionCompleted: false }, "induction").state).toBe("fail");
  });
});

describe("§8's demobilisation checklist", () => {
  it("reports a clean return", () => {
    const check = demobChecklist([]);
    expect(check.toolsReconciled).toBe(true);
    expect(check.outstandingCount).toBe(0);
  });

  /**
   * Reported, not enforced. A crew that lost a tool still has to demobilise — refusing would leave
   * the ticket open forever and the loss unrecorded, which is worse than recording both.
   */
  it("names what did not come back, and says the loss is recorded rather than hidden", () => {
    const check = demobChecklist([{ description: "Torque wrench", outstanding: 1 }]);
    expect(check.toolsReconciled).toBe(false);
    expect(check.message).toMatch(/Torque wrench/);
    expect(check.message).toMatch(/records the loss rather than hiding it/);
  });
});
