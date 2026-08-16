import { TRPCError } from "@trpc/server";
import { Prisma } from "@prisma/client";
import { db } from "@/lib/db";
import { writeAuditLog } from "@/server/core/audit/audit";
import type { ActorMeta } from "@/server/core/crm/account-service";
import { emit } from "@/server/core/events/emit";
import { allocateNumber } from "@/server/core/numbering/numbering";
import { notify } from "@/server/core/notify/notify";
import { registerNotificationType } from "@/server/core/notify/registry";
import { registerFileAccessChecker } from "@/server/core/storage/access";
import type { AuthedUser } from "@/server/core/rbac/types";
import {
  METHODOLOGY_DOCUMENT_TYPE,
  METHODOLOGY_ENTITY_TYPE,
  canTransition,
  clientTurnaround,
  isMethodologyEditable,
  materialRequestSeed,
  methodologyCompleteness,
  methodologyGate,
} from "./methodology-rules";
import { TICKET_ENTITY_TYPE } from "./ticket-rules";

/**
 * Method statements (specs/04-operations-projects.md §6.2).
 *
 * Two things in this file carry the section's weight.
 *
 * **The dates.** §6.2: "Client methodology approval is a common and invisible source of schedule
 * slip, and AIES is usually blamed for delays it did not cause. A dated submission record changes
 * that conversation." So `submittedToClientAt` is written by the act of sending, never by hand, and
 * the turnaround is computed from it rather than remembered.
 *
 * **The revision chain.** §6.2: a client rejection "returns the methodology to draft with the
 * client's comments captured, and creates a revision — the revision chain is the evidence of what
 * was agreed." The rejected document therefore stays rejected: R+1 is a new row. A document that
 * could be edited back into acceptability would prove nothing about what the client turned down.
 */

export const METHODOLOGY_SUBMITTED_NOTIFICATION_TYPE = "methodology.submitted_for_review";
export const METHODOLOGY_DECIDED_NOTIFICATION_TYPE = "methodology.decided";

registerNotificationType({
  key: METHODOLOGY_SUBMITTED_NOTIFICATION_TYPE,
  label: "A method statement is waiting for your review",
  defaultChannels: { inApp: true, email: false, digest: false },
});

registerNotificationType({
  key: METHODOLOGY_DECIDED_NOTIFICATION_TYPE,
  label: "A method statement was approved or sent back",
  defaultChannels: { inApp: true, email: false, digest: false },
});

/**
 * The JSA and the client's approval letter are readable by anyone who can see the ticket.
 *
 * Registered here and listed in register-checkers.ts — see docs/DECISIONS.md #60 for why the second
 * half is not optional.
 */
registerFileAccessChecker(METHODOLOGY_ENTITY_TYPE, async (user) => {
  return user.permissions.has("ticket.view") || user.permissions.has("ticket.view_all");
});

// ---- creating ---------------------------------------------------------------------------------

export interface CreateMethodologyInput {
  projectId?: string | null;
  ticketId?: string | null;
  title: string;
  /** §6.2's institutional library: start from a previous project's method statement. */
  cloneFromId?: string | null;
}

/**
 * Raises R0, optionally cloned from a previous one.
 *
 * §6.2: "Methodologies are reusable: clone from a previous project of the same type, which is how
 * the company builds an institutional library instead of rewriting from scratch each time."
 *
 * The clone copies the *method* — sequence, manpower, tools, materials, safety, permits — and
 * deliberately not the history: no client dates, no approvals, no JSA file, and a fresh number. What
 * is being reused is how the company does this kind of work, not what a different customer agreed to.
 */
