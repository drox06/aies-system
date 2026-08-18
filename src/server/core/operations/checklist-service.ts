import { TRPCError } from "@trpc/server";
import { Prisma } from "@prisma/client";
import { db } from "@/lib/db";
import { writeAuditLog } from "@/server/core/audit/audit";
import type { ActorMeta } from "@/server/core/crm/account-service";
import { emit } from "@/server/core/events/emit";
import { registerFileAccessChecker } from "@/server/core/storage/access";
import {
  CHECKLIST_RESPONSE_ENTITY_TYPE,
  CHECKLIST_TEMPLATE_ENTITY_TYPE,
  checkResponse,
  ncrWorthy,
  readAnswers,
  readSections,
  summarise,
  type Answers,
} from "./checklist-rules";

/**
 * specs/04-operations-projects.md §15's templates and responses.
 *
 * ## The rule that makes versioning worth having
 *
 * §15: "templates are versioned; responses permanently record the version used, so historical
 * evidence reflects the procedure actually in force."
 *
 * That sentence is only true if **a published version can never be edited**. If it can, then a
 * checklist somebody signed six months ago silently comes to mean whatever the template says today —
 * which is worse than having no checklist, because it looks like evidence and is not. So
 * `publishTemplate` freezes a version, `reviseTemplate` creates the next one, and there is no path
 * that mutates the `sections` of anything published.
 *
 * The response also keeps its own `snapshot` of the items it answered. Belt and braces, and worth
 * the duplication: evidence that can only be read by joining to another table depends on that table
 * still being right, and this is the kind of record somebody reads in five years during an audit.
 */

registerFileAccessChecker(CHECKLIST_RESPONSE_ENTITY_TYPE, async (user) => {
  return user.permissions.has("ticket.view") || user.permissions.has("ticket.view_all");
});

// ---- templates -----------------------------------------------------------------------------------

export async function listTemplatesService(
  input: { stage?: string; includeRetired?: boolean } = {},
) {
  const rows = await db.checklistTemplate.findMany({
    where: {
      deletedAt: null,
      ...(input.stage ? { stage: input.stage } : {}),
      ...(input.includeRetired ? {} : { status: { in: ["draft", "active"] } }),
    },
    orderBy: [{ stage: "asc" }, { key: "asc" }, { version: "desc" }],
  });

  return rows.map((row) => ({
    ...row,
    sections: readSections(row.sections),
  }));
}

/** The version somebody filling in a checklist should get: the active one, highest version. */
export async function activeTemplateService(key: string) {
  const row = await db.checklistTemplate.findFirst({
    where: { key, status: "active", deletedAt: null },
    orderBy: { version: "desc" },
  });
  if (!row) return null;
  return { ...row, sections: readSections(row.sections) };
}

export async function createTemplateService(
  actor: ActorMeta,
  input: {
    key: string;
    name: string;
    stage: string;
    description?: string | null;
    sections?: unknown;
  },
) {
  const existing = await db.checklistTemplate.findFirst({
    where: { key: input.key, deletedAt: null },
    orderBy: { version: "desc" },
  });
  if (existing) {
    throw new TRPCError({
      code: "BAD_REQUEST",
      message:
        `A checklist called "${input.key}" already exists at version ${existing.version}. ` +
        `Revise that one instead — a second series under the same name would leave nobody able to ` +
        `say which procedure a response followed.`,
    });
  }

  return db.checklistTemplate.create({
    data: {
      key: input.key,
      version: 1,
      name: input.name,
      stage: input.stage,
      description: input.description ?? null,
      sections: (input.sections ?? []) as Prisma.InputJsonValue,
      status: "draft",
    },
  });
}

