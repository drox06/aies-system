import { randomUUID } from "node:crypto";
import { afterAll, describe, expect, it } from "vitest";
import { db } from "@/lib/db";
import {
  buildChecklistResponseProps,
  buildCloseOutPackProps,
  buildDailyProgressProps,
  buildMethodStatementProps,
  buildServiceReportProps,
  buildSiteInspectionReportProps,
  buildTcCertificateProps,
  renderChecklistResponsePdf,
  renderCloseOutPackPdf,
  renderDailyProgressPdf,
  renderMethodStatementPdf,
  renderServiceReportPdf,
  renderSiteInspectionReportPdf,
  renderTcCertificatePdf,
} from "@/server/core/operations/pdf/render";
import {
  createMethodologyService,
  saveMethodologyService,
} from "@/server/core/operations/methodology-service";
import {
  advanceServiceReportService,
  saveServiceReportService,
  upsertCloseOutService,
} from "@/server/core/operations/close-out-service";
import {
  completeResponseService,
  saveAnswersService,
  startResponseService,
} from "@/server/core/operations/checklist-service";
import { CHECKLIST_RESPONSE_ENTITY_TYPE } from "@/server/core/operations/checklist-rules";
import { SERVICE_REPORT_ENTITY_TYPE } from "@/server/core/operations/close-out-rules";
import { SITE_INSPECTION_ENTITY_TYPE } from "@/server/core/operations/site-inspection-rules";
import { createStandaloneTicketService } from "@/server/core/operations/ticket-service";
import { uploadFile } from "@/server/core/storage/storage";
import { supabaseStorageDriver } from "@/server/core/storage/supabase-driver";
import type { AuthedUser } from "@/server/core/rbac/types";

/**
 * Module 04's three documents: §10's certificate, §8's daily progress report, §12's close-out pack.
 *
 * Asserted on the **props**, not the bytes. `@react-pdf` compresses its content streams and subsets
 * its fonts, so the finished PDF cannot be searched for text — grepping the output to prove
 * something is on the page would pass whether it was there or not. The props are the document's
 * complete input, so this is the real test. Same reasoning as modules 02 and 03.
 */

const suffix = randomUUID().slice(0, 8);
const accountIds: string[] = [];
const projectIds: string[] = [];
const ticketIds: string[] = [];
const tcIds: string[] = [];
const progressIds: string[] = [];
const userIds: string[] = [];
const methodologyIds: string[] = [];
const inspectionIds: string[] = [];
const checklistResponseIds: string[] = [];
const serviceReportIds: string[] = [];
const fileIds: string[] = [];
const storageKeys: string[] = [];