export async function createMethodologyService(actor: ActorMeta, input: CreateMethodologyInput) {
  if (!input.projectId && !input.ticketId) {
    throw new TRPCError({
      code: "BAD_REQUEST",
      message: "A method statement has to belong to a project or a ticket.",
    });
  }

  const source = input.cloneFromId
    ? await db.methodology.findFirst({ where: { id: input.cloneFromId, deletedAt: null } })
    : null;
  if (input.cloneFromId && !source) {
    throw new TRPCError({ code: "NOT_FOUND", message: "That method statement no longer exists." });
  }

  const number = await allocateNumber(METHODOLOGY_DOCUMENT_TYPE);

  const created = await db.$transaction(async (tx) => {
    const row = await tx.methodology.create({
      data: {
        number,
        revision: 0,
        projectId: input.projectId ?? null,
        ticketId: input.ticketId ?? null,
        title: input.title,
        preparedById: actor.actorId,
        status: "draft",
        ...(source
          ? {
              scopeSummary: source.scopeSummary,
              sequenceOfWork: source.sequenceOfWork as Prisma.InputJsonValue,
              manpowerPlan: source.manpowerPlan as Prisma.InputJsonValue,
              toolsRequired: source.toolsRequired,
              materialsRequired: source.materialsRequired as Prisma.InputJsonValue,
              safetyPlan: source.safetyPlan,
              permitsRequired: source.permitsRequired,
              environmentalConsiderations: source.environmentalConsiderations,
              durationDays: source.durationDays,
              mobilizationPlan: source.mobilizationPlan,
              demobilizationPlan: source.demobilizationPlan,
              contingencyPlan: source.contingencyPlan,
            }
          : { scopeSummary: "" }),
      },
    });

    await writeAuditLog(tx, {
      actorId: actor.actorId,
      actorLabel: actor.actorLabel,
      action: "created",
      entityType: METHODOLOGY_ENTITY_TYPE,
      entityId: row.id,
      summary: source
        ? `Raised method statement ${number} for "${input.title}", cloned from ${source.number} R${source.revision}`
        : `Raised method statement ${number} for "${input.title}"`,
      ip: actor.ip,
      userAgent: actor.userAgent,
      requestId: actor.requestId,
    });

    return row;
  });

  return { id: created.id, number: created.number, revision: created.revision };
}

// ---- editing ------------------------------------------------------------------------------------

export interface SaveMethodologyInput {
  methodologyId: string;
  title?: string;
  scopeSummary?: string;
  sequenceOfWork?: { step: number; description: string; durationHours: number; crew: string }[];
  manpowerPlan?: { role: string; count: number; notes?: string }[];
  toolsRequired?: string[];
  materialsRequired?: { description: string; quantity: string; unit: string }[];
  safetyPlan?: string | null;
  jsaFileId?: string | null;
  permitsRequired?: string[];
  environmentalConsiderations?: string | null;
  durationDays?: number | null;
  mobilizationPlan?: string | null;
  demobilizationPlan?: string | null;
  contingencyPlan?: string | null;
}

export async function saveMethodologyService(actor: ActorMeta, input: SaveMethodologyInput) {
  const methodology = await loadEditable(input.methodologyId);

  const updated = await db.$transaction(async (tx) => {
    const row = await tx.methodology.update({
      where: { id: methodology.id },
      data: {
        ...(input.title !== undefined ? { title: input.title } : {}),
        ...(input.scopeSummary !== undefined ? { scopeSummary: input.scopeSummary } : {}),
        ...(input.sequenceOfWork !== undefined
          ? { sequenceOfWork: input.sequenceOfWork as unknown as Prisma.InputJsonValue }
          : {}),
        ...(input.manpowerPlan !== undefined
          ? { manpowerPlan: input.manpowerPlan as unknown as Prisma.InputJsonValue }
          : {}),
        ...(input.toolsRequired !== undefined ? { toolsRequired: input.toolsRequired } : {}),
        ...(input.materialsRequired !== undefined
          ? { materialsRequired: input.materialsRequired as unknown as Prisma.InputJsonValue }
          : {}),
        ...(input.safetyPlan !== undefined ? { safetyPlan: input.safetyPlan } : {}),
        ...(input.jsaFileId !== undefined ? { jsaFileId: input.jsaFileId } : {}),
        ...(input.permitsRequired !== undefined ? { permitsRequired: input.permitsRequired } : {}),
        ...(input.environmentalConsiderations !== undefined
          ? { environmentalConsiderations: input.environmentalConsiderations }
          : {}),
        ...(input.durationDays !== undefined ? { durationDays: input.durationDays } : {}),
        ...(input.mobilizationPlan !== undefined
          ? { mobilizationPlan: input.mobilizationPlan }
          : {}),
        ...(input.demobilizationPlan !== undefined
          ? { demobilizationPlan: input.demobilizationPlan }
          : {}),
        ...(input.contingencyPlan !== undefined ? { contingencyPlan: input.contingencyPlan } : {}),
        version: { increment: 1 },
      },
    });

    await writeAuditLog(tx, {
      actorId: actor.actorId,
      actorLabel: actor.actorLabel,
      action: "updated",
      entityType: METHODOLOGY_ENTITY_TYPE,
      entityId: methodology.id,
      summary: `Edited method statement ${methodology.number} R${methodology.revision}`,
      ip: actor.ip,
      userAgent: actor.userAgent,
      requestId: actor.requestId,
    });

    return row;
  });

  return { id: updated.id, completeness: methodologyCompleteness(updated) };
}