/** Editing is allowed only while a version is a draft. This is the whole immutability rule. */
export async function saveDraftService(
  actor: ActorMeta,
  input: { templateId: string; name?: string; description?: string | null; sections?: unknown },
) {
  const template = await db.checklistTemplate.findFirst({
    where: { id: input.templateId, deletedAt: null },
  });
  if (!template) throw new TRPCError({ code: "NOT_FOUND", message: "No such checklist." });

  if (template.status !== "draft") {
    throw new TRPCError({
      code: "BAD_REQUEST",
      message:
        `${template.name} v${template.version} is ${template.status} and cannot be edited. ` +
        `Responses cite this version as the procedure they followed, and changing it would rewrite ` +
        `what they say. Create the next version instead.`,
    });
  }

  return db.checklistTemplate.update({
    where: { id: template.id },
    data: {
      name: input.name ?? template.name,
      description: input.description === undefined ? template.description : input.description,
      ...(input.sections === undefined
        ? {}
        : { sections: input.sections as Prisma.InputJsonValue }),
    },
  });
}

export async function publishTemplateService(actor: ActorMeta, input: { templateId: string }) {
  const template = await db.checklistTemplate.findFirst({
    where: { id: input.templateId, deletedAt: null },
  });
  if (!template) throw new TRPCError({ code: "NOT_FOUND", message: "No such checklist." });
  if (template.status !== "draft") {
    throw new TRPCError({ code: "BAD_REQUEST", message: "Only a draft can be published." });
  }

  const sections = readSections(template.sections);
  if (sections.flatMap((section) => section.items).length === 0) {
    throw new TRPCError({
      code: "BAD_REQUEST",
      message: "A checklist with no items would be a signature on an empty page.",
    });
  }

  return db.$transaction(async (tx) => {
    // Exactly one active version per key. The previous one is retired rather than deleted, because
    // responses point at it and it is what they followed.
    await tx.checklistTemplate.updateMany({
      where: { key: template.key, status: "active", id: { not: template.id } },
      data: { status: "retired", retiredAt: new Date() },
    });

    const published = await tx.checklistTemplate.update({
      where: { id: template.id },
      data: { status: "active", publishedAt: new Date(), publishedById: actor.actorId },
    });

    await writeAuditLog(tx, {
      actorId: actor.actorId,
      actorLabel: actor.actorLabel,
      action: "checklist_published",
      entityType: CHECKLIST_TEMPLATE_ENTITY_TYPE,
      entityId: published.id,
      summary: `${published.name} v${published.version} published; earlier versions retired.`,
      ip: actor.ip,
      userAgent: actor.userAgent,
      requestId: actor.requestId,
    });

    return published;
  });
}

/**
 * The next version of a published checklist, copied from the current one.
 *
 * The only way to change a procedure that is in force. Copying rather than starting blank is the
 * difference between "correct one limit" and "retype forty items", and a procedure somebody has to
 * retype is one that quietly stops being revised.
 */
export async function reviseTemplateService(actor: ActorMeta, input: { templateId: string }) {
  const source = await db.checklistTemplate.findFirst({
    where: { id: input.templateId, deletedAt: null },
  });
  if (!source) throw new TRPCError({ code: "NOT_FOUND", message: "No such checklist." });

  const latest = await db.checklistTemplate.findFirst({
    where: { key: source.key, deletedAt: null },
    orderBy: { version: "desc" },
  });
  if (latest && latest.status === "draft") {
    throw new TRPCError({
      code: "BAD_REQUEST",
      message: `v${latest.version} is already an unpublished draft. Finish or discard it first.`,
    });
  }

  return db.checklistTemplate.create({
    data: {
      key: source.key,
      version: (latest?.version ?? source.version) + 1,
      name: source.name,
      description: source.description,
      stage: source.stage,
      sections: source.sections as Prisma.InputJsonValue,
      status: "draft",
    },
  });
}

// ---- responses -----------------------------------------------------------------------------------

