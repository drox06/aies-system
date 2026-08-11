import { describe, expect, it } from "vitest";
import { resolveStepEligibility } from "@/server/core/approvals/eligibility";
import type { ApprovalStepDef } from "@/server/core/approvals/types";
import type { AuthedUser } from "@/server/core/rbac/types";

function user(overrides: Partial<AuthedUser> = {}): AuthedUser {
  return {
    id: "u1",
    email: "u1@test",
    name: "U1",
    roleKeys: [],
    permissions: new Set(),
    ...overrides,
  };
}

describe("resolveStepEligibility — role/permission/user-based steps", () => {
  it("requiredRole matches only users holding that role", async () => {
    const step: ApprovalStepDef = { name: "s", requiredRole: "vice_president", mode: "parallel" };
    const eligibility = await resolveStepEligibility(step, new Date());

    expect(eligibility.isEligibleToDecide(user({ roleKeys: ["vice_president"] }))).toBe(true);
    expect(eligibility.isEligibleToDecide(user({ roleKeys: ["sales"] }))).toBe(false);
    expect(eligibility.isInInbox(user({ roleKeys: ["vice_president"] }))).toBe(true);
    expect(eligibility.isFallbackDecision(user({ roleKeys: ["vice_president"] }))).toBe(false);
  });

  it("requiredPermission matches only users holding that permission", async () => {
    const step: ApprovalStepDef = {
      name: "s",
      requiredPermission: "quotation.approve",
      mode: "parallel",
    };
    const eligibility = await resolveStepEligibility(step, new Date());

    expect(
      eligibility.isEligibleToDecide(user({ permissions: new Set(["quotation.approve"]) })),
    ).toBe(true);
    expect(eligibility.isEligibleToDecide(user())).toBe(false);
  });

  it("specificUserId matches only that exact user", async () => {
    const step: ApprovalStepDef = { name: "s", specificUserId: "u42", mode: "parallel" };
    const eligibility = await resolveStepEligibility(step, new Date());

    expect(eligibility.isEligibleToDecide(user({ id: "u42" }))).toBe(true);
    expect(eligibility.isEligibleToDecide(user({ id: "u43" }))).toBe(false);
  });
});

describe("resolveStepEligibility — approvalRuleKey (fallback-integrated) steps", () => {
  // Seeded by prisma/seed.ts: primary vice_president, fallback president, escalateAfterHours: 4.
  const step: ApprovalStepDef = {
    name: "cash advance",
    approvalRuleKey: "cash_advance.approve",
    mode: "parallel",
  };

  /**
   * Fixed Manila instants rather than offsets from `Date.now()`.
   *
   * The window counts **working** hours now, so "five hours ago" is five hours only on a working
   * day — run this suite on a Saturday and an offset-based test would silently assert the opposite
   * of what it reads. Monday 2026-08-10 is a working day whatever day the suite runs.
   */
  const manila = (isoLocal: string) => new Date(`${isoLocal}+08:00`);
  const MONDAY_9AM = manila("2026-08-10T09:00:00");

  it("the president can always decide immediately, before the window elapses", async () => {
    const requestedAt = manila("2026-08-10T08:55:00"); // 5 minutes before, window is 4h
    const eligibility = await resolveStepEligibility(step, requestedAt, MONDAY_9AM);

    expect(eligibility.isEligibleToDecide(user({ roleKeys: ["president"] }))).toBe(true);
    expect(eligibility.isEligibleToDecide(user({ roleKeys: ["vice_president"] }))).toBe(true);
    expect(eligibility.isEligibleToDecide(user({ roleKeys: ["sales"] }))).toBe(false);
  }, 30_000);

  it("only the VP sees it in the inbox before the window elapses; the president also does after", async () => {
    const early = await resolveStepEligibility(step, manila("2026-08-10T08:55:00"), MONDAY_9AM);
    expect(early.isInInbox(user({ roleKeys: ["vice_president"] }))).toBe(true);
    expect(early.isInInbox(user({ roleKeys: ["president"] }))).toBe(false);

    // Five working hours earlier, past the 4h window.
    const late = await resolveStepEligibility(step, manila("2026-08-10T04:00:00"), MONDAY_9AM);
    expect(late.isInInbox(user({ roleKeys: ["vice_president"] }))).toBe(true); // still there — not a handoff
    expect(late.isInInbox(user({ roleKeys: ["president"] }))).toBe(true);
  }, 30_000);

  it("a president's decision is stamped as a fallback; a VP's is not", async () => {
    const eligibility = await resolveStepEligibility(step, new Date());

    expect(eligibility.isFallbackDecision(user({ roleKeys: ["president"] }))).toBe(true);
    expect(eligibility.isFallbackDecision(user({ roleKeys: ["vice_president"] }))).toBe(false);
  }, 30_000);
});
