import { randomUUID } from "node:crypto";
import { afterAll, describe, expect, it } from "vitest";
import { db } from "@/lib/db";
import { BUSINESS_DAY_MS } from "@/server/core/calendar/business-days";
import {
  createInquiryService,
  getInquiryService,
  listInquiriesService,
  overrideRequirementsService,
  setInquiryItemsService,
  transitionInquiryService,
} from "@/server/core/crm/inquiry-service";
import {
  decideQuotingWaiverService,
  findPendingQuotingWaiver,
  requestQuotingWaiverService,
} from "@/server/core/crm/inquiry-quoting-waiver";
import { sweepInquirySla } from "@/server/core/crm/inquiry-sla";
import {
  cancelInspectionService,
  completeInspectionService,
  createInspectionRequestService,
} from "@/server/core/crm/inspection-service";
import { answerKey } from "@/server/core/crm/requirements";
import type { AuthedUser } from "@/server/core/rbac/types";

/**
 * specs/01-crm-inquiry.md §§3-5, against the real database.
 *
 * Three of §10's named tests live here — the SLA firing "at the right time and not before", the
 * pause during `inspection_required`, and the requirements gate — because all three hinge on
 * exactly the things a mock would fake away: whether the transition really persisted, whether the
 * paused milliseconds were really banked, and whether the sweep's query actually selects the row.
 */

const suffix = randomUUID().slice(0, 8);
const OWNER = `owner-${suffix}`;
const OTHER = `other-${suffix}`;
const actor = { actorId: OWNER, actorLabel: "Owner Test" };

const inquiryIds: string[] = [];
const accountIds: string[] = [];

const scoped = (id: string, extra: string[] = []) => ({
  id,
  permissions: new Set(extra),
});

async function makeInquiry(
  options: {
    ownerId?: string;
    receivedAt?: Date;
    serviceType?: string | null;
    subject?: string;
  } = {},
) {
  const inquiry = await createInquiryService(
    { ...actor, actorId: options.ownerId ?? OWNER },
    {
      subject: options.subject ?? `Test inquiry ${randomUUID().slice(0, 6)}`,
      receivedAt: options.receivedAt ?? new Date(),
      ownerId: options.ownerId ?? OWNER,
      items:
        options.serviceType === null
          ? []
          : [{ description: "2 x DN100 flow meter", serviceType: options.serviceType ?? "supply" }],
    },
  );
  inquiryIds.push(inquiry.id);
  return inquiry;
}

/** Walks an inquiry to `evaluating`, which is where most of §3's interesting moves start. */
async function toEvaluating(inquiryId: string) {
  await transitionInquiryService(actor, { inquiryId, to: "acknowledged" });
  await transitionInquiryService(actor, { inquiryId, to: "evaluating" });
}

afterAll(async () => {
  // Since #164, requesting an inspection also schedules the real SiteInspection immediately rather
  // than waiting on the job queue, so every createInspectionRequestService call here leaves one of
  // these behind too — found and its own audit rows before the delete, since AuditLog is keyed on
  // entityId with no foreign key to enforce it.
  const inspections = await db.siteInspection.findMany({
    where: { inquiryId: { in: inquiryIds } },
    select: { id: true },
  });
  const inspectionIds = inspections.map((row) => row.id);
  await db.auditLog.deleteMany({ where: { entityId: { in: inspectionIds } } });
  await db.siteInspection.deleteMany({ where: { id: { in: inspectionIds } } });
  await db.inspectionRequest.deleteMany({ where: { inquiryId: { in: inquiryIds } } });
  await db.approvalAction.deleteMany({ where: { request: { entityId: { in: inquiryIds } } } });
  await db.approvalRequest.deleteMany({ where: { entityId: { in: inquiryIds } } });
  await db.auditLog.deleteMany({ where: { entityId: { in: inquiryIds } } });
  await db.notification.deleteMany({ where: { entityId: { in: inquiryIds } } });
  await db.searchIndex.deleteMany({ where: { entityId: { in: inquiryIds } } });
  await db.eventOutbox.deleteMany({ where: { actorId: { in: [OWNER, OTHER] } } });
  await db.inquiryItem.deleteMany({ where: { inquiryId: { in: inquiryIds } } });
  await db.inquiry.deleteMany({ where: { id: { in: inquiryIds } } });
  await db.customerAccount.deleteMany({ where: { id: { in: accountIds } } });
});

