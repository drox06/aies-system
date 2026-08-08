import { describe, expect, it } from "vitest";
import {
  isFallbackDecision,
  resolveApprovalFallback,
  type ApprovalRuleConfig,
} from "@/server/core/rbac/approval-fallback";

const cashAdvanceRule: ApprovalRuleConfig = {
  primaryApproverRole: "vice_president",
  fallbackApproverRole: "president",
  escalateAfterHours: 4,
};

describe("resolveApprovalFallback", () => {
  it("before the window elapses, only the VP sees it in their inbox", () => {
    const requestedAt = new Date("2026-08-08T08:00:00Z");
    const now = new Date("2026-08-08T10:00:00Z"); // 2h elapsed, window is 4h

    const result = resolveApprovalFallback(cashAdvanceRule, requestedAt, now);

    expect(result.isFallbackWindowElapsed).toBe(false);
    expect(result.inboxRoles).toEqual(["vice_president"]);
  });

  it("after the window elapses, it appears in the president's inbox too", () => {
    const requestedAt = new Date("2026-08-08T08:00:00Z");
    const now = new Date("2026-08-08T12:30:00Z"); // 4.5h elapsed, window is 4h

    const result = resolveApprovalFallback(cashAdvanceRule, requestedAt, now);

    expect(result.isFallbackWindowElapsed).toBe(true);
    expect(result.inboxRoles).toEqual(["vice_president", "president"]);
    expect(result.elapsedHours).toBeCloseTo(4.5, 5);
  });

  it("the president can always act immediately, before the window elapses", () => {
    const requestedAt = new Date("2026-08-08T08:00:00Z");
    const now = new Date("2026-08-08T08:05:00Z"); // 5 minutes elapsed

    const result = resolveApprovalFallback(cashAdvanceRule, requestedAt, now);

    expect(result.isFallbackWindowElapsed).toBe(false);
    expect(result.eligibleToDecideRoles).toContain("president");
  });

  it("the VP's inbox still lists the request after fallback activates (it is not a handoff)", () => {
    const requestedAt = new Date("2026-08-08T08:00:00Z");
    const now = new Date("2026-08-08T13:00:00Z");

    const result = resolveApprovalFallback(cashAdvanceRule, requestedAt, now);

    expect(result.inboxRoles).toContain("vice_president");
  });
});

describe("isFallbackDecision", () => {
  it("a VP decision is not a fallback", () => {
    expect(isFallbackDecision("vice_president", cashAdvanceRule)).toBe(false);
  });

  it("a president decision is a fallback, regardless of timing", () => {
    expect(isFallbackDecision("president", cashAdvanceRule)).toBe(true);
  });

  it("an unrelated role deciding is not classified as a fallback for this rule", () => {
    expect(isFallbackDecision("operations_manager", cashAdvanceRule)).toBe(false);
  });
});
