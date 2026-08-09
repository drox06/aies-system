import { TRPCError } from "@trpc/server";
import { db } from "@/lib/db";
import { writeAuditLog } from "@/server/core/audit/audit";
import type { ActorMeta } from "@/server/core/crm/account-service";
import { emit } from "@/server/core/events/emit";

/**
 * The relationship record (specs/01-crm-inquiry.md §2's `Activity`).
 *
 * Not to be confused with module 00's activity *feed*, which merges comments and audit rows and
 * answers "what happened to this record?". This answers a different question, and §1 says which
 * one: "A salesperson's real question is 'who haven't I talked to in 60 days, and what's stuck?'
 * Design for that question."
 *
 * A phone call changes nothing in the system, so it produces no audit row and would leave no trace
 * at all without this. That is precisely the gap — AIES "generates inquiries through networking and
 * customer relations", and the record of that networking is the asset.
 */

export const ACTIVITY_TYPES = ["call", "meeting", "site_visit", "email", "note", "demo"] as const;

/** Entities an activity may hang off. An allow-list rather than any string: a typo'd entityType
 *  produces a row nothing will ever read again, which is worse than an error. */
export const ACTIVITY_ENTITY_TYPES = [
  "CustomerAccount",
  "Contact",
  "Inquiry",
  "AccreditationRecord",
  "PrincipalProspect",
] as const;

export interface LogActivityInput {
  entityType: string;
  entityId: string;
  type: string;
  subject: string;
  body?: string | null;
  occurredAt?: Date | null;
  durationMin?: number | null;
  participantIds?: string[];
  contactIds?: string[];
  outcome?: string | null;
  nextStepDue?: Date | null;
}

export async function logActivityService(actor: ActorMeta, input: LogActivityInput) {
  if (!ACTIVITY_TYPES.includes(input.type as (typeof ACTIVITY_TYPES)[number])) {
    throw new TRPCError({ code: "BAD_REQUEST", message: `Unknown activity type "${input.type}".` });
  }
  if (!ACTIVITY_ENTITY_TYPES.includes(input.entityType as (typeof ACTIVITY_ENTITY_TYPES)[number])) {
    throw new TRPCError({
      code: "BAD_REQUEST",
      message: `Activities cannot be logged against "${input.entityType}".`,
    });
  }
  const subject = input.subject.trim();
  if (subject.length === 0) {
    throw new TRPCError({ code: "BAD_REQUEST", message: "Give the activity a subject." });
  }

  // Defaults to now, but backdating is expected and supported: people log Friday's site visit on
  // Monday, and "who haven't I talked to in 60 days" is wrong if the date is when it was typed.
  const occurredAt = input.occurredAt ?? new Date();

  return db.$transaction(async (tx) => {
    const activity = await tx.activity.create({
      data: {
        entityType: input.entityType,
        entityId: input.entityId,
        type: input.type,
        subject,
        body: input.body ?? null,
        occurredAt,
        durationMin: input.durationMin ?? null,
        participantIds: input.participantIds ?? [actor.actorId],
        contactIds: input.contactIds ?? [],
        outcome: input.outcome ?? null,
        nextStepDue: input.nextStepDue ?? null,
        createdById: actor.actorId,
      },
    });

    // Also audited, so the call shows up in the record's activity feed alongside the status
    // changes. The Activity row is the queryable relationship history; the audit row is what makes
    // it visible in the one timeline people actually read.
    await writeAuditLog(tx, {
      actorId: actor.actorId,
      actorLabel: actor.actorLabel,
      action: "activity_logged",
      entityType: input.entityType,
      entityId: input.entityId,
      summary: `Logged a ${input.type.replace(/_/g, " ")}: ${subject}`,
      ip: actor.ip,
      userAgent: actor.userAgent,
      requestId: actor.requestId,
    });

    await emit(
      tx,
      "activity.logged",
      {
        activityId: activity.id,
        entityType: input.entityType,
        entityId: input.entityId,
        type: input.type,
        occurredAt: occurredAt.toISOString(),
      },
      { actorId: actor.actorId, requestId: actor.requestId },
    );

    return activity;
  });
}

export async function listActivitiesService(input: {
  entityType: string;
  entityId: string;
  limit?: number;
}) {
  const activities = await db.activity.findMany({
    where: { entityType: input.entityType, entityId: input.entityId, deletedAt: null },
    orderBy: { occurredAt: "desc" },
    take: Math.min(200, Math.max(1, input.limit ?? 50)),
  });

  // `createdById` is a plain id (the same decoupled-from-User convention as AuditLog.actorId), so
  // names are resolved on read rather than snapshotted — matching how the comment feed does it.
  const ids = [...new Set(activities.map((a) => a.createdById))];
  const users = await db.user.findMany({
    where: { id: { in: ids } },
    select: { id: true, name: true },
  });
  const nameById = new Map(users.map((u) => [u.id, u.name]));

  return activities.map((activity) => ({
    ...activity,
    createdByLabel: nameById.get(activity.createdById) ?? activity.createdById,
  }));
}

/**
 * §6's "accounts not contacted in N days", as the query it will need.
 *
 * The follow-up engine itself is session 3; this is here because it is the read that justifies the
 * model, and having it now means the model can be checked against its purpose rather than assumed
 * to fit.
 */
export async function lastContactByAccount(accountIds: string[]): Promise<Map<string, Date>> {
  if (accountIds.length === 0) return new Map();

  const rows = await db.activity.groupBy({
    by: ["entityId"],
    where: {
      entityType: "CustomerAccount",
      entityId: { in: accountIds },
      deletedAt: null,
      // A note to self is not contact with the customer.
      type: { in: ["call", "meeting", "site_visit", "email", "demo"] },
    },
    _max: { occurredAt: true },
  });

  const result = new Map<string, Date>();
  for (const row of rows) {
    if (row._max.occurredAt) result.set(row.entityId, row._max.occurredAt);
  }
  return result;
}