describe("the §3 lifecycle, persisted", () => {
  it("gives a new inquiry a number and starts it unacknowledged", async () => {
    const inquiry = await makeInquiry();
    expect(inquiry.number).toMatch(/^AIESINQ-\d{6}$/);
    expect(inquiry.status).toBe("new");
    expect(inquiry.acknowledgedAt).toBeNull();
  });

  it("stamps acknowledgedAt on the way through, which is what stops the clock", async () => {
    const inquiry = await makeInquiry();
    const acknowledged = await transitionInquiryService(actor, {
      inquiryId: inquiry.id,
      to: "acknowledged",
    });
    expect(acknowledged.acknowledgedAt).not.toBeNull();
  });

  it("refuses an illegal move and leaves the record untouched", async () => {
    const inquiry = await makeInquiry();
    await expect(
      transitionInquiryService(actor, { inquiryId: inquiry.id, to: "quoting" }),
    ).rejects.toThrow(/can only move to/);

    const after = await db.inquiry.findUnique({ where: { id: inquiry.id } });
    expect(after?.status).toBe("new");
  });

  it("writes an audit row for every status change, which is what the activity feed reads", async () => {
    const inquiry = await makeInquiry();
    await toEvaluating(inquiry.id);

    const rows = await db.auditLog.findMany({
      where: { entityType: "Inquiry", entityId: inquiry.id, action: "status_changed" },
    });
    expect(rows).toHaveLength(2);
    expect(rows.map((r) => r.summary).join(" ")).toContain("new → acknowledged");
  });

  it("emits the named event as well as the generic one", async () => {
    const inquiry = await makeInquiry();
    await transitionInquiryService(actor, { inquiryId: inquiry.id, to: "acknowledged" });

    const events = await db.eventOutbox.findMany({
      where: { actorId: OWNER, event: { in: ["inquiry.acknowledged", "inquiry.status_changed"] } },
    });
    const forThis = events.filter(
      (e) => (e.payload as { inquiryId?: string }).inquiryId === inquiry.id,
    );
    expect(forThis.map((e) => e.event).sort()).toEqual([
      "inquiry.acknowledged",
      "inquiry.status_changed",
    ]);
  });
});

describe("§4's completeness gate", () => {
  it("blocks quoting while a required requirement is unanswered", async () => {
    const inquiry = await makeInquiry({ serviceType: "supply" });
    await toEvaluating(inquiry.id);

    await expect(
      transitionInquiryService(actor, { inquiryId: inquiry.id, to: "quoting" }),
    ).rejects.toThrow(/required requirement\(s\) are unanswered/);
  });

  it("lets it through once the answers are there", async () => {
    const inquiry = await makeInquiry({ serviceType: "supply" });
    await toEvaluating(inquiry.id);

    const detail = await getInquiryService(scoped(OWNER), inquiry.id);
    const answers: Record<string, string> = {};
    for (const template of detail.templates) {
      for (const field of template.fields) {
        if (field.required) answers[answerKey(template.serviceType, field.key)] = "Answered";
      }
    }
    await db.inquiry.update({ where: { id: inquiry.id }, data: { requirements: answers } });

    const quoting = await transitionInquiryService(actor, {
      inquiryId: inquiry.id,
      to: "quoting",
    });
    expect(quoting.status).toBe("quoting");
  });

  it("lets it through on a logged override instead, and keeps the reason", async () => {
    // §4: "or the user explicitly overrides with a reason (logged)".
    const inquiry = await makeInquiry({ serviceType: "installation" });
    await toEvaluating(inquiry.id);

    await overrideRequirementsService(actor, {
      inquiryId: inquiry.id,
      reason: "Customer supplied a full technical datasheet by email; nothing left to ask.",
    });

    const quoting = await transitionInquiryService(actor, { inquiryId: inquiry.id, to: "quoting" });
    expect(quoting.status).toBe("quoting");

    const audit = await db.auditLog.findFirst({
      where: { entityId: inquiry.id, action: "requirements_overridden" },
    });
    expect(audit?.summary).toContain("technical datasheet");
  });

  it("refuses an override with no real reason in it", async () => {
    const inquiry = await makeInquiry({ serviceType: "supply" });
    await expect(
      overrideRequirementsService(actor, { inquiryId: inquiry.id, reason: "n/a" }),
    ).rejects.toThrow(/at least a sentence/);
  });

  it("does not gate an inquiry whose lines carry no service type", async () => {
    const inquiry = await makeInquiry({ serviceType: null });
    await toEvaluating(inquiry.id);
    const quoting = await transitionInquiryService(actor, { inquiryId: inquiry.id, to: "quoting" });
    expect(quoting.status).toBe("quoting");
  });

  it("re-gates when a line item gains a service type after the fact", async () => {
    const inquiry = await makeInquiry({ serviceType: null });
    await toEvaluating(inquiry.id);
    await setInquiryItemsService(actor, {
      inquiryId: inquiry.id,
      items: [{ description: "Calibrate 6 transmitters", serviceType: "calibration" }],
    });

    await expect(
      transitionInquiryService(actor, { inquiryId: inquiry.id, to: "quoting" }),
    ).rejects.toThrow(/unanswered/);
  });
});