export async function startResponseService(
  actor: ActorMeta,
  input: {
    templateKey: string;
    ticketId?: string | null;
    projectId?: string | null;
    entityType?: string | null;
    entityId?: string | null;
  },
) {
  const template = await activeTemplateService(input.templateKey);
  if (!template) {
    throw new TRPCError({
      code: "BAD_REQUEST",
      message: `There is no published "${input.templateKey}" checklist to fill in.`,
    });
  }

  return db.checklistResponse.create({
    data: {
      templateId: template.id,
      templateKey: template.key,
      templateVersion: template.version,
      // Frozen at the moment of answering, so the record reads on its own.
      snapshot: { sections: template.sections } as unknown as Prisma.InputJsonValue,
      ticketId: input.ticketId ?? null,
      projectId: input.projectId ?? null,
      entityType: input.entityType ?? null,
      entityId: input.entityId ?? null,
      status: "draft",
      startedById: actor.actorId,
    },
  });
}

export async function saveAnswersService(
  actor: ActorMeta,
  input: { responseId: string; answers: unknown },
) {
  const response = await loadResponse(input.responseId);
  if (response.status === "complete") {
    throw new TRPCError({
      code: "BAD_REQUEST",
      message: "This checklist is signed off. Fill in a new one rather than rewriting the record.",
    });
  }

  return db.checklistResponse.update({
    where: { id: response.id },
    data: {
      answers: (input.answers ?? {}) as Prisma.InputJsonValue,
      version: { increment: 1 },
    },
  });
}

/**
 * Signs the checklist off.
 *
 * Every gate lives in `checkResponse`, which the screen runs too — so somebody sees why they are
 * blocked while they can still fix it, and the server refuses the same thing for the same reason if
 * the screen is bypassed.
 */
export async function completeResponseService(
  actor: ActorMeta,
  input: {
    responseId: string;
    signatureFileId?: string | null;
    signedByName?: string | null;
    signedByPosition?: string | null;
  },
) {
  const response = await loadResponse(input.responseId);
  if (response.status === "complete") {
    throw new TRPCError({ code: "BAD_REQUEST", message: "Already signed off." });
  }

  const sections = snapshotSections(response.snapshot);
  const answers = readAnswers(response.answers);
  const check = checkResponse(sections, answers);

  if (!check.ok) {
    const reasons = [
      ...check.invalidNotApplicable,
      ...check.unanswered,
      ...check.incompleteFailures,
    ].map((problem) => `${problem.label}: ${problem.reason}`);
    throw new TRPCError({ code: "BAD_REQUEST", message: reasons.join(" ") });
  }

  const now = new Date();

  return db.$transaction(async (tx) => {
    const completed = await tx.checklistResponse.update({
      where: { id: response.id },
      data: {
        status: "complete",
        completedById: actor.actorId,
        completedAt: now,
        signatureFileId: input.signatureFileId ?? null,
        signedByName: input.signedByName ?? null,
        signedByPosition: input.signedByPosition ?? null,
        version: { increment: 1 },
      },
    });

    await writeAuditLog(tx, {
      actorId: actor.actorId,
      actorLabel: actor.actorLabel,
      action: "checklist_completed",
      entityType: CHECKLIST_RESPONSE_ENTITY_TYPE,
      entityId: completed.id,
      summary: `${response.templateKey} v${response.templateVersion}: ${summarise(check)}.`,
      ip: actor.ip,
      userAgent: actor.userAgent,
      requestId: actor.requestId,
    });

    await emit(
      tx,
      "checklist.completed",
      {
        responseId: completed.id,
        templateKey: response.templateKey,
        templateVersion: response.templateVersion,
        ticketId: response.ticketId,
        projectId: response.projectId,
        failures: check.failures.length,
      },
      { actorId: actor.actorId },
    );

    /**
     * §15: a fail "can auto-raise an NCR".
     *
     * Emitted rather than raised, because module 04 does not own the NCR register —
     * specs/08-qms-iso9001.md §2 does. Same deferral §9's QA gate already makes, and emitting now
     * means module 08 subscribes rather than every caller being retrofitted.
     */
    const worthy = ncrWorthy(check);
    if (worthy.length > 0) {
      await emit(
        tx,
        "checklist.failed",
        {
          responseId: completed.id,
          templateKey: response.templateKey,
          ticketId: response.ticketId,
          projectId: response.projectId,
          failures: worthy,
        },
        { actorId: actor.actorId },
      );
    }

    return completed;
  });
}