// ---- the internal cycle -------------------------------------------------------------------------

/** Moves it to internal review, refusing a method statement that does not yet describe a method. */
export async function submitForInternalReviewService(actor: ActorMeta, methodologyId: string) {
  const methodology = await loadOne(methodologyId);
  assertTransition(methodology.status, "internal_review", methodology.number);

  const check = methodologyCompleteness(methodology);
  if (!check.complete) {
    throw new TRPCError({
      code: "BAD_REQUEST",
      message: `${methodology.number} still needs ${check.missing.join("; ")}.`,
    });
  }

  await move(
    actor,
    methodology,
    "internal_review",
    `Sent ${methodology.number} for internal review`,
  );

  // Whoever can approve should hear about it; best-effort, like every other notification here.
  const approvers = await db.user.findMany({
    where: {
      isActive: true,
      deletedAt: null,
      roles: {
        some: { role: { key: { in: ["president", "vice_president", "operations_manager"] } } },
      },
    },
    select: { id: true },
  });
  for (const approver of approvers) {
    await safeNotify({
      recipientId: approver.id,
      type: METHODOLOGY_SUBMITTED_NOTIFICATION_TYPE,
      title: `${methodology.number} is ready for internal review`,
      body: methodology.title,
      entityType: METHODOLOGY_ENTITY_TYPE,
      entityId: methodology.id,
    });
  }

  return { status: "internal_review" as const, warnings: check.warnings };
}

/** The internal sign-off, before the client ever sees it (§19's `methodology.approve`). */
export async function approveMethodologyService(
  actor: ActorMeta,
  input: { methodologyId: string; decision: "approved" | "rejected"; comment?: string },
) {
  const methodology = await loadOne(input.methodologyId);
  const to = input.decision === "approved" ? "approved" : "draft";
  assertTransition(methodology.status, to, methodology.number);

  if (input.decision === "rejected" && !input.comment?.trim()) {
    throw new TRPCError({
      code: "BAD_REQUEST",
      message:
        "Say what needs changing — a method statement sent back blind gets resubmitted blind.",
    });
  }

  await db.$transaction(async (tx) => {
    await tx.methodology.update({
      where: { id: methodology.id },
      data: {
        status: to,
        ...(input.decision === "approved"
          ? { approvedById: actor.actorId, approvedAt: new Date() }
          : { approvedById: null, approvedAt: null }),
        version: { increment: 1 },
      },
    });
    await writeAuditLog(tx, {
      actorId: actor.actorId,
      actorLabel: actor.actorLabel,
      action: input.decision === "approved" ? "approved_internally" : "sent_back",
      entityType: METHODOLOGY_ENTITY_TYPE,
      entityId: methodology.id,
      summary:
        input.decision === "approved"
          ? `Approved ${methodology.number} R${methodology.revision} internally`
          : `Sent ${methodology.number} R${methodology.revision} back — ${input.comment}`,
      diff: { status: { from: methodology.status, to } },
      ip: actor.ip,
      userAgent: actor.userAgent,
      requestId: actor.requestId,
    });

    if (input.decision === "approved") {
      await emit(
        tx,
        "methodology.approved",
        {
          methodologyId: methodology.id,
          number: methodology.number,
          revision: methodology.revision,
          projectId: methodology.projectId,
          ticketId: methodology.ticketId,
        },
        { actorId: actor.actorId },
      );
    }
  });

  await safeNotify({
    recipientId: methodology.preparedById,
    type: METHODOLOGY_DECIDED_NOTIFICATION_TYPE,
    title:
      input.decision === "approved"
        ? `${methodology.number} approved — ready to send to the client`
        : `${methodology.number} was sent back`,
    body: input.comment ?? "",
    entityType: METHODOLOGY_ENTITY_TYPE,
    entityId: methodology.id,
  });

  return { status: to };
}

// ---- the client ---------------------------------------------------------------------------------

/**
 * Records that it went to the client, and starts §6.2's clock.
 *
 * `submittedToClientAt` is written here and nowhere else. The whole value of the date is that it is
 * the moment the document left AIES, recorded by the act of sending rather than remembered
 * afterwards — a date somebody types in later is exactly the evidence a customer will dispute.
 */