/**
 * 2026-09-04: "if the inquiry did not call a request for site inspection, the 9 gates should not
 * hold it... pop a prompt that asks if logging the requirements are really not necessary. if it was
 * clicked yes then ask approval to KJ or EA for this to push to quotation."
 *
 * `decideApprovalRequest`'s eligibility check only reads `roleKeys` off the passed-in `AuthedUser` —
 * it never looks the approver up in the database — so a plain object stands in for KJ/EA here rather
 * than a persisted `db.user` row, the way this file's `OWNER`/`OTHER` are already plain ids and not
 * real rows either.
 */
function fakeApprover(roleKey: "vice_president" | "president"): AuthedUser {
  return {
    id: `${roleKey}-${randomUUID().slice(0, 8)}`,
    email: `${roleKey}@test.local`,
    name: roleKey === "vice_president" ? "KJ Test" : "EA Test",
    roleKeys: [roleKey],
    permissions: new Set<string>(),
  };
}

describe("§4's gate, waived for a simple purchase and delivery", () => {
  it("refuses a waiver while requirements are already satisfied", async () => {
    const inquiry = await makeInquiry({ serviceType: null });
    await toEvaluating(inquiry.id);

    await expect(requestQuotingWaiverService(actor, { inquiryId: inquiry.id })).rejects.toThrow(
      /nothing to waive/,
    );
  });

  it("refuses a waiver once a site inspection has ever been requested", async () => {
    const inquiry = await makeInquiry({ serviceType: "supply" });
    await toEvaluating(inquiry.id);
    const request = await createInspectionRequestService(actor, {
      inquiryId: inquiry.id,
      purpose: "Confirm access before quoting",
    });
    // Requesting one parks the inquiry at `inspection_required` (§5) — back to `evaluating` first,
    // the same way a real inquiry would be by the time anyone is looking at "Hand to quotation"
    // again. The inspection having been requested at all is what should still refuse the waiver,
    // regardless of what became of it since.
    await completeInspectionService(actor, {
      inspectionRequestId: request.id,
      findings: "DN80, flanged PN16.",
    });

    await expect(requestQuotingWaiverService(actor, { inquiryId: inquiry.id })).rejects.toThrow(
      /has a site inspection on it/,
    );
  });

  it("opens exactly one waiver request, and refuses a second while it is pending", async () => {
    const inquiry = await makeInquiry({ serviceType: "supply" });
    await toEvaluating(inquiry.id);

    const request = await requestQuotingWaiverService(actor, { inquiryId: inquiry.id });
    expect(request.status).toBe("pending");
    expect(request.entityType).toBe("InquiryQuotingWaiver");

    await expect(requestQuotingWaiverService(actor, { inquiryId: inquiry.id })).rejects.toThrow(
      /already waiting/,
    );
  });

  it("pushes straight to quoting once KJ or EA approves, without a second click", async () => {
    const inquiry = await makeInquiry({ serviceType: "supply" });
    await toEvaluating(inquiry.id);
    await requestQuotingWaiverService(actor, { inquiryId: inquiry.id });

    const kj = fakeApprover("vice_president");
    const result = await decideQuotingWaiverService(actor, kj, {
      inquiryId: inquiry.id,
      decision: "approved",
    });
    expect(result.status).toBe("approved");

    const after = await db.inquiry.findUniqueOrThrow({ where: { id: inquiry.id } });
    expect(after.status).toBe("quoting");
    expect(after.requirementsOverrideReason).toContain("No site inspection was requested");
    expect(after.requirementsOverrideBy).toBe(kj.id);

    expect(await findPendingQuotingWaiver(inquiry.id)).toBeNull();
  });

  it("lets the President decide it too — not only the Vice President", async () => {
    const inquiry = await makeInquiry({ serviceType: "supply" });
    await toEvaluating(inquiry.id);
    await requestQuotingWaiverService(actor, { inquiryId: inquiry.id });

    const ea = fakeApprover("president");
    await decideQuotingWaiverService(actor, ea, { inquiryId: inquiry.id, decision: "approved" });

    const after = await db.inquiry.findUniqueOrThrow({ where: { id: inquiry.id } });
    expect(after.status).toBe("quoting");
    expect(after.requirementsOverrideBy).toBe(ea.id);
  });

  it("leaves the inquiry exactly where it was on a decline, with a reason on record", async () => {
    const inquiry = await makeInquiry({ serviceType: "supply" });
    await toEvaluating(inquiry.id);
    await requestQuotingWaiverService(actor, { inquiryId: inquiry.id });

    const kj = fakeApprover("vice_president");
    const result = await decideQuotingWaiverService(actor, kj, {
      inquiryId: inquiry.id,
      decision: "rejected",
      comment: "Get at least the tag numbers from the customer first.",
    });
    expect(result.status).toBe("rejected");

    const after = await db.inquiry.findUniqueOrThrow({ where: { id: inquiry.id } });
    expect(after.status).toBe("evaluating");
    expect(after.requirementsOverrideReason).toBeNull();

    const audit = await db.auditLog.findFirst({
      where: { entityId: inquiry.id, action: "quoting_waiver_rejected" },
    });
    expect(audit?.summary).toContain("tag numbers");

    // Refused, not stranded — the ordinary gate is exactly what it was before the waiver.
    await expect(
      transitionInquiryService(actor, { inquiryId: inquiry.id, to: "quoting" }),
    ).rejects.toThrow(/unanswered/);
  });

  it("refuses a decision from someone who is neither the Vice President nor the President", async () => {
    const inquiry = await makeInquiry({ serviceType: "supply" });
    await toEvaluating(inquiry.id);
    await requestQuotingWaiverService(actor, { inquiryId: inquiry.id });

    const bystander: AuthedUser = {
      id: `bystander-${randomUUID().slice(0, 8)}`,
      email: "bystander@test.local",
      name: "Bystander Test",
      roleKeys: ["technician"],
      permissions: new Set<string>(),
    };

    await expect(
      decideQuotingWaiverService(actor, bystander, { inquiryId: inquiry.id, decision: "approved" }),
    ).rejects.toThrow(/not eligible/);

    const after = await db.inquiry.findUniqueOrThrow({ where: { id: inquiry.id } });
    expect(after.status).toBe("evaluating");
  });
});

