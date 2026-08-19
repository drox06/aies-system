import { TRPCError } from "@trpc/server";
import { Prisma } from "@prisma/client";
import { db } from "@/lib/db";
import { writeAuditLog } from "@/server/core/audit/audit";
import type { ActorMeta } from "@/server/core/crm/account-service";
import { emit } from "@/server/core/events/emit";
import { allocateNumber } from "@/server/core/numbering/numbering";
import { registerFileAccessChecker } from "@/server/core/storage/access";
import {
  TC_DOCUMENT_TYPE,
  TC_ENTITY_TYPE,
  checkTcRecord,
  closeoutBlockers,
  evaluateTests,
  isOpen,
  tcOutcome,
  type Criterion,
  type FunctionalTest,
  type PunchItem,
  type TcResult,
} from "./tc-rules";

/**
 * Testing and commissioning (specs/04-operations-projects.md §10).
 *
 * ## Why the timestamps are stamped here
 *
 * §10 wants results judged against something the technician did not supply. The record keeps, per
 * test, when its criterion was fixed and when its reading was taken — and **the server sets both**.
 * A client that could post its own `criterionSetAt` could claim the limit was written last week, and
 * a provenance field anybody can write is decoration. See docs/DECISIONS.md #69.
 */

/**
 * Commissioning evidence is readable by anyone who can see the ticket.
 *
 * Registered here and listed in register-checkers.ts — docs/DECISIONS.md #60 for why the second half
 * is not optional.
 */
registerFileAccessChecker(TC_ENTITY_TYPE, async (user) => {
  return user.permissions.has("ticket.view") || user.permissions.has("ticket.view_all");
});

const keyOf = (name: string) => name.trim().toLowerCase();

/**
 * Compares two criteria regardless of key order.
 *
 * Postgres `jsonb` does not store keys in the order they were written — it reorders them — so a
 * criterion read back is byte-for-byte different from the identical one being saved. A plain
 * `JSON.stringify` comparison therefore reports "changed" on every save, which would re-stamp
 * `criterionSetAt` every time and make every test look like its limit was written after its own
 * reading. The warning would then fire on every record, and a warning that always fires is one
 * people learn to click past — which would quietly cost exactly the signal §10 is asking for.
 */
const canonical = (value: unknown): string =>
  JSON.stringify(value ?? null, (_key, entry: unknown) =>
    entry && typeof entry === "object" && !Array.isArray(entry)
      ? Object.fromEntries(
          Object.entries(entry as Record<string, unknown>).sort(([a], [b]) => a.localeCompare(b)),
        )
      : entry,
  );

const sameCriterion = (a: Criterion | null | undefined, b: Criterion | null | undefined) =>
  canonical(a ?? null) === canonical(b ?? null);

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

async function loadOrThrow(id: string) {
  const record = await db.testingCommissioning.findFirst({ where: { id, deletedAt: null } });
  if (!record) {
    throw new TRPCError({
      code: "NOT_FOUND",
      message: "That commissioning record no longer exists.",
    });
  }
  return record;
}

// ---- starting -----------------------------------------------------------------------------------

export async function beginTcService(actor: ActorMeta, input: { ticketId: string }) {
  const ticket = await db.ticket.findFirst({
    where: { id: input.ticketId, deletedAt: null },
    select: { id: true, number: true, projectId: true, status: true },
  });
  if (!ticket) {
    throw new TRPCError({ code: "NOT_FOUND", message: "That ticket no longer exists." });
  }

  const open = await db.testingCommissioning.findFirst({
    where: { ticketId: ticket.id, completedAt: null, deletedAt: null },
  });
  if (open) return open;

  const number = await allocateNumber(TC_DOCUMENT_TYPE);

  return db.$transaction(async (tx) => {
    const created = await tx.testingCommissioning.create({
      data: {
        number,
        ticketId: ticket.id,
        projectId: ticket.projectId,
        recordedById: actor.actorId,
      },
    });

    await writeAuditLog(tx, {
      actorId: actor.actorId,
      actorLabel: actor.actorLabel,
      action: "tc_started",
      entityType: TC_ENTITY_TYPE,
      entityId: created.id,
      summary: `${number} opened on ${ticket.number}.`,
      ip: actor.ip,
      userAgent: actor.userAgent,
      requestId: actor.requestId,
    });

    return created;
  });
}

// ---- the working record -------------------------------------------------------------------------

