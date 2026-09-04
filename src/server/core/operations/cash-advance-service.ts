import { TRPCError } from "@trpc/server";
import { Prisma } from "@prisma/client";
import { db } from "@/lib/db";
import { registerApprovalDecisionHandler } from "@/server/core/approvals/decision-registry";
import { decideApprovalRequest } from "@/server/core/approvals/service";
import { writeAuditLog } from "@/server/core/audit/audit";
import type { ActorMeta } from "@/server/core/crm/account-service";
import { emit } from "@/server/core/events/emit";
import { allocateNumber } from "@/server/core/numbering/numbering";
import { notify } from "@/server/core/notify/notify";
import type { AuthedUser } from "@/server/core/rbac/types";
import {
  CASH_ADVANCE_APPROVAL_RULE,
  CASH_ADVANCE_CATEGORIES,
  CASH_ADVANCE_DOCUMENT_TYPE,
  CASH_ADVANCE_ENTITY_TYPE,
  CASH_ADVANCE_EXTENSION_RULE,
  CA_REGISTER_PERMISSION,
  OUTSTANDING_STATUSES,
  RELEASE_METHODS,
  breakdownTotal,
  canRequestAdvance,
  cashAdvanceGate,
  isCashAdvanceEditable,
  liquidationDueFrom,
  liquidationStanding,
  liquidationTotals,
  pendingExtension,
  reconcile,
  type BreakdownLine,
  type CashAdvanceCategory,
  type ExtensionRecord,
  type LiquidationLine,
  type ReleaseMethod,
} from "./cash-advance-rules";
import {
  CASH_ADVANCE_APPROVAL_DECIDED_NOTIFICATION_TYPE,
  CASH_ADVANCE_EXTENSION_ENTITY_TYPE,
  CASH_ADVANCE_RELEASED_NOTIFICATION_TYPE,
  findPendingCashAdvanceApproval,
  notifyCashAdvanceApprovers,
  openCashAdvanceApproval,
} from "./cash-advance-approval";
import { TICKET_ENTITY_TYPE } from "./ticket-rules";

/**
 * Cash advances (specs/04-operations-projects.md §5).
 *
 * §5's opening sentence is the design brief: the constraint is "**currently invisible to everyone
 * until a technician can't board a bus**". Everything below exists to move the moment of discovery
 * earlier — a request with a breakdown, an approval with the shortest fallback window in the build,
 * a release that is a separate act from the approval, and a liquidation deadline counted on the
 * working calendar.
 *
 * ## Money
 *
 * Centavos as integers everywhere inside this file, converted to `Decimal` only at the database
 * boundary. Same rule as the rest of the build: a float cannot hold 0.1, and an advance reconciled
 * through one is wrong by an amount nobody can find later.
 */

export { CASH_ADVANCE_ENTITY_TYPE } from "./cash-advance-rules";

const money = (centavos: number) => new Prisma.Decimal(centavos).dividedBy(100);
const toCentavos = (value: Prisma.Decimal | null) =>
  value === null ? 0 : Math.round(Number(value) * 100);

// ---- reading ------------------------------------------------------------------------------------

/**
 * §1's Gate 1 for one ticket.
 *
 * Exported on its own because §8's mobilization will call exactly this, and because the ticket
 * screen shows the verdict today. One definition of "may this crew leave", used by both.
 */
export async function cashAdvanceGateForTicket(ticketId: string) {
  const ticket = await db.ticket.findFirst({
    where: { id: ticketId, deletedAt: null },
    select: {
      id: true,
      number: true,
      cashAdvanceRequired: true,
      cashAdvances: {
        where: { deletedAt: null },
        select: { id: true, number: true, status: true },
        orderBy: { createdAt: "asc" },
      },
    },
  });
  if (!ticket) {
    throw new TRPCError({ code: "NOT_FOUND", message: "That ticket no longer exists." });
  }

  return { ...cashAdvanceGate(ticket, ticket.cashAdvances), advances: ticket.cashAdvances };
}

export async function getCashAdvanceService(user: AuthedUser, cashAdvanceId: string) {
  const advance = await db.cashAdvance.findFirst({
    where: { id: cashAdvanceId, deletedAt: null },
    include: {
      ticket: { select: { id: true, number: true, title: true, status: true } },
      project: { select: { id: true, code: true, name: true } },
      liquidations: { orderBy: { submittedAt: "desc" } },
    },
  });
  if (!advance) {
    throw new TRPCError({ code: "NOT_FOUND", message: "That cash advance no longer exists." });
  }

  /**
   * §19: technicians "see scope, site data, and **their own cash advances**".
   *
   * Scoped by involvement plus one permission: the person who asked, anybody the advance covers,
   * and anybody holding `cash_advance.view_register`. A technician looking at a colleague's advance
   * sees somebody else's pay-adjacent paperwork, and there is no reason for it.
   *
   * `cash_advance.view_register` rather than `ticket.view_all` deliberately, and the two grant to
   * the same five roles today. The register permission is what the nav entry is gated on, and a
   * permission that only hides a menu item is not a control — anybody could type the URL. Gating
   * the *data* on the same key is what makes the menu entry honest.
   */
  const involved = advance.requestedById === user.id || advance.requestedFor.includes(user.id);
  if (!involved && !user.permissions.has(CA_REGISTER_PERMISSION)) {
    throw new TRPCError({
      code: "FORBIDDEN",
      message: "Cash advances are visible to the people they cover and to management.",
    });
  }

  const standing = liquidationStanding(advance, new Date());

  return {
    ...advance,
    amountRequested: advance.amountRequested.toString(),
    amountApproved: advance.amountApproved?.toString() ?? null,
    amountLiquidated: advance.amountLiquidated?.toString() ?? null,
    amountReturned: advance.amountReturned?.toString() ?? null,
    amountReimbursed: advance.amountReimbursed?.toString() ?? null,
    liquidations: advance.liquidations.map((liq) => ({
      ...liq,
      totalSpent: liq.totalSpent.toString(),
      balanceReturned: liq.balanceReturned.toString(),
      balanceReimbursable: liq.balanceReimbursable.toString(),
    })),
    standing,
    pendingExtension: pendingExtension(advance.extensions),
    editable: isCashAdvanceEditable(advance.status),
  };
}

export interface ListCashAdvancesFilter {
  /** outstanding | late | mine | all — the register's four useful questions. */
  scope?: "outstanding" | "late" | "mine" | "all";
  ticketId?: string;
}

/**
 * §5's register.
 *
 * The `late` scope is computed after the query rather than in it, and deliberately: "late" depends
 * on the newest *approved* extension inside a Json column, and expressing that in SQL would be a
 * second implementation of `liquidationStanding` that could disagree with the one on the screen.
 * The register is tens of rows, not millions.
 */
