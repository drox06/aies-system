import { randomUUID } from "node:crypto";
import { afterAll, describe, expect, it } from "vitest";
import { db } from "@/lib/db";
import {
  approveInspectionService,
  completeInspectionService,
  getInspectionService,
  listInspectionsService,
  saveInspectionService,
  scheduleFromInspectionRequest,
  scheduleInspectionService,
  shareInspectionService,
} from "@/server/core/operations/site-inspection-service";
import { SITE_INSPECTION_ENTITY_TYPE } from "@/server/core/operations/site-inspection-rules";
import { canAccessFile } from "@/server/core/storage/access";
import { uploadFile } from "@/server/core/storage/storage";
import { supabaseStorageDriver } from "@/server/core/storage/supabase-driver";
import { createStandaloneTicketService } from "@/server/core/operations/ticket-service";
import { promptRevisionOnScopeChange } from "@/server/core/quotation/scope-change-service";
import { createQuotationService } from "@/server/core/quotation/quotation-service";
import type { TicketType } from "@/server/core/operations/ticket-rules";
import type { AuthedUser } from "@/server/core/rbac/types";

/**
 * specs/04-operations-projects.md §6.1, against the real database.
 *
 * Two things here cannot be proved by a pure function and are the reason this file exists:
 *
 *  1. **The module 01 route actually works.** crm.prisma has carried a promise since module 01 was
 *     built — "when module 04 lands it consumes `inspection.requested` and this becomes the request
 *     of record with the field task alongside it". Either an inspection request now produces a
 *     scheduled visit, or the comment was decoration.
 *  2. **The scope-change link reaches sales.** §6.1 calls it "one of the highest-value things the
 *     platform does", which is a claim about an end-to-end path: flag → event → module 02 → a
 *     notification in a named person's inbox.
 */

const suffix = randomUUID().slice(0, 8);
const accountIds: string[] = [];
const ticketIds: string[] = [];
const inspectionIds: string[] = [];
const requestIds: string[] = [];
const inquiryIds: string[] = [];
const quotationIds: string[] = [];
const userIds: string[] = [];
const fileIds: string[] = [];
const storageKeys: string[] = [];

