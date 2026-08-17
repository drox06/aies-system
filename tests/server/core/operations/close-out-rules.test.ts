import { describe, expect, it } from "vitest";
import {
  CLOSE_OUT_BLOCKERS,
  SERVICE_REPORT_STATUSES,
  checkServiceReport,
  closeOutChecklist,
  closeOutVerdict,
  type CloseOutBlockerKey,
  type CloseOutInput,
} from "@/server/core/operations/close-out-rules";

/**
 * specs/04-operations-projects.md §12, as pure functions.
 *
 * §20 names the test this section owes: "Close-out blocked independently by each blocker in §12;
 * each unblocks in isolation."
 */

const clear: CloseOutInput = {
  criticalPunchItems: 0,
  unapprovedServiceReports: 0,
  failedQa: 0,
  unliquidatedCashAdvances: 0,
  unreturnedTools: 0,
  customerAcceptanceRequired: true,
  customerAcceptanceFileId: "file-acceptance",
};

/** One field per blocker, so each can be turned on alone. */
const RAISE: Record<CloseOutBlockerKey, Partial<CloseOutInput>> = {
  critical_punch_items: { criticalPunchItems: 2 },
  unapproved_service_reports: { unapprovedServiceReports: 1 },
  failed_qa: { failedQa: 1 },
  unliquidated_cash_advances: { unliquidatedCashAdvances: 3 },
  unreturned_tools: { unreturnedTools: 4 },
  missing_customer_acceptance: { customerAcceptanceFileId: null },
};

describe("§12's vocabulary", () => {
  it("is the six blockers and five report statuses the spec names", () => {
    expect([...CLOSE_OUT_BLOCKERS]).toEqual([
      "critical_punch_items",
      "unapproved_service_reports",
      "failed_qa",
      "unliquidated_cash_advances",
      "unreturned_tools",
      "missing_customer_acceptance",
    ]);
    expect([...SERVICE_REPORT_STATUSES]).toEqual([
      "draft",
      "pending_signature",
      "signed",
      "submitted",
      "approved",
    ]);
  });
});

describe("§20's named case: each blocker blocks alone and releases alone", () => {
  it("lets a project close when everything is clear", () => {
    const verdict = closeOutVerdict(closeOutChecklist(clear));
    expect(verdict.canClose).toBe(true);
    expect(verdict.blockers).toHaveLength(0);
  });

  /** Blocked independently: each one on its own is enough to hold close-out. */
  for (const key of CLOSE_OUT_BLOCKERS) {
    it(`blocks on ${key} alone`, () => {
      const verdict = closeOutVerdict(closeOutChecklist({ ...clear, ...RAISE[key] }));
      expect(verdict.canClose).toBe(false);
      expect(verdict.blockers.map((entry) => entry.key)).toEqual([key]);
    });
  }

  /** Unblocks in isolation: clearing that one, with the others clear, closes the project. */
  for (const key of CLOSE_OUT_BLOCKERS) {
    it(`releases when ${key} is cleared and nothing else is outstanding`, () => {
      const raised = closeOutVerdict(closeOutChecklist({ ...clear, ...RAISE[key] }));
      expect(raised.canClose).toBe(false);

      const cleared = closeOutVerdict(closeOutChecklist(clear));
      expect(cleared.canClose).toBe(true);
    });
  }

  it("reports every blocker at once when several are outstanding", () => {
    const verdict = closeOutVerdict(
      closeOutChecklist({
        ...clear,
        criticalPunchItems: 1,
        unreturnedTools: 2,
        customerAcceptanceFileId: null,
      }),
    );
    expect(verdict.blockers).toHaveLength(3);
    expect(verdict.message).toMatch(/3 of 6 blocker\(s\) outstanding/);
  });
});

describe("§12's checklist, as a checklist", () => {
  /**
   * §12: "The blockers show as a checklist so the PM can see who owns each one." A list containing
   * only problems makes "clear" indistinguishable from "not checked".
   */
  it("returns every blocker, cleared ones included, each with an owner", () => {
    const checklist = closeOutChecklist(clear);
    expect(checklist).toHaveLength(6);
    for (const entry of checklist) {
      expect(entry.owner.length).toBeGreaterThan(0);
      expect(entry.detail.length).toBeGreaterThan(0);
    }
  });

  it("counts what is outstanding, so the detail is actionable", () => {
    const checklist = closeOutChecklist({ ...clear, unreturnedTools: 4 });
    const tools = checklist.find((entry) => entry.key === "unreturned_tools")!;
    expect(tools.count).toBe(4);
    expect(tools.detail).toMatch(/4 returnable item\(s\) still out/);
  });
});