export async function listCashAdvancesService(
  user: AuthedUser,
  filter: ListCashAdvancesFilter = {},
) {
  const scope = filter.scope ?? "outstanding";
  const seesAll = user.permissions.has(CA_REGISTER_PERMISSION);

  const rows = await db.cashAdvance.findMany({
    where: {
      deletedAt: null,
      ...(filter.ticketId ? { ticketId: filter.ticketId } : {}),
      ...(scope === "outstanding" || scope === "late"
        ? { status: { in: [...OUTSTANDING_STATUSES] } }
        : {}),
      // Without the register permission you see your own, whatever scope you asked for.
      ...(scope === "mine" || !seesAll
        ? { OR: [{ requestedById: user.id }, { requestedFor: { has: user.id } }] }
        : {}),
    },
    include: {
      ticket: { select: { id: true, number: true, title: true } },
      project: { select: { id: true, code: true, name: true } },
    },
    orderBy: [{ liquidationDueAt: "asc" }, { createdAt: "desc" }],
    take: 300,
  });

  const now = new Date();
  const decorated = rows.map((row) => ({
    ...row,
    amountRequested: row.amountRequested.toString(),
    amountApproved: row.amountApproved?.toString() ?? null,
    standing: liquidationStanding(row, now),
  }));

  return scope === "late" ? decorated.filter((row) => row.standing.state === "late") : decorated;
}

/**
 * Whether this person may ask for another advance (§5), and why not.
 *
 * Asked by the screen before it shows the form, so the block is visible before somebody fills in a
 * breakdown — the request path checks it again, because a screen is not a control.
 */
export async function requestEligibilityService(userId: string) {
  const open = await db.cashAdvance.findMany({
    where: { deletedAt: null, requestedById: userId, status: { in: [...OUTSTANDING_STATUSES] } },
    select: { id: true, number: true, status: true, liquidationDueAt: true, extensions: true },
  });
  return canRequestAdvance(open, new Date());
}

// ---- requesting ---------------------------------------------------------------------------------

export interface RequestCashAdvanceInput {
  ticketId?: string | null;
  projectId?: string | null;
  requestedFor: string[];
  purpose: string;
  /** Amounts in centavos. */
  breakdown: BreakdownLine[];
  neededBy: Date;
  /** Submit straight to the VP rather than leaving a draft. */
  submit: boolean;
}

export async function requestCashAdvanceService(actor: ActorMeta, input: RequestCashAdvanceInput) {
  if (!input.ticketId && !input.projectId) {
    throw new TRPCError({
      code: "BAD_REQUEST",
      message:
        "An advance has to be against a ticket or a project — otherwise nothing can be costed to it.",
    });
  }

  const bad = input.breakdown.find(
    (line) => !CASH_ADVANCE_CATEGORIES.includes(line.category as CashAdvanceCategory),
  );
  if (bad) {
    throw new TRPCError({
      code: "BAD_REQUEST",
      message: `"${bad.category}" is not one of the eight cash advance categories.`,
    });
  }

  const total = breakdownTotal(input.breakdown);
  if (total <= 0) {
    throw new TRPCError({
      code: "BAD_REQUEST",
      message: "The breakdown comes to nothing. §5 wants what the money is for, line by line.",
    });
  }

  // §5's block, checked here and not only on the screen.
  const eligibility = await requestEligibilityService(actor.actorId);
  if (!eligibility.allowed) {
    throw new TRPCError({ code: "FORBIDDEN", message: eligibility.message });
  }

  const ticket = input.ticketId
    ? await db.ticket.findFirst({
        where: { id: input.ticketId, deletedAt: null },
        select: { id: true, number: true, title: true, status: true, cashAdvanceRequired: true },
      })
    : null;
  if (input.ticketId && !ticket) {
    throw new TRPCError({ code: "NOT_FOUND", message: "That ticket no longer exists." });
  }

  const number = await allocateNumber(CASH_ADVANCE_DOCUMENT_TYPE);

  const advance = await db.$transaction(async (tx) => {
    const created = await tx.cashAdvance.create({
      data: {
        number,
        ticketId: input.ticketId ?? null,
        projectId: input.projectId ?? null,
        requestedById: actor.actorId,
        requestedFor: input.requestedFor,
        purpose: input.purpose,
        breakdown: input.breakdown as unknown as Prisma.InputJsonValue,
        amountRequested: money(total),
        neededBy: input.neededBy,
        status: input.submit ? "pending_approval" : "draft",
      },
    });

    /**
     * §5: "If `cashAdvanceRequired` is true, the ticket status is `cash_advance_pending`."
     *
     * Requesting an advance against a ticket is itself the answer to §1's Y/N question, so the flag
     * is set here rather than requiring somebody to have ticked it first. Nobody raises an advance
     * for a job that does not need one, and a gate that only engages when a second box was ticked
     * is a gate that will be missed.
     */
    if (ticket && ticket.status === "generated") {
      await tx.ticket.update({
        where: { id: ticket.id },
        data: {
          cashAdvanceRequired: true,
          status: "cash_advance_pending",
          version: { increment: 1 },
        },
      });
    } else if (ticket && !ticket.cashAdvanceRequired) {
      await tx.ticket.update({
        where: { id: ticket.id },
        data: { cashAdvanceRequired: true, version: { increment: 1 } },
      });
    }

    await writeAuditLog(tx, {
      actorId: actor.actorId,
      actorLabel: actor.actorLabel,
      action: input.submit ? "requested" : "drafted",
      entityType: CASH_ADVANCE_ENTITY_TYPE,
      entityId: created.id,
      summary: `${input.submit ? "Requested" : "Drafted"} ${number} — PHP ${(total / 100).toFixed(2)} for ${input.purpose}`,
      ip: actor.ip,
      userAgent: actor.userAgent,
      requestId: actor.requestId,
    });

    if (input.submit) {
      await emit(
        tx,
        "cash_advance.requested",
        {
          cashAdvanceId: created.id,
          number,
          ticketId: input.ticketId ?? null,
          projectId: input.projectId ?? null,
          amount: total,
          neededBy: input.neededBy.toISOString(),
        },
        { actorId: actor.actorId },
      );
    }

    return created;
  });

  if (input.submit) {
    await openApproval(
      actor,
      advance.id,
      number,
      total,
      input.purpose,
      ticket?.number ?? null,
      input.neededBy,
    );
  }

  return { id: advance.id, number, status: advance.status };
}

