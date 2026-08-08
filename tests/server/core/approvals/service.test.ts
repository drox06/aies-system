import { randomUUID } from "node:crypto";
import { afterEach, describe, expect, it } from "vitest";
import { db } from "@/lib/db";
import {
  assertStepsSupported,
  createApprovalRequest,
  decideApprovalRequest,
  listMyApprovalInbox,
  upsertApprovalWorkflow,
} from "@/server/core/approvals/service";
import type { ApprovalStepDef } from "@/server/core/approvals/types";
import type { AuthedUser } from "@/server/core/rbac/types";

const entityType = `test_workflow_${randomUUID().replace(/-/g, "")}`;
const createdWorkflowIds: string[] = [];
const createdRequestIds: string[] = [];

function user(overrides: Partial<AuthedUser> = {}): AuthedUser {
  return {
    id: randomUUID(),
    email: "test@test",
    name: "Test",
    roleKeys: [],
    permissions: new Set(),
    ...overrides,
  };
}

async function makeWorkflow(steps: ApprovalStepDef[]) {
  const workflow = await upsertApprovalWorkflow({ entityType, name: "Test workflow", steps });
  createdWorkflowIds.push(workflow.id);
  return workflow;
}

afterEach(async () => {
  if (createdRequestIds.length > 0) {
    await db.approvalAction.deleteMany({ where: { requestId: { in: createdRequestIds } } });
    await db.approvalRequest.deleteMany({ where: { id: { in: createdRequestIds } } });
    createdRequestIds.length = 0;
  }
  if (createdWorkflowIds.length > 0) {
    await db.approvalWorkflow.deleteMany({ where: { id: { in: createdWorkflowIds } } });
    createdWorkflowIds.length = 0;
  }
  await db.eventOutbox.deleteMany({
    where: { event: { in: ["approval.requested", "approval.approved", "approval.rejected"] } },
  });
});

describe("assertStepsSupported", () => {
  it("rejects a step in unsupported 'sequential' mode", () => {
    expect(() =>
      assertStepsSupported([{ name: "s", requiredRole: "president", mode: "sequential" }]),
    ).toThrow(/not implemented/);
  });

  it("rejects a step with no eligibility rule at all", () => {
    expect(() => assertStepsSupported([{ name: "s", mode: "parallel" }])).toThrow(
      /no eligibility rule/,
    );
  });

  it("accepts a well-formed parallel step", () => {
    expect(() =>
      assertStepsSupported([{ name: "s", requiredRole: "president", mode: "parallel" }]),
    ).not.toThrow();
  });
});

describe("createApprovalRequest", () => {
  it("starts pending at the first step whose condition matches", async () => {
    const workflow = await makeWorkflow([
      {
        name: "big deals only",
        requiredRole: "president",
        mode: "parallel",
        condition: { field: "total", operator: ">", value: 500_000 },
      },
    ]);

    const request = await createApprovalRequest({
      entityType,
      entityId: "e1",
      workflowId: workflow.id,
      requestedById: "requester1",
      entitySnapshot: { total: 600_000 },
    });
    createdRequestIds.push(request.id);

    expect(request.status).toBe("pending");
    expect(request.currentStep).toBe(0);
  }, 30_000);

  it("auto-approves immediately when no step's condition matches", async () => {
    const workflow = await makeWorkflow([
      {
        name: "big deals only",
        requiredRole: "president",
        mode: "parallel",
        condition: { field: "total", operator: ">", value: 500_000 },
      },
    ]);

    const request = await createApprovalRequest({
      entityType,
      entityId: "e2",
      workflowId: workflow.id,
      requestedById: "requester1",
      entitySnapshot: { total: 100 },
    });
    createdRequestIds.push(request.id);

    expect(request.status).toBe("approved");
    expect(request.decidedAt).not.toBeNull();
  }, 30_000);

  it("emits approval.requested", async () => {
    const workflow = await makeWorkflow([
      { name: "s", requiredRole: "president", mode: "parallel" },
    ]);
    const request = await createApprovalRequest({
      entityType,
      entityId: "e3",
      workflowId: workflow.id,
      requestedById: "requester1",
      entitySnapshot: {},
    });
    createdRequestIds.push(request.id);

    const events = await db.eventOutbox.findMany({
      where: { event: "approval.requested" },
      orderBy: { createdAt: "desc" },
      take: 1,
    });
    expect((events[0]?.payload as { requestId: string }).requestId).toBe(request.id);
  }, 30_000);
});