/**
 * Removes a checklist somebody started by mistake.
 *
 * The company's reason, 2026-08-18: "a wrong checklist might be selected and is not needed. This
 * will leave an 'in progress' when it does not really progress." Correct — an abandoned draft sits on
 * the ticket forever looking like outstanding work, and a list of outstanding work that contains
 * things nobody intends to do is a list people stop reading.
 *
 * ## A signed checklist is never deletable
 *
 * That is the line, and it is not a policy setting. §15 exists so that what was checked can be read
 * afterwards; a signed-off checklist is the evidence, and evidence somebody can remove when it
 * becomes inconvenient is not evidence. If a completed one is wrong, the answer is a new one that
 * says so — the record then shows both, which is the truth.
 *
 * ## Soft, not hard
 *
 * A draft can be half-filled. Somebody deleting the wrong row should not destroy an afternoon of
 * answers, and §14's whole argument is that field work is not something to lose casually. The row
 * stays, hidden, recoverable by anybody with database access.
 */
export async function deleteResponseService(actor: ActorMeta, input: { responseId: string }) {
  const response = await loadResponse(input.responseId);

  if (response.status === "complete") {
    throw new TRPCError({
      code: "BAD_REQUEST",
      message:
        `${response.templateKey} was signed off${response.signedByName ? ` by ${response.signedByName}` : ""} ` +
        `and cannot be deleted — it is the record of what was checked. If it is wrong, fill in a new ` +
        `one; the history then shows both, which is what actually happened.`,
    });
  }

  const removed = await db.$transaction(async (tx) => {
    const row = await tx.checklistResponse.update({
      where: { id: response.id },
      data: { deletedAt: new Date(), deletedBy: actor.actorId, version: { increment: 1 } },
    });

    await writeAuditLog(tx, {
      actorId: actor.actorId,
      actorLabel: actor.actorLabel,
      action: "checklist_discarded",
      entityType: CHECKLIST_RESPONSE_ENTITY_TYPE,
      entityId: response.id,
      summary: `Discarded an unfinished ${response.templateKey} v${response.templateVersion}.`,
      ip: actor.ip,
      userAgent: actor.userAgent,
      requestId: actor.requestId,
    });

    return row;
  });

  return removed;
}

export async function getResponseService(responseId: string) {
  const response = await db.checklistResponse.findFirst({
    where: { id: responseId, deletedAt: null },
  });
  if (!response) return null;

  const sections = snapshotSections(response.snapshot);
  const answers = readAnswers(response.answers);

  return {
    ...response,
    sections,
    answers,
    check: checkResponse(sections, answers),
  };
}

export async function listResponsesForTicketService(ticketId: string) {
  const rows = await db.checklistResponse.findMany({
    where: { ticketId, deletedAt: null },
    orderBy: { startedAt: "desc" },
  });

  return rows.map((row) => {
    const sections = snapshotSections(row.snapshot);
    const check = checkResponse(sections, readAnswers(row.answers));
    return {
      id: row.id,
      templateKey: row.templateKey,
      templateVersion: row.templateVersion,
      status: row.status,
      startedAt: row.startedAt,
      completedAt: row.completedAt,
      signedByName: row.signedByName,
      summary: summarise(check),
      failures: check.failures.length,
    };
  });
}

// ---- helpers -------------------------------------------------------------------------------------

async function loadResponse(responseId: string) {
  const response = await db.checklistResponse.findFirst({
    where: { id: responseId, deletedAt: null },
  });
  if (!response) {
    throw new TRPCError({ code: "NOT_FOUND", message: "That checklist no longer exists." });
  }
  return response;
}

/** The snapshot is `{ sections: [...] }`, parsed with the same tolerance as a live template. */
function snapshotSections(snapshot: Prisma.JsonValue) {
  if (!snapshot || typeof snapshot !== "object" || Array.isArray(snapshot)) return [];
  return readSections((snapshot as Record<string, unknown>).sections);
}

/** Re-exported so callers do not have to know the answers are stored as Json. */
export type { Answers };