async function makeUser(roleKey: string, permissions: string[]): Promise<AuthedUser> {
  const role = await db.role.findUniqueOrThrow({ where: { key: roleKey } });
  const user = await db.user.create({
    data: {
      email: `si-${roleKey}-${randomUUID().slice(0, 8)}@test.local`,
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
    permissions: new Set(permissions),
  };
}

const actorFor = (user: AuthedUser) => ({ actorId: user.id, actorLabel: user.name });

async function makeTicket(lead: AuthedUser, type: TicketType = "new_project") {
  const account = await db.customerAccount.create({
    data: { code: `SI-${randomUUID().slice(0, 12)}`, name: `SI Co ${suffix}`, ownerId: lead.id },
  });
  accountIds.push(account.id);

  const ticket = await createStandaloneTicketService(actorFor(lead), {
    accountId: account.id,
    type,
    title: `Pump station upgrade ${randomUUID().slice(0, 6)}`,
    scopeOfWork: "Survey, then replace the transfer pumps.",
    justification: "Standalone for the test fixture.",
  });
  ticketIds.push(ticket.id);
  return ticket;
}

async function scheduleFor(actor: AuthedUser, ticketId: string) {
  const inspection = await scheduleInspectionService(actorFor(actor), {
    ticketId,
    inspectedByIds: [actor.id],
  });
  inspectionIds.push(inspection.id);
  return inspection;
}

const GOOD_FINDINGS = {
  inspectedAt: new Date("2026-08-20T02:00:00.000Z"),
  /**
   * Who turned up, by department — the shape the company asked for on 2026-08-17. Deliberately not
   * the same as who was *assigned*: `inspectedByIds` is that, and the two disagree on a real survey.
   */
  attendees: [{ party: "sales" as const }, { party: "technical" as const, name: "DJ" }],
  findings: "Existing meter is a DN100, not the DN150 on the drawing.",
};

afterAll(async () => {
  await db.fileObject.deleteMany({ where: { id: { in: fileIds } } });
  for (const key of storageKeys) {
    await supabaseStorageDriver.remove(key).catch(() => {});
  }
  await db.siteInspection.deleteMany({ where: { id: { in: inspectionIds } } });
  await db.inspectionRequest.deleteMany({ where: { id: { in: requestIds } } });
  await db.notification.deleteMany({ where: { recipientId: { in: userIds } } });
  await db.auditLog.deleteMany({
    where: {
      entityId: {
        in: [...inspectionIds, ...ticketIds, ...accountIds, ...inquiryIds, ...quotationIds],
      },
    },
  });
  await db.eventOutbox.deleteMany({ where: { actorId: { in: userIds } } });
  await db.searchIndex.deleteMany({
    where: { entityId: { in: [...quotationIds, ...inquiryIds] } },
  });
  await db.ticketSalesOrderLine.deleteMany({ where: { ticketId: { in: ticketIds } } });
  await db.ticket.deleteMany({ where: { id: { in: ticketIds } } });
  await db.quotationLine.deleteMany({ where: { quotationId: { in: quotationIds } } });
  await db.quotation.deleteMany({ where: { id: { in: quotationIds } } });
  await db.inquiry.deleteMany({ where: { id: { in: inquiryIds } } });
  await db.customerAccount.deleteMany({ where: { id: { in: accountIds } } });
  await db.userRole.deleteMany({ where: { userId: { in: userIds } } });
  await db.user.deleteMany({ where: { id: { in: userIds } } });
});

describe("§6.1 — scheduling and recording", () => {
  it("allocates a house-format number and starts scheduled", async () => {
    const tech = await makeUser("technician", ["ticket.execute", "ticket.view"]);
    const ticket = await makeTicket(tech);
    const inspection = await scheduleFor(tech, ticket.id);

    expect(inspection.number).toMatch(/^AIESSIR-\d{6}$/);
    expect(inspection.status).toBe("scheduled");
  });

  it("refuses an inspection attached to nothing", async () => {
    const tech = await makeUser("technician", ["ticket.execute"]);
    await expect(scheduleInspectionService(actorFor(tech), { inspectedByIds: [] })).rejects.toThrow(
      /ticket, a project or an inquiry/,
    );
  });

  it("will not complete a report that records nothing", async () => {
    const tech = await makeUser("technician", ["ticket.execute"]);
    const ticket = await makeTicket(tech);
    const inspection = await scheduleFor(tech, ticket.id);

    await expect(completeInspectionService(actorFor(tech), inspection.id)).rejects.toThrow(
      /still needs/,
    );
  });

  it("completes on three fields, warns about the photographs, and emits", async () => {
    const tech = await makeUser("technician", ["ticket.execute", "ticket.view_all"]);
    const ticket = await makeTicket(tech);
    const inspection = await scheduleFor(tech, ticket.id);

    await saveInspectionService(actorFor(tech), { inspectionId: inspection.id, ...GOOD_FINDINGS });
    const result = await completeInspectionService(actorFor(tech), inspection.id);

    // A refused-entry visit has no photographs and is still a real inspection.
    expect(result.warnings.join(" ")).toMatch(/No photographs/);

    const event = await db.eventOutbox.findFirst({
      where: { event: "site_inspection.completed", actorId: tech.id },
    });
    expect((event?.payload as { siteInspectionId?: string })?.siteInspectionId).toBe(inspection.id);
  });

  /**
   * Pins the 2026-09-04 fix: a photo attached the way the app actually attaches one — through the
   * generic "Photographs and sketches" panel, which uploads keyed by entityType/entityId and never
   * touches `SiteInspection.photoFileIds` — used to still trigger this exact warning, because the
   * check read the unused id list instead of what was really on the record.
   */
  it("does not warn about photographs once one is actually attached", async () => {
    const tech = await makeUser("technician", ["ticket.execute", "ticket.view_all"]);
    const ticket = await makeTicket(tech);
    const inspection = await scheduleFor(tech, ticket.id);

    const png = Buffer.from(
      "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=",
      "base64",
    );
    const file = await uploadFile({
      entityType: SITE_INSPECTION_ENTITY_TYPE,
      entityId: inspection.id,
      uploaderId: tech.id,
      filename: "meter-room.png",
      mimeType: "image/png",
      buffer: png,
    });
    fileIds.push(file.id);
    storageKeys.push(file.storageKey);
    if (file.webDerivativeKey) storageKeys.push(file.webDerivativeKey);

    await saveInspectionService(actorFor(tech), { inspectionId: inspection.id, ...GOOD_FINDINGS });
    const result = await completeInspectionService(actorFor(tech), inspection.id);

    expect(result.warnings.join(" ")).not.toMatch(/No photographs/);

    const read = await getInspectionService(tech, inspection.id);
    expect(read.completeness.warnings.join(" ")).not.toMatch(/No photographs/);
  });

  it("closes an approved report to further edits", async () => {
    const tech = await makeUser("technician", ["ticket.execute", "ticket.view_all"]);
    const manager = await makeUser("operations_manager", ["project.manage", "ticket.view_all"]);
    const ticket = await makeTicket(tech);
    const inspection = await scheduleFor(tech, ticket.id);

    await saveInspectionService(actorFor(tech), { inspectionId: inspection.id, ...GOOD_FINDINGS });
    await completeInspectionService(actorFor(tech), inspection.id);
    await approveInspectionService(manager, actorFor(manager), inspection.id);

    await expect(
      saveInspectionService(actorFor(tech), { inspectionId: inspection.id, findings: "changed" }),
    ).rejects.toThrow(/signature/);
  });

  /**
   * 2026-09-04: "the generated SIR should be made available to the requestor... this should also go
   * into the requestor's notification as soon as the SIR is approved and generated." Approval is the
   * trigger — the report itself is generated on demand, so there is nothing to wait on beyond that.
   */
  it("tells the requester their report is approved, pointing at the inspection", async () => {
    const tech = await makeUser("technician", ["ticket.execute", "ticket.view_all"]);
    const manager = await makeUser("operations_manager", ["project.manage", "ticket.view_all"]);
    const ticket = await makeTicket(tech);
    const inspection = await scheduleFor(tech, ticket.id);

    await saveInspectionService(actorFor(tech), { inspectionId: inspection.id, ...GOOD_FINDINGS });
    await completeInspectionService(actorFor(tech), inspection.id);
    await approveInspectionService(manager, actorFor(manager), inspection.id);

    const notifications = await db.notification.findMany({ where: { recipientId: tech.id } });
    const approved = notifications.find((n) => n.type === "site_inspection.approved");
    expect(approved).toBeDefined();
    expect(approved?.entityType).toBe(SITE_INSPECTION_ENTITY_TYPE);
    expect(approved?.entityId).toBe(inspection.id);
  });

  /**
   * The company's instruction of 2026-08-17: "the personnel who assigned the site inspection during
   * the quoting process should also be able to approve the site inspection report, this ensures that
   * they have reviewed the site inspection report prior to continuing the quotation process."
   *
   * The better reason of the two. An officer approving a survey they did not ask for is a rubber
   * stamp; the requester is the one whose quotation depends on what it says.
   */
  it("lets the person who asked for the survey approve the report", async () => {
    const tech = await makeUser("technician", ["ticket.execute", "ticket.view_all"]);
    const ticket = await makeTicket(tech);
    // `scheduleFor` records the scheduler as the requester, so `tech` is who asked for it.
    const inspection = await scheduleFor(tech, ticket.id);

    await saveInspectionService(actorFor(tech), { inspectionId: inspection.id, ...GOOD_FINDINGS });
    await completeInspectionService(actorFor(tech), inspection.id);

    // No `project.manage`, and it still goes through — being the requester is enough.
    await approveInspectionService(tech, actorFor(tech), inspection.id);

    const after = await db.siteInspection.findUniqueOrThrow({ where: { id: inspection.id } });
    expect(after.status).toBe("approved");
    expect(after.approvedById).toBe(tech.id);

    // Approving your own report is not news — nothing should land in your own inbox for it.
    const notifications = await db.notification.findMany({ where: { recipientId: tech.id } });
    expect(notifications.find((n) => n.type === "site_inspection.approved")).toBeUndefined();
  });

  /** Enough is not the same as anybody. */
  it("refuses a bystander with neither the permission nor the request behind them", async () => {
    const tech = await makeUser("technician", ["ticket.execute", "ticket.view_all"]);
    const bystander = await makeUser("technician", ["ticket.execute", "ticket.view_all"]);
    const ticket = await makeTicket(tech);
    const inspection = await scheduleFor(tech, ticket.id);

    await saveInspectionService(actorFor(tech), { inspectionId: inspection.id, ...GOOD_FINDINGS });
    await completeInspectionService(actorFor(tech), inspection.id);

    await expect(
      approveInspectionService(bystander, actorFor(bystander), inspection.id),
    ).rejects.toThrow(/the person who asked for this survey/);
  });

  it("refuses to approve an inspection nobody has completed", async () => {
    const tech = await makeUser("technician", ["ticket.execute"]);
    const manager = await makeUser("operations_manager", ["project.manage"]);
    const ticket = await makeTicket(tech);
    const inspection = await scheduleFor(tech, ticket.id);

    await expect(
      approveInspectionService(manager, actorFor(manager), inspection.id),
    ).rejects.toThrow(/Only a completed inspection/);
  });
});

/**
 * 2026-09-04: "the inputs in the app disappeared, but the downloadable pdf copy retained the
 * inputs. the inputs should remain on accomplished SIRs and should become frozen and cannot be
 * edited. unless the assigned person to conduct the SIRs press the edit button. but this edit
 * becomes a revision not an overwrite. reason should be added at the bottom of the SIR."
 *
 * Before this, `completed` had no protection beyond "not yet approved" — anybody with
 * `ticket.execute` could reopen and silently rewrite a finished report, which is exactly how a
 * report's own inputs could vanish from the app while the PDF (rendered from the same row, a
 * moment earlier) still had them.
 */
describe("§6.1 — revising an accomplished report", () => {
  it("freezes a completed report against anyone but who conducted it", async () => {
    const tech = await makeUser("technician", ["ticket.execute", "ticket.view_all"]);
    const bystander = await makeUser("technician", ["ticket.execute", "ticket.view_all"]);
    const ticket = await makeTicket(tech);
    const inspection = await scheduleFor(tech, ticket.id);

    await saveInspectionService(actorFor(tech), { inspectionId: inspection.id, ...GOOD_FINDINGS });
    await completeInspectionService(actorFor(tech), inspection.id);

    await expect(
      saveInspectionService(actorFor(bystander), {
        inspectionId: inspection.id,
        findings: "Overwritten by somebody who never went.",
      }),
    ).rejects.toThrow(/Only the person who conducted the inspection/);

    const untouched = await db.siteInspection.findUniqueOrThrow({ where: { id: inspection.id } });
    expect(untouched.findings).toBe(GOOD_FINDINGS.findings);
  });

  it("refuses even the assigned surveyor without a reason", async () => {
    const tech = await makeUser("technician", ["ticket.execute", "ticket.view_all"]);
    const ticket = await makeTicket(tech);
    const inspection = await scheduleFor(tech, ticket.id);

    await saveInspectionService(actorFor(tech), { inspectionId: inspection.id, ...GOOD_FINDINGS });
    await completeInspectionService(actorFor(tech), inspection.id);

    await expect(
      saveInspectionService(actorFor(tech), {
        inspectionId: inspection.id,
        findings: "Corrected the DN100 reading.",
      }),
    ).rejects.toThrow(/Say why/);
  });

  it("lets the assigned surveyor revise with a reason, tracked, not overwritten silently", async () => {
    const tech = await makeUser("technician", ["ticket.execute", "ticket.view_all"]);
    const ticket = await makeTicket(tech);
    const inspection = await scheduleFor(tech, ticket.id);

    await saveInspectionService(actorFor(tech), { inspectionId: inspection.id, ...GOOD_FINDINGS });
    await completeInspectionService(actorFor(tech), inspection.id);

    const beforeRevise = await getInspectionService(tech, inspection.id);
    expect(beforeRevise.editable).toBe(false);
    expect(beforeRevise.canRevise).toBe(true);

    await saveInspectionService(actorFor(tech), {
      inspectionId: inspection.id,
      findings: "Corrected: the meter is actually a DN80, not a DN100.",
      revisionReason: "Re-measured after the client's engineer disputed the first reading.",
    });

    const after = await db.siteInspection.findUniqueOrThrow({ where: { id: inspection.id } });
    expect(after.findings).toContain("DN80");
    expect(after.status).toBe("completed");

    const revised = await db.auditLog.findFirst({
      where: {
        entityType: SITE_INSPECTION_ENTITY_TYPE,
        entityId: inspection.id,
        action: "revised",
      },
    });
    expect(revised?.summary).toContain("Re-measured after the client's engineer disputed");
    expect(revised?.actorId).toBe(tech.id);
  });

  it("leaves an approved report refused even for the person who conducted it", async () => {
    const tech = await makeUser("technician", ["ticket.execute", "ticket.view_all"]);
    const ticket = await makeTicket(tech);
    const inspection = await scheduleFor(tech, ticket.id);

    await saveInspectionService(actorFor(tech), { inspectionId: inspection.id, ...GOOD_FINDINGS });
    await completeInspectionService(actorFor(tech), inspection.id);
    await approveInspectionService(tech, actorFor(tech), inspection.id);

    const read = await getInspectionService(tech, inspection.id);
    expect(read.canRevise).toBe(false);

    await expect(
      saveInspectionService(actorFor(tech), {
        inspectionId: inspection.id,
        findings: "changed",
        revisionReason: "Trying anyway.",
      }),
    ).rejects.toThrow(/signature/);
  });
});

describe("§6.1 — the scope-change link", () => {
  it("emits once, on the save that flags it, and not again", async () => {
    const tech = await makeUser("technician", ["ticket.execute", "ticket.view_all"]);
    const ticket = await makeTicket(tech);
    const inspection = await scheduleFor(tech, ticket.id);

    const first = await saveInspectionService(actorFor(tech), {
      inspectionId: inspection.id,
      ...GOOD_FINDINGS,
      scopeChangeIdentified: true,
      scopeChangeNotes: "Two extra tie-in points not on the drawing.",
    });
    expect(first.scopeChangeReported).toBe(true);

    // Correcting a measurement must not tell sales a second time.
    const second = await saveInspectionService(actorFor(tech), {
      inspectionId: inspection.id,
      findings: "Corrected: the meter is a DN80.",
    });
    expect(second.scopeChangeReported).toBe(false);

    const events = await db.eventOutbox.findMany({
      where: { event: "scope_change.identified", actorId: tech.id },
    });
    expect(events).toHaveLength(1);
  });

  it("does not emit on a flag with no explanation", async () => {
    const tech = await makeUser("technician", ["ticket.execute"]);
    const ticket = await makeTicket(tech);
    const inspection = await scheduleFor(tech, ticket.id);

    const result = await saveInspectionService(actorFor(tech), {
      inspectionId: inspection.id,
      scopeChangeIdentified: true,
      scopeChangeNotes: "   ",
    });
    expect(result.scopeChangeReported).toBe(false);

    const events = await db.eventOutbox.findMany({
      where: { event: "scope_change.identified", actorId: tech.id },
    });
    expect(events).toHaveLength(0);
  });

  /**
   * §6.1's claim, end to end: the surveyor's flag reaches the person who wrote the quotation.
   *
   * Module 02's handler is called directly rather than through the queue, which is what the
   * manifest subscription does when the drainer runs — the subscription itself is covered by the
   * manifest tests.
   */
  it("reaches the person who prepared the quotation, in their own inbox", async () => {
    const seller = await makeUser("marketing_manager", ["quotation.create", "quotation.view"]);
    const account = await db.customerAccount.create({
      data: {
        code: `SIQ-${randomUUID().slice(0, 11)}`,
        name: `SI Quote Co ${suffix}`,
        ownerId: seller.id,
      },
    });
    accountIds.push(account.id);

    const inquiry = await db.inquiry.create({
      data: {
        number: `TEST-INQ-${randomUUID().slice(0, 8)}`,
        accountId: account.id,
        subject: `Scope change fixture ${suffix}`,
        ownerId: seller.id,
        source: "email",
      },
    });
    inquiryIds.push(inquiry.id);

    const quotation = await createQuotationService(actorFor(seller), {
      accountId: account.id,
      inquiryId: inquiry.id,
      title: "Supply and install two transfer pumps",
    });
    quotationIds.push(quotation.id);

    await promptRevisionOnScopeChange({
      siteInspectionId: "fixture",
      number: "AIESSIR-260099",
      inquiryId: inquiry.id,
      notes: "Two extra tie-in points not on the drawing.",
    });

    const notification = await db.notification.findFirst({
      where: { recipientId: seller.id, type: "quotation.scope_change_identified" },
    });
    expect(notification).not.toBeNull();
    expect(notification!.title).toContain(quotation.number);
    expect(notification!.body).toContain("tie-in points");
  });

  it("says so quietly when a survey precedes any quotation", async () => {
    // The module 01 route: inspecting *before* pricing is the whole point, so there is nothing to
    // revise. This must not throw — a throw would dead-letter a job whose real work is done.
    await expect(
      promptRevisionOnScopeChange({ siteInspectionId: "fixture-2", notes: "n/a" }),
    ).resolves.toBeUndefined();
  });
});

describe("§6.1 — the module 01 route", () => {
  /**
   * specs/01-crm-inquiry.md §5: "Module 04 subscribes and creates a scheduled field task."
   *
   * The promise crm.prisma has carried in a comment since module 01 was built.
   */
  it("turns an inspection request into a scheduled visit", async () => {
    const seller = await makeUser("marketing_manager", ["quotation.create"]);
    const tech = await makeUser("technician", ["ticket.execute", "ticket.view_all"]);

    const account = await db.customerAccount.create({
      data: {
        code: `SIR-${randomUUID().slice(0, 11)}`,
        name: `SI Req Co ${suffix}`,
        ownerId: seller.id,
      },
    });
    accountIds.push(account.id);

    const inquiry = await db.inquiry.create({
      data: {
        number: `TEST-INQ-${randomUUID().slice(0, 8)}`,
        accountId: account.id,
        subject: `Inspection request fixture ${suffix}`,
        ownerId: seller.id,
        source: "email",
      },
    });
    inquiryIds.push(inquiry.id);

    const request = await db.inspectionRequest.create({
      data: {
        inquiryId: inquiry.id,
        purpose: "Confirm the tie-in points before pricing.",
        requestedById: seller.id,
        assignedToId: tech.id,
        dueAt: new Date("2026-09-01T00:00:00.000Z"),
        status: "scheduled",
      },
    });
    requestIds.push(request.id);

    await scheduleFromInspectionRequest({
      inspectionRequestId: request.id,
      inquiryId: inquiry.id,
    });

    const inspection = await db.siteInspection.findUnique({
      where: { inspectionRequestId: request.id },
    });
    expect(inspection).not.toBeNull();
    inspectionIds.push(inspection!.id);

    expect(inspection!.inquiryId).toBe(inquiry.id);
    expect(inspection!.ticketId).toBeNull();
    expect(inspection!.inspectedByIds).toContain(tech.id);
    expect(inspection!.scheduledFor?.toISOString().slice(0, 10)).toBe("2026-09-01");

    /**
     * The retry case. The job queue redelivers, and a second visit scheduled for one request would
     * put two surveyors on one site.
     */
    await scheduleFromInspectionRequest({
      inspectionRequestId: request.id,
      inquiryId: inquiry.id,
    });
    const all = await db.siteInspection.findMany({ where: { inquiryId: inquiry.id } });
    expect(all).toHaveLength(1);

    // Completing the visit closes module 01's request, so the inquiry stops waiting on it.
    await saveInspectionService(actorFor(tech), { inspectionId: inspection!.id, ...GOOD_FINDINGS });
    await completeInspectionService(actorFor(tech), inspection!.id);

    const closed = await db.inspectionRequest.findUniqueOrThrow({ where: { id: request.id } });
    expect(closed.status).toBe("completed");
    expect(closed.findings).toContain("DN100");
  });
});

describe("§19 — who sees what", () => {
  it("keeps a technician out of a survey they did not attend", async () => {
    const tech = await makeUser("technician", ["ticket.execute", "ticket.view"]);
    const other = await makeUser("technician", ["ticket.view"]);
    const ticket = await makeTicket(tech);
    const inspection = await scheduleFor(tech, ticket.id);

    await expect(getInspectionService(other, inspection.id)).rejects.toThrow(
      /visible to the people who attended/,
    );
    await expect(getInspectionService(tech, inspection.id)).resolves.toBeTruthy();
  });

  it("filters the register down to surveys that found extra scope", async () => {
    const tech = await makeUser("technician", ["ticket.execute", "ticket.view_all"]);
    const plain = await makeTicket(tech);
    const grew = await makeTicket(tech);

    const a = await scheduleFor(tech, plain.id);
    const b = await scheduleFor(tech, grew.id);

    await saveInspectionService(actorFor(tech), {
      inspectionId: b.id,
      ...GOOD_FINDINGS,
      scopeChangeIdentified: true,
      scopeChangeNotes: "Extra tie-in points.",
    });

    const flagged = await listInspectionsService(tech, { scopeChangeOnly: true });
    const ids = flagged.map((row) => row.id);
    expect(ids).toContain(b.id);
    expect(ids).not.toContain(a.id);
  });

  /**
   * The behaviour this change actually removed (2026-09-03): `ticket.view_all` used to be enough on
   * its own. It no longer is — the company asked for exactly EA, KJ and DJ by name, "and by the
   * person that conducted the inspection" for anyone else, so a bystander who merely holds that one
   * broad permission for unrelated dispatch reasons is refused, same as one holding no permission at
   * all in the first test above.
   */
  it("refuses a bystander who holds ticket.view_all but is not EA, KJ or DJ", async () => {
    const tech = await makeUser("technician", ["ticket.execute"]);
    const ticket = await makeTicket(tech);
    const inspection = await scheduleFor(tech, ticket.id);

    const dispatcher = await makeUser("operations_manager", ["ticket.view_all"]);
    await expect(getInspectionService(dispatcher, inspection.id)).rejects.toThrow(
      /visible to the people who attended/,
    );
  });

  it("writes an audit row against the inspection", async () => {
    const tech = await makeUser("technician", ["ticket.execute"]);
    const ticket = await makeTicket(tech);
    const inspection = await scheduleFor(tech, ticket.id);

    const log = await db.auditLog.findFirst({
      where: {
        entityType: SITE_INSPECTION_ENTITY_TYPE,
        entityId: inspection.id,
        action: "scheduled",
      },
    });
    expect(log).not.toBeNull();
  });

  /**
   * "Share report to" (2026-09-03): "when this is clicked, the user selected will have access to
   * this site inspection report." Built the moment the closed default list shipped, so somebody
   * outside it can still be let in for one particular survey without a standing permission.
   */
  describe("sharing", () => {
    it("lets in a bystander once shared, and names them on the record", async () => {
      const tech = await makeUser("technician", ["ticket.execute"]);
      const ticket = await makeTicket(tech);
      const inspection = await scheduleFor(tech, ticket.id);

      const bystander = await makeUser("technician", ["ticket.view"]);
      await expect(getInspectionService(bystander, inspection.id)).rejects.toThrow(
        /visible to the people who attended/,
      );

      const result = await shareInspectionService(
        { ...actorFor(tech), id: tech.id, email: tech.email },
        { inspectionId: inspection.id, userId: bystander.id },
      );
      expect(result.alreadyShared).toBe(false);

      await expect(getInspectionService(bystander, inspection.id)).resolves.toBeTruthy();

      const opened = await getInspectionService(tech, inspection.id);
      expect(opened.sharedWith.map((person) => person.id)).toContain(bystander.id);
    });

    it("is idempotent — sharing with somebody who already has access changes nothing", async () => {
      const tech = await makeUser("technician", ["ticket.execute"]);
      const ticket = await makeTicket(tech);
      const inspection = await scheduleFor(tech, ticket.id);

      // tech is already the requester — already has access before any share.
      const result = await shareInspectionService(
        { ...actorFor(tech), id: tech.id, email: tech.email },
        { inspectionId: inspection.id, userId: tech.id },
      );
      expect(result.alreadyShared).toBe(true);

      const opened = await getInspectionService(tech, inspection.id);
      expect(opened.sharedWith).toEqual([]);
    });

    /**
     * The gap found while building this feature: the file-access checker for a survey's own photos
     * had never been updated for #166's closed list, so it still read `ticket.view_all` — meaning a
     * bystander refused the record itself could still open every picture in it, and there was no way
     * for the checker to see a fresh share at all.
     */
    it("shares access to the survey's own photographs, not only the record", async () => {
      const tech = await makeUser("technician", ["ticket.execute"]);
      const ticket = await makeTicket(tech);
      const inspection = await scheduleFor(tech, ticket.id);

      const dispatcher = await makeUser("operations_manager", ["ticket.view_all"]);
      const fakeFile = {
        id: "f1",
        entityType: SITE_INSPECTION_ENTITY_TYPE,
        entityId: inspection.id,
        storageKey: "k",
        webDerivativeKey: null,
        filename: "photo.jpg",
        mimeType: "image/jpeg",
        size: 1,
        sha256: "x",
        uploaderId: tech.id,
        createdAt: new Date(),
        deletedAt: null,
      };

      expect(await canAccessFile(dispatcher, fakeFile)).toBe(false);

      await shareInspectionService(
        { ...actorFor(tech), id: tech.id, email: tech.email },
        { inspectionId: inspection.id, userId: dispatcher.id },
      );

      expect(await canAccessFile(dispatcher, fakeFile)).toBe(true);
    });

    it("refuses to let somebody share a report they cannot themselves open", async () => {
      const tech = await makeUser("technician", ["ticket.execute"]);
      const ticket = await makeTicket(tech);
      const inspection = await scheduleFor(tech, ticket.id);

      const bystander = await makeUser("technician", ["ticket.view"]);
      const thirdParty = await makeUser("technician", ["ticket.view"]);

      await expect(
        shareInspectionService(
          { ...actorFor(bystander), id: bystander.id, email: bystander.email },
          { inspectionId: inspection.id, userId: thirdParty.id },
        ),
      ).rejects.toThrow(/cannot share a report you cannot yourself open/);
    });
  });
});
