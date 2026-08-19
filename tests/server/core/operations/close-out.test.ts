import { randomUUID } from "node:crypto";
import { afterAll, describe, expect, it } from "vitest";
import { db } from "@/lib/db";
import { SERVICE_REPORT_ENTITY_TYPE } from "@/server/core/operations/close-out-rules";
import {
  advanceServiceReportService,
  recordExternalServiceReportService,
  closeOutChecklistForProjectService,
  closeOutProjectService,
  saveServiceReportService,
  upsertCloseOutService,
} from "@/server/core/operations/close-out-service";
import { createStandaloneTicketService } from "@/server/core/operations/ticket-service";
import type { AuthedUser } from "@/server/core/rbac/types";

/**
 * specs/04-operations-projects.md §12, against the real database.
 *
 * The pure tests prove `closeOutChecklist` behaves. What only a real run settles is that each
 * blocker is **wired to the right records** — that "unapproved service reports" counts service
 * reports and not something that happens to be nearby, and that clearing the real record clears the
 * real blocker.
 */

const suffix = randomUUID().slice(0, 8);
const accountIds: string[] = [];
const projectIds: string[] = [];
const ticketIds: string[] = [];
const reportIds: string[] = [];
const tcIds: string[] = [];
const qaIds: string[] = [];
const userIds: string[] = [];

