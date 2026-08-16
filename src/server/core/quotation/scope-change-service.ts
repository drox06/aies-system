import { TRPCError } from "@trpc/server";
import type { Prisma } from "@prisma/client";
import { db } from "@/lib/db";
import { writeAuditLog } from "@/server/core/audit/audit";
import { addBusinessDays } from "@/server/core/calendar/business-days";
import type { ActorMeta } from "@/server/core/crm/account-service";
import { notify } from "@/server/core/notify/notify";
import { registerNotificationType } from "@/server/core/notify/registry";

/**
 * What module 02 does when a site inspection finds the job is bigger than quoted.
 *
 * specs/04-operations-projects.md §6.1: "**If `scopeChangeIdentified` is true, emit
 * `scope_change.identified`.** Module 02 subscribes and prompts sales to raise a quotation revision.
 * Discovering at inspection that the job is bigger than quoted is normal; discovering it *after*
 * mobilization is expensive. **This link is one of the highest-value things the platform does.**"
 *
 * ## It prompts. It does not revise.
 *
 * The spec says "prompts sales to raise a quotation revision", and the wording is doing real work.
 * Automatically creating a revision would be wrong twice over: only a human knows whether the extra
 * scope is chargeable, absorbed, or a misunderstanding to be argued about — and a revision raised by
 * a robot still has to be priced by somebody who was not told why it appeared.
 *
 * ## Why a mark, and not only a notification
 *
 * The first version of this notified and stopped. That put the platform's self-described
 * highest-value link on the weakest channel it has — the in-app bell, with email off because the
 * `notify_email` queue still has no handler (docs/DECISIONS.md #10). Miss the bell and nothing ever
 * surfaces it again, so the crew mobilises three weeks later against a quotation nobody revised:
 * the exact failure §6.1 exists to prevent, arriving by a different road.
 *
 * So the finding is written onto the quotation and stays there until somebody revises it or
 * dismisses it with a reason, and `sweepUnactionedScopeChanges` chases it in between.
 * docs/DECISIONS.md #59.
 */

export const SCOPE_CHANGE_NOTIFICATION_TYPE = "quotation.scope_change_identified";

registerNotificationType({
  key: SCOPE_CHANGE_NOTIFICATION_TYPE,
  label: "A site inspection found work beyond what was quoted",
  // The strongest case for email in this build. Left in-app like the rest because the `notify_email`
  // queue still has no handler and every send would dead-letter (docs/DECISIONS.md #10) — but this
  // is the first one to switch on when it does. The mark on the quotation is what covers the gap
  // in the meantime.
  defaultChannels: { inApp: true, email: false, digest: false },
});

export async function promptRevisionOnScopeChange(payload: {
  siteInspectionId?: string;
  number?: string;
  ticketId?: string | null;
  inquiryId?: string | null;
  notes?: string | null;
}): Promise<void> {
  if (!payload.siteInspectionId) return;

  const quotation = await findQuotationBehind(payload);
  if (!quotation) {
    // Not an error, and deliberately not a throw: a survey can legitimately precede any quotation —
    // that is the module 01 route, where the whole point is to inspect *before* pricing. Throwing
    // would dead-letter a job whose real work (recording the finding) is already done.
    console.warn(
      `[quotation] ${payload.number ?? payload.siteInspectionId} flagged a scope change with no ` +
        `quotation behind it — nothing to revise yet.`,
    );
    return;
  }

  const notes = payload.notes?.trim() || "The surveyor flagged a scope change but left no note.";

  /**
   * Guarded on the flag still being clear, so a second inspection does not quietly overwrite a first
   * finding nobody has dealt with yet. The newer one still notifies — the person needs to know — but
   * the older mark and its notes stay put until they are resolved.
   */
  const { count } = await db.quotation.updateMany({
    where: { id: quotation.id, scopeChangeFlaggedAt: null },
    data: {
      scopeChangeFlaggedAt: new Date(),
      scopeChangeNotes: notes,
      scopeChangeInspectionId: payload.siteInspectionId,
      scopeChangeSource: payload.number ?? null,
      scopeChangeChasedAt: null,
      scopeChangeResolvedAt: null,
      scopeChangeResolution: null,
      scopeChangeResolutionNote: null,
    },
  });

  await notify({
    recipientId: quotation.preparedById,
    type: SCOPE_CHANGE_NOTIFICATION_TYPE,
    title: `${quotation.number} may need revising — site inspection found extra scope`,
    body:
      notes +
      ` (from ${payload.number ?? "a site inspection"})` +
      (count === 0 ? " — an earlier scope change on this quotation is still open." : ""),
    entityType: "Quotation",
    entityId: quotation.id,
  });
}

