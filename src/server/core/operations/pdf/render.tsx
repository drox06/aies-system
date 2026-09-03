import { renderToBuffer } from "@react-pdf/renderer";
import { TRPCError } from "@trpc/server";
import { db } from "@/lib/db";
import { getCompanyDetails } from "@/server/core/company";
import { fmtDate, logoDataUri } from "@/server/core/quotation/pdf/render";
import { getFileDownloadUrl } from "@/server/core/storage/storage";
import {
  CAUSE_ATTRIBUTION,
  STANDBY_CAUSE_LABELS,
  type StandbyCause,
} from "../daily-progress-rules";
import {
  SITE_INSPECTION_ENTITY_TYPE,
  describeAttendees,
  readAttendees,
  readUtilities,
  type MeasurementRow,
} from "../site-inspection-rules";
import {
  TC_RESULT_LABELS,
  describeCriterion,
  evaluateMeasurement,
  type Criterion,
  type FunctionalTest,
  type PunchItem,
  type TcResult,
} from "../tc-rules";
import { closeOutChecklistForProjectService } from "../close-out-service";
import {
  CloseOutPackDocument,
  type CloseOutPackPdfProps,
  type PackIndexEntry,
} from "./CloseOutPackDocument";
import {
  DailyProgressDocument,
  type DailyProgressPdfProps,
  type DailyProgressRow,
} from "./DailyProgressDocument";
import {
  TcCertificateDocument,
  type TcCertificatePdfProps,
  type TcCertificateTest,
} from "./TcCertificateDocument";
import { MethodStatementDocument, type MethodStatementPdfProps } from "./MethodStatementDocument";
import {
  SiteInspectionReportDocument,
  type SiteInspectionPhoto,
  type SiteInspectionReportPdfProps,
} from "./SiteInspectionReportDocument";

/**
 * Module 04's documents (specs/04-operations-projects.md §8, §10 and §12).
 *
 * Split from the renderers for the same reason modules 02 and 03 are: `@react-pdf` compresses its
 * content streams and subsets its fonts, so the finished bytes cannot be searched for text. Grepping
 * the output to prove something is on the page would pass whether it was or not. **The props are the
 * document's complete input, so asserting on them is the real test.**
 *
 * `logoDataUri` and `fmtDate` come from module 02's renderer rather than being copied — the logo is
 * ~200kB and cached per process, and a second date formatter is how two documents in the same
 * envelope end up with two date formats.
 */

const readTests = (raw: unknown): FunctionalTest[] =>
  Array.isArray(raw)
    ? raw.filter(
        (entry): entry is FunctionalTest =>
          !!entry &&
          typeof entry === "object" &&
          typeof (entry as FunctionalTest).test === "string",
      )
    : [];

const readPunch = (raw: unknown): PunchItem[] =>
  Array.isArray(raw)
    ? raw.filter(
        (entry): entry is PunchItem =>
          !!entry &&
          typeof entry === "object" &&
          typeof (entry as PunchItem).description === "string",
      )
    : [];

// ---- §10's certificate ----------------------------------------------------------------------------

