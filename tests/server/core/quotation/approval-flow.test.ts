import { randomUUID } from "node:crypto";
import { afterAll, describe, expect, it } from "vitest";
import { db } from "@/lib/db";
import {
  decideQuotationApprovalService,
  findPendingApprovalRequest,
  getQuotationApprovalStateService,
  listQuotationApprovalQueueService,
  submitQuotationForApprovalService,
} from "@/server/core/quotation/approval-service";
import { saveQuotationLinesService } from "@/server/core/quotation/quotation-line-service";
import { createQuotationService } from "@/server/core/quotation/quotation-service";
import { confirmQuotationSentService } from "@/server/core/quotation/send-service";
import type { AuthedUser } from "@/server/core/rbac/types";

/**
 * specs/02-quotation.md §6 and §12's two named approval tests.
 *
 * §12 asks for exactly two things by name, and they are the two that would be embarrassing to get
 * wrong:
 *
 *   "Every quotation, at any value, routes to the VP for approval; none can be sent unapproved."
 *   "A quotation unapproved after 24 working hours becomes approvable by the president, and the
 *    resulting approval is recorded as a fallback with elapsed time — never as a VP approval."
 *
 * Against the real database, because both hinge on things a mock removes: whether the request row
 * really exists, whether the rule really resolves, and whether the send path really refuses.
 */

const suffix = randomUUID().slice(0, 8);
const accountIds: string[] = [];
const quotationIds: string[] = [];
const userIds: string[] = [];

async function makeUser(roleKey: string): Promise<AuthedUser> {
  const role = await db.role.findUniqueOrThrow({ where: { key: roleKey } });
  const user = await db.user.create({
    data: {
      email: `${roleKey}-${randomUUID().slice(0, 8)}@test.local`,
      name: `${roleKey} ${randomUUID().slice(0, 4)}`,
      passwordHash: "x",
      isActive: true,
      roles: { create: { roleId: role.id } },
    },
  });
  userIds.push(user.id);
  return {
    id: user.id,
    email: user.email,
    name: user.name,
    roleKeys: [roleKey],
    // Cost visibility follows Spec.md §4.3: the two approver roles have it, nobody else does.
    permissions: new Set(
      roleKey === "president" || roleKey === "vice_president"
        ? ["quotation.approve", "quotation.view", "finance.view_cost"]
        : ["quotation.view"],
    ),
  };
}

const actorFor = (user: AuthedUser) => ({ actorId: user.id, actorLabel: user.name });

/** A draft with one line, which is the minimum §6 will accept for approval. */
async function makeQuotation(preparer: AuthedUser, unitCost = "10000.00") {
  const account = await db.customerAccount.create({
    data: {
      code: `AP-${randomUUID().slice(0, 12)}`,
      name: `Approval Water District ${suffix}`,
      ownerId: preparer.id,
    },
  });
  accountIds.push(account.id);

  const quotation = await createQuotationService(actorFor(preparer), {
    accountId: account.id,
    title: "Supply of one flow meter",
  });
  quotationIds.push(quotation.id);

  await saveQuotationLinesService(actorFor(preparer), {
    quotationId: quotation.id,
    version: quotation.version,
    canSeeCost: true,
    lines: [{ description: "DN100 flow meter", quantity: "1", unitCost, markupPct: "25" }],
  });

  return quotation;
}

/**
 * Seven calendar days always contains at least three working days, whatever the weekday and
 * whatever holidays fall in it — so this is past the 24-working-hour window without the test
 * needing to know which day it runs on.
 */
async function backdateRequest(quotationId: string, days = 7) {
  const request = await findPendingApprovalRequest(quotationId);
  await db.approvalRequest.update({
    where: { id: request!.id },
    data: { requestedAt: new Date(Date.now() - days * 86_400_000) },
  });
  return request!;
}

afterAll(async () => {
  const requests = await db.approvalRequest.findMany({
    where: { entityId: { in: quotationIds } },
    select: { id: true },
  });
  await db.approvalAction.deleteMany({ where: { requestId: { in: requests.map((r) => r.id) } } });
  await db.approvalRequest.deleteMany({ where: { entityId: { in: quotationIds } } });
  await db.notification.deleteMany({ where: { entityId: { in: quotationIds } } });
  await db.notification.deleteMany({ where: { recipientId: { in: userIds } } });
  await db.auditLog.deleteMany({ where: { entityId: { in: [...quotationIds, ...accountIds] } } });
  await db.eventOutbox.deleteMany({ where: { actorId: { in: userIds } } });
  await db.quotationLine.deleteMany({ where: { quotationId: { in: quotationIds } } });
  await db.quotation.deleteMany({ where: { id: { in: quotationIds } } });
  await db.customerAccount.deleteMany({ where: { id: { in: accountIds } } });
  await db.userRole.deleteMany({ where: { userId: { in: userIds } } });
  await db.user.deleteMany({ where: { id: { in: userIds } } });
});