/** Moves a draft to the Vice President. Separate path so a draft can be edited then submitted. */
export async function submitCashAdvanceService(actor: ActorMeta, cashAdvanceId: string) {
  const advance = await db.cashAdvance.findFirst({
    where: { id: cashAdvanceId, deletedAt: null },
    include: { ticket: { select: { number: true } } },
  });
  if (!advance) {
    throw new TRPCError({ code: "NOT_FOUND", message: "That cash advance no longer exists." });
  }
  if (advance.status !== "draft") {
    throw new TRPCError({
      code: "BAD_REQUEST",
      message: `${advance.number} is ${advance.status.replace(/_/g, " ")}, not a draft.`,
    });
  }
  if (advance.requestedById !== actor.actorId) {
    throw new TRPCError({
      code: "FORBIDDEN",
      message: "Only the person who raised an advance can submit it.",
    });
  }

  const eligibility = await requestEligibilityService(actor.actorId);
  if (!eligibility.allowed) {
    throw new TRPCError({ code: "FORBIDDEN", message: eligibility.message });
  }

  const total = toCentavos(advance.amountRequested);

  await db.$transaction(async (tx) => {
    await tx.cashAdvance.update({
      where: { id: advance.id },
      data: { status: "pending_approval", version: { increment: 1 } },
    });
    await writeAuditLog(tx, {
      actorId: actor.actorId,
      actorLabel: actor.actorLabel,
      action: "requested",
      entityType: CASH_ADVANCE_ENTITY_TYPE,
      entityId: advance.id,
      summary: `Submitted ${advance.number} for approval — PHP ${(total / 100).toFixed(2)}`,
      diff: { status: { from: "draft", to: "pending_approval" } },
      ip: actor.ip,
      userAgent: actor.userAgent,
      requestId: actor.requestId,
    });
    await emit(
      tx,
      "cash_advance.requested",
      {
        cashAdvanceId: advance.id,
        number: advance.number,
        ticketId: advance.ticketId,
        projectId: advance.projectId,
        amount: total,
        neededBy: advance.neededBy.toISOString(),
      },
      { actorId: actor.actorId },
    );
  });

  await openApproval(
    actor,
    advance.id,
    advance.number,
    total,
    advance.purpose,
    advance.ticket?.number ?? null,
    advance.neededBy,
  );

  return { status: "pending_approval" as const };
}

async function openApproval(
  actor: ActorMeta,
  cashAdvanceId: string,
  number: string,
  totalCentavos: number,
  purpose: string,
  ticketNumber: string | null,
  neededBy: Date,
) {
  const request = await openCashAdvanceApproval({
    kind: "advance",
    cashAdvanceId,
    requestedById: actor.actorId,
    snapshot: {
      number,
      amount: totalCentavos / 100,
      currency: "PHP",
      purpose,
      ticket: ticketNumber,
      neededBy: neededBy.toISOString(),
      requestedBy: actor.actorLabel,
    },
  });

  await notifyCashAdvanceApprovers(
    request,
    CASH_ADVANCE_APPROVAL_RULE,
    `${number} needs your approval — PHP ${(totalCentavos / 100).toFixed(2)}`,
    // The needed-by date is in the notification body on purpose. §5's four-hour window exists
    // "because a crew is standing by", and the approver should be able to see the urgency without
    // opening the record.
    `${actor.actorLabel} needs this by ${neededBy.toISOString().slice(0, 10)}${ticketNumber ? ` for ${ticketNumber}` : ""} — ${purpose}`,
  );

  return request;
}

/**
 * Writes a decision onto the advance itself: status, approved amount, reason, audit row.
 *
 * Shared by the normal path and by the repair branch above, because "what an approval does to a
 * cash advance" must have exactly one definition. Two copies would drift, and the copy that drifted
 * would be the one nobody reads — the repair path, which by definition only runs when something has
 * already gone wrong.
 */
async function applyRecordedDecision(
  actor: ActorMeta,
  advance: {
    id: string;
    number: string;
    status: string;
    amountRequested: Prisma.Decimal;
    requestedById: string;
  },
  decision: "approved" | "rejected",
  meta: { decidedById: string | null; comment: string | null },
) {
  const approvedAmount = advance.amountRequested;

  await db.$transaction(async (tx) => {
    await tx.cashAdvance.update({
      where: { id: advance.id },
      data: {
        status: decision,
        approvedById: meta.decidedById ?? actor.actorId,
        approvedAt: new Date(),
        amountApproved: decision === "approved" ? approvedAmount : null,
        rejectionReason: decision === "rejected" ? meta.comment : null,
        version: { increment: 1 },
      },
    });

    await writeAuditLog(tx, {
      actorId: actor.actorId,
      actorLabel: actor.actorLabel,
      action: decision === "approved" ? "approved" : "rejected",
      entityType: CASH_ADVANCE_ENTITY_TYPE,
      entityId: advance.id,
      summary:
        `Applied the decision already recorded against ${advance.number}: ` +
        `${decision}. The approval was decided earlier and the advance had not caught up.`,
      diff: { status: { from: advance.status, to: decision } },
      ip: actor.ip,
      userAgent: actor.userAgent,
      requestId: actor.requestId,
    });
  });

  await safeNotify({
    recipientId: advance.requestedById,
    type: CASH_ADVANCE_APPROVAL_DECIDED_NOTIFICATION_TYPE,
    title:
      decision === "approved"
        ? `${advance.number} approved — waiting on release`
        : `${advance.number} was sent back`,
    body:
      decision === "approved"
        ? "The money still has to be released before anyone mobilizes."
        : (meta.comment ?? ""),
    entityType: CASH_ADVANCE_ENTITY_TYPE,
    entityId: advance.id,
  });

  return { status: decision };
}

// ---- PD's / DJ's endorsement ---------------------------------------------------------------------

/**
 * PD's or DJ's endorsement (docs/DECISIONS.md #175, EA's own correction to #151).
 *
 * Deliberately not a step in the `ApprovalRequest`/`ApprovalWorkflow` engine below: that engine
 * treats one entity as having exactly one open request with one decision, and this codebase has
 * already been bitten once by folding two different facts into one commit (AIESCA-260127, see
 * `applyRecordedDecision`'s doc comment). Endorsement is a second, independent fact about the
 * advance — a plain status stamp — that never touches the `ApprovalRequest` the Vice President's
 * own decision still runs through unmodified.
 *
 * Optional, not a gate: the Vice President or President can still decide straight from
 * `pending_approval`, exactly as before this existed. Endorsing only adds a second valid starting
 * state and a heads-up to whoever decides next — it does not block them and it does not release
 * anything (`releaseCashAdvanceService` still requires `approved`).
 */