export async function buildTcCertificateProps(id: string): Promise<TcCertificatePdfProps> {
  const record = await db.testingCommissioning.findFirst({
    where: { id, deletedAt: null },
    include: {
      ticket: {
        select: {
          number: true,
          account: { select: { name: true } },
          site: { select: { name: true } },
        },
      },
      project: { select: { code: true } },
    },
  });
  if (!record) {
    throw new TRPCError({
      code: "NOT_FOUND",
      message: "That commissioning record no longer exists.",
    });
  }

  const signer = record.signedOffById
    ? await db.user.findUnique({ where: { id: record.signedOffById }, select: { name: true } })
    : null;

  const all = [...readTests(record.functionalTests), ...readTests(record.performanceVerification)];

  const tests: TcCertificateTest[] = all.map((test) => {
    const evaluation = evaluateMeasurement(test.criterion as Criterion | null, test.measured);
    return {
      test: test.test,
      criterion: test.criterion ? describeCriterion(test.criterion as Criterion) : "not stated",
      measured: test.measured === null || test.measured === undefined ? "—" : String(test.measured),
      unit: test.unit ?? null,
      verdict: evaluation.verdict,
      // §10's provenance, on the face of the document — DECISIONS #69.
      source: test.criterionSource === "quotation" ? "Accepted quotation" : "Stated on site",
      promiseText: test.criterionSource === "quotation" ? (test.promiseText ?? null) : null,
    };
  });

  return {
    number: record.number,
    company: getCompanyDetails(),
    customer: {
      name: record.ticket.account.name,
      site: record.ticket.site?.name ?? null,
    },
    ticketNumber: record.ticket.number,
    projectCode: record.project?.code ?? null,
    startedAt: fmtDate(record.startedAt),
    completedAt: record.completedAt ? fmtDate(record.completedAt) : null,
    result: record.result,
    resultLabel: record.result
      ? (TC_RESULT_LABELS[record.result as TcResult] ?? record.result)
      : null,
    witnessedByCustomer: record.witnessedByCustomer,
    customerWitnessName: record.customerWitnessName,
    customerWitnessPosition: record.customerWitnessPosition,
    signedBy: signer?.name ?? null,
    signedAt: record.signedAt ? fmtDate(record.signedAt) : null,
    hasCustomerSignature: !!record.customerSignatureFileId,
    signOffRemarks: record.signOffRemarks,
    instruments: record.calibrationAssetsUsed,
    tests,
    punchItems: readPunch(record.punchItems).map((item) => ({
      description: item.description,
      severity: item.severity,
      owner: item.ownerId ?? null,
      dueAt: item.dueAt ? fmtDate(new Date(item.dueAt)) : null,
      status: item.status ?? "open",
    })),
    statedCriteriaCount: all.filter((test) => (test.criterionSource ?? "stated") === "stated")
      .length,
    logoSrc: await logoDataUri(),
  };
}

export async function renderTcCertificatePdf(id: string): Promise<Buffer> {
  return renderToBuffer(<TcCertificateDocument {...await buildTcCertificateProps(id)} />);
}

// ---- §8's daily progress report -------------------------------------------------------------------

export async function buildDailyProgressProps(ticketId: string): Promise<DailyProgressPdfProps> {
  const ticket = await db.ticket.findFirst({
    where: { id: ticketId, deletedAt: null },
    select: {
      number: true,
      title: true,
      account: { select: { name: true } },
      site: { select: { name: true } },
      project: { select: { code: true } },
    },
  });
  if (!ticket) {
    throw new TRPCError({ code: "NOT_FOUND", message: "That ticket no longer exists." });
  }

  const entries = await db.dailyProgress.findMany({
    where: { ticketId, deletedAt: null },
    orderBy: { logDate: "asc" },
  });

  let hoursWorked = 0;
  let standby = 0;
  const byAttribution = { customer: 0, aies: 0, neither: 0 };

  const rows: DailyProgressRow[] = entries.map((entry) => {
    const hours = Number(entry.hoursWorked);
    const standbyHours = Number(entry.standbyHours);
    hoursWorked += hours;
    standby += standbyHours;

    const cause = entry.standbyCause as StandbyCause | null;
    const attribution = cause ? CAUSE_ATTRIBUTION[cause] : null;
    if (attribution) byAttribution[attribution] += standbyHours;

    return {
      logDate: fmtDate(entry.logDate),
      percentComplete: entry.percentComplete,
      manpowerOnSite: entry.manpowerOnSite,
      hoursWorked: hours.toFixed(2),
      standbyHours: standbyHours.toFixed(2),
      standbyCauseLabel: cause ? (STANDBY_CAUSE_LABELS[cause] ?? cause) : null,
      standbyAttribution: attribution,
      weather: entry.weather,
      notes: entry.notes,
      issuesRaised: entry.issuesRaised,
    };
  });

  const first = entries[0];
  const last = entries[entries.length - 1];

  return {
    company: getCompanyDetails(),
    customer: { name: ticket.account.name, site: ticket.site?.name ?? null },
    ticketNumber: ticket.number,
    ticketTitle: ticket.title,
    projectCode: ticket.project?.code ?? null,
    periodFrom: first ? fmtDate(first.logDate) : "—",
    periodTo: last ? fmtDate(last.logDate) : "—",
    rows,
    latestPercent: last?.percentComplete ?? 0,
    totals: {
      days: entries.length,
      hoursWorked: hoursWorked.toFixed(2),
      standbyHours: standby.toFixed(2),
      customerStandbyHours: byAttribution.customer.toFixed(2),
      aiesStandbyHours: byAttribution.aies.toFixed(2),
      neitherStandbyHours: byAttribution.neither.toFixed(2),
    },
    logoSrc: await logoDataUri(),
  };
}