export interface SaveTcInput {
  id: string;
  functionalTests?: FunctionalTest[];
  performanceVerification?: FunctionalTest[];
  loopChecks?: {
    tagNumber: string;
    loopId?: string | null;
    result: string;
    remarks?: string | null;
  }[];
  punchItems?: PunchItem[];
  calibrationAssetsUsed?: string[];
  trainingDelivered?: {
    topic: string;
    attendees?: string[];
    durationHours?: number;
    materialsFileId?: string | null;
  }[];
  witnessedByCustomer?: boolean;
  customerWitnessName?: string | null;
  customerWitnessPosition?: string | null;
}

/**
 * Saves the working record, stamping provenance on anything that changed.
 *
 * Criteria and measurements are matched between saves **by test name**, which is why duplicate names
 * are refused: without a stable key the stamps would follow whichever row happened to land at the
 * same index, and a provenance trail that silently attaches to the wrong test is worse than none.
 */
export async function saveTcService(actor: ActorMeta, input: SaveTcInput) {
  const existing = await loadOrThrow(input.id);
  if (existing.completedAt) {
    throw new TRPCError({
      code: "BAD_REQUEST",
      message: "This commissioning record is completed. Reopen it or start another round.",
    });
  }

  const now = new Date().toISOString();

  const stamp = (incoming: FunctionalTest[], previous: FunctionalTest[]): FunctionalTest[] => {
    const before = new Map(previous.map((test) => [keyOf(test.test), test]));

    return incoming.map((test) => {
      const prior = before.get(keyOf(test.test));

      // The criterion's clock starts when the criterion first appears, and restarts if it changes.
      const criterionChanged = !prior || !sameCriterion(prior.criterion, test.criterion);
      const criterionSetAt = criterionChanged ? now : (prior.criterionSetAt ?? now);
      const criterionSetById = criterionChanged
        ? actor.actorId
        : (prior.criterionSetById ?? actor.actorId);

      const hasMeasurement = test.measured !== null && String(test.measured ?? "").trim() !== "";
      const measurementChanged =
        !prior || String(prior.measured ?? "") !== String(test.measured ?? "");
      const measuredAt = !hasMeasurement
        ? null
        : measurementChanged
          ? now
          : (prior.measuredAt ?? now);
      const measuredById = !hasMeasurement
        ? null
        : measurementChanged
          ? actor.actorId
          : (prior.measuredById ?? actor.actorId);

      return {
        ...test,
        criterionSource: test.criterionSource ?? "stated",
        criterionSetAt: test.criterion ? criterionSetAt : null,
        criterionSetById: test.criterion ? criterionSetById : null,
        measuredAt,
        measuredById,
      };
    });
  };

  const functionalTests = input.functionalTests
    ? stamp(input.functionalTests, readTests(existing.functionalTests))
    : readTests(existing.functionalTests);
  const performanceVerification = input.performanceVerification
    ? stamp(input.performanceVerification, readTests(existing.performanceVerification))
    : readTests(existing.performanceVerification);

  for (const set of [functionalTests, performanceVerification]) {
    const names = set.map((test) => keyOf(test.test));
    const duplicate = names.find((name, index) => names.indexOf(name) !== index);
    if (duplicate) {
      throw new TRPCError({
        code: "BAD_REQUEST",
        message: `Two tests are both called "${duplicate}". Names are how results stay attached to their criteria — give them different ones.`,
      });
    }
  }

  const punchItems = (input.punchItems ?? readPunch(existing.punchItems)).map((item) => ({
    ...item,
    status: item.status ?? "open",
    raisedAt: item.raisedAt ?? now,
  }));

  const updated = await db.testingCommissioning.update({
    where: { id: existing.id },
    data: {
      functionalTests: functionalTests as unknown as Prisma.InputJsonValue,
      performanceVerification: performanceVerification as unknown as Prisma.InputJsonValue,
      punchItems: punchItems as unknown as Prisma.InputJsonValue,
      ...(input.loopChecks
        ? { loopChecks: input.loopChecks as unknown as Prisma.InputJsonValue }
        : {}),
      ...(input.trainingDelivered
        ? { trainingDelivered: input.trainingDelivered as unknown as Prisma.InputJsonValue }
        : {}),
      ...(input.calibrationAssetsUsed
        ? { calibrationAssetsUsed: input.calibrationAssetsUsed }
        : {}),
      ...(input.witnessedByCustomer === undefined
        ? {}
        : { witnessedByCustomer: input.witnessedByCustomer }),
      ...(input.customerWitnessName === undefined
        ? {}
        : { customerWitnessName: input.customerWitnessName }),
      ...(input.customerWitnessPosition === undefined
        ? {}
        : { customerWitnessPosition: input.customerWitnessPosition }),
      version: { increment: 1 },
    },
  });

  const summary = evaluateTests([...functionalTests, ...performanceVerification]);

  return {
    id: updated.id,
    number: updated.number,
    evaluations: summary.evaluations,
    outOfSpec: summary.failed.length,
    unresolved: summary.indeterminate.length,
  };
}