describe("decideApprovalRequest", () => {
  it("an eligible approver's approval on a single-step workflow fully approves the request", async () => {
    const workflow = await makeWorkflow([
      { name: "s", requiredRole: "president", mode: "parallel" },
    ]);
    const request = await createApprovalRequest({
      entityType,
      entityId: "e4",
      workflowId: workflow.id,
      requestedById: "requester1",
      entitySnapshot: {},
    });
    createdRequestIds.push(request.id);

    const updated = await decideApprovalRequest({
      requestId: request.id,
      approver: user({ roleKeys: ["president"] }),
      decision: "approved",
    });

    expect(updated.status).toBe("approved");
    expect(updated.decidedAt).not.toBeNull();

    const events = await db.eventOutbox.findMany({ where: { event: "approval.approved" } });
    expect(events.some((e) => (e.payload as { requestId: string }).requestId === request.id)).toBe(
      true,
    );
  }, 30_000);

  it("an ineligible approver is rejected with an error, and the request stays pending", async () => {
    const workflow = await makeWorkflow([
      { name: "s", requiredRole: "president", mode: "parallel" },
    ]);
    const request = await createApprovalRequest({
      entityType,
      entityId: "e5",
      workflowId: workflow.id,
      requestedById: "requester1",
      entitySnapshot: {},
    });
    createdRequestIds.push(request.id);

    await expect(
      decideApprovalRequest({
        requestId: request.id,
        approver: user({ roleKeys: ["sales"] }),
        decision: "approved",
      }),
    ).rejects.toThrow(/not eligible/);

    const reloaded = await db.approvalRequest.findUniqueOrThrow({ where: { id: request.id } });
    expect(reloaded.status).toBe("pending");
  }, 30_000);

  it("a rejection immediately rejects the whole request", async () => {
    const workflow = await makeWorkflow([
      { name: "s", requiredRole: "president", mode: "parallel" },
    ]);
    const request = await createApprovalRequest({
      entityType,
      entityId: "e6",
      workflowId: workflow.id,
      requestedById: "requester1",
      entitySnapshot: {},
    });
    createdRequestIds.push(request.id);

    const updated = await decideApprovalRequest({
      requestId: request.id,
      approver: user({ roleKeys: ["president"] }),
      decision: "rejected",
      comment: "not now",
    });

    expect(updated.status).toBe("rejected");
  }, 30_000);

  it("advances a multi-step workflow one step at a time", async () => {
    const workflow = await makeWorkflow([
      { name: "step1", requiredRole: "operations_manager", mode: "parallel" },
      { name: "step2", requiredRole: "president", mode: "parallel" },
    ]);
    const request = await createApprovalRequest({
      entityType,
      entityId: "e7",
      workflowId: workflow.id,
      requestedById: "requester1",
      entitySnapshot: {},
    });
    createdRequestIds.push(request.id);

    const afterStep1 = await decideApprovalRequest({
      requestId: request.id,
      approver: user({ roleKeys: ["operations_manager"] }),
      decision: "approved",
    });
    expect(afterStep1.status).toBe("pending");
    expect(afterStep1.currentStep).toBe(1);

    const afterStep2 = await decideApprovalRequest({
      requestId: request.id,
      approver: user({ roleKeys: ["president"] }),
      decision: "approved",
    });
    expect(afterStep2.status).toBe("approved");
  }, 30_000);

  it("deciding an already-resolved request throws", async () => {
    const workflow = await makeWorkflow([
      { name: "s", requiredRole: "president", mode: "parallel" },
    ]);
    const request = await createApprovalRequest({
      entityType,
      entityId: "e8",
      workflowId: workflow.id,
      requestedById: "requester1",
      entitySnapshot: {},
    });
    createdRequestIds.push(request.id);

    await decideApprovalRequest({
      requestId: request.id,
      approver: user({ roleKeys: ["president"] }),
      decision: "approved",
    });

    await expect(
      decideApprovalRequest({
        requestId: request.id,
        approver: user({ roleKeys: ["president"] }),
        decision: "approved",
      }),
    ).rejects.toThrow(/already approved/);
  }, 30_000);
});

describe("listMyApprovalInbox", () => {
  it("only lists requests the user is currently eligible to see", async () => {
    const workflow = await makeWorkflow([
      { name: "s", requiredRole: "marketing_manager", mode: "parallel" },
    ]);
    const request = await createApprovalRequest({
      entityType,
      entityId: "e9",
      workflowId: workflow.id,
      requestedById: "requester1",
      entitySnapshot: {},
    });
    createdRequestIds.push(request.id);

    const marketerInbox = await listMyApprovalInbox(user({ roleKeys: ["marketing_manager"] }));
    expect(marketerInbox.some((r) => r.id === request.id)).toBe(true);

    const salesInbox = await listMyApprovalInbox(user({ roleKeys: ["sales"] }));
    expect(salesInbox.some((r) => r.id === request.id)).toBe(false);
  }, 30_000);
});
