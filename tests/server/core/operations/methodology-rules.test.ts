import { describe, expect, it } from "vitest";
import {
  METHODOLOGY_STATUSES,
  canTransition,
  clientTurnaround,
  isMethodologyEditable,
  materialRequestSeed,
  methodologyCompleteness,
  methodologyGate,
} from "@/server/core/operations/methodology-rules";

/**
 * specs/04-operations-projects.md §6.2, as pure functions.
 *
 * The assertion that carries the section is the gate's: mobilization needs `client_approved` **and**
 * the client's document. A status is something AIES set; the document is something the customer
 * signed, and §6.2 exists to win exactly that argument.
 */

const COMPLETE = {
  scopeSummary: "Replace two DN100 ultrasonic flowmeters on the raw water line.",
  sequenceOfWork: [
    { step: 1, description: "Isolate and drain", durationHours: 2, crew: "2 techs" },
  ],
  manpowerPlan: [{ role: "Instrument technician", count: 2 }],
  safetyPlan: "Confined space entry permit, gas testing before entry, standby man.",
  durationDays: 3,
  toolsRequired: ["Torque wrench"],
  materialsRequired: [{ description: "DN100 gasket set", quantity: "2", unit: "set" }],
  permitsRequired: ["Hot work"],
};

describe("§6.2's statuses", () => {
  it("is the seven the spec names", () => {
    expect([...METHODOLOGY_STATUSES]).toEqual([
      "draft",
      "internal_review",
      "approved",
      "submitted_to_client",
      "client_approved",
      "client_rejected",
      "superseded",
    ]);
  });

  it("routes draft → review → approved → client", () => {
    expect(canTransition("draft", "internal_review")).toBe(true);
    expect(canTransition("internal_review", "approved")).toBe(true);
    expect(canTransition("approved", "submitted_to_client")).toBe(true);
    expect(canTransition("submitted_to_client", "client_approved")).toBe(true);
  });

  it("will not send a draft straight to the client", () => {
    expect(canTransition("draft", "submitted_to_client")).toBe(false);
  });

  /**
   * §6.2: a rejection "returns the methodology to draft **and creates a revision**".
   *
   * So the rejected row itself goes nowhere. A document that could be edited back into
   * acceptability would prove nothing about what the client actually turned down, and §6.2 calls the
   * chain "the evidence of what was agreed".
   */
  it("leaves a client-rejected revision rejected", () => {
    expect(canTransition("client_rejected", "draft")).toBe(false);
    expect(canTransition("client_rejected", "submitted_to_client")).toBe(false);
    expect(canTransition("client_rejected", "superseded")).toBe(true);
  });

  it("closes editing once it has left AIES", () => {
    expect(isMethodologyEditable("draft")).toBe(true);
    expect(isMethodologyEditable("internal_review")).toBe(true);
    for (const status of ["approved", "submitted_to_client", "client_approved", "superseded"]) {
      expect(isMethodologyEditable(status), status).toBe(false);
    }
  });
});

describe("§6.2's completeness", () => {
  it("accepts a method statement that describes a method", () => {
    expect(methodologyCompleteness(COMPLETE).complete).toBe(true);
  });

  it("names each missing piece", () => {
    const check = methodologyCompleteness({
      ...COMPLETE,
      scopeSummary: "  ",
      sequenceOfWork: [],
      manpowerPlan: [],
      safetyPlan: null,
    });
    expect(check.complete).toBe(false);
    expect(check.missing).toHaveLength(4);
    expect(check.missing.join(" ")).toMatch(/safety plan/);
  });

  /**
   * Duration warns rather than blocks: a survey-first job legitimately does not know it, and forcing
   * a number produces a fictional one that the schedule then gets built on.
   */
  it("warns about a missing duration without blocking", () => {
    const check = methodologyCompleteness({ ...COMPLETE, durationDays: null });
    expect(check.complete).toBe(true);
    expect(check.warnings.join(" ")).toMatch(/No duration/);
  });

  it("warns when there is nothing for the material request to start from", () => {
    const check = methodologyCompleteness({
      ...COMPLETE,
      toolsRequired: [],
      materialsRequired: [],
    });
    expect(check.complete).toBe(true);
    expect(check.warnings.join(" ")).toMatch(/typed from scratch/);
  });
});