// ---- completing ---------------------------------------------------------------------------------

export interface CompleteTcInput {
  id: string;
  result: TcResult;
  remarks?: string | null;
  customerSignatureFileId?: string | null;
  signOffRemarks?: string | null;
  certificateFileId?: string | null;
}

/**
 * Completes commissioning and moves the ticket.
 *
 * The sign-off is §10's billing trigger, so it carries the customer's signature — or, where there
 * genuinely is none, a written reason. That is the same standard §5 holds receipts to, §6.2 holds
 * the client approval document to and §9 holds QA evidence to: a status is something AIES set, an
 * artefact is something the customer produced, and only the second survives an argument.
 */
/**
 * §10's second path: commissioning carried out on an externally supplied form, already signed.
 *
 * The third of these, after §6.2's method statement and §12's service report, and the company asked
 * for it before it bit them — a plant that imposes its own method statement and its own service
 * report imposes its own commissioning sheet too. The readings go on their form, their engineer
 * witnesses and signs it, and the van leaves.
 *
 * §10 makes the certificate a **billing trigger**, so this is the one of the three where a missing
 * path costs money rather than tidiness: the job was commissioned and accepted, and the platform
 * went on reading "nothing recorded" while the milestone that should have become billable did not.
 *
 * ## What it writes
 *
 * A completed record with the customer's signed document attached, so everything downstream — the
 * billing trigger, the close-out pack, §10's certificate list — reads it exactly as it reads one
 * filled in here. `externalDocument` says the empty `functionalTests` are readings on somebody
 * else's sheet rather than readings nobody took.
 *
 * ## What it refuses
 *
 * **A rejected result.** This path exists for work the customer accepted on their own paperwork; a
 * failure needs the punch list and the rework loop, which is what the worksheet here is for. Letting
 * "rejected" through would file a failure with no punch items and nothing for anybody to act on.
 *
 * And, as with its two siblings: an unsigned document, an unnamed witness, and a date in the future.
 */