export async function endorseCashAdvanceService(actor: ActorMeta, cashAdvanceId: string) {
  const advance = await db.cashAdvance.findFirst({
    where: { id: cashAdvanceId, deletedAt: null },
  });
  if (!advance) {
    throw new TRPCError({ code: "NOT_FOUND", message: "That cash advance no longer exists." });
  }
  if (advance.status !== "pending_approval") {
    throw new TRPCError({
      code: "BAD_REQUEST",
      message: `${advance.number} is ${advance.status.replace(/_/g, " ")}, so there is nothing to endorse.`,
    });
  }

  await db.$transaction(async (tx) => {
    await tx.cashAdvance.update({
      where: { id: advance.id },
      data: {
        status: "endorsed",
        endorsedById: actor.actorId,
        endorsedAt: new Date(),
        version: { increment: 1 },
      },
    });

    await writeAuditLog(tx, {
      actorId: actor.actorId,
      actorLabel: actor.actorLabel,
      action: "endorsed",
      entityType: CASH_ADVANCE_ENTITY_TYPE,
      entityId: advance.id,
      summary: `Endorsed ${advance.number} — PHP ${advance.amountRequested.toString()}. Still needs the Vice President's approval.`,
      diff: { status: { from: "pending_approval", to: "endorsed" } },
      ip: actor.ip,
      userAgent: actor.userAgent,
      requestId: actor.requestId,
    });
  });

  const request = await findPendingCashAdvanceApproval(advance.id, "advance");
  if (request) {
    await notifyCashAdvanceApprovers(
      request,
      CASH_ADVANCE_APPROVAL_RULE,
      `${advance.number} was endorsed by ${actor.actorLabel} — still needs your approval`,
      `${actor.actorLabel} endorsed this cash advance ahead of you. It cannot be released until you decide it.`,
    );
  }

  return { status: "endorsed" as const };
}

// ---- the Vice President's decision --------------------------------------------------------------

export async function decideCashAdvanceService(
  actor: ActorMeta,
  user: AuthedUser,
  input: { cashAdvanceId: string; decision: "approved" | "rejected"; reason?: string },
) {
  const advance = await db.cashAdvance.findFirst({
    where: { id: input.cashAdvanceId, deletedAt: null },
  });
  if (!advance) {
    throw new TRPCError({ code: "NOT_FOUND", message: "That cash advance no longer exists." });
  }
  // `endorsed` is a valid starting state too (docs/DECISIONS.md #175) — PD's or DJ's endorsement
  // never blocks the Vice President's or President's own decision, it only precedes it optionally.
  if (advance.status !== "pending_approval" && advance.status !== "endorsed") {
    throw new TRPCError({
      code: "BAD_REQUEST",
      message: `${advance.number} is ${advance.status.replace(/_/g, " ")}, so there is nothing to decide.`,
    });
  }
  if (input.decision === "rejected" && !input.reason?.trim()) {
    throw new TRPCError({
      code: "BAD_REQUEST",
      message:
        "Say why. A declined advance without a reason is a crew that cannot fix the request.",
    });
  }

  const request = await findPendingCashAdvanceApproval(advance.id, "advance");

  /**
   * The advance says "waiting", the engine says "decided". Apply the decision that already exists.
   *
   * ## What happened to AIESCA-260127
   *
   * Its approval request was approved at 14:35:47 and the advance stayed `pending_approval`. The
   * engine's decision and the advance's own update were two separate commits in one request, and
   * only the first landed. Every retry then hit "has no open approval request" — because the
   * request was no longer pending — and re-submitting was refused because the advance was no longer
   * a draft. A record with a decision recorded against it and no way to act on that decision.
   *
   * The two commits are now one (below), so this cannot happen again. This branch is for the rows
   * where it already did: rather than a repair script somebody has to know exists, the screen heals
   * it the next time anybody presses the button.
   *
   * **It applies the recorded decision, it does not make a new one.** Whatever the approver decided
   * is what happens — the person pressing the button now is completing an act, not performing one,
   * and the audit trail says so.
   */
  if (!request) {
    const decided = await db.approvalRequest.findFirst({
      where: {
        entityType: CASH_ADVANCE_ENTITY_TYPE,
        entityId: advance.id,
        status: { in: ["approved", "rejected"] },
      },
      orderBy: { decidedAt: "desc" },
    });

    if (!decided) {
      throw new TRPCError({
        code: "BAD_REQUEST",
        message: `${advance.number} has no open approval request.`,
      });
    }

    const action = await db.approvalAction.findFirst({
      where: { requestId: decided.id },
      orderBy: { at: "desc" },
    });
    return applyRecordedDecision(actor, advance, decided.status as "approved" | "rejected", {
      decidedById: action?.approverId ?? null,
      comment: action?.comment ?? null,
    });
  }

  const approvedAmount = advance.amountRequested;

  /**
   * The engine's decision and the advance's own update, in **one** transaction.
   *
   * They used to be two, in this order, with the engine committing first. AIESCA-260127 landed in
   * the gap between them: request approved, advance still `pending_approval`, and no screen able to
   * finish the job. Whatever interrupted it — a timeout, a dropped connection — the shape of the
   * bug was that one decision needed two commits to be true.
   *
   * Eligibility, including whether the 4-hour fallback has put this in the President's hands, still
   * lives in the engine. Deciding it a second time here is how two answers drift apart.
   */
  await db.$transaction(async (tx) => {
    try {
      await decideApprovalRequest({
        requestId: request.id,
        approver: user,
        decision: input.decision,
        comment: input.reason,
        tx,
      });
    } catch (error) {
      throw new TRPCError({
        code: "FORBIDDEN",
        message: error instanceof Error ? error.message : "You cannot decide this approval.",
      });
    }

    await tx.cashAdvance.update({
      where: { id: advance.id },
      data: {
        status: input.decision === "approved" ? "approved" : "rejected",
        approvedById: actor.actorId,
        approvedAt: new Date(),
        // §5 has no partial-approval flow — the VP approves the advance or sends it back. Recorded
        // anyway, because what was approved must not be inferred from a request that could later
        // be edited.
        amountApproved: input.decision === "approved" ? approvedAmount : null,
        rejectionReason: input.decision === "rejected" ? (input.reason ?? null) : null,
        version: { increment: 1 },
      },
    });

    await writeAuditLog(tx, {
      actorId: actor.actorId,
      actorLabel: actor.actorLabel,
      action: input.decision === "approved" ? "approved" : "rejected",
      entityType: CASH_ADVANCE_ENTITY_TYPE,
      entityId: advance.id,
      summary:
        input.decision === "approved"
          ? `Approved ${advance.number} — PHP ${approvedAmount.toString()}`
          : `Declined ${advance.number} — ${input.reason}`,
      diff: { status: { from: advance.status, to: input.decision } },
      ip: actor.ip,
      userAgent: actor.userAgent,
      requestId: actor.requestId,
    });
  });

  await safeNotify({
    recipientId: advance.requestedById,
    type: CASH_ADVANCE_APPROVAL_DECIDED_NOTIFICATION_TYPE,
    title:
      input.decision === "approved"
        ? `${advance.number} approved — waiting on release`
        : `${advance.number} was sent back`,
    body:
      input.decision === "approved"
        ? "Approved by " +
          actor.actorLabel +
          ". The money still has to be released before anyone mobilizes."
        : (input.reason ?? ""),
    entityType: CASH_ADVANCE_ENTITY_TYPE,
    entityId: advance.id,
  });

  return { status: input.decision };
}

// ---- release ------------------------------------------------------------------------------------