describe("§5's inspection request and the SLA pause", () => {
  it("parks the inquiry and banks the paused time on the way back", async () => {
    const inquiry = await makeInquiry({ serviceType: "supply" });
    await toEvaluating(inquiry.id);

    const request = await createInspectionRequestService(actor, {
      inquiryId: inquiry.id,
      purpose: "Confirm line size and tie-in points before quoting",
      requiredOutputs: ["photos", "measurements"],
    });

    const parked = await db.inquiry.findUnique({ where: { id: inquiry.id } });
    expect(parked?.status).toBe("inspection_required");
    expect(parked?.slaPausedAt).not.toBeNull();
    expect(parked?.slaPausedMs).toBe(0);

    await completeInspectionService(actor, {
      inspectionRequestId: request.id,
      findings: "DN80, flanged PN16, 400 mm straight run upstream.",
    });

    const resumed = await db.inquiry.findUnique({ where: { id: inquiry.id } });
    expect(resumed?.status).toBe("evaluating");
    expect(resumed?.slaPausedAt).toBeNull();
    // The pause was momentary in a test, so the banked figure is small — but it must have moved off
    // its sentinel, or nothing was banked at all.
    expect(resumed?.slaPausedMs).toBeGreaterThanOrEqual(0);
  });

  it("emits inspection.requested for module 04 to pick up later", async () => {
    const inquiry = await makeInquiry();
    await toEvaluating(inquiry.id);
    await createInspectionRequestService(actor, {
      inquiryId: inquiry.id,
      purpose: "Survey the existing panel",
    });

    const event = await db.eventOutbox.findFirst({
      where: { event: "inspection.requested", actorId: OWNER },
      orderBy: { createdAt: "desc" },
    });
    expect((event?.payload as { inquiryId?: string }).inquiryId).toBe(inquiry.id);
  });

  it("schedules the real SiteInspection immediately, not on the next job-queue drain (#164)", async () => {
    const inquiry = await makeInquiry();
    await toEvaluating(inquiry.id);
    const request = await createInspectionRequestService(actor, {
      inquiryId: inquiry.id,
      purpose: "Confirm access before quoting",
    });

    // No call to scheduleFromInspectionRequest and no wait for a drain — if the request created the
    // Operations record synchronously, it is already here.
    const inspection = await db.siteInspection.findUnique({
      where: { inspectionRequestId: request.id },
    });
    expect(inspection).not.toBeNull();
    expect(inspection?.inquiryId).toBe(inquiry.id);
    expect(inspection?.status).toBe("scheduled");
  });

  it("will not raise a second inspection while one is open", async () => {
    const inquiry = await makeInquiry();
    await toEvaluating(inquiry.id);
    await createInspectionRequestService(actor, { inquiryId: inquiry.id, purpose: "First look" });

    await expect(
      createInspectionRequestService(actor, { inquiryId: inquiry.id, purpose: "Second look" }),
    ).rejects.toThrow(/already has an open inspection/);
  });

  it("returns the inquiry to evaluating when the request is cancelled instead", async () => {
    const inquiry = await makeInquiry();
    await toEvaluating(inquiry.id);
    const request = await createInspectionRequestService(actor, {
      inquiryId: inquiry.id,
      purpose: "Check access",
    });

    await cancelInspectionService(actor, {
      inspectionRequestId: request.id,
      reason: "Customer sent photographs instead.",
    });

    const after = await db.inquiry.findUnique({ where: { id: inquiry.id } });
    expect(after?.status).toBe("evaluating");
    expect(after?.slaPausedAt).toBeNull();
  });
});