describe("§6.2's gate", () => {
  const base = {
    status: "client_approved",
    clientApprovalRequired: true,
    clientApprovalFileId: "file-1",
    submittedToClientAt: new Date("2026-08-01T00:00:00.000Z"),
  };

  it("blocks when there is no method statement at all", () => {
    const gate = methodologyGate(null);
    expect(gate.blocks).toBe(true);
    expect(gate.message).toMatch(/No method statement/);
  });

  it("clears when the client approved it and their document is on file", () => {
    expect(methodologyGate(base).blocks).toBe(false);
  });

  /**
   * The assertion this whole section turns on.
   *
   * Gating on the status alone would let the company mobilise on somebody's recollection of a phone
   * call — which is precisely the dispute §6.2 exists to win, and it would lose it.
   */
  it("still blocks when marked client-approved with no document attached", () => {
    const gate = methodologyGate({ ...base, clientApprovalFileId: null });
    expect(gate.blocks).toBe(true);
    expect(gate.message).toMatch(/not attached/);
  });

  it("blocks while it is sitting with the client, and says how long", () => {
    const gate = methodologyGate({
      ...base,
      status: "submitted_to_client",
      clientApprovalFileId: null,
      submittedToClientAt: new Date(Date.now() - 5 * 86_400_000),
    });
    expect(gate.blocks).toBe(true);
    expect(gate.message).toMatch(/5 days/);
  });

  it("blocks a rejected one and points at the revision", () => {
    const gate = methodologyGate({
      ...base,
      status: "client_rejected",
      clientApprovalFileId: null,
    });
    expect(gate.blocks).toBe(true);
    expect(gate.message).toMatch(/revision was raised/);
  });

  it("does not block when the customer does not require approval", () => {
    const gate = methodologyGate({
      ...base,
      clientApprovalRequired: false,
      clientApprovalFileId: null,
    });
    expect(gate.state).toBe("not_required");
    expect(gate.blocks).toBe(false);
  });
});

describe("§6.2's turnaround", () => {
  it("says nothing before it is sent", () => {
    expect(
      clientTurnaround({ submittedToClientAt: null, clientApprovedAt: null, status: "draft" }).days,
    ).toBeNull();
  });

  it("counts the days the client took", () => {
    const result = clientTurnaround({
      submittedToClientAt: new Date("2026-08-01T00:00:00.000Z"),
      clientApprovedAt: new Date("2026-08-18T00:00:00.000Z"),
      status: "client_approved",
    });
    expect(result.days).toBe(17);
    expect(result.pending).toBe(false);
  });

  it("keeps counting while it is unanswered", () => {
    const result = clientTurnaround(
      {
        submittedToClientAt: new Date("2026-08-01T00:00:00.000Z"),
        clientApprovedAt: null,
        status: "submitted_to_client",
      },
      new Date("2026-08-09T00:00:00.000Z"),
    );
    expect(result.days).toBe(8);
    expect(result.pending).toBe(true);
  });
});

describe("§7's head start", () => {
  /** §6.2: "Nobody should type the same list twice." */
  it("turns materials and tools into a material request", () => {
    const seed = materialRequestSeed(COMPLETE);
    expect(seed).toEqual([
      { description: "DN100 gasket set", quantity: "2", unit: "set" },
      { description: "Torque wrench", quantity: "1", unit: "set" },
    ]);
  });

  it("survives a malformed materials column", () => {
    expect(materialRequestSeed({ toolsRequired: [], materialsRequired: "nonsense" })).toEqual([]);
  });
});