export interface ReleaseCashAdvanceInput {
  cashAdvanceId: string;
  method: ReleaseMethod;
  /** Centavos. Defaults to the approved amount — a short release is recorded, not silently ignored. */
  amountCentavos?: number;
  /**
   * When the crew is expected off site, which starts §5's three working days.
   *
   * Optional: falls back to the ticket's required-by date, then to today. §8's demobilization will
   * overwrite whatever is derived here with the real date.
   */
  expectedDemobilisation?: Date;
}

/**
 * Hands over the money (§5).
 *
 * A separate act from approval, and the gate reads *this* rather than the approval — see
 * `cashAdvanceGate`. §5's complaint is about the gap between a decision and cash in a pocket, and
 * collapsing the two would remove the only place that gap is visible.
 */
export async function releaseCashAdvanceService(actor: ActorMeta, input: ReleaseCashAdvanceInput) {
  if (!RELEASE_METHODS.includes(input.method)) {
    throw new TRPCError({
      code: "BAD_REQUEST",
      message: `Unknown release method "${input.method}".`,
    });
  }

  const advance = await db.cashAdvance.findFirst({
    where: { id: input.cashAdvanceId, deletedAt: null },
    include: { ticket: { select: { id: true, number: true, requiredByDate: true, status: true } } },
  });
  if (!advance) {
    throw new TRPCError({ code: "NOT_FOUND", message: "That cash advance no longer exists." });
  }
  if (advance.status !== "approved") {
    throw new TRPCError({
      code: "BAD_REQUEST",
      message: `${advance.number} is ${advance.status.replace(/_/g, " ")}. Only an approved advance can be released.`,
    });
  }

  const released =
    input.amountCentavos ?? toCentavos(advance.amountApproved ?? advance.amountRequested);
  if (released <= 0) {
    throw new TRPCError({ code: "BAD_REQUEST", message: "Nothing to release." });
  }

  /**
   * §5's deadline, from the best date available today.
   *
   * Demobilization is §8's. Until it exists the ticket's required-by date is the closest honest
   * proxy for when the crew comes off site; with no ticket and no date, the release date itself is
   * used. `liquidationDueFrom` is the single definition of "3 working days", and §8 calls it again
   * with the actual timestamp — so this is a provisional deadline, not a competing rule.
   */
  const now = new Date();
  const basis = input.expectedDemobilisation ?? advance.ticket?.requiredByDate ?? now;
  const dueAt = liquidationDueFrom(basis);

  await db.$transaction(async (tx) => {
    await tx.cashAdvance.update({
      where: { id: advance.id },
      data: {
        status: "released",
        releasedById: actor.actorId,
        releasedAt: now,
        releaseMethod: input.method,
        amountApproved: money(released),
        liquidationDueAt: dueAt,
        version: { increment: 1 },
      },
    });

    // The gate is now satisfied, so the ticket stops waiting on it. `ready_to_mobilize` rather than
    // `mobilized`: §8 owns actually sending anybody, and §7's material gate may still be shut.
    if (advance.ticket && advance.ticket.status === "cash_advance_pending") {
      await tx.ticket.update({
        where: { id: advance.ticket.id },
        data: { status: "ready_to_mobilize", version: { increment: 1 } },
      });
    }

    await writeAuditLog(tx, {
      actorId: actor.actorId,
      actorLabel: actor.actorLabel,
      action: "released",
      entityType: CASH_ADVANCE_ENTITY_TYPE,
      entityId: advance.id,
      summary: `Released ${advance.number} — PHP ${(released / 100).toFixed(2)} by ${input.method.replace(/_/g, " ")}; liquidation due ${dueAt.toISOString().slice(0, 10)}`,
      ip: actor.ip,
      userAgent: actor.userAgent,
      requestId: actor.requestId,
    });

    await emit(
      tx,
      "cash_advance.released",
      {
        cashAdvanceId: advance.id,
        number: advance.number,
        ticketId: advance.ticketId,
        projectId: advance.projectId,
        amount: released,
        method: input.method,
        liquidationDueAt: dueAt.toISOString(),
      },
      { actorId: actor.actorId },
    );
  });

  for (const recipient of new Set([advance.requestedById, ...advance.requestedFor])) {
    await safeNotify({
      recipientId: recipient,
      type: CASH_ADVANCE_RELEASED_NOTIFICATION_TYPE,
      title: `${advance.number} released — PHP ${(released / 100).toFixed(2)}`,
      body: `By ${input.method.replace(/_/g, " ")}. Liquidation is due ${dueAt.toISOString().slice(0, 10)} — 3 working days after the job ends.`,
      entityType: CASH_ADVANCE_ENTITY_TYPE,
      entityId: advance.id,
    });
  }

  return { status: "released" as const, liquidationDueAt: dueAt };
}

// ---- liquidation --------------------------------------------------------------------------------

export interface LiquidateInput {
  cashAdvanceId: string;
  lines: LiquidationLine[];
  /**
   * Cash handed back with these receipts, in centavos.
   *
   * A recorded fact rather than `released − spent`: see `reconcile` in cash-advance-rules.ts for
   * why the difference matters. Until this is recorded, unspent money is still in somebody's
   * pocket, and the advance is not settled.
   */
  amountReturnedCentavos?: number;
  remarks?: string;
}

/**
 * Files receipts against an advance (§5).
 *
 * Every submission is its own `CashAdvanceLiquidation` row rather than an update of one, because
 * §5 gives liquidation a review cycle and a rejected liquidation is resubmitted. Two attempts are
 * two records, and the finance officer needs to be able to see the first one.
 */