describe("§12: every quotation routes to the VP, at any value", () => {
  it("routes a ₱12,500 quotation and a ₱12,500,000 one identically", async () => {
    // The point of §6's "regardless of value or margin". A threshold that quietly waved small
    // quotations through would be invisible until the day one of them was wrong.
    const preparer = await makeUser("sales");
    const small = await makeQuotation(preparer, "10000.00");
    const large = await makeQuotation(preparer, "10000000.00");

    for (const quotation of [small, large]) {
      const result = await submitQuotationForApprovalService(actorFor(preparer), {
        quotationId: quotation.id,
      });
      expect(result.status).toBe("pending_approval");

      const request = await findPendingApprovalRequest(quotation.id);
      expect(request).not.toBeNull();
      // Step 0 of a one-step workflow — no condition skipped it.
      expect(request!.currentStep).toBe(0);
    }
  }, 60_000);

  it("puts it in the VP's queue and not in anybody else's", async () => {
    const preparer = await makeUser("sales");
    const vp = await makeUser("vice_president");
    const president = await makeUser("president");
    const quotation = await makeQuotation(preparer);

    await submitQuotationForApprovalService(actorFor(preparer), { quotationId: quotation.id });

    const vpQueue = await listQuotationApprovalQueueService(vp);
    expect(vpQueue.map((row) => row.quotationId)).toContain(quotation.id);

    // Before the window elapses this is the VP's alone — §4.4: "Before the window elapses, only
    // the VP sees it in 'Awaiting my approval'."
    const presidentQueue = await listQuotationApprovalQueueService(president);
    expect(presidentQueue.map((row) => row.quotationId)).not.toContain(quotation.id);
  }, 60_000);

  it("§12: none can be sent unapproved", async () => {
    const preparer = await makeUser("sales");
    const quotation = await makeQuotation(preparer);

    // Straight from draft.
    await expect(
      confirmQuotationSentService(actorFor(preparer), { quotationId: quotation.id }),
    ).rejects.toThrow(/requires approval/);

    // And while it is sitting with the VP.
    await submitQuotationForApprovalService(actorFor(preparer), { quotationId: quotation.id });
    await expect(
      confirmQuotationSentService(actorFor(preparer), { quotationId: quotation.id }),
    ).rejects.toThrow(/requires approval/);

    const stored = await db.quotation.findUniqueOrThrow({ where: { id: quotation.id } });
    expect(stored.sentAt).toBeNull();
  }, 60_000);

  it("refuses to submit a quotation with no lines", async () => {
    const preparer = await makeUser("sales");
    const account = await db.customerAccount.create({
      data: {
        code: `AE-${randomUUID().slice(0, 12)}`,
        name: `Empty ${suffix}`,
        ownerId: preparer.id,
      },
    });
    accountIds.push(account.id);
    const quotation = await createQuotationService(actorFor(preparer), {
      accountId: account.id,
      title: "Nothing priced yet",
    });
    quotationIds.push(quotation.id);

    await expect(
      submitQuotationForApprovalService(actorFor(preparer), { quotationId: quotation.id }),
    ).rejects.toThrow(/no line items/);
  }, 60_000);
});

