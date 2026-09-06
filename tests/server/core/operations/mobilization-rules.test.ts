import { describe, expect, it } from "vitest";
import {
  demobChecklist,
  mobilizationReadiness,
  type ReadinessInput,
} from "@/server/core/operations/mobilization-rules";

/**
 * specs/04-operations-projects.md §8's readiness check, as a pure function.
 *
 * §8: "`ready_to_mobilize` is only reachable when **all mandatory items pass**." So the assertions
 * that matter are about which items are mandatory and which are merely shown — a check that blocks
 * on everything gets overridden as a habit, and one that blocks on nothing is decoration.
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

  it("blocks on each of the unconditional gates in turn", () => {
    for (const gate of ["downpayment", "cashAdvance", "materials"] as const) {
      const readiness = mobilizationReadiness({
        ...CLEAR,
        [gate]: { blocks: true, message: "not yet" },
      });
      expect(readiness.ready, gate).toBe(false);
    }
  });

  /**
   * §6: "Only `new_project` tickets take this branch."
   *
   * Making an after-sales callout wait on a method statement would teach people to override the
   * gate, which is how an override stops meaning anything.
   */
  it("only requires a method statement on a new project", () => {
    const blocked = { ...CLEAR, methodology: { blocks: true, message: "not approved" } };

    expect(mobilizationReadiness({ ...blocked, ticketType: "after_sales" }).ready).toBe(true);
    expect(itemFor({ ...blocked, ticketType: "after_sales" }, "methodology").state).toBe(
      "not_applicable",
    );

    expect(mobilizationReadiness({ ...blocked, ticketType: "new_project" }).ready).toBe(false);
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

  it("does not let a cash advance override clear the methodology gate", () => {
    const readiness = mobilizationReadiness({
      ...CLEAR,
      ticketType: "new_project",
      methodology: { blocks: true, message: "not approved" },
      overrides: { cash_advance: "unrelated" },
    });
    expect(readiness.ready).toBe(false);
  });

  it("blocks a crew of nobody", () => {
    expect(mobilizationReadiness({ ...CLEAR, crewIds: [] }).ready).toBe(false);
  });

  it("blocks an unconfirmed customer contact", () => {
    expect(mobilizationReadiness({ ...CLEAR, customerContactConfirmed: false }).ready).toBe(false);
  });
});

describe("§8's conditionally mandatory items", () => {
  /** Same shape as §7's N/A: "needs none" and "nobody asked" must not look alike. */
  it("passes a gate pass recorded as not required, and fails one still pending", () => {
    expect(itemFor({ ...CLEAR, gatePassStatus: "not_required" }, "gate_pass").state).toBe(
      "not_applicable",
    );
    expect(mobilizationReadiness({ ...CLEAR, gatePassStatus: "not_required" }).ready).toBe(true);

    expect(itemFor({ ...CLEAR, gatePassStatus: "pending" }, "gate_pass").state).toBe("fail");
    expect(mobilizationReadiness({ ...CLEAR, gatePassStatus: "pending" }).ready).toBe(false);
  });

  /**
   * An empty PPE list is not a crew that needs none — it is a checklist nobody filled in, and this
   * is the one place where an absence is treated as a failure rather than as "not applicable".
   */
  it("fails an empty PPE checklist rather than reading it as none required", () => {
    const readiness = mobilizationReadiness({ ...CLEAR, ppeChecklist: [] });
    expect(readiness.ready).toBe(false);
    expect(itemFor({ ...CLEAR, ppeChecklist: [] }, "ppe").detail).toMatch(/not the same as/);
  });

  it("shows an unticked tool as blocking, and no tools list as merely unknown", () => {
    expect(
      mobilizationReadiness({ ...CLEAR, toolsChecklist: [{ label: "Wrench", checked: false }] })
        .ready,
    ).toBe(false);
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