export async function liquidateCashAdvanceService(actor: ActorMeta, input: LiquidateInput) {
  const advance = await db.cashAdvance.findFirst({
    where: { id: input.cashAdvanceId, deletedAt: null },
    include: { liquidations: { where: { status: { not: "rejected" } } } },
  });
  if (!advance) {
    throw new TRPCError({ code: "NOT_FOUND", message: "That cash advance no longer exists." });
  }
  if (!OUTSTANDING_STATUSES.includes(advance.status as (typeof OUTSTANDING_STATUSES)[number])) {
    throw new TRPCError({
      code: "BAD_REQUEST",
      message: `${advance.number} is ${advance.status.replace(/_/g, " ")}, so there is nothing to liquidate.`,
    });
  }
  if (input.lines.length === 0) {
    throw new TRPCError({ code: "BAD_REQUEST", message: "A liquidation needs at least one line." });
  }
  // The person who took the money accounts for it. Finance reviews the result; it does not file it
  // on somebody's behalf, because a liquidation is an assertion about what that person spent.
  if (advance.requestedById !== actor.actorId && !advance.requestedFor.includes(actor.actorId)) {
    throw new TRPCError({
      code: "FORBIDDEN",
      message: `${advance.number} is not yours to liquidate.`,
    });
  }

  const badCategory = input.lines.find(
    (line) => !CASH_ADVANCE_CATEGORIES.includes(line.category as CashAdvanceCategory),
  );
  if (badCategory) {
    throw new TRPCError({
      code: "BAD_REQUEST",
      message: `"${badCategory.category}" is not one of the eight cash advance categories.`,
    });
  }

  const releasedTotal = toCentavos(advance.amountApproved);
  const totals = liquidationTotals(input.lines);
  const returnedNow = Math.max(0, Math.round(input.amountReturnedCentavos ?? 0));

  // Everything filed before this submission, so the advance reconciles as a whole rather than each
  // submission reconciling against itself — otherwise two half-liquidations would each look like a
  // large refund due.
  const priorSpent = advance.liquidations.reduce((sum, liq) => sum + toCentavos(liq.totalSpent), 0);
  const priorReturned = advance.liquidations.reduce(
    (sum, liq) => sum + toCentavos(liq.balanceReturned),
    0,
  );

  const cumulativeSpent = priorSpent + totals.totalSpent;
  const cumulativeReturned = priorReturned + returnedNow;
  const result = reconcile({
    amountReleased: releasedTotal,
    totalSpent: cumulativeSpent,
    amountReturned: cumulativeReturned,
  });

  if (cumulativeReturned > releasedTotal) {
    throw new TRPCError({
      code: "BAD_REQUEST",
      message: `More cash has been handed back than was released against ${advance.number}.`,
    });
  }

  const liquidation = await db.$transaction(async (tx) => {
    const created = await tx.cashAdvanceLiquidation.create({
      data: {
        cashAdvanceId: advance.id,
        submittedById: actor.actorId,
        lines: input.lines as unknown as Prisma.InputJsonValue,
        totalSpent: money(totals.totalSpent),
        balanceReturned: money(returnedNow),
        // The reimbursement is a property of the advance as a whole, so it is recorded cumulatively
        // rather than per submission — the company owes one amount, not one per envelope.
        balanceReimbursable: money(result.balanceReimbursable),
        status: "submitted",
        remarks: input.remarks ?? null,
      },
    });

    await tx.cashAdvance.update({
      where: { id: advance.id },
      data: {
        /**
         * Settled by the numbers is not settled by finance.
         *
         * §5 gives the liquidation a review cycle, and the reason is physical: a BIR official
         * receipt is what makes a cost deductible, and the app cannot see a piece of paper. So the
         * advance sits at `pending_settlement` until somebody has checked the documents against
         * what was filed here. `liquidatedAt` is set by that review, not by this.
         */
        status: result.settled ? "pending_settlement" : "partially_liquidated",
        amountLiquidated: money(cumulativeSpent),
        amountReturned: money(cumulativeReturned),
        amountReimbursed: money(result.balanceReimbursable),
        version: { increment: 1 },
      },
    });

    await writeAuditLog(tx, {
      actorId: actor.actorId,
      actorLabel: actor.actorLabel,
      action: result.settled ? "liquidated" : "partially_liquidated",
      entityType: CASH_ADVANCE_ENTITY_TYPE,
      entityId: advance.id,
      summary:
        `Liquidated PHP ${(totals.totalSpent / 100).toFixed(2)} against ${advance.number}` +
        (returnedNow > 0 ? `, PHP ${(returnedNow / 100).toFixed(2)} returned` : "") +
        (result.settled
          ? result.balanceReimbursable > 0
            ? ` — settled; PHP ${(result.balanceReimbursable / 100).toFixed(2)} reimbursable`
            : " — settled"
          : ` — PHP ${(result.unaccounted / 100).toFixed(2)} still unaccounted for`) +
        (totals.withoutOfficialReceipt > 0
          ? `; ${totals.withoutOfficialReceipt} line(s) with no official receipt`
          : ""),
      ip: actor.ip,
      userAgent: actor.userAgent,
      requestId: actor.requestId,
    });

    return created;
  });

  return {
    id: liquidation.id,
    settled: result.settled,
    totalSpent: totals.totalSpent,
    unaccounted: result.unaccounted,
    balanceReturned: cumulativeReturned,
    balanceReimbursable: result.balanceReimbursable,
    withoutOfficialReceipt: totals.withoutOfficialReceipt,
  };
}

// ---- extensions ---------------------------------------------------------------------------------

/**
 * Asks the Vice President for more time (§5).
 *
 * §5: "Extensions are approved by the Vice President and may be indefinite. Build it as a request →
 * approve record carrying a reason and a new due date — **never a silent edit of the deadline**."
 *
 * So this appends a row with no `approvedAt`, which `liquidationStanding` deliberately ignores when
 * working out the deadline in force. Filing the request does not move anything; the approval does.
 */
export async function requestExtensionService(
  actor: ActorMeta,
  input: { cashAdvanceId: string; reason: string; newDueAt: Date },
) {
  const advance = await db.cashAdvance.findFirst({
    where: { id: input.cashAdvanceId, deletedAt: null },
  });
  if (!advance) {
    throw new TRPCError({ code: "NOT_FOUND", message: "That cash advance no longer exists." });
  }
  if (!OUTSTANDING_STATUSES.includes(advance.status as (typeof OUTSTANDING_STATUSES)[number])) {
    throw new TRPCError({
      code: "BAD_REQUEST",
      message: `${advance.number} is ${advance.status.replace(/_/g, " ")}, so there is no deadline to extend.`,
    });
  }
  if (input.reason.trim().length < 10) {
    throw new TRPCError({
      code: "BAD_REQUEST",
      message:
        "Give a real reason. §5 keeps the reason on the record precisely so an extension is not an unexplained postponement.",
    });
  }
  if (pendingExtension(advance.extensions)) {
    throw new TRPCError({
      code: "BAD_REQUEST",
      message: "There is already an extension request on this advance waiting for a decision.",
    });
  }

  const standing = liquidationStanding(advance, new Date());
  if (standing.dueAt && input.newDueAt.getTime() <= standing.dueAt.getTime()) {
    throw new TRPCError({
      code: "BAD_REQUEST",
      message: `The new date has to be after the deadline in force (${standing.dueAt.toISOString().slice(0, 10)}).`,
    });
  }

  const record: ExtensionRecord = {
    requestedAt: new Date().toISOString(),
    requestedById: actor.actorId,
    reason: input.reason.trim(),
    newDueAt: input.newDueAt.toISOString(),
    approvedById: null,
    approvedAt: null,
  };
  const extensions = [...asArray(advance.extensions), record];

  await db.$transaction(async (tx) => {
    await tx.cashAdvance.update({
      where: { id: advance.id },
      data: {
        extensions: extensions as unknown as Prisma.InputJsonValue,
        version: { increment: 1 },
      },
    });
    await writeAuditLog(tx, {
      actorId: actor.actorId,
      actorLabel: actor.actorLabel,
      action: "extension_requested",
      entityType: CASH_ADVANCE_ENTITY_TYPE,
      entityId: advance.id,
      summary: `Asked to move ${advance.number}'s liquidation deadline to ${input.newDueAt.toISOString().slice(0, 10)} — ${record.reason}`,
      ip: actor.ip,
      userAgent: actor.userAgent,
      requestId: actor.requestId,
    });
  });

  const request = await openCashAdvanceApproval({
    kind: "extension",
    cashAdvanceId: advance.id,
    requestedById: actor.actorId,
    snapshot: {
      number: advance.number,
      currentDueAt: standing.dueAt?.toISOString() ?? null,
      newDueAt: input.newDueAt.toISOString(),
      reason: record.reason,
      requestedBy: actor.actorLabel,
    },
  });

  await notifyCashAdvanceApprovers(
    request,
    CASH_ADVANCE_EXTENSION_RULE,
    `${advance.number} — extension requested to ${input.newDueAt.toISOString().slice(0, 10)}`,
    `${actor.actorLabel}: ${record.reason}`,
  );

  return { requested: true as const, newDueAt: input.newDueAt };
}