export async function renderDailyProgressPdf(ticketId: string): Promise<Buffer> {
  return renderToBuffer(<DailyProgressDocument {...await buildDailyProgressProps(ticketId)} />);
}

// ---- §12's close-out pack -------------------------------------------------------------------------

/**
 * §12's sixteen items, each answered from the records that would hold it.
 *
 * Where a section has not been built yet — as-built documentation, spare parts, training — the entry
 * says so rather than being left out. An index that omits what it cannot answer reads as a complete
 * pack with fewer requirements, which is the opposite of what a controlled document is for.
 */
export async function buildCloseOutPackProps(projectId: string): Promise<CloseOutPackPdfProps> {
  const state = await closeOutChecklistForProjectService(projectId);

  const project = await db.project.findFirst({
    where: { id: projectId, deletedAt: null },
    select: {
      code: true,
      name: true,
      scopeOfWork: true,
      status: true,
      plannedStart: true,
      plannedEnd: true,
      actualEnd: true,
      account: { select: { name: true } },
      tickets: {
        where: { deletedAt: null },
        select: { number: true, title: true, type: true, status: true },
        orderBy: { createdAt: "asc" },
      },
    },
  });
  if (!project) {
    throw new TRPCError({ code: "NOT_FOUND", message: "That project no longer exists." });
  }

  const ticketIds = await db.ticket.findMany({
    where: { projectId, deletedAt: null },
    select: { id: true },
  });
  const ids = ticketIds.map((t) => t.id);

  const [methodologies, inspections, materialRequests, qaRecords, commissionings, serviceReports] =
    await Promise.all([
      db.methodology.count({ where: { projectId, deletedAt: null, status: "client_approved" } }),
      ids.length ? db.siteInspection.count({ where: { ticketId: { in: ids } } }) : 0,
      ids.length
        ? db.materialRequest.count({ where: { ticketId: { in: ids }, deletedAt: null } })
        : 0,
      ids.length ? db.qAApproval.count({ where: { ticketId: { in: ids }, deletedAt: null } }) : 0,
      db.testingCommissioning.findMany({
        where: { projectId, deletedAt: null },
        select: { number: true, completedAt: true, calibrationAssetsUsed: true },
      }),
      db.serviceReport.findMany({
        where: { projectId, deletedAt: null },
        select: { number: true, status: true },
      }),
    ]);

  const approvedReports = serviceReports.filter((row) => row.status === "approved");
  const completedTc = commissionings.filter((row) => row.completedAt);
  const instruments = [...new Set(commissionings.flatMap((row) => row.calibrationAssetsUsed))];
  const closeOut = state.closeOut;

  const notBuilt = (section: string) => `Not built yet — ${section}.`;

  const index: PackIndexEntry[] = [
    { item: "Cover sheet", present: true, reference: "This document." },
    { item: "Scope summary", present: true, reference: "This document, page 1." },
    {
      item: "Approved methodology",
      present: methodologies > 0,
      reference: methodologies > 0 ? `${methodologies} client-approved` : "None client-approved.",
    },
    {
      item: "Site inspection report",
      present: inspections > 0,
      reference: inspections > 0 ? `${inspections} on file` : "No inspection recorded.",
    },
    {
      item: "Delivery receipts",
      present: false,
      reference: notBuilt("module 03 §7's delivery lane, blocked on §13"),
    },
    {
      item: "Material list",
      present: materialRequests > 0,
      reference: materialRequests > 0 ? `${materialRequests} material request(s)` : "None raised.",
    },
    {
      item: "QA records",
      present: qaRecords > 0,
      reference: qaRecords > 0 ? `${qaRecords} client QA record(s)` : "No QA recorded.",
    },
    {
      item: "T&C certificate and test results",
      present: completedTc.length > 0,
      reference:
        completedTc.length > 0
          ? completedTc.map((row) => row.number).join(", ")
          : "No completed commissioning.",
    },
    {
      item: "Service reports",
      present: approvedReports.length > 0,
      reference:
        approvedReports.length > 0
          ? `${approvedReports.length} approved of ${serviceReports.length}`
          : "None approved.",
    },
    {
      item: "Calibration and test certificates",
      present: instruments.length > 0,
      reference:
        instruments.length > 0
          ? `Instruments used: ${instruments.join(", ")}`
          : "No instruments recorded.",
    },
    { item: "As-built documentation", present: false, reference: notBuilt("§16's installed base") },
    { item: "Spare parts list", present: false, reference: notBuilt("§16's installed base") },
    {
      item: "Warranty statement",
      present: false,
      reference: notBuilt("§16's equipment warranty terms per item"),
    },
    { item: "Training record", present: false, reference: notBuilt("§10's training capture") },
    {
      item: "Punch list closure",
      present: state.checklist.find((e) => e.key === "critical_punch_items")?.blocking === false,
      reference:
        state.checklist.find((e) => e.key === "critical_punch_items")?.detail ?? "Not assessed.",
    },
    {
      item: "Customer acceptance certificate",
      present: !!closeOut?.customerAcceptanceFileId,
      reference: closeOut?.customerAcceptanceFileId
        ? "On file."
        : closeOut?.acceptanceWaiverReason
          ? `Waived: ${closeOut.acceptanceWaiverReason}`
          : "Not on file.",
    },
  ];

  const approver = closeOut?.approvedById
    ? await db.user.findUnique({ where: { id: closeOut.approvedById }, select: { name: true } })
    : null;

  const shape = (entry: (typeof state.checklist)[number]) => ({
    label: entry.label,
    blocking: entry.blocking,
    detail: entry.detail,
    owner: entry.owner,
  });

  return {
    company: getCompanyDetails(),
    customer: { name: project.account.name },
    projectCode: project.code,
    projectName: project.name,
    scopeOfWork: project.scopeOfWork,
    status: project.status,
    plannedStart: project.plannedStart ? fmtDate(project.plannedStart) : null,
    plannedEnd: project.plannedEnd ? fmtDate(project.plannedEnd) : null,
    actualEnd: project.actualEnd ? fmtDate(project.actualEnd) : null,
    closedAt: closeOut?.approvedAt ? fmtDate(closeOut.approvedAt) : null,
    approvedBy: approver?.name ?? null,
    generatedAt: fmtDate(new Date()),
    canClose: state.canClose,
    blockers: state.blockers.map(shape),
    checklist: state.checklist.map(shape),
    index,
    tickets: project.tickets,
    lessonsLearned: closeOut?.lessonsLearned ?? null,
    logoSrc: await logoDataUri(),
  };
}