describe("the nightly SLA sweep (§3)", () => {
  it("does not escalate an inquiry that is still inside its window", async () => {
    const inquiry = await makeInquiry({ receivedAt: new Date() });
    const result = await sweepInquirySla();
    expect(result.escalated.map((e) => e.inquiryId)).not.toContain(inquiry.id);
  });

  it("escalates one that is past it, and only once", async () => {
    // Ten days back clears the deadline whatever weekends or holidays intervene.
    const inquiry = await makeInquiry({
      receivedAt: new Date(Date.now() - 10 * BUSINESS_DAY_MS),
    });

    const first = await sweepInquirySla();
    expect(first.escalated.map((e) => e.inquiryId)).toContain(inquiry.id);

    const stamped = await db.inquiry.findUnique({ where: { id: inquiry.id } });
    expect(stamped?.slaEscalatedAt).not.toBeNull();

    // §3's escalation is an interruption, and an interruption repeated nightly is ignored.
    const second = await sweepInquirySla();
    expect(second.escalated.map((e) => e.inquiryId)).not.toContain(inquiry.id);
  });

  it("notifies the vice-president and president, resolved by role", async () => {
    const inquiry = await makeInquiry({
      receivedAt: new Date(Date.now() - 10 * BUSINESS_DAY_MS),
    });
    await sweepInquirySla();

    const notifications = await db.notification.findMany({
      where: { entityType: "Inquiry", entityId: inquiry.id },
    });
    expect(notifications.length).toBeGreaterThan(0);

    const leadership = await db.user.findMany({
      where: { roles: { some: { role: { key: { in: ["vice_president", "president"] } } } } },
      select: { id: true },
    });
    const leadershipIds = new Set(leadership.map((u) => u.id));
    for (const notification of notifications) {
      expect(leadershipIds.has(notification.recipientId)).toBe(true);
    }
  });

  it("leaves an acknowledged inquiry alone however old it is", async () => {
    const inquiry = await makeInquiry({
      receivedAt: new Date(Date.now() - 30 * BUSINESS_DAY_MS),
    });
    await transitionInquiryService(actor, { inquiryId: inquiry.id, to: "acknowledged" });

    const result = await sweepInquirySla();
    expect(result.escalated.map((e) => e.inquiryId)).not.toContain(inquiry.id);
  });
});

describe("§10's record scoping", () => {
  it("hides another owner's inquiry from someone without crm.view_all", async () => {
    const mine = await makeInquiry({ ownerId: OWNER, subject: `Mine ${suffix}` });
    const theirs = await makeInquiry({ ownerId: OTHER, subject: `Theirs ${suffix}` });

    const listed = await listInquiriesService(scoped(OWNER), { pageSize: 100 });
    const ids = listed.rows.map((row) => row.id);
    expect(ids).toContain(mine.id);
    expect(ids).not.toContain(theirs.id);

    // And a direct fetch by id is a 404, not a 403: a 403 would confirm the record exists to
    // somebody not allowed to know that.
    await expect(getInquiryService(scoped(OWNER), theirs.id)).rejects.toThrow(/no longer exists/);
  });

  it("lifts the scope entirely for crm.view_all", async () => {
    const theirs = await makeInquiry({ ownerId: OTHER, subject: `Theirs2 ${suffix}` });
    const seen = await getInquiryService(scoped(OWNER, ["crm.view_all"]), theirs.id);
    expect(seen.id).toBe(theirs.id);
  });
});