export async function recordExternalTcService(
  actor: ActorMeta,
  input: {
    ticketId: string;
    signedDocumentFileId: string;
    customerWitnessName: string;
    customerWitnessPosition?: string | null;
    completedAt: Date;
    remarks?: string | null;
  },
) {
  const ticket = await db.ticket.findFirst({
    where: { id: input.ticketId, deletedAt: null },
    select: { id: true, number: true, projectId: true },
  });
  if (!ticket) {
    throw new TRPCError({ code: "NOT_FOUND", message: "That ticket no longer exists." });
  }

  const witness = input.customerWitnessName.trim();
  if (witness.length === 0) {
    throw new TRPCError({
      code: "BAD_REQUEST",
      message:
        "Name who witnessed and signed it. §10's certificate is a billing trigger — an unwitnessed " +
        "one is AIES's word for it.",
    });
  }

  if (input.completedAt.getTime() > Date.now()) {
    throw new TRPCError({
      code: "BAD_REQUEST",
      message: "Commissioning cannot have finished in the future. Check the date.",
    });
  }

  const file = await db.fileObject.findFirst({
    where: { id: input.signedDocumentFileId, deletedAt: null },
    select: { id: true },
  });
  if (!file) {
    throw new TRPCError({
      code: "BAD_REQUEST",
      message: "That attachment no longer exists. Upload the signed sheet and choose it again.",
    });
  }

  const number = await allocateNumber(TC_DOCUMENT_TYPE);
  const now = new Date();

  const created = await db.$transaction(async (tx) => {
    const row = await tx.testingCommissioning.create({
      data: {
        number,
        ticketId: ticket.id,
        projectId: ticket.projectId,
        startedAt: input.completedAt,
        completedAt: input.completedAt,
        result: "accepted",
        externalDocument: true,
        witnessedByCustomer: true,
        customerWitnessName: witness,
        customerWitnessPosition: input.customerWitnessPosition?.trim() || null,
        certificateFileId: file.id,
        customerSignatureFileId: file.id,
        signOffRemarks: input.remarks?.trim() || null,
        recordedById: actor.actorId,
        signedOffById: actor.actorId,
        signedAt: now,
      },
    });

    await writeAuditLog(tx, {
      actorId: actor.actorId,
      actorLabel: actor.actorLabel,
      action: "create",
      entityType: TC_ENTITY_TYPE,
      entityId: row.id,
      summary:
        `Recorded ${row.number} on ${ticket.number} — commissioning on an externally written form, ` +
        `witnessed and signed by ${witness}` +
        `${input.customerWitnessPosition ? `, ${input.customerWitnessPosition.trim()}` : ""}.`,
      ip: actor.ip,
      userAgent: actor.userAgent,
      requestId: actor.requestId,
    });

    /*
      The same event the worksheet's sign-off emits, inside the same transaction, for the same
      reason.

      §10's acceptance is what makes the installation milestone billable, and a job commissioned on
      an externally written form is billable on exactly the same footing as one commissioned on ours.
      Emitting from one path and not the other is the asymmetry that fires for some jobs and not
      others — and here it would be the difference between an invoice and no invoice.

      No punch items, so no `punch_item.raised`: this path only accepts, and a failure needs the
      worksheet's punch list and rework loop rather than a filed acceptance with nothing to act on.
    */
    await emit(
      tx,
      "tc.completed",
      {
        testingCommissioningId: row.id,
        number: row.number,
        ticketId: ticket.id,
        projectId: ticket.projectId,
        result: "accepted",
        openPunchItems: 0,
        closeoutBlockers: 0,
      },
      { actorId: actor.actorId },
    );

    return row;
  });

  return { id: created.id, number: created.number };
}

export async function completeTcService(actor: ActorMeta, input: CompleteTcInput) {
  const record = await loadOrThrow(input.id);
  if (record.completedAt) {
    throw new TRPCError({
      code: "BAD_REQUEST",
      message: "This commissioning is already completed.",
    });
  }

  const ticket = await db.ticket.findFirst({
    where: { id: record.ticketId, deletedAt: null },
    select: { id: true, number: true, status: true, projectId: true },
  });
  if (!ticket) {
    throw new TRPCError({ code: "NOT_FOUND", message: "That ticket no longer exists." });
  }

  const functionalTests = readTests(record.functionalTests);
  const performanceVerification = readTests(record.performanceVerification);
  const punchItems = readPunch(record.punchItems);

  const check = checkTcRecord({
    result: input.result,
    functionalTests,
    performanceVerification,
    punchItems,
    witnessedByCustomer: record.witnessedByCustomer,
    calibrationAssetsUsed: record.calibrationAssetsUsed,
    remarks: input.remarks,
  });
  if (!check.ok) {
    throw new TRPCError({ code: "BAD_REQUEST", message: check.errors.join(" ") });
  }

  if (!input.customerSignatureFileId && !input.signOffRemarks?.trim()) {
    throw new TRPCError({
      code: "BAD_REQUEST",
      message:
        "The certificate needs the customer's signature, or a written reason there is none. §10 " +
        "makes this a billing trigger, and an unsigned one is AIES's word for it.",
    });
  }

  const outcome = tcOutcome({ result: input.result, punchItems });
  const blockers = closeoutBlockers(punchItems);
  const now = new Date();

  const completed = await db.$transaction(async (tx) => {
    const saved = await tx.testingCommissioning.update({
      where: { id: record.id },
      data: {
        result: input.result,
        completedAt: now,
        signedOffById: actor.actorId,
        signedAt: now,
        customerSignatureFileId: input.customerSignatureFileId ?? null,
        signOffRemarks: input.signOffRemarks ?? null,
        certificateFileId: input.certificateFileId ?? null,
        version: { increment: 1 },
      },
    });

    await tx.ticket.update({
      where: { id: ticket.id },
      data: { status: outcome.ticketStatus, version: { increment: 1 } },
    });

    await writeAuditLog(tx, {
      actorId: actor.actorId,
      actorLabel: actor.actorLabel,
      action: input.result === "rejected" ? "tc_rejected" : "tc_completed",
      entityType: TC_ENTITY_TYPE,
      entityId: record.id,
      summary:
        `${record.number} on ${ticket.number}: commissioning ${input.result.replace(/_/g, " ")}` +
        (record.witnessedByCustomer ? "" : " (not witnessed by the customer)") +
        `. ${outcome.message}`,
      diff: { status: { from: ticket.status, to: outcome.ticketStatus } },
      ip: actor.ip,
      userAgent: actor.userAgent,
      requestId: actor.requestId,
    });

    await emit(
      tx,
      "tc.completed",
      {
        testingCommissioningId: record.id,
        number: record.number,
        ticketId: ticket.id,
        projectId: ticket.projectId,
        result: input.result,
        openPunchItems: punchItems.filter(isOpen).length,
        closeoutBlockers: blockers.length,
      },
      { actorId: actor.actorId },
    );

    // §10: critical punch items block close-out. Raised as their own event so §12 and module 08 do
    // not have to re-read the commissioning record to learn that something is outstanding.
    if (blockers.length > 0) {
      await emit(
        tx,
        "punch_item.raised",
        {
          testingCommissioningId: record.id,
          ticketId: ticket.id,
          projectId: ticket.projectId,
          items: blockers.map((item) => ({
            description: item.description,
            severity: item.severity,
            ownerId: item.ownerId ?? null,
            dueAt: item.dueAt ?? null,
          })),
        },
        { actorId: actor.actorId },
      );
    }

    return saved;
  });

  return {
    id: completed.id,
    number: completed.number,
    result: input.result,
    ticketStatus: outcome.ticketStatus,
    message: outcome.message,
    closeoutBlockers: blockers.length,
    warnings: check.warnings,
  };
}