async function makeUser(): Promise<AuthedUser> {
  const role = await db.role.findUniqueOrThrow({ where: { key: "operations_manager" } });
  const user = await db.user.create({
    data: {
      email: `pdf-${randomUUID().slice(0, 8)}@test.local`,
      name: `PDF tester ${randomUUID().slice(0, 4)}`,
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
    roleKeys: ["operations_manager"],
    permissions: new Set(["ticket.execute", "project.manage"]),
  };
}

const actorFor = (user: AuthedUser) => ({ actorId: user.id, actorLabel: user.name });

async function makeFixture(user: AuthedUser) {
  const account = await db.customerAccount.create({
    data: { code: `PDF-${randomUUID().slice(0, 12)}`, name: `PDF Co ${suffix}`, ownerId: user.id },
  });
  accountIds.push(account.id);

  const project = await db.project.create({
    data: {
      code: `PRJ-${randomUUID().slice(0, 10)}`,
      name: `PDF project ${suffix}`,
      accountId: account.id,
      status: "in_progress",
      scopeOfWork: "Install, commission and hand over.",
    },
  });
  projectIds.push(project.id);

  const ticket = await createStandaloneTicketService(actorFor(user), {
    accountId: account.id,
    projectId: project.id,
    type: "installation",
    title: `PDF ticket ${randomUUID().slice(0, 6)}`,
    scopeOfWork: "Do the work.",
    justification: "Standalone for the test fixture.",
  });
  ticketIds.push(ticket.id);

  return { account, project, ticket };
}

afterAll(async () => {
  await db.auditLog.deleteMany({ where: { entityId: { in: inspectionIds } } });
  await db.siteInspection.deleteMany({ where: { id: { in: inspectionIds } } });
  await db.auditLog.deleteMany({
    where: { entityId: { in: [...checklistResponseIds, ...serviceReportIds] } },
  });
  await db.checklistResponse.deleteMany({ where: { id: { in: checklistResponseIds } } });
  await db.serviceReport.deleteMany({ where: { id: { in: serviceReportIds } } });
  await db.fileObject.deleteMany({ where: { id: { in: fileIds } } });
  for (const key of storageKeys) {
    await supabaseStorageDriver.remove(key).catch(() => {});
  }
  await db.methodology.deleteMany({ where: { id: { in: methodologyIds } } });
  await db.projectCloseOut.deleteMany({ where: { projectId: { in: projectIds } } });
  await db.testingCommissioning.deleteMany({ where: { id: { in: tcIds } } });
  await db.dailyProgress.deleteMany({ where: { id: { in: progressIds } } });
  await db.auditLog.deleteMany({
    where: { entityId: { in: [...projectIds, ...ticketIds, ...accountIds] } },
  });
  await db.eventOutbox.deleteMany({ where: { actorId: { in: userIds } } });
  await db.ticketSalesOrderLine.deleteMany({ where: { ticketId: { in: ticketIds } } });
  await db.ticket.deleteMany({ where: { id: { in: ticketIds } } });
  await db.project.deleteMany({ where: { id: { in: projectIds } } });
  await db.customerAccount.deleteMany({ where: { id: { in: accountIds } } });
  await db.userRole.deleteMany({ where: { userId: { in: userIds } } });
  await db.user.deleteMany({ where: { id: { in: userIds } } });
});

describe("§10's certificate", () => {
  /**
   * The document's whole reason to exist: §10 calls it "a primary billing trigger document", and a
   * reader months later needs the criterion each reading was judged against and where it came from.
   */
  it("prints every test with its criterion and where the criterion came from", async () => {
    const user = await makeUser();
    const { project, ticket } = await makeFixture(user);

    const record = await db.testingCommissioning.create({
      data: {
        number: `AIESTC-PDF${randomUUID().slice(0, 5)}`,
        ticketId: ticket.id,
        projectId: project.id,
        recordedById: user.id,
        completedAt: new Date(),
        result: "accepted_with_punch",
        calibrationAssetsUsed: ["FLUKE-744"],
        functionalTests: [
          {
            test: "Loop 4-20mA output",
            criterion: { kind: "range", min: 4, max: 20 },
            criterionSource: "quotation",
            quotationLineId: "ql-1",
            promiseText: "Transmitter, 4-20mA output",
            measured: 12,
          },
          {
            test: "Insulation resistance",
            criterion: { kind: "min", min: 5 },
            criterionSource: "stated",
            measured: 2,
          },
          {
            test: "Vibration",
            criterion: { kind: "max", max: 4 },
            criterionSource: "stated",
            measured: null,
          },
        ] as never,
        punchItems: [
          { description: "Earth bond missing", severity: "critical", status: "open" },
        ] as never,
      },
    });
    tcIds.push(record.id);

    const props = await buildTcCertificateProps(record.id);

    expect(props.tests).toHaveLength(3);
    expect(props.tests[0]).toMatchObject({
      criterion: "4 to 20",
      measured: "12",
      verdict: "pass",
      source: "Accepted quotation",
      promiseText: "Transmitter, 4-20mA output",
    });
    // Out of spec prints as out of spec.
    expect(props.tests[1]!.verdict).toBe("fail");
    // Never measured prints as unresolved rather than being dropped or read as a pass.
    expect(props.tests[2]!.verdict).toBe("indeterminate");

    // The weak part, stated on the face of the document rather than left to be inferred.
    expect(props.statedCriteriaCount).toBe(2);
    expect(props.punchItems).toHaveLength(1);
    expect(props.instruments).toEqual(["FLUKE-744"]);
    expect(props.resultLabel).toBe("Accepted with punch list");
  });

  /** An incomplete commissioning is a draft, not a certificate waiting for a signature. */
  it("carries no result for a commissioning nobody has completed", async () => {
    const user = await makeUser();
    const { project, ticket } = await makeFixture(user);

    const record = await db.testingCommissioning.create({
      data: {
        number: `AIESTC-PDF${randomUUID().slice(0, 5)}`,
        ticketId: ticket.id,
        projectId: project.id,
        recordedById: user.id,
      },
    });
    tcIds.push(record.id);

    const props = await buildTcCertificateProps(record.id);
    expect(props.completedAt).toBeNull();
    expect(props.result).toBeNull();
    expect(props.resultLabel).toBeNull();
  });
});

describe("§8's daily progress report", () => {
  /**
   * §8's attribution, on the page. A claim built on the customer's delays that quietly omits AIES's
   * own is the one their engineer takes apart, so the document totals both.
   */
  it("totals standby by who caused it, ours included", async () => {
    const user = await makeUser();
    const { project, ticket } = await makeFixture(user);

    const days = [
      { day: "2026-08-10", standby: "4.00", cause: "client_not_ready", pct: 10 },
      { day: "2026-08-11", standby: "2.50", cause: "equipment_failure", pct: 25 },
      { day: "2026-08-12", standby: "3.00", cause: "weather", pct: 40 },
      { day: "2026-08-13", standby: "0.00", cause: null, pct: 60 },
    ];

    for (const entry of days) {
      const row = await db.dailyProgress.create({
        data: {
          ticketId: ticket.id,
          projectId: project.id,
          logDate: new Date(entry.day),
          percentComplete: entry.pct,
          manpowerOnSite: 3,
          hoursWorked: "8.00",
          standbyHours: entry.standby,
          standbyCause: entry.cause,
          loggedById: user.id,
        },
      });
      progressIds.push(row.id);
    }

    const props = await buildDailyProgressProps(ticket.id);

    expect(props.rows).toHaveLength(4);
    expect(props.totals.days).toBe(4);
    expect(props.totals.customerStandbyHours).toBe("4.00");
    expect(props.totals.aiesStandbyHours).toBe("2.50");
    expect(props.totals.neitherStandbyHours).toBe("3.00");
    expect(props.totals.standbyHours).toBe("9.50");
    expect(props.totals.hoursWorked).toBe("32.00");
    expect(props.latestPercent).toBe(60);

    // Attribution is printed per row, not only in the totals.
    expect(props.rows[0]!.standbyAttribution).toBe("customer");
    expect(props.rows[1]!.standbyAttribution).toBe("aies");
    expect(props.rows[2]!.standbyAttribution).toBe("neither");
  });

  it("renders a ticket with no days logged rather than failing", async () => {
    const user = await makeUser();
    const { ticket } = await makeFixture(user);

    const props = await buildDailyProgressProps(ticket.id);
    expect(props.rows).toHaveLength(0);
    expect(props.periodFrom).toBe("—");
    expect(props.latestPercent).toBe(0);
  });
});

describe("§12's close-out pack", () => {
  /**
   * §12 lists sixteen items. The index answers all sixteen — including the ones that are missing,
   * because an index that omits what it cannot answer reads as a complete pack with fewer
   * requirements.
   */
  it("indexes all sixteen items and states which are not on file", async () => {
    const user = await makeUser();
    const { project } = await makeFixture(user);

    await upsertCloseOutService(actorFor(user), {
      projectId: project.id,
      customerAcceptanceFileId: "file-acceptance",
    });

    const props = await buildCloseOutPackProps(project.id);

    expect(props.index).toHaveLength(16);
    expect(props.index.map((entry) => entry.item)).toContain("Customer acceptance certificate");

    const acceptance = props.index.find(
      (entry) => entry.item === "Customer acceptance certificate",
    )!;
    expect(acceptance.present).toBe(true);

    // A section whose module has not been built says so, rather than vanishing from the index.
    const asBuilt = props.index.find((entry) => entry.item === "As-built documentation")!;
    expect(asBuilt.present).toBe(false);
    expect(asBuilt.reference).toMatch(/Not built yet/);

    // §12's blockers travel with the pack, all six, cleared ones included.
    expect(props.checklist).toHaveLength(6);
    expect(props.canClose).toBe(true);
  });

  /** A pack pulled while blockers are open is provisional, and says so on its face. */
  it("marks a pack provisional while the project is open", async () => {
    const user = await makeUser();
    const { project } = await makeFixture(user);

    const props = await buildCloseOutPackProps(project.id);
    expect(props.closedAt).toBeNull();
    expect(props.canClose).toBe(false);
    expect(props.blockers.length).toBeGreaterThan(0);
  });
});

/**
 * §6.1's site inspection report, added 2026-09-03 at the company's request: "once all details in
 * the site inspection is accomplished, create a pdf site inspection report. include the pictures in
 * the report."
 *
 * The property that matters most is the last one: an uploaded photo has to come back as an
 * embeddable data URI, not merely as a file id the document trusts blind. `imageDataUri` fetches the
 * real bytes from Supabase Storage — the same integration-tested path storage.test.ts already
 * exercises — so this is the one PDF in the suite that cannot be proved with fixture JSON alone.
 */
describe("§6.1's site inspection report", () => {
  it("embeds an uploaded photo as a data URI, in attachment order", async () => {
    const user = await makeUser();
    const { ticket } = await makeFixture(user);

    const inspection = await db.siteInspection.create({
      data: {
        number: `AIESSIR-PDF${randomUUID().slice(0, 5)}`,
        ticketId: ticket.id,
        requestedById: user.id,
        inspectedAt: new Date("2026-08-20"),
        attendees: [{ party: "technical", name: "" }] as never,
        findings: "Existing panel is corroded; recommend full replacement.",
        status: "completed",
        completedAt: new Date(),
      },
    });
    inspectionIds.push(inspection.id);

    // A minimal, real, decodable PNG — sharp needs bytes it can actually resize, not a stub.
    const png = Buffer.from(
      "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=",
      "base64",
    );
    const file = await uploadFile({
      entityType: SITE_INSPECTION_ENTITY_TYPE,
      entityId: inspection.id,
      uploaderId: user.id,
      filename: "corroded-panel.png",
      mimeType: "image/png",
      buffer: png,
    });
    fileIds.push(file.id);
    storageKeys.push(file.storageKey);
    if (file.webDerivativeKey) storageKeys.push(file.webDerivativeKey);

    // No further wiring needed — attaching the file (above, keyed by entityType/entityId) is the
    // whole of what the real "Photographs and sketches" panel does. Pinning that the report finds it
    // without a second write is the point: `SiteInspection.photoFileIds` used to be required here too,
    // and the real UI never sets it (2026-09-04).
    const props = await buildSiteInspectionReportProps(inspection.id);

    expect(props.photos).toHaveLength(1);
    expect(props.photos[0]!.caption).toBe("Photo 1");
    // sharp resizes every image/* upload to a JPEG derivative — this is that photo, round-tripped.
    expect(props.photos[0]!.src.startsWith("data:image/jpeg;base64,")).toBe(true);
    expect(props.omittedImageCount).toBe(0);
    expect(props.linkedToLabel).toBe("Ticket");
    expect(props.linkedToValue).toBe(ticket.number);

    const pdf = await renderSiteInspectionReportPdf(inspection.id);
    expect(pdf.subarray(0, 4).toString()).toBe("%PDF");
    // A page with a real embedded photo is not a few hundred bytes.
    expect(pdf.length).toBeGreaterThan(3000);
  }, 60_000);

  it("renders a report with no photos rather than failing", async () => {
    const user = await makeUser();
    const { ticket } = await makeFixture(user);

    const inspection = await db.siteInspection.create({
      data: {
        number: `AIESSIR-PDF${randomUUID().slice(0, 5)}`,
        ticketId: ticket.id,
        requestedById: user.id,
        inspectedAt: new Date("2026-08-21"),
        attendees: [{ party: "sales", name: "" }] as never,
        findings: "Refused entry — no authorised contact on site.",
        status: "completed",
        completedAt: new Date(),
      },
    });
    inspectionIds.push(inspection.id);

    const props = await buildSiteInspectionReportProps(inspection.id);
    expect(props.photos).toEqual([]);
    expect(props.omittedImageCount).toBe(0);

    const pdf = await renderSiteInspectionReportPdf(inspection.id);
    expect(pdf.subarray(0, 4).toString()).toBe("%PDF");
  }, 30_000);

  /**
   * 2026-09-04: "reason should be added at the bottom of the SIR on why it was revised." The reason
   * is a `"revised"` audit row, written by `saveInspectionService` — this proves the report actually
   * finds it and renders with it present, not just that an empty list renders (the case above).
   */
  it("prints why an accomplished report was revised", async () => {
    const user = await makeUser();
    const { ticket } = await makeFixture(user);

    const inspection = await db.siteInspection.create({
      data: {
        number: `AIESSIR-PDF${randomUUID().slice(0, 5)}`,
        ticketId: ticket.id,
        requestedById: user.id,
        inspectedAt: new Date("2026-08-21"),
        attendees: [{ party: "sales", name: "" }] as never,
        findings: "Corrected: the meter is a DN80, not a DN100.",
        status: "completed",
        completedAt: new Date(),
      },
    });
    inspectionIds.push(inspection.id);

    await db.auditLog.create({
      data: {
        actorId: user.id,
        actorLabel: user.name,
        action: "revised",
        entityType: SITE_INSPECTION_ENTITY_TYPE,
        entityId: inspection.id,
        summary: `Revised ${inspection.number} — re-measured after the client disputed the first reading.`,
      },
    });

    const props = await buildSiteInspectionReportProps(inspection.id);
    expect(props.revisions).toHaveLength(1);
    expect(props.revisions[0]!.summary).toContain("re-measured after the client disputed");
    expect(props.revisions[0]!.by).toBe(user.name);

    const pdf = await renderSiteInspectionReportPdf(inspection.id);
    expect(pdf.subarray(0, 4).toString()).toBe("%PDF");
  }, 30_000);
});

/**
 * The props tests above prove the right facts reach the document. They cannot prove the document
 * renders — a bad style or a malformed row throws inside `@react-pdf` at render time, and every
 * props assertion would still pass. So each document is rendered once and the bytes are checked to
 * be a PDF. Not a content assertion, which the compressed streams make meaningless; a check that
 * bytes come out at all.
 */
describe("the documents actually render", () => {
  const isPdf = (bytes: Buffer) => bytes.subarray(0, 5).toString("latin1") === "%PDF-";

  it("renders §10's certificate, §8's report and §12's pack", async () => {
    const user = await makeUser();
    const { project, ticket } = await makeFixture(user);

    const record = await db.testingCommissioning.create({
      data: {
        number: `AIESTC-PDF${randomUUID().slice(0, 5)}`,
        ticketId: ticket.id,
        projectId: project.id,
        recordedById: user.id,
        completedAt: new Date(),
        result: "accepted",
        calibrationAssetsUsed: ["FLUKE-744"],
        functionalTests: [
          {
            test: "Loop 4-20mA output",
            criterion: { kind: "range", min: 4, max: 20 },
            criterionSource: "quotation",
            quotationLineId: "ql-1",
            promiseText: "Transmitter, 4-20mA output",
            measured: 12,
          },
        ] as never,
        punchItems: [{ description: "Touch-up paint", severity: "minor" }] as never,
      },
    });
    tcIds.push(record.id);

    const progress = await db.dailyProgress.create({
      data: {
        ticketId: ticket.id,
        projectId: project.id,
        logDate: new Date("2026-08-10"),
        percentComplete: 50,
        manpowerOnSite: 2,
        hoursWorked: "8.00",
        standbyHours: "1.00",
        standbyCause: "client_not_ready",
        loggedById: user.id,
      },
    });
    progressIds.push(progress.id);

    const [certificate, report, pack] = await Promise.all([
      renderTcCertificatePdf(record.id),
      renderDailyProgressPdf(ticket.id),
      renderCloseOutPackPdf(project.id),
    ]);

    expect(isPdf(certificate)).toBe(true);
    expect(isPdf(report)).toBe(true);
    expect(isPdf(pack)).toBe(true);
    // A document of a few hundred bytes is an empty page that rendered without throwing.
    expect(certificate.length).toBeGreaterThan(5000);
    expect(report.length).toBeGreaterThan(5000);
    expect(pack.length).toBeGreaterThan(5000);
  }, 60_000);
});

/**
 * §6.2's method statement, added 2026-08-19 at the company's request: "make the completed method
 * downloadable so that there is an option for review and sending the pdf to the client."
 *
 * The property that matters most is the DRAFT mark. §6.2 gates mobilisation on client approval, and
 * a document that prints as though it were agreed when it is not is how a crew ends up working to a
 * method nobody signed.
 */
describe("§6.2's method statement", () => {
  it("carries the whole method, and marks an unapproved one as draft", async () => {
    const user = await makeUser();
    const { ticket } = await makeFixture(user);

    const method = await createMethodologyService(actorFor(user), {
      ticketId: ticket.id,
      title: "Replace flowmeter FT-1180",
    });
    methodologyIds.push(method.id);

    await saveMethodologyService(actorFor(user), {
      methodologyId: method.id,
      scopeSummary: "Isolate, remove, install and calibrate the replacement meter.",
      sequenceOfWork: [
        { step: 1, description: "Isolate and lock out", durationHours: 1, crew: "2 technicians" },
        {
          step: 2,
          description: "Remove the existing meter",
          durationHours: 2,
          crew: "2 technicians",
        },
      ],
      manpowerPlan: [{ role: "Instrument technician", count: 2, notes: "One must be certified" }],
      toolsRequired: ["Torque wrench", "HART communicator"],
      materialsRequired: [{ description: "Gasket set", quantity: "2", unit: "set" }],
      permitsRequired: ["Hot work", "Confined space"],
      safetyPlan: "Full PPE. Line isolated and drained before breaking any flange.",
      durationDays: 2,
    });

    const props = await buildMethodStatementProps(method.id);

    expect(props.number).toBe(method.number);
    expect(props.steps).toHaveLength(2);
    expect(props.steps[0]!.description).toBe("Isolate and lock out");
    expect(props.manpower[0]!.role).toBe("Instrument technician");
    expect(props.tools).toContain("HART communicator");
    expect(props.permits).toContain("Confined space");
    expect(props.durationDays).toBe(2);

    // The whole point: a draft says so.
    expect(props.isFinal).toBe(false);
    expect(props.statusLabel).toBe("Draft");

    const pdf = await renderMethodStatementPdf(method.id);
    expect(pdf.length).toBeGreaterThan(1000);
    expect(pdf.subarray(0, 4).toString()).toBe("%PDF");
  });

  /**
   * An empty section prints as "none recorded" rather than disappearing. A method statement with no
   * permits and no safety plan is a fact the client's engineer should see — and it is the first
   * thing they will ask about.
   */
  it("reports what is missing rather than closing the gap over", async () => {
    const user = await makeUser();
    const { ticket } = await makeFixture(user);

    const method = await createMethodologyService(actorFor(user), {
      ticketId: ticket.id,
      title: "Bare method",
    });
    methodologyIds.push(method.id);

    const props = await buildMethodStatementProps(method.id);
    expect(props.steps).toEqual([]);
    expect(props.tools).toEqual([]);
    expect(props.permits).toEqual([]);
    expect(props.safetyPlan).toBeNull();
    expect(props.hasJsa).toBe(false);

    // It still renders — a half-written method statement is exactly what internal review is for.
    const pdf = await renderMethodStatementPdf(method.id);
    expect(pdf.subarray(0, 4).toString()).toBe("%PDF");
  });
});

// A minimal, real, decodable PNG — sharp needs bytes it can actually resize, not a stub.
const REAL_PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=",
  "base64",
);

/**
 * §15's filled-in checklist, added at the company's request: "all the checklists filled in on site
 * should have a PDF output, so it can be printed and signed." One document template covers all
 * eleven seeded checklist keys — they share one schema (sections of items, one answer each) — so
 * this exercises it against the seeded `site_inspection` key (a realistic mix of pass/fail,
 * pass/fail/na and photo items) and the seeded `toolbox_talk_jsa` key (simple enough to sign off
 * cleanly in one test).
 */
describe("§15's filled-in checklist", () => {
  it("shows a failure's cause and action, marks N/A, and embeds a photo answer", async () => {
    const user = await makeUser();
    const { ticket } = await makeFixture(user);

    const response = await startResponseService(actorFor(user), {
      templateKey: "site_inspection",
      ticketId: ticket.id,
    });
    checklistResponseIds.push(response.id);

    const file = await uploadFile({
      entityType: CHECKLIST_RESPONSE_ENTITY_TYPE,
      entityId: response.id,
      uploaderId: user.id,
      filename: "site-access.png",
      mimeType: "image/png",
      buffer: REAL_PNG,
    });
    fileIds.push(file.id);
    storageKeys.push(file.storageKey);
    if (file.webDerivativeKey) storageKeys.push(file.webDerivativeKey);

    await saveAnswersService(actorFor(user), {
      responseId: response.id,
      answers: {
        site_reachable: { value: "fail", cause: "Gate padlocked", action: "Called the caretaker" },
        working_at_height: { na: true },
        power_available: { value: "pass" },
        site_photos: { photoFileIds: [file.id] },
      },
    });

    const props = await buildChecklistResponseProps(response.id);

    const access = props.sections.find((s) => s.key === "access")!;
    const reachable = access.items.find((i) => i.key === "site_reachable")!;
    expect(reachable.answerText).toBe("Fail");
    expect(reachable.failed).toBe(true);
    expect(reachable.cause).toBe("Gate padlocked");
    expect(reachable.action).toBe("Called the caretaker");

    const height = access.items.find((i) => i.key === "working_at_height")!;
    expect(height.answerText).toBe("Not applicable");
    expect(height.failed).toBe(false);

    const photoItem = access.items.find((i) => i.key === "site_photos")!;
    expect(photoItem.answerText).toBe("1 photo attached");
    expect(photoItem.photos).toHaveLength(1);
    // sharp resizes every image/* upload to a JPEG derivative — this is that photo, round-tripped.
    expect(photoItem.photos[0]!.src.startsWith("data:image/jpeg;base64,")).toBe(true);

    expect(props.isFinal).toBe(false);
    expect(props.statusLabel).toBe("In progress");
    expect(props.failuresCount).toBe(1);
    expect(props.linkedToLabel).toBe("Ticket");
    expect(props.linkedToValue).toBe(ticket.number);
    expect(props.templateName).toBe("Site inspection");

    const pdf = await renderChecklistResponsePdf(response.id);
    expect(pdf.subarray(0, 4).toString()).toBe("%PDF");
    // A page with a real embedded photo is not a few hundred bytes.
    expect(pdf.length).toBeGreaterThan(3000);
  }, 60_000);

  it("prints who signed off a completed checklist", async () => {
    const user = await makeUser();
    const { ticket } = await makeFixture(user);

    const response = await startResponseService(actorFor(user), {
      templateKey: "toolbox_talk_jsa",
      ticketId: ticket.id,
    });
    checklistResponseIds.push(response.id);

    await saveAnswersService(actorFor(user), {
      responseId: response.id,
      answers: {
        hazards_identified: { value: "Working at height, pinch points on the winch." },
        controls_agreed: { value: "pass" },
        emergency_route: { value: "pass" },
        attendees: { value: "J. Cruz, R. Santos" },
        crew_signature: { value: "J. Cruz" },
      },
    });
    await completeResponseService(actorFor(user), {
      responseId: response.id,
      signedByName: "J. Cruz",
      signedByPosition: "Crew lead",
    });

    const props = await buildChecklistResponseProps(response.id);
    expect(props.isFinal).toBe(true);
    expect(props.statusLabel).toBe("Signed off");
    expect(props.summaryLine).toBe("All 5 passed");
    expect(props.failuresCount).toBe(0);
    expect(props.signedByName).toBe("J. Cruz");
    expect(props.signedByPosition).toBe("Crew lead");
    expect(props.completedAt).not.toBeNull();

    const pdf = await renderChecklistResponsePdf(response.id);
    expect(pdf.subarray(0, 4).toString()).toBe("%PDF");
  }, 60_000);
});

/**
 * §12's service report, added alongside the checklist PDF at the same request: "app created service
 * reports should also have a PDF output, so it can also be printed."
 */
describe("§12's service report", () => {
  it("carries the whole report and embeds the customer's signature and photos", async () => {
    const user = await makeUser();
    const { project, ticket } = await makeFixture(user);

    const report = await saveServiceReportService(actorFor(user), {
      ticketId: ticket.id,
      workPerformed: "Replaced the flow transmitter and recalibrated the loop.",
      findings: "Original unit had a corroded terminal block.",
      recommendations: "Re-inspect in six months given the site's humidity.",
      partsUsed: [
        { description: "Flow transmitter FT-100", quantity: 1, unit: "pc", fromStock: true },
      ],
      startedAt: new Date("2026-09-10T08:00:00.000Z"),
      finishedAt: new Date("2026-09-10T11:30:00.000Z"),
      travelTimeMin: 45,
      standbyTimeMin: 0,
      followUpRequired: true,
      followUpNotes: "Order a spare terminal block for next time.",
    });
    serviceReportIds.push(report.id);

    const signatureFile = await uploadFile({
      entityType: SERVICE_REPORT_ENTITY_TYPE,
      entityId: report.id,
      uploaderId: user.id,
      filename: "customer-signature.png",
      mimeType: "image/png",
      buffer: REAL_PNG,
    });
    fileIds.push(signatureFile.id);
    storageKeys.push(signatureFile.storageKey);
    if (signatureFile.webDerivativeKey) storageKeys.push(signatureFile.webDerivativeKey);

    await advanceServiceReportService(actorFor(user), {
      id: report.id,
      target: "signed",
      customerSignatureFileId: signatureFile.id,
      customerName: "Plant Engineer",
      customerPosition: "Maintenance Manager",
    });

    const photoFile = await uploadFile({
      entityType: SERVICE_REPORT_ENTITY_TYPE,
      entityId: report.id,
      uploaderId: user.id,
      filename: "corroded-terminal.png",
      mimeType: "image/png",
      buffer: REAL_PNG,
    });
    fileIds.push(photoFile.id);
    storageKeys.push(photoFile.storageKey);
    if (photoFile.webDerivativeKey) storageKeys.push(photoFile.webDerivativeKey);
    await db.serviceReport.update({
      where: { id: report.id },
      data: { photoFileIds: [photoFile.id] },
    });

    const props = await buildServiceReportProps(report.id);

    expect(props.number).toBe(report.number);
    expect(props.workPerformed).toContain("Replaced the flow transmitter");
    expect(props.parts).toHaveLength(1);
    expect(props.parts[0]!.description).toBe("Flow transmitter FT-100");
    expect(props.customerName).toBeTruthy();
    expect(props.projectCode).toBe(project.code);
    expect(props.ticketNumber).toBe(ticket.number);
    expect(props.followUpRequired).toBe(true);
    expect(props.followUpNotes).toContain("terminal block");

    expect(props.isDraft).toBe(false);
    expect(props.statusLabel).toBe("Signed by the customer");
    expect(props.signerName).toBe("Plant Engineer");
    expect(props.signerPosition).toBe("Maintenance Manager");
    expect(props.customerSignatureSrc?.startsWith("data:image/jpeg;base64,")).toBe(true);

    expect(props.photos).toHaveLength(1);
    expect(props.photos[0]!.src.startsWith("data:image/jpeg;base64,")).toBe(true);

    const pdf = await renderServiceReportPdf(report.id);
    expect(pdf.subarray(0, 4).toString()).toBe("%PDF");
    expect(pdf.length).toBeGreaterThan(3000);
  }, 60_000);

  it("marks a draft, and refuses an externally-authored report", async () => {
    const user = await makeUser();
    const { ticket } = await makeFixture(user);

    const draft = await saveServiceReportService(actorFor(user), {
      ticketId: ticket.id,
      workPerformed: "Preliminary visit — full write-up to follow.",
    });
    serviceReportIds.push(draft.id);

    const draftProps = await buildServiceReportProps(draft.id);
    expect(draftProps.isDraft).toBe(true);
    expect(draftProps.statusLabel).toBe("Draft");
    const pdf = await renderServiceReportPdf(draft.id);
    expect(pdf.subarray(0, 4).toString()).toBe("%PDF");

    const external = await db.serviceReport.create({
      data: {
        number: `AIESSR-PDF${randomUUID().slice(0, 5)}`,
        ticketId: ticket.id,
        workPerformed: "Written on the customer's own job sheet.",
        externalDocument: true,
        preparedById: user.id,
      },
    });
    serviceReportIds.push(external.id);

    // Its uploaded form is the document of record — generating a second, AIES-authored PDF for it
    // would be a copy of a copy, not the report.
    await expect(buildServiceReportProps(external.id)).rejects.toThrow(/document of record/);
  }, 60_000);
});