describe("§12's customer acceptance, where required", () => {
  it("does not block when acceptance is not required on this project", () => {
    const verdict = closeOutVerdict(
      closeOutChecklist({
        ...clear,
        customerAcceptanceRequired: false,
        customerAcceptanceFileId: null,
      }),
    );
    expect(verdict.canClose).toBe(true);
  });

  /** A waiver is a deliberate act with a reason, not a blank field — §9's rule, again. */
  it("accepts an explained waiver but not a silent gap", () => {
    const silent = closeOutVerdict(closeOutChecklist({ ...clear, customerAcceptanceFileId: null }));
    expect(silent.canClose).toBe(false);

    const waived = closeOutVerdict(
      closeOutChecklist({
        ...clear,
        customerAcceptanceFileId: null,
        acceptanceWaiverReason:
          "Framework agreement covers acceptance; no per-project certificate.",
      }),
    );
    expect(waived.canClose).toBe(true);
    expect(
      waived.cleared.find((entry) => entry.key === "missing_customer_acceptance")!.detail,
    ).toMatch(/Waived:/);
  });
});

describe("§12's service report", () => {
  const base = {
    target: "draft" as const,
    workPerformed: "Replaced the seal and re-commissioned the pump.",
    followUpRequired: false,
  };

  it("accepts a draft with the work described", () => {
    expect(checkServiceReport(base).ok).toBe(true);
  });

  it("refuses a report with no work described", () => {
    const check = checkServiceReport({ ...base, workPerformed: " " });
    expect(check.ok).toBe(false);
    expect(check.errors.join(" ")).toMatch(/needs the work described/);
  });

  /** A report AIES signed alone is AIES's account of its own work. */
  it("refuses to mark a report signed with no customer signature and no reason", () => {
    const check = checkServiceReport({
      ...base,
      target: "signed",
      finishedAt: new Date(),
    });
    expect(check.ok).toBe(false);
    expect(check.errors.join(" ")).toMatch(/customer's signature, or a written reason/);
  });

  it("accepts a signature with the signer named", () => {
    const check = checkServiceReport({
      ...base,
      target: "signed",
      finishedAt: new Date(),
      customerSignatureFileId: "file-sig",
      customerName: "Plant engineer",
    });
    expect(check.ok).toBe(true);
  });

  it("refuses a signature nobody can attribute", () => {
    const check = checkServiceReport({
      ...base,
      target: "signed",
      finishedAt: new Date(),
      customerSignatureFileId: "file-sig",
    });
    expect(check.ok).toBe(false);
    expect(check.errors.join(" ")).toMatch(/Name who signed/);
  });

  it("accepts an honest waiver instead", () => {
    const check = checkServiceReport({
      ...base,
      target: "signed",
      finishedAt: new Date(),
      signatureWaiverReason:
        "Site cleared before the customer's engineer returned; emailed instead.",
    });
    expect(check.ok).toBe(true);
  });

  it("refuses to send an unfinished report to the customer", () => {
    const check = checkServiceReport({ ...base, target: "pending_signature" });
    expect(check.ok).toBe(false);
    expect(check.errors.join(" ")).toMatch(/when the work finished/);
  });

  it("refuses work that finished before it started", () => {
    const check = checkServiceReport({
      ...base,
      startedAt: new Date("2026-08-10T08:00:00.000Z"),
      finishedAt: new Date("2026-08-09T08:00:00.000Z"),
    });
    expect(check.ok).toBe(false);
    expect(check.errors.join(" ")).toMatch(/finished before it started/);
  });

  /** A flag with no description is not a handover. */
  it("refuses a follow-up flag with nothing said about it", () => {
    const check = checkServiceReport({ ...base, followUpRequired: true });
    expect(check.ok).toBe(false);
    expect(check.errors.join(" ")).toMatch(/Say what the follow-up is/);
  });

  it("refuses a part with no quantity", () => {
    const check = checkServiceReport({
      ...base,
      partsUsed: [{ description: "Mechanical seal", quantity: 0 }],
    });
    expect(check.ok).toBe(false);
    expect(check.errors.join(" ")).toMatch(/quantity above zero/);
  });
});