/**
 * The quotation the surveyed work was priced from.
 *
 * Two routes, matching the two ways an inspection is raised. From a ticket the chain is
 * ticket → sales order → quotation; from an inquiry it is inquiry → quotation. Both take the newest
 * live quotation, because a revised quotation supersedes the one before it and revising the
 * superseded one is not useful.
 */
async function findQuotationBehind(payload: {
  ticketId?: string | null;
  inquiryId?: string | null;
}) {
  if (payload.ticketId) {
    const ticket = await db.ticket.findFirst({
      where: { id: payload.ticketId },
      select: { salesOrder: { select: { quotationId: true } } },
    });
    const quotationId = ticket?.salesOrder?.quotationId;
    if (quotationId) {
      const quotation = await db.quotation.findFirst({
        where: { id: quotationId, deletedAt: null },
        select: { id: true, number: true, preparedById: true },
      });
      if (quotation) return quotation;
    }
  }

  if (payload.inquiryId) {
    return db.quotation.findFirst({
      where: { inquiryId: payload.inquiryId, deletedAt: null, status: { not: "superseded" } },
      orderBy: { revision: "desc" },
      select: { id: true, number: true, preparedById: true },
    });
  }

  return null;
}

// ---- resolving it -------------------------------------------------------------------------------

/** How long a flagged scope change may sit before the sweep chases it, and between chases. */
export const SCOPE_CHANGE_CHASE_WORKING_DAYS = 3;

/**
 * Clears the mark because the quotation was revised.
 *
 * Called from `reviseQuotationService` inside its own transaction: raising the revision **is** the
 * action the mark was asking for, and requiring a second click to dismiss it afterwards would only
 * train people to dismiss things.
 */
export function resolveScopeChangeOnRevision(
  tx: Prisma.TransactionClient,
  quotationId: string,
  actorId: string,
) {
  return tx.quotation.updateMany({
    where: { id: quotationId, scopeChangeFlaggedAt: { not: null }, scopeChangeResolvedAt: null },
    data: {
      scopeChangeResolvedAt: new Date(),
      scopeChangeResolvedById: actorId,
      scopeChangeResolution: "revised",
    },
  });
}

/**
 * Clears the mark without revising — the extra scope is absorbed, or the surveyor was wrong.
 *
 * The reason is required. §6.1's complaint is about findings that vanish, and "we absorbed it" is a
 * decision worth keeping where silence is not. It is also what somebody reads six months later when
 * the job overran and nobody remembers agreeing to it.
 */
export async function dismissScopeChangeService(
  actor: ActorMeta,
  input: { quotationId: string; reason: string },
) {
  if (input.reason.trim().length < 10) {
    throw new TRPCError({
      code: "BAD_REQUEST",
      message:
        "Say why this needs no revision. Absorbing extra scope is a decision worth recording — it " +
        "is what somebody reads when the job overruns.",
    });
  }

  const quotation = await db.quotation.findFirst({
    where: { id: input.quotationId, deletedAt: null },
    select: { id: true, number: true, scopeChangeFlaggedAt: true, scopeChangeResolvedAt: true },
  });
  if (!quotation) {
    throw new TRPCError({ code: "NOT_FOUND", message: "That quotation no longer exists." });
  }
  if (!quotation.scopeChangeFlaggedAt || quotation.scopeChangeResolvedAt) {
    throw new TRPCError({
      code: "BAD_REQUEST",
      message: `${quotation.number} has no open scope change.`,
    });
  }

  await db.$transaction(async (tx) => {
    await tx.quotation.update({
      where: { id: quotation.id },
      data: {
        scopeChangeResolvedAt: new Date(),
        scopeChangeResolvedById: actor.actorId,
        scopeChangeResolution: "dismissed",
        scopeChangeResolutionNote: input.reason.trim(),
      },
    });
    await writeAuditLog(tx, {
      actorId: actor.actorId,
      actorLabel: actor.actorLabel,
      action: "scope_change_dismissed",
      entityType: "Quotation",
      entityId: quotation.id,
      summary: `Dismissed the scope change on ${quotation.number} without revising — ${input.reason.trim()}`,
      ip: actor.ip,
      userAgent: actor.userAgent,
      requestId: actor.requestId,
    });
  });

  return { resolved: true as const };
}