export async function submitToClientService(actor: ActorMeta, methodologyId: string) {
  const methodology = await loadOne(methodologyId);
  assertTransition(methodology.status, "submitted_to_client", methodology.number);

  await db.$transaction(async (tx) => {
    await tx.methodology.update({
      where: { id: methodology.id },
      data: {
        status: "submitted_to_client",
        submittedToClientAt: new Date(),
        version: { increment: 1 },
      },
    });
    await writeAuditLog(tx, {
      actorId: actor.actorId,
      actorLabel: actor.actorLabel,
      action: "submitted_to_client",
      entityType: METHODOLOGY_ENTITY_TYPE,
      entityId: methodology.id,
      summary: `Sent ${methodology.number} R${methodology.revision} to the client`,
      diff: { status: { from: methodology.status, to: "submitted_to_client" } },
      ip: actor.ip,
      userAgent: actor.userAgent,
      requestId: actor.requestId,
    });
  });

  return { status: "submitted_to_client" as const };
}

/**
 * The client's answer.
 *
 * Approval demands the file. §6.2 gates mobilization on the document as well as the status, so
 * accepting an approval without one would create a record that reads approved and a gate that stays
 * shut — which looks like a bug and is actually the gate being right.
 *
 * Rejection captures the comments and **raises R+1 as a draft**, per §6.2. The rejected revision
 * stays rejected; that is what makes the chain evidence of what was agreed.
 */
export async function recordClientDecisionService(
  actor: ActorMeta,
  input: {
    methodologyId: string;
    decision: "approved" | "rejected";
    approvalFileId?: string | null;
    notes?: string;
  },
) {
  const methodology = await loadOne(input.methodologyId);
  const to = input.decision === "approved" ? "client_approved" : "client_rejected";
  assertTransition(methodology.status, to, methodology.number);

  if (input.decision === "approved" && !input.approvalFileId) {
    throw new TRPCError({
      code: "BAD_REQUEST",
      message:
        "Attach the client's approval before recording it. §6.2 gates mobilisation on the document " +
        "as well as the status — a status is ours, the document is theirs.",
    });
  }
  if (input.decision === "rejected" && !input.notes?.trim()) {
    throw new TRPCError({
      code: "BAD_REQUEST",
      message:
        "Capture what the client objected to. The revision is written against those comments.",
    });
  }

  const rootId = methodology.parentMethodologyId ?? methodology.id;

  const result = await db.$transaction(async (tx) => {
    await tx.methodology.update({
      where: { id: methodology.id },
      data: {
        status: to,
        ...(input.decision === "approved"
          ? { clientApprovedAt: new Date(), clientApprovalFileId: input.approvalFileId }
          : { clientRejectionNotes: input.notes }),
        version: { increment: 1 },
      },
    });

    let revisionId: string | null = null;
    if (input.decision === "rejected") {
      const latest = await tx.methodology.aggregate({
        where: { OR: [{ id: rootId }, { parentMethodologyId: rootId }], deletedAt: null },
        _max: { revision: true },
      });
      const nextRevision = (latest._max.revision ?? methodology.revision) + 1;

      const revision = await tx.methodology.create({
        data: {
          number: methodology.number,
          revision: nextRevision,
          parentMethodologyId: rootId,
          projectId: methodology.projectId,
          ticketId: methodology.ticketId,
          title: methodology.title,
          scopeSummary: methodology.scopeSummary,
          sequenceOfWork: methodology.sequenceOfWork as Prisma.InputJsonValue,
          manpowerPlan: methodology.manpowerPlan as Prisma.InputJsonValue,
          toolsRequired: methodology.toolsRequired,
          materialsRequired: methodology.materialsRequired as Prisma.InputJsonValue,
          safetyPlan: methodology.safetyPlan,
          permitsRequired: methodology.permitsRequired,
          environmentalConsiderations: methodology.environmentalConsiderations,
          durationDays: methodology.durationDays,
          mobilizationPlan: methodology.mobilizationPlan,
          demobilizationPlan: methodology.demobilizationPlan,
          contingencyPlan: methodology.contingencyPlan,
          clientApprovalRequired: methodology.clientApprovalRequired,
          // The JSA is not carried across: it describes the method that was rejected, and a safety
          // analysis attached to a plan nobody is following any more is worse than none.
          preparedById: actor.actorId,
          status: "draft",
        },
      });
      revisionId = revision.id;
    }

    await writeAuditLog(tx, {
      actorId: actor.actorId,
      actorLabel: actor.actorLabel,
      action: input.decision === "approved" ? "client_approved" : "client_rejected",
      entityType: METHODOLOGY_ENTITY_TYPE,
      entityId: methodology.id,
      summary:
        input.decision === "approved"
          ? `Client approved ${methodology.number} R${methodology.revision}`
          : `Client rejected ${methodology.number} R${methodology.revision} — ${input.notes}`,
      diff: { status: { from: methodology.status, to } },
      ip: actor.ip,
      userAgent: actor.userAgent,
      requestId: actor.requestId,
    });

    return { revisionId };
  });

  return { status: to, revisionId: result.revisionId };
}

