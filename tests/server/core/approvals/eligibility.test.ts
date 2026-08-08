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

  it("the president can always decide immediately, before the window elapses", async () => {
    const requestedAt = new Date(Date.now() - 5 * 60_000); // 5 minutes ago, window is 4h
    const eligibility = await resolveStepEligibility(step, requestedAt);

    expect(eligibility.isEligibleToDecide(user({ roleKeys: ["president"] }))).toBe(true);
    expect(eligibility.isEligibleToDecide(user({ roleKeys: ["vice_president"] }))).toBe(true);
    expect(eligibility.isEligibleToDecide(user({ roleKeys: ["sales"] }))).toBe(false);
  }, 30_000);

  it("only the VP sees it in the inbox before the window elapses; the president also does after", async () => {
    const recentRequest = new Date(Date.now() - 5 * 60_000);
    const early = await resolveStepEligibility(step, recentRequest);
    expect(early.isInInbox(user({ roleKeys: ["vice_president"] }))).toBe(true);
    expect(early.isInInbox(user({ roleKeys: ["president"] }))).toBe(false);

    const oldRequest = new Date(Date.now() - 5 * 60 * 60_000); // 5 hours ago, past the 4h window
    const late = await resolveStepEligibility(step, oldRequest);
    expect(late.isInInbox(user({ roleKeys: ["vice_president"] }))).toBe(true); // still there — not a handoff
    expect(late.isInInbox(user({ roleKeys: ["president"] }))).toBe(true);
  }, 30_000);

  it("a president's decision is stamped as a fallback; a VP's is not", async () => {
    const eligibility = await resolveStepEligibility(step, new Date());

    expect(eligibility.isFallbackDecision(user({ roleKeys: ["president"] }))).toBe(true);
    expect(eligibility.isFallbackDecision(user({ roleKeys: ["vice_president"] }))).toBe(false);
  }, 30_000);
});