// ---- reading ------------------------------------------------------------------------------------

export async function listTcForTicketService(ticketId: string) {
  const rows = await db.testingCommissioning.findMany({
    where: { ticketId, deletedAt: null },
    orderBy: { startedAt: "desc" },
  });

  const shaped = rows.map((row) => ({
    ...row,
    functionalTests: readTests(row.functionalTests),
    performanceVerification: readTests(row.performanceVerification),
    punchItems: readPunch(row.punchItems),
  }));

  const openPunch = shaped.flatMap((row) => row.punchItems.filter(isOpen));

  return {
    rows: shaped,
    latest: shaped[0] ?? null,
    openPunchItems: openPunch,
    /** §10: critical punch items block project close-out. §12 reads this rather than recomputing it. */
    closeoutBlockers: closeoutBlockers(openPunch),
  };
}

/**
 * What the accepted quotation actually promised for this ticket, so a criterion can cite a line.
 *
 * The walk is ticket → sales order lines → quotation lines, which module 03 already describes as the
 * answer to "what did we actually promise?" once a quotation has been superseded by a later
 * revision. The text comes back as prose because that is how module 02 stores it — the reason §10's
 * comparison cannot read a number by itself. docs/DECISIONS.md #69.
 */
export async function promisedLinesForTicketService(ticketId: string) {
  const links = await db.ticketSalesOrderLine.findMany({
    where: { ticketId },
    select: { salesOrderLineId: true },
  });
  if (links.length === 0) return { lines: [], note: "This ticket is not linked to a sales order." };

  const orderLines = await db.salesOrderLine.findMany({
    where: { id: { in: links.map((link) => link.salesOrderLineId) } },
    select: { id: true, quotationLineId: true, description: true },
  });

  const quotationLineIds = orderLines
    .map((line) => line.quotationLineId)
    .filter((id): id is string => !!id);

  const quotationLines = quotationLineIds.length
    ? await db.quotationLine.findMany({
        where: { id: { in: quotationLineIds } },
        select: {
          id: true,
          description: true,
          longDescription: true,
          manufacturer: true,
          modelNumber: true,
        },
      })
    : [];

  const byId = new Map(quotationLines.map((line) => [line.id, line]));

  return {
    lines: orderLines.map((line) => {
      const quoted = line.quotationLineId ? byId.get(line.quotationLineId) : undefined;
      return {
        quotationLineId: quoted?.id ?? null,
        description: quoted?.description ?? line.description,
        promiseText:
          [quoted?.description, quoted?.longDescription, quoted?.modelNumber]
            .filter(Boolean)
            .join(" — ") || line.description,
      };
    }),
    note: null,
  };
}