/**
 * §6.2's rare exception: this customer does not require method statement approval.
 *
 * "`clientApprovalRequired` defaults to `true` and the flag exists only so a rare exception can be
 * recorded, **not as a routine setting**." So it is a service call with a mandatory reason rather
 * than a checkbox on the form — the difference is that this leaves an audit row naming who decided
 * the client did not need to see it.
 */
export async function waiveClientApprovalService(
  actor: ActorMeta,
  input: { methodologyId: string; reason: string },
) {
  if (input.reason.trim().length < 10) {
    throw new TRPCError({
      code: "BAD_REQUEST",
      message:
        "Say why this customer does not require approval. §6.2 treats it as a rare exception, and " +
        "the reason is the whole record of it.",
    });
  }

  const methodology = await loadOne(input.methodologyId);

  await db.$transaction(async (tx) => {
    await tx.methodology.update({
      where: { id: methodology.id },
      data: {
        clientApprovalRequired: false,
        clientApprovalWaiver: input.reason.trim(),
        version: { increment: 1 },
      },
    });
    await writeAuditLog(tx, {
      actorId: actor.actorId,
      actorLabel: actor.actorLabel,
      action: "client_approval_waived",
      entityType: METHODOLOGY_ENTITY_TYPE,
      entityId: methodology.id,
      summary: `Waived client approval on ${methodology.number} — ${input.reason.trim()}`,
      ip: actor.ip,
      userAgent: actor.userAgent,
      requestId: actor.requestId,
    });
  });

  return { clientApprovalRequired: false as const };
}

// ---- the gate -----------------------------------------------------------------------------------

/** §6.2's gate for one ticket. §8's mobilization will call exactly this. */
export async function methodologyGateForTicket(ticketId: string) {
  const ticket = await db.ticket.findFirst({
    where: { id: ticketId, deletedAt: null },
    select: { id: true, number: true, projectId: true },
  });
  if (!ticket) {
    throw new TRPCError({ code: "NOT_FOUND", message: "That ticket no longer exists." });
  }

  // The newest live revision, on the ticket or on the project it rolls up to.
  const methodology = await db.methodology.findFirst({
    where: {
      deletedAt: null,
      status: { not: "superseded" },
      OR: [{ ticketId: ticket.id }, ...(ticket.projectId ? [{ projectId: ticket.projectId }] : [])],
    },
    orderBy: { revision: "desc" },
  });

  return {
    ...methodologyGate(methodology),
    methodology: methodology
      ? {
          id: methodology.id,
          number: methodology.number,
          revision: methodology.revision,
          status: methodology.status,
          turnaround: clientTurnaround(methodology),
        }
      : null,
  };
}

/** §19's `operations.override_methodology_gate` — president and VP only, and logged with a reason. */
export async function overrideMethodologyGateService(
  actor: ActorMeta,
  input: { ticketId: string; reason: string },
) {
  if (input.reason.trim().length < 10) {
    throw new TRPCError({
      code: "BAD_REQUEST",
      message: "An override needs a reason somebody can read months later.",
    });
  }

  const gate = await methodologyGateForTicket(input.ticketId);
  if (!gate.blocks) {
    throw new TRPCError({
      code: "BAD_REQUEST",
      message: "The method statement is not blocking this ticket, so there is nothing to override.",
    });
  }

  const ticket = await db.ticket.findFirstOrThrow({
    where: { id: input.ticketId },
    select: { id: true, number: true, status: true },
  });

  await db.$transaction(async (tx) => {
    await writeAuditLog(tx, {
      actorId: actor.actorId,
      actorLabel: actor.actorLabel,
      action: "methodology_gate_overridden",
      entityType: TICKET_ENTITY_TYPE,
      entityId: ticket.id,
      summary:
        `Cleared ${ticket.number} to mobilise without an approved method statement — ` +
        input.reason.trim(),
      ip: actor.ip,
      userAgent: actor.userAgent,
      requestId: actor.requestId,
    });
  });

  return { overridden: true as const };
}