export async function renderCloseOutPackPdf(projectId: string): Promise<Buffer> {
  return renderToBuffer(<CloseOutPackDocument {...await buildCloseOutPackProps(projectId)} />);
}

// ---- §6.2's method statement ----------------------------------------------------------------------

const METHOD_STATUS_LABELS: Record<string, string> = {
  draft: "Draft",
  internal_review: "In internal review",
  approved: "Approved internally",
  submitted_to_client: "With the client",
  client_approved: "Approved by the client",
  client_rejected: "Sent back by the client",
  superseded: "Superseded",
};

/** Only these two are a document somebody may work to. Everything else prints a DRAFT mark. */
const FINAL_METHOD_STATUSES = new Set(["approved", "client_approved"]);

function asArray(value: unknown): Record<string, unknown>[] {
  return Array.isArray(value) ? (value as Record<string, unknown>[]) : [];
}

function str(value: unknown): string | null {
  if (value === null || value === undefined || value === "") return null;
  return String(value);
}

export async function buildMethodStatementProps(
  methodologyId: string,
): Promise<MethodStatementPdfProps> {
  const record = await db.methodology.findFirst({
    where: { id: methodologyId, deletedAt: null },
    include: {
      ticket: {
        select: {
          number: true,
          account: { select: { name: true } },
          site: { select: { name: true } },
        },
      },
      project: { select: { code: true } },
    },
  });
  if (!record) {
    throw new TRPCError({ code: "NOT_FOUND", message: "That method statement no longer exists." });
  }

  const [preparedBy, approvedBy] = await Promise.all([
    record.preparedById
      ? db.user.findUnique({ where: { id: record.preparedById }, select: { name: true } })
      : null,
    record.approvedById
      ? db.user.findUnique({ where: { id: record.approvedById }, select: { name: true } })
      : null,
  ]);

  return {
    company: getCompanyDetails(),
    logoSrc: await logoDataUri(),

    number: record.number,
    revision: record.revision,
    title: record.title,
    status: record.status,
    statusLabel: METHOD_STATUS_LABELS[record.status] ?? record.status,
    isFinal: FINAL_METHOD_STATUSES.has(record.status),

    customerName: record.ticket?.account?.name ?? null,
    siteName: record.ticket?.site?.name ?? null,
    ticketNumber: record.ticket?.number ?? null,
    projectCode: record.project?.code ?? null,

    scopeSummary: record.scopeSummary,
    durationDays: record.durationDays,
    steps: asArray(record.sequenceOfWork).map((step, index) => ({
      step: str(step.step) ?? index + 1,
      description: str(step.description) ?? "",
      durationHours: str(step.durationHours),
      crew: str(step.crew),
    })),
    manpower: asArray(record.manpowerPlan).map((row) => ({
      role: str(row.role) ?? "",
      count: str(row.count) ?? "1",
      notes: str(row.notes),
    })),
    tools: record.toolsRequired,
    materials: asArray(record.materialsRequired).map((row) => ({
      description: str(row.description) ?? "",
      quantity: str(row.quantity) ?? "",
      unit: str(row.unit),
    })),
    permits: record.permitsRequired,
    safetyPlan: record.safetyPlan,
    hasJsa: Boolean(record.jsaFileId),
    environmental: record.environmentalConsiderations,
    mobilizationPlan: record.mobilizationPlan,
    demobilizationPlan: record.demobilizationPlan,
    contingencyPlan: record.contingencyPlan,

    preparedBy: preparedBy?.name ?? null,
    approvedBy: approvedBy?.name ?? null,
    clientDecisionAt: record.clientApprovedAt ? fmtDate(record.clientApprovedAt) : null,
    printedAt: fmtDate(new Date()),
  };
}