// ---- the nightly chase --------------------------------------------------------------------------

/**
 * Chases scope changes nobody has acted on (docs/DECISIONS.md #59).
 *
 * Emitting the event once is right — a surveyor correcting a measurement must not re-send "the job
 * is bigger than quoted", because a warning that arrives repeatedly is one people learn to close
 * unread. But *once, ever* also means *never again*, and a scope change raised on Tuesday and
 * forgotten is the same failure §6.1 is about, arriving three weeks later.
 *
 * So the event fires once and this chases the **unresolved mark**, every three working days.
 * Working days rather than calendar, for the same reason as everything else here: a Friday finding
 * should not chase somebody on a Sunday. The cadence repeats deliberately — an open scope change
 * should stay uncomfortable until it is either revised or explicitly absorbed.
 *
 * §6 does not ask for this. It is the same shape as the seven-day silent-quotation sweep and the
 * overdue-liquidation sweep already running nightly.
 */
export async function sweepUnactionedScopeChanges(now: Date = new Date()) {
  const open = await db.quotation.findMany({
    where: {
      deletedAt: null,
      scopeChangeFlaggedAt: { not: null },
      scopeChangeResolvedAt: null,
      // A superseded quotation has already been revised past, and a dead one is not going to be
      // revised at all. Chasing either is noise.
      status: { notIn: ["superseded", "cancelled", "lost", "expired"] },
    },
    select: {
      id: true,
      number: true,
      preparedById: true,
      scopeChangeFlaggedAt: true,
      scopeChangeChasedAt: true,
      scopeChangeNotes: true,
      account: { select: { name: true, ownerId: true } },
    },
  });

  const chased: { id: string; number: string }[] = [];

  for (const quotation of open) {
    const flaggedAt = quotation.scopeChangeFlaggedAt;
    if (!flaggedAt) continue;

    const since = quotation.scopeChangeChasedAt ?? flaggedAt;
    if (addBusinessDays(since, SCOPE_CHANGE_CHASE_WORKING_DAYS).getTime() > now.getTime()) continue;

    const days = Math.floor((now.getTime() - flaggedAt.getTime()) / 86_400_000);

    /**
     * The account owner as well as whoever prepared it.
     *
     * After a fortnight the preparer may simply not be the person who can get a decision out of the
     * customer. A `Set` because on most quotations they are the same person, and telling somebody
     * twice is how a chase becomes noise.
     */
    for (const recipient of new Set(
      [quotation.preparedById, quotation.account.ownerId].filter(Boolean) as string[],
    )) {
      try {
        await notify({
          recipientId: recipient,
          type: SCOPE_CHANGE_NOTIFICATION_TYPE,
          title: `${quotation.number} still has an unactioned scope change (${days} day${days === 1 ? "" : "s"})`,
          body:
            `${quotation.scopeChangeNotes ?? "No note was left."} ` +
            `Revise it, or dismiss it with a reason — ${quotation.account.name}.`,
          entityType: "Quotation",
          entityId: quotation.id,
        });
      } catch {
        // One bad recipient must not stop the sweep.
      }
    }

    await db.quotation.update({
      where: { id: quotation.id },
      data: { scopeChangeChasedAt: now },
    });
    chased.push({ id: quotation.id, number: quotation.number });
  }

  return { open: open.length, chased };
}