// ---- reading ------------------------------------------------------------------------------------

export async function getMethodologyService(user: AuthedUser, methodologyId: string) {
  const methodology = await db.methodology.findFirst({
    where: { id: methodologyId, deletedAt: null },
    include: {
      project: { select: { id: true, code: true, name: true } },
      ticket: { select: { id: true, number: true, title: true } },
    },
  });
  if (!methodology) {
    throw new TRPCError({ code: "NOT_FOUND", message: "That method statement no longer exists." });
  }

  const rootId = methodology.parentMethodologyId ?? methodology.id;
  const chain = await db.methodology.findMany({
    where: { OR: [{ id: rootId }, { parentMethodologyId: rootId }], deletedAt: null },
    orderBy: { revision: "asc" },
    select: {
      id: true,
      revision: true,
      status: true,
      clientRejectionNotes: true,
      submittedToClientAt: true,
      clientApprovedAt: true,
    },
  });

  return {
    ...methodology,
    completeness: methodologyCompleteness(methodology),
    turnaround: clientTurnaround(methodology),
    editable: isMethodologyEditable(methodology.status),
    canApprove: user.permissions.has("methodology.approve"),
    materialSeed: materialRequestSeed(methodology),
    chain,
  };
}

export async function listMethodologiesService(
  filter: { projectId?: string; ticketId?: string; status?: string } = {},
) {
  return db.methodology.findMany({
    where: {
      deletedAt: null,
      ...(filter.projectId ? { projectId: filter.projectId } : {}),
      ...(filter.ticketId ? { ticketId: filter.ticketId } : {}),
      ...(filter.status ? { status: filter.status } : {}),
    },
    include: {
      project: { select: { id: true, code: true, name: true } },
      ticket: { select: { id: true, number: true, title: true } },
    },
    orderBy: [{ createdAt: "desc" }],
    take: 200,
  });
}

/**
 * §6.2's institutional library: what a new method statement could be cloned from.
 *
 * Only ones a client actually approved. A draft somebody abandoned is not a template, and cloning
 * from a rejected revision would propagate whatever the customer objected to.
 */
export async function listReusableMethodologiesService() {
  return db.methodology.findMany({
    where: { deletedAt: null, status: "client_approved" },
    select: {
      id: true,
      number: true,
      revision: true,
      title: true,
      durationDays: true,
      clientApprovedAt: true,
      project: { select: { code: true, name: true } },
    },
    orderBy: { clientApprovedAt: "desc" },
    take: 50,
  });
}

// ---- helpers ------------------------------------------------------------------------------------

async function loadOne(methodologyId: string) {
  const methodology = await db.methodology.findFirst({
    where: { id: methodologyId, deletedAt: null },
  });
  if (!methodology) {
    throw new TRPCError({ code: "NOT_FOUND", message: "That method statement no longer exists." });
  }
  return methodology;
}

async function loadEditable(methodologyId: string) {
  const methodology = await loadOne(methodologyId);
  if (!isMethodologyEditable(methodology.status)) {
    throw new TRPCError({
      code: "BAD_REQUEST",
      message:
        `${methodology.number} R${methodology.revision} is ${methodology.status.replace(/_/g, " ")}. ` +
        `Once it has left AIES a change is a revision, not an edit.`,
    });
  }
  return methodology;
}

function assertTransition(from: string, to: string, number: string) {
  if (!canTransition(from, to)) {
    throw new TRPCError({
      code: "BAD_REQUEST",
      message: `${number} is ${from.replace(/_/g, " ")} and cannot become ${to.replace(/_/g, " ")}.`,
    });
  }
}

async function move(
  actor: ActorMeta,
  methodology: { id: string; number: string; revision: number; status: string },
  to: string,
  summary: string,
) {
  await db.$transaction(async (tx) => {
    await tx.methodology.update({
      where: { id: methodology.id },
      data: { status: to, version: { increment: 1 } },
    });
    await writeAuditLog(tx, {
      actorId: actor.actorId,
      actorLabel: actor.actorLabel,
      action: to,
      entityType: METHODOLOGY_ENTITY_TYPE,
      entityId: methodology.id,
      summary,
      diff: { status: { from: methodology.status, to } },
      ip: actor.ip,
      userAgent: actor.userAgent,
      requestId: actor.requestId,
    });
  });
}

async function safeNotify(input: Parameters<typeof notify>[0]) {
  try {
    await notify(input);
  } catch {
    // A notification failure must never roll back the thing it announces.
  }
}