describe("the VP's decision", () => {
  it("approves, and only then can it be issued", async () => {
    const preparer = await makeUser("sales");
    const vp = await makeUser("vice_president");
    const quotation = await makeQuotation(preparer);

    await submitQuotationForApprovalService(actorFor(preparer), { quotationId: quotation.id });
    const result = await decideQuotationApprovalService(actorFor(vp), vp, {
      quotationId: quotation.id,
      decision: "approved",
    });

    expect(result.quotationStatus).toBe("approved");
    expect(result.isFallback).toBe(false);

    const stored = await db.quotation.findUniqueOrThrow({ where: { id: quotation.id } });
    expect(stored.status).toBe("approved");
    expect(stored.approvedById).toBe(vp.id);
    expect(stored.approvedAt).toBeTruthy();
  }, 60_000);

  it("sends it back to draft with the comment, which is mandatory", async () => {
    const preparer = await makeUser("sales");
    const vp = await makeUser("vice_president");
    const quotation = await makeQuotation(preparer);

    await submitQuotationForApprovalService(actorFor(preparer), { quotationId: quotation.id });

    // §6: "Rejection returns the quote to draft with a mandatory comment." A rejection with no
    // reason is one the preparer will resubmit unchanged.
    await expect(
      decideQuotationApprovalService(actorFor(vp), vp, {
        quotationId: quotation.id,
        decision: "rejected",
        comment: "   ",
      }),
    ).rejects.toThrow(/no comment/);

    await decideQuotationApprovalService(actorFor(vp), vp, {
      quotationId: quotation.id,
      decision: "rejected",
      comment: "The installation line is under-scoped — add the tie-in works.",
    });

    const stored = await db.quotation.findUniqueOrThrow({ where: { id: quotation.id } });
    expect(stored.status).toBe("draft");
    expect(stored.rejectionReason).toContain("tie-in works");
    // Back in the preparer's hands, so it is editable again.
    expect(stored.approvedById).toBeNull();
  }, 60_000);

  it("refuses a decision from somebody the rule does not name", async () => {
    const preparer = await makeUser("sales");
    const technician = await makeUser("technician");
    const quotation = await makeQuotation(preparer);

    await submitQuotationForApprovalService(actorFor(preparer), { quotationId: quotation.id });

    await expect(
      decideQuotationApprovalService(actorFor(technician), technician, {
        quotationId: quotation.id,
        decision: "approved",
      }),
    ).rejects.toThrow(/not eligible/);

    const stored = await db.quotation.findUniqueOrThrow({ where: { id: quotation.id } });
    expect(stored.status).toBe("pending_approval");
  }, 60_000);

  it("refuses a second decision on the same request — first decision wins", async () => {
    const preparer = await makeUser("sales");
    const vp = await makeUser("vice_president");
    const president = await makeUser("president");
    const quotation = await makeQuotation(preparer);

    await submitQuotationForApprovalService(actorFor(preparer), { quotationId: quotation.id });
    await decideQuotationApprovalService(actorFor(vp), vp, {
      quotationId: quotation.id,
      decision: "approved",
    });

    await expect(
      decideQuotationApprovalService(actorFor(president), president, {
        quotationId: quotation.id,
        decision: "rejected",
        comment: "Too late.",
      }),
    ).rejects.toThrow(/not awaiting approval/);
  }, 60_000);
});

describe("§12: the fallback to the president after 24 working hours", () => {
  it("appears in the president's queue once the window has elapsed, without leaving the VP's", async () => {
    const preparer = await makeUser("sales");
    const vp = await makeUser("vice_president");
    const president = await makeUser("president");
    const quotation = await makeQuotation(preparer);

    await submitQuotationForApprovalService(actorFor(preparer), { quotationId: quotation.id });
    await backdateRequest(quotation.id);

    const presidentQueue = await listQuotationApprovalQueueService(president);
    const row = presidentQueue.find((r) => r.quotationId === quotation.id);
    expect(row).toBeDefined();
    expect(row!.isEscalated).toBe(true);
    expect(row!.wouldBeFallback).toBe(true);
    expect(row!.ageWorkingHours).toBeGreaterThanOrEqual(24);

    // §4.4: "The VP's queue does not clear — this is a fallback, not a handoff."
    const vpQueue = await listQuotationApprovalQueueService(vp);
    const vpRow = vpQueue.find((r) => r.quotationId === quotation.id);
    expect(vpRow).toBeDefined();
    expect(vpRow!.wouldBeFallback).toBe(false);
  }, 60_000);

  it("records the president's approval as a fallback, with the elapsed working hours", async () => {
    const preparer = await makeUser("sales");
    const president = await makeUser("president");
    const quotation = await makeQuotation(preparer);

    await submitQuotationForApprovalService(actorFor(preparer), { quotationId: quotation.id });
    const request = await backdateRequest(quotation.id);

    const result = await decideQuotationApprovalService(actorFor(president), president, {
      quotationId: quotation.id,
      decision: "approved",
    });

    expect(result.isFallback).toBe(true);
    expect(result.elapsedWorkingHours).toBeGreaterThanOrEqual(24);

    // Stamped on the action row, which is the permanent record §4.4 asks for.
    const action = await db.approvalAction.findFirstOrThrow({ where: { requestId: request.id } });
    expect(action.isFallback).toBe(true);
    expect(action.approverId).toBe(president.id);

    // And in words, in the audit trail — §4.4: "The audit trail must never show a fallback
    // approval as though the VP made it."
    const audit = await db.auditLog.findFirstOrThrow({
      where: { entityId: quotation.id, action: "approved" },
      orderBy: { at: "desc" },
    });
    expect(audit.summary).toContain("fallback approver");
    expect(audit.summary).toMatch(/working hours after submission/);
    expect(audit.actorId).toBe(president.id);
  }, 60_000);

  it("stamps a president's approval as a fallback even before the window elapses", async () => {
    // Spec.md §4.4 gives the President standing authority — "can always act immediately, without
    // waiting for the window" — and says the stamp is about *who* decided, not when. Both halves
    // matter: acting early is allowed, and it is still not a VP approval.
    const preparer = await makeUser("sales");
    const president = await makeUser("president");
    const quotation = await makeQuotation(preparer);

    await submitQuotationForApprovalService(actorFor(preparer), { quotationId: quotation.id });

    const result = await decideQuotationApprovalService(actorFor(president), president, {
      quotationId: quotation.id,
      decision: "approved",
    });

    expect(result.isFallback).toBe(true);
    expect(result.elapsedWorkingHours).toBeLessThan(24);
  }, 60_000);
});