export async function decideExtensionService(
  actor: ActorMeta,
  user: AuthedUser,
  input: { cashAdvanceId: string; decision: "approved" | "rejected"; comment?: string },
) {
  const advance = await db.cashAdvance.findFirst({
    where: { id: input.cashAdvanceId, deletedAt: null },
  });
  if (!advance) {
    throw new TRPCError({ code: "NOT_FOUND", message: "That cash advance no longer exists." });
  }

  const pending = pendingExtension(advance.extensions);
  if (!pending) {
    throw new TRPCError({
      code: "BAD_REQUEST",
      message: `${advance.number} has no extension request waiting.`,
    });
  }

  const request = await findPendingCashAdvanceApproval(advance.id, "extension");
  if (!request) {
    throw new TRPCError({
      code: "BAD_REQUEST",
      message: `${advance.number}'s extension has no open approval request.`,
    });
  }

  try {
    await decideApprovalRequest({
      requestId: request.id,
      approver: user,
      decision: input.decision,
      comment: input.comment,
    });
  } catch (error) {
    throw new TRPCError({
      code: "FORBIDDEN",
      message: error instanceof Error ? error.message : "You cannot decide this approval.",
    });
  }

  const rows = asArray(advance.extensions);
  const updated = rows.map((row) =>
    row === pending || (isRecord(row) && row.requestedAt === pending.requestedAt)
      ? input.decision === "approved"
        ? { ...pending, approvedById: actor.actorId, approvedAt: new Date().toISOString() }
        : // A declined request stays on the record with a marker rather than disappearing. Somebody
          // asked for more time and was told no, and that is exactly the history a chase-up needs.
          { ...pending, approvedById: null, approvedAt: null, declinedAt: new Date().toISOString() }
      : row,
  );

  await db.$transaction(async (tx) => {
    await tx.cashAdvance.update({
      where: { id: advance.id },
      data: {
        extensions: updated as unknown as Prisma.InputJsonValue,
        // `extended` is a status of its own so the register can count extensions without parsing
        // Json — §5 asks that extensions be "visible and counted".
        ...(input.decision === "approved" && advance.status !== "liquidated"
          ? { status: "extended" }
          : {}),
        version: { increment: 1 },
      },
    });
    await writeAuditLog(tx, {
      actorId: actor.actorId,
      actorLabel: actor.actorLabel,
      action: input.decision === "approved" ? "extension_approved" : "extension_declined",
      entityType: CASH_ADVANCE_ENTITY_TYPE,
      entityId: advance.id,
      summary:
        input.decision === "approved"
          ? `Extended ${advance.number}'s liquidation deadline to ${pending.newDueAt.slice(0, 10)} — ${pending.reason}`
          : `Declined the extension on ${advance.number}${input.comment ? ` — ${input.comment}` : ""}`,
      ip: actor.ip,
      userAgent: actor.userAgent,
      requestId: actor.requestId,
    });
  });

  await safeNotify({
    recipientId: advance.requestedById,
    type: CASH_ADVANCE_APPROVAL_DECIDED_NOTIFICATION_TYPE,
    title:
      input.decision === "approved"
        ? `${advance.number} — extension approved to ${pending.newDueAt.slice(0, 10)}`
        : `${advance.number} — extension declined`,
    body: input.comment ?? "",
    entityType: CASH_ADVANCE_ENTITY_TYPE,
    entityId: advance.id,
  });

  return { decision: input.decision };
}

// ---- the nightly sweep --------------------------------------------------------------------------

/**
 * Marks overdue liquidations and tells people (§5, §18's `cash_advance.liquidation_overdue`).
 *
 * Runs on the nightly cron. The status is written as well as computed, so that `canRequestAdvance`
 * and the register agree with a plain database query — a finance officer running SQL should not get
 * a different answer from the screen.
 *
 * Deliberately **idempotent and quiet on repeat**: only advances not already `overdue_liquidation`
 * produce an event and a notification, so a nightly job does not send the same person the same
 * message for a fortnight.
 */
export async function sweepOverdueLiquidationsService(now = new Date()) {
  const candidates = await db.cashAdvance.findMany({
    where: {
      deletedAt: null,
      status: { in: ["released", "partially_liquidated", "extended"] },
      liquidationDueAt: { not: null },
    },
    select: {
      id: true,
      number: true,
      status: true,
      requestedById: true,
      liquidationDueAt: true,
      extensions: true,
      amountApproved: true,
    },
  });

  let marked = 0;

  for (const advance of candidates) {
    const standing = liquidationStanding(advance, now);
    if (standing.state !== "late") continue;

    await db.$transaction(async (tx) => {
      await tx.cashAdvance.update({
        where: { id: advance.id },
        data: { status: "overdue_liquidation", version: { increment: 1 } },
      });
      await emit(tx, "cash_advance.liquidation_overdue", {
        cashAdvanceId: advance.id,
        number: advance.number,
        requestedById: advance.requestedById,
        daysOverdue: standing.daysOverdue,
        amount: toCentavos(advance.amountApproved),
      });
    });

    await safeNotify({
      recipientId: advance.requestedById,
      type: "cash_advance.liquidation_due",
      title: `${advance.number} liquidation is ${standing.daysOverdue} day(s) overdue`,
      body: "Until this is liquidated or formally extended, you cannot request another advance.",
      entityType: CASH_ADVANCE_ENTITY_TYPE,
      entityId: advance.id,
    });

    marked += 1;
  }

  return { checked: candidates.length, marked };
}

// ---- §19's override -----------------------------------------------------------------------------

/**
 * Records a decision to mobilize past a shut gate (§19's `operations.override_ca_gate`).
 *
 * There is no `mobilize` to call yet — §8 owns it — so this writes the justification and nothing
 * else. That is the useful half: the override is only worth having if the reason survives, and the
 * audit row is what an officer reads afterwards. §8 will check for it before letting a crew leave.
 */