async function makeUser(roleKey: string): Promise<AuthedUser> {
  const role = await db.role.findUniqueOrThrow({ where: { key: roleKey } });
  const user = await db.user.create({
    data: {
      email: `co-${roleKey}-${randomUUID().slice(0, 8)}@test.local`,
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
    permissions: new Set(["ticket.execute", "service_report.approve", "project.close"]),
  };
}

const actorFor = (user: AuthedUser) => ({ actorId: user.id, actorLabel: user.name });

/** A project with one ticket on it, and customer acceptance already on file. */
async function makeProject(lead: AuthedUser) {
  const account = await db.customerAccount.create({
    data: { code: `CO-${randomUUID().slice(0, 12)}`, name: `CO Co ${suffix}`, ownerId: lead.id },
  });
  accountIds.push(account.id);

  const project = await db.project.create({
    data: {
      code: `PRJ-${randomUUID().slice(0, 10)}`,
      name: `Close-out project ${suffix}`,
      accountId: account.id,
      status: "in_progress",
      scopeOfWork: "Work that has to be finished before anybody is billed.",
    },
  });
  projectIds.push(project.id);

  const ticket = await createStandaloneTicketService(actorFor(lead), {
    accountId: account.id,
    projectId: project.id,
    type: "installation",
    title: `Close-out ticket ${randomUUID().slice(0, 6)}`,
    scopeOfWork: "Do it.",
    justification: "Standalone for the test fixture.",
  });
  ticketIds.push(ticket.id);

  await upsertCloseOutService(actorFor(lead), {
    projectId: project.id,
    customerAcceptanceFileId: "file-acceptance",
  });

  return { account, project, ticket };
}

async function addTc(ticketId: string, projectId: string, userId: string, punchItems: unknown[]) {
  const row = await db.testingCommissioning.create({
    data: {
      number: `AIESTC-TEST${randomUUID().slice(0, 6)}`,
      ticketId,
      projectId,
      recordedById: userId,
      punchItems: punchItems as never,
    },
  });
  tcIds.push(row.id);
  return row;
}

async function addQa(ticketId: string, userId: string, approved: boolean) {
  const row = await db.qAApproval.create({
    data: {
      number: `AIESQA-TEST${randomUUID().slice(0, 6)}`,
      ticketId,
      approved,
      recordedById: userId,
      recordedAt: new Date(),
    },
  });
  qaIds.push(row.id);
  return row;
}

afterAll(async () => {
  await db.projectCloseOut.deleteMany({ where: { projectId: { in: projectIds } } });
  // By ticket as well as by id: the external-report tests let the service allocate the id, so the
  // fixture never sees it. Deleting by id alone left rows behind and the ticket delete then failed
  // on the foreign key — which is how this cleanup announced the gap rather than hiding it.
  await db.serviceReport.deleteMany({
    where: { OR: [{ id: { in: reportIds } }, { ticketId: { in: ticketIds } }] },
  });
  await db.testingCommissioning.deleteMany({ where: { id: { in: tcIds } } });
  await db.qAApproval.deleteMany({ where: { id: { in: qaIds } } });
  await db.auditLog.deleteMany({
    where: { entityId: { in: [...reportIds, ...projectIds, ...ticketIds, ...accountIds] } },
  });
  await db.eventOutbox.deleteMany({ where: { actorId: { in: userIds } } });
  await db.ticketSalesOrderLine.deleteMany({ where: { ticketId: { in: ticketIds } } });
  await db.ticket.deleteMany({ where: { id: { in: ticketIds } } });
  await db.project.deleteMany({ where: { id: { in: projectIds } } });
  await db.customerAccount.deleteMany({ where: { id: { in: accountIds } } });
  // The signed documents the external reports point at.
  await db.fileObject.deleteMany({ where: { uploaderId: { in: userIds } } });
  await db.userRole.deleteMany({ where: { userId: { in: userIds } } });
  await db.user.deleteMany({ where: { id: { in: userIds } } });
});

describe("§12's blockers, wired to real records", () => {
  it("closes a project with nothing outstanding, and emits the handover", async () => {
    const pm = await makeUser("operations_manager");
    const { project } = await makeProject(pm);

    const state = await closeOutChecklistForProjectService(project.id);
    expect(state.canClose).toBe(true);
    expect(state.checklist).toHaveLength(6);

    await closeOutProjectService(actorFor(pm), { projectId: project.id });

    const after = await db.project.findUniqueOrThrow({ where: { id: project.id } });
    expect(after.status).toBe("closed");

    // §12: "Approval emits `project.closed` → module 05 releases final billing."
    const event = await db.eventOutbox.findFirst({
      where: { event: "project.closed", actorId: pm.id },
    });
    expect(event).toBeTruthy();
    const payload = event?.payload as { clearedBlockers?: string[] };
    expect(payload.clearedBlockers).toHaveLength(6);
  });

  /** §10's punch items, read through the commissioning records on the project. */
  it("blocks on an open critical punch item and releases when it is closed", async () => {
    const pm = await makeUser("operations_manager");
    const { project, ticket } = await makeProject(pm);

    const tc = await addTc(ticket.id, project.id, pm.id, [
      { description: "Earth bond missing", severity: "critical" },
    ]);

    const blocked = await closeOutChecklistForProjectService(project.id);
    expect(blocked.canClose).toBe(false);
    expect(blocked.blockers.map((entry) => entry.key)).toEqual(["critical_punch_items"]);

    await expect(closeOutProjectService(actorFor(pm), { projectId: project.id })).rejects.toThrow(
      /Close-out is blocked/,
    );

    await db.testingCommissioning.update({
      where: { id: tc.id },
      data: {
        punchItems: [
          { description: "Earth bond missing", severity: "critical", status: "closed" },
        ] as never,
      },
    });

    const released = await closeOutChecklistForProjectService(project.id);
    expect(released.canClose).toBe(true);
  });

  it("blocks on an unapproved service report and releases when it is approved", async () => {
    const pm = await makeUser("operations_manager");
    const { project, ticket } = await makeProject(pm);

    const report = await saveServiceReportService(actorFor(pm), {
      ticketId: ticket.id,
      workPerformed: "Replaced the seal and re-commissioned the pump.",
      finishedAt: new Date(),
    });
    reportIds.push(report.id);

    const blocked = await closeOutChecklistForProjectService(project.id);
    expect(blocked.blockers.map((entry) => entry.key)).toEqual(["unapproved_service_reports"]);

    await advanceServiceReportService(actorFor(pm), {
      id: report.id,
      target: "approved",
      customerSignatureFileId: "file-sig",
      customerName: "Plant engineer",
    });

    const released = await closeOutChecklistForProjectService(project.id);
    expect(released.canClose).toBe(true);
  });

  /**
   * The nuance worth a real test: §9 counts rework rounds, so an early rejection followed by an
   * approval is a job that went round the loop and came out — not an open blocker. Only the
   * **latest** verdict per ticket counts.
   */
  it("blocks on a failed QA and releases when a later round passes", async () => {
    const pm = await makeUser("operations_manager");
    const { project, ticket } = await makeProject(pm);

    await addQa(ticket.id, pm.id, false);

    const blocked = await closeOutChecklistForProjectService(project.id);
    expect(blocked.blockers.map((entry) => entry.key)).toEqual(["failed_qa"]);

    // A later approval, recorded after the rejection.
    await new Promise((resolve) => setTimeout(resolve, 10));
    await addQa(ticket.id, pm.id, true);

    const released = await closeOutChecklistForProjectService(project.id);
    expect(released.canClose).toBe(true);
  });

  it("blocks on missing customer acceptance and releases when it is on file", async () => {
    const pm = await makeUser("operations_manager");
    const { project } = await makeProject(pm);

    await upsertCloseOutService(actorFor(pm), {
      projectId: project.id,
      customerAcceptanceFileId: null,
    });

    const blocked = await closeOutChecklistForProjectService(project.id);
    expect(blocked.blockers.map((entry) => entry.key)).toEqual(["missing_customer_acceptance"]);

    await upsertCloseOutService(actorFor(pm), {
      projectId: project.id,
      customerAcceptanceFileId: "file-acceptance",
    });

    const released = await closeOutChecklistForProjectService(project.id);
    expect(released.canClose).toBe(true);
  });

  /** A project with no close-out record has not waived anything — acceptance is required by default. */
  it("requires customer acceptance on a project nobody has set up yet", async () => {
    const pm = await makeUser("operations_manager");
    const account = await db.customerAccount.create({
      data: { code: `CO-${randomUUID().slice(0, 12)}`, name: `Bare ${suffix}`, ownerId: pm.id },
    });
    accountIds.push(account.id);
    const project = await db.project.create({
      data: {
        code: `PRJ-${randomUUID().slice(0, 10)}`,
        name: `Bare project ${suffix}`,
        accountId: account.id,
        status: "in_progress",
        scopeOfWork: "Nothing set up.",
      },
    });
    projectIds.push(project.id);

    const state = await closeOutChecklistForProjectService(project.id);
    expect(state.canClose).toBe(false);
    expect(state.blockers.map((entry) => entry.key)).toEqual(["missing_customer_acceptance"]);
  });
});

describe("§12's service report, at the service", () => {
  it("refuses to mark a report signed with nothing behind it", async () => {
    const pm = await makeUser("operations_manager");
    const { ticket } = await makeProject(pm);

    const report = await saveServiceReportService(actorFor(pm), {
      ticketId: ticket.id,
      workPerformed: "Work done.",
      finishedAt: new Date(),
    });
    reportIds.push(report.id);

    await expect(
      advanceServiceReportService(actorFor(pm), { id: report.id, target: "signed" }),
    ).rejects.toThrow(/customer's signature, or a written reason/);
  });

  it("emits service_report.approved for §12's checklist to read", async () => {
    const pm = await makeUser("operations_manager");
    const { ticket } = await makeProject(pm);

    const report = await saveServiceReportService(actorFor(pm), {
      ticketId: ticket.id,
      workPerformed: "Work done.",
      finishedAt: new Date(),
    });
    reportIds.push(report.id);

    await advanceServiceReportService(actorFor(pm), {
      id: report.id,
      target: "approved",
      signatureWaiverReason: "Customer left site; acceptance emailed the same evening.",
    });

    const event = await db.eventOutbox.findFirst({
      where: { event: "service_report.approved", actorId: pm.id },
    });
    expect(event).toBeTruthy();
  });

  it("will not edit an approved report", async () => {
    const pm = await makeUser("operations_manager");
    const { ticket } = await makeProject(pm);

    const report = await saveServiceReportService(actorFor(pm), {
      ticketId: ticket.id,
      workPerformed: "Work done.",
      finishedAt: new Date(),
    });
    reportIds.push(report.id);

    await advanceServiceReportService(actorFor(pm), {
      id: report.id,
      target: "approved",
      signatureWaiverReason: "Emailed.",
    });

    await expect(
      saveServiceReportService(actorFor(pm), {
        id: report.id,
        ticketId: ticket.id,
        workPerformed: "Rewritten after approval.",
      }),
    ).rejects.toThrow(/Raise a new one/);
  });
});

describe("§12's handover happens once", () => {
  it("will not close a project twice", async () => {
    const pm = await makeUser("operations_manager");
    const { project } = await makeProject(pm);

    await closeOutProjectService(actorFor(pm), { projectId: project.id });
    await expect(closeOutProjectService(actorFor(pm), { projectId: project.id })).rejects.toThrow(
      /already closed/,
    );
  });
});

/**
 * §12's second path — a service report written on an externally supplied form, already signed.
 *
 * Some customers will not accept AIES's report and hand over their own job sheet, which the
 * technician completes on site and their engineer signs before the van leaves. Until this existed
 * that document could be attached and nothing more, so §12's gate went on reading "no approved
 * service report" and held the project open at close-out on a job the customer had already signed
 * off. Found by the company on 2026-08-19, one panel after the method statement version of the same
 * gap.
 */
describe("an externally written service report", () => {
  async function makeSignedFile(uploader: AuthedUser) {
    return db.fileObject.create({
      data: {
        entityType: SERVICE_REPORT_ENTITY_TYPE,
        entityId: `pending-${randomUUID()}`,
        filename: "customer-job-sheet.pdf",
        mimeType: "application/pdf",
        size: 4096,
        sha256: randomUUID(),
        storageKey: `test/${randomUUID()}.pdf`,
        uploaderId: uploader.id,
      },
    });
  }

  it("counts as approved, so close-out stops waiting on it", async () => {
    const tech = await makeUser("operations_manager");
    const { ticket } = await makeProject(tech);
    const file = await makeSignedFile(tech);

    const created = await recordExternalServiceReportService(actorFor(tech), {
      ticketId: ticket.id,
      workPerformed: "Replaced the flow element and proved the loop against the DCS.",
      signatureFileId: file.id,
      customerName: "R. Santos",
      customerPosition: "Maintenance Superintendent",
      finishedAt: new Date(Date.now() - 24 * 60 * 60 * 1000),
    });

    const row = await db.serviceReport.findUniqueOrThrow({ where: { id: created.id } });
    // Approved through the status the close-out gate already counts, rather than through any new
    // notion of "approved enough".
    expect(row.status).toBe("approved");
    expect(row.customerSignatureFileId).toBe(file.id);
    expect(row.customerName).toBe("R. Santos");
    // And honest about who wrote it: the missing findings and parts are somebody else's form, not
    // a half-filled one of ours.
    expect(row.externalDocument).toBe(true);
  });

  it("refuses a report nobody signed, and one finished in the future", async () => {
    const tech = await makeUser("operations_manager");
    const { ticket } = await makeProject(tech);
    const file = await makeSignedFile(tech);

    await expect(
      recordExternalServiceReportService(actorFor(tech), {
        ticketId: ticket.id,
        workPerformed: "Did the work.",
        signatureFileId: file.id,
        customerName: "  ",
        finishedAt: new Date(Date.now() - 1000),
      }),
    ).rejects.toThrow(/Name who signed/);

    await expect(
      recordExternalServiceReportService(actorFor(tech), {
        ticketId: ticket.id,
        workPerformed: "Did the work.",
        signatureFileId: file.id,
        customerName: "R. Santos",
        finishedAt: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000),
      }),
    ).rejects.toThrow(/finished in the future/);
  });

  it("refuses an attachment that is not there", async () => {
    const tech = await makeUser("operations_manager");
    const { ticket } = await makeProject(tech);

    await expect(
      recordExternalServiceReportService(actorFor(tech), {
        ticketId: ticket.id,
        workPerformed: "Did the work.",
        signatureFileId: "no-such-file",
        customerName: "R. Santos",
        finishedAt: new Date(Date.now() - 1000),
      }),
    ).rejects.toThrow(/no longer exists/);
  });

  /**
   * Unlike the method statement's twin, this one does **not** refuse a second report on the ticket.
   * §12 expects one per visit, so refusing would break the ordinary case to prevent a misuse that is
   * not available here: there is no review chain to sidestep, and this path costs the same signature
   * and the same named signatory as the other one.
   */
  it("allows a second report on the same ticket, because visits repeat", async () => {
    const tech = await makeUser("operations_manager");
    const { ticket } = await makeProject(tech);
    const first = await makeSignedFile(tech);
    const second = await makeSignedFile(tech);

    await recordExternalServiceReportService(actorFor(tech), {
      ticketId: ticket.id,
      workPerformed: "First visit.",
      signatureFileId: first.id,
      customerName: "R. Santos",
      finishedAt: new Date(Date.now() - 2 * 24 * 60 * 60 * 1000),
    });

    await expect(
      recordExternalServiceReportService(actorFor(tech), {
        ticketId: ticket.id,
        workPerformed: "Second visit, snag cleared.",
        signatureFileId: second.id,
        customerName: "R. Santos",
        finishedAt: new Date(Date.now() - 1000),
      }),
    ).resolves.toBeTruthy();
  });
});