describe("the queue itself", () => {
  it("carries everything §6 asks for, so rows are decidable without opening each one", async () => {
    const preparer = await makeUser("sales");
    const vp = await makeUser("vice_president");
    const quotation = await makeQuotation(preparer, "40000.00");

    await submitQuotationForApprovalService(actorFor(preparer), { quotationId: quotation.id });

    const row = (await listQuotationApprovalQueueService(vp)).find(
      (r) => r.quotationId === quotation.id,
    )!;
    expect(row.customer).toContain("Approval Water District");
    // 40,000 cost × 1.25 markup = 50,000, plus §4's default 12% exclusive VAT. The queue shows the
    // number on the customer's document, which is the one the approver is agreeing to.
    expect(row.total).toBe("56000");
    expect(row.marginPct).toBeTruthy();
    expect(row.displayNumber).toBe(quotation.number);
    expect(typeof row.ageWorkingHours).toBe("number");
  }, 60_000);

  it("strips margin for a caller without finance.view_cost", async () => {
    // Spec.md §4.3, in the one place it would be easiest to forget: a queue is a serialised
    // response too, and §12 tests the payload rather than the screen.
    const preparer = await makeUser("sales");
    const vp = await makeUser("vice_president");
    const quotation = await makeQuotation(preparer);
    await submitQuotationForApprovalService(actorFor(preparer), { quotationId: quotation.id });

    const costBlind: AuthedUser = { ...vp, permissions: new Set(["quotation.view"]) };
    const row = (await listQuotationApprovalQueueService(costBlind)).find(
      (r) => r.quotationId === quotation.id,
    )!;

    expect(row.total).toBeTruthy();
    expect(row).not.toHaveProperty("marginPct");
    expect(row).not.toHaveProperty("marginAmount");
  }, 60_000);

  it("drops a row whose quotation has moved on, rather than offering a button that cannot work", async () => {
    const preparer = await makeUser("sales");
    const vp = await makeUser("vice_president");
    const quotation = await makeQuotation(preparer);
    await submitQuotationForApprovalService(actorFor(preparer), { quotationId: quotation.id });

    // A pending request whose quotation was cancelled out from under it.
    await db.quotation.update({ where: { id: quotation.id }, data: { status: "cancelled" } });

    const queue = await listQuotationApprovalQueueService(vp);
    expect(queue.map((r) => r.quotationId)).not.toContain(quotation.id);
  }, 60_000);

  it("shows the record page who decided what, and whether it was a fallback", async () => {
    const preparer = await makeUser("sales");
    const president = await makeUser("president");
    const quotation = await makeQuotation(preparer);

    await submitQuotationForApprovalService(actorFor(preparer), { quotationId: quotation.id });
    await backdateRequest(quotation.id);
    await decideQuotationApprovalService(actorFor(president), president, {
      quotationId: quotation.id,
      decision: "approved",
    });

    const state = await getQuotationApprovalStateService(president, quotation.id);
    expect(state.pendingRequestId).toBeNull();
    expect(state.history).toHaveLength(1);
    expect(state.history[0]!.requestedByLabel).toBe(preparer.name);
    expect(state.history[0]!.actions[0]!.approverLabel).toBe(president.name);
    expect(state.history[0]!.actions[0]!.isFallback).toBe(true);
  }, 60_000);
});