export async function renderMethodStatementPdf(methodologyId: string): Promise<Buffer> {
  return renderToBuffer(
    <MethodStatementDocument {...await buildMethodStatementProps(methodologyId)} />,
  );
}

// ---- §6.1's site inspection report ------------------------------------------------------------

const readMeasurements = (raw: unknown): MeasurementRow[] =>
  Array.isArray(raw)
    ? raw.filter(
        (entry): entry is MeasurementRow =>
          !!entry &&
          typeof entry === "object" &&
          typeof (entry as MeasurementRow).label === "string",
      )
    : [];

/** `@react-pdf`'s `<Image>` decodes JPEG and PNG; nothing else reliably. */
const EMBEDDABLE_MIME_TYPES = new Set(["image/jpeg", "image/png"]);

/**
 * Fetches one uploaded file's bytes and returns it as a data URI `<Image>` can embed directly —
 * the same shape `logoDataUri()` above hands the document, just built from a signed URL instead of
 * a file on disk, because a `FileObject`'s bytes live in Supabase Storage and nothing in this
 * codebase has previously needed to pull them back into a Node buffer (`getFileDownloadUrl` has only
 * ever produced a signed URL for the *browser* to fetch, via the redirect in
 * `/api/files/[id]/route.ts`).
 *
 * The web derivative is preferred when one exists — always a JPEG, resized for exactly this kind of
 * use, at `storage.ts`'s `uploadFile()` — so most photos are both smaller to fetch and guaranteed
 * embeddable. Falls back to the original for a file whose derivative failed to generate (some camera
 * formats `sharp` cannot decode), and returns `null` — never throws — for anything `@react-pdf`
 * itself could not render either, so one bad photo does not fail the whole report.
 */
async function imageDataUri(file: {
  storageKey: string;
  webDerivativeKey: string | null;
  filename: string;
  mimeType: string;
}): Promise<string | null> {
  const usingDerivative = !!file.webDerivativeKey;
  const mimeType = usingDerivative ? "image/jpeg" : file.mimeType;
  if (!EMBEDDABLE_MIME_TYPES.has(mimeType)) return null;

  try {
    const url = await getFileDownloadUrl(file, "web", 60);
    const response = await fetch(url);
    if (!response.ok) return null;
    const bytes = Buffer.from(await response.arrayBuffer());
    return `data:${mimeType};base64,${bytes.toString("base64")}`;
  } catch {
    return null;
  }
}