export async function overrideCashAdvanceGateService(
  actor: ActorMeta,
  input: { ticketId: string; reason: string },
) {
  if (input.reason.trim().length < 10) {
    throw new TRPCError({
      code: "BAD_REQUEST",
      message: "An override needs a reason somebody can read months later.",
    });
  }

  const gate = await cashAdvanceGateForTicket(input.ticketId);
  if (!gate.blocks) {
    throw new TRPCError({
      code: "BAD_REQUEST",
      message: "Nothing is blocking this ticket, so there is nothing to override.",
    });
  }

  const ticket = await db.ticket.findFirstOrThrow({
    where: { id: input.ticketId },
    select: { id: true, number: true, status: true },
  });

  await db.$transaction(async (tx) => {
    await tx.ticket.update({
      where: { id: ticket.id },
      data: { status: "ready_to_mobilize", version: { increment: 1 } },
    });
    await writeAuditLog(tx, {
      actorId: actor.actorId,
      actorLabel: actor.actorLabel,
      action: "cash_advance_gate_overridden",
      entityType: TICKET_ENTITY_TYPE,
      entityId: ticket.id,
      summary: `Cleared ${ticket.number} to mobilize without a released cash advance — ${input.reason.trim()}`,
      diff: { status: { from: ticket.status, to: "ready_to_mobilize" } },
      ip: actor.ip,
      userAgent: actor.userAgent,
      requestId: actor.requestId,
    });
  });

  return { status: "ready_to_mobilize" as const };
}

// ---- helpers ------------------------------------------------------------------------------------

function asArray(raw: unknown): ExtensionRecord[] {
  return Array.isArray(raw) ? (raw as ExtensionRecord[]) : [];
}

function isRecord(value: unknown): value is ExtensionRecord {
  return typeof value === "object" && value !== null && "requestedAt" in value;
}

/** Notifications must never roll back the thing they announce. */
async function safeNotify(input: Parameters<typeof notify>[0]) {
  try {
    await notify(input);
  } catch {
    // ignored
  }
}

// ---- §5's liquidation review --------------------------------------------------------------------

/**
 * Finance checks the physical documents and settles the advance, or sends it back.
 *
 * §5 gives `CashAdvanceLiquidation` a status of draft | submitted | under_review | approved |
 * rejected. That vocabulary was modelled in session 2 and nothing moved it, which left filing
 * receipts in the app equivalent to proving they existed. They are not the same thing: what makes a
 * cost deductible is a BIR official receipt, on paper, in the office — and no amount of typing
 * produces one.
 *
 * So an advance whose numbers reconcile now stops at `pending_settlement`, and this is the step that
 * closes it. Rejecting returns it to `partially_liquidated` so the crew can resubmit; the rejected
 * liquidation row stays, because two attempts at reconciling one advance are two records and the
 * first is part of the history.
 */
export async function reviewLiquidationService(
  actor: ActorMeta,
  input: { liquidationId: string; decision: "approved" | "rejected"; remarks?: string },
) {
  const liquidation = await db.cashAdvanceLiquidation.findFirst({
    where: { id: input.liquidationId },
    include: {
      cashAdvance: { select: { id: true, number: true, status: true, requestedById: true } },
    },
  });
  if (!liquidation) {
    throw new TRPCError({ code: "NOT_FOUND", message: "That liquidation no longer exists." });
  }
  if (liquidation.status === "approved" || liquidation.status === "rejected") {
    throw new TRPCError({
      code: "BAD_REQUEST",
      message: `This liquidation has already been ${liquidation.status}.`,
    });
  }
  if (input.decision === "rejected" && !input.remarks?.trim()) {
    throw new TRPCError({
      code: "BAD_REQUEST",
      message:
        "Say what is wrong with it. A liquidation sent back without a reason is one the crew " +
        "cannot correct.",
    });
  }

  const advance = liquidation.cashAdvance;
  const approved = input.decision === "approved";

  await db.$transaction(async (tx) => {
    await tx.cashAdvanceLiquidation.update({
      where: { id: liquidation.id },
      data: {
        status: approved ? "approved" : "rejected",
        reviewedById: actor.actorId,
        reviewedAt: new Date(),
        remarks: input.remarks ?? liquidation.remarks,
      },
    });

    await tx.cashAdvance.update({
      where: { id: advance.id },
      data: {
        // Back to partially liquidated on a rejection: money is still out and unaccounted for, which
        // is exactly what that status means.
        status: approved ? "liquidated" : "partially_liquidated",
        liquidatedAt: approved ? new Date() : null,
        version: { increment: 1 },
      },
    });

    await writeAuditLog(tx, {
      actorId: actor.actorId,
      actorLabel: actor.actorLabel,
      action: approved ? "liquidation_settled" : "liquidation_rejected",
      entityType: CASH_ADVANCE_ENTITY_TYPE,
      entityId: advance.id,
      summary: approved
        ? `Checked the physical receipts against ${advance.number} and settled it`
        : `Sent the liquidation on ${advance.number} back — ${input.remarks}`,
      diff: {
        status: { from: advance.status, to: approved ? "liquidated" : "partially_liquidated" },
      },
      ip: actor.ip,
      userAgent: actor.userAgent,
      requestId: actor.requestId,
    });
  });

  await safeNotify({
    recipientId: advance.requestedById,
    type: CASH_ADVANCE_APPROVAL_DECIDED_NOTIFICATION_TYPE,
    title: approved
      ? `${advance.number} is settled`
      : `${advance.number} — your liquidation was sent back`,
    body: approved
      ? "Finance has checked the receipts against what you filed."
      : (input.remarks ?? ""),
    entityType: CASH_ADVANCE_ENTITY_TYPE,
    entityId: advance.id,
  });

  return { status: approved ? ("liquidated" as const) : ("partially_liquidated" as const) };
}

/** Liquidations waiting on somebody to check the paper against them. */
export async function listLiquidationsAwaitingCheckService() {
  return db.cashAdvanceLiquidation.findMany({
    where: { status: { in: ["submitted", "under_review"] } },
    include: {
      cashAdvance: {
        select: { id: true, number: true, status: true, purpose: true, amountApproved: true },
      },
    },
    orderBy: { submittedAt: "asc" },
    take: 100,
  });
}

/**
 * What the global inbox does when somebody approves a cash advance from it.
 *
 * Both handlers call the module's own service — the same path the ticket panel uses. The inbox used
 * to call the engine directly and leave the advance untouched, which is what stranded
 * AIESCA-260127. See decision-registry.ts.
 */
registerApprovalDecisionHandler(CASH_ADVANCE_ENTITY_TYPE, (context) =>
  decideCashAdvanceService(context.actor, context.approver, {
    cashAdvanceId: context.entityId,
    decision: context.decision,
    reason: context.comment,
  }),
);

registerApprovalDecisionHandler(CASH_ADVANCE_EXTENSION_ENTITY_TYPE, (context) =>
  decideExtensionService(context.actor, context.approver, {
    cashAdvanceId: context.entityId,
    decision: context.decision,
    comment: context.comment,
  }),
);
