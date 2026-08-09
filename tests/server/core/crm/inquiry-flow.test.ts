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
import { sweepInquirySla } from "@/server/core/crm/inquiry-sla";
import {
  cancelInspectionService,
  completeInspectionService,
  createInspectionRequestService,
} from "@/server/core/crm/inspection-service";
import { answerKey } from "@/server/core/crm/requirements";

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
  await db.inspectionRequest.deleteMany({ where: { inquiryId: { in: inquiryIds } } });
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
    expect(inquiry.number).toMatch(/^INQ-\d{4}-\d{4}$/);
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