export async function buildSiteInspectionReportProps(
  inspectionId: string,
): Promise<SiteInspectionReportPdfProps> {
  const inspection = await db.siteInspection.findFirst({
    where: { id: inspectionId, deletedAt: null },
    include: {
      ticket: { select: { number: true, account: { select: { name: true } } } },
      project: { select: { code: true, account: { select: { name: true } } } },
    },
  });
  if (!inspection) {
    throw new TRPCError({ code: "NOT_FOUND", message: "That inspection no longer exists." });
  }

  const [site, inquiry, requester, approver, attachedFiles] = await Promise.all([
    inspection.siteId
      ? db.site.findUnique({
          where: { id: inspection.siteId },
          select: { name: true, address: true },
        })
      : null,
    // Not a Prisma relation on SiteInspection — see the model's own comment on why `siteId` isn't
    // one either — so a pre-quotation survey's inquiry is looked up by hand.
    inspection.inquiryId
      ? db.inquiry.findUnique({
          where: { id: inspection.inquiryId },
          select: { number: true, account: { select: { name: true } } },
        })
      : null,
    inspection.requestedById
      ? db.user.findUnique({ where: { id: inspection.requestedById }, select: { name: true } })
      : null,
    inspection.approvedById
      ? db.user.findUnique({ where: { id: inspection.approvedById }, select: { name: true } })
      : null,
    // Counted from the stored files, never a stale id list — see `inspectionCompleteness`'s own
    // comment on `photoCount` for why: `photoFileIds`/`sketchFileIds` looked like the source of truth
    // but nothing in the app ever wrote to them, so a genuinely photographed visit still generated a
    // report reading "None attached to this visit" (2026-09-04). Attachment order is preserved
    // because that is the order the surveyor actually added them in.
    db.fileObject.findMany({
      where: { entityType: SITE_INSPECTION_ENTITY_TYPE, entityId: inspectionId, deletedAt: null },
      select: {
        id: true,
        storageKey: true,
        webDerivativeKey: true,
        filename: true,
        mimeType: true,
      },
      orderBy: { createdAt: "asc" },
    }),
  ]);

  const embedded = await Promise.all(
    attachedFiles.map(async (file, index) => {
      const src = await imageDataUri(file);
      return src ? { src, caption: `Photo ${index + 1}` } : null;
    }),
  );
  const photos = embedded.filter((entry): entry is SiteInspectionPhoto => entry !== null);
  const omittedImageCount = attachedFiles.length - photos.length;

  const address = (site?.address as { line1?: string } | null)?.line1 ?? null;

  const linked = inspection.ticket
    ? { label: "Ticket", value: inspection.ticket.number, customer: inspection.ticket.account.name }
    : inspection.project
      ? {
          label: "Project",
          value: inspection.project.code,
          customer: inspection.project.account.name,
        }
      : inquiry
        ? { label: "Inquiry", value: inquiry.number, customer: inquiry.account?.name ?? null }
        : { label: null, value: null, customer: null };

  return {
    company: getCompanyDetails(),
    logoSrc: logoDataUri(),

    number: inspection.number,
    statusLabel: inspection.status.charAt(0).toUpperCase() + inspection.status.slice(1),

    linkedToLabel: linked.label,
    linkedToValue: linked.value,

    customerName: linked.customer,
    siteName: site?.name ?? null,
    siteAddress: address,

    scheduledFor: inspection.scheduledFor ? fmtDate(inspection.scheduledFor) : null,
    inspectedAt: inspection.inspectedAt ? fmtDate(inspection.inspectedAt) : null,
    attendees: describeAttendees(readAttendees(inspection.attendees)),

    findings: inspection.findings,

    tagNumbers: inspection.tagNumbers,
    hazards: inspection.hazards,
    permitsRequired: inspection.permitsRequired,
    accessConstraints: inspection.accessConstraints,

    utilities: readUtilities(inspection.utilitiesAvailable),
    measurements: readMeasurements(inspection.measurements),

    scopeChangeIdentified: inspection.scopeChangeIdentified,
    scopeChangeNotes: inspection.scopeChangeNotes,

    photos,
    omittedImageCount,

    requestedBy: requester?.name ?? null,
    approvedBy: approver?.name ?? null,
    approvedAt: inspection.approvedAt ? fmtDate(inspection.approvedAt) : null,
    generatedAt: fmtDate(new Date()),
  };
}

export async function renderSiteInspectionReportPdf(inspectionId: string): Promise<Buffer> {
  return renderToBuffer(
    <SiteInspectionReportDocument {...await buildSiteInspectionReportProps(inspectionId)} />,
  );
}
