import { TRPCError } from "@trpc/server";
import { db } from "@/lib/db";
import { writeAuditLog } from "@/server/core/audit/audit";
import { emit } from "@/server/core/events/emit";
import { notify } from "@/server/core/notify/notify";
import { registerNotificationType } from "@/server/core/notify/registry";
import type { ActorMeta } from "@/server/core/crm/account-service";
import { isAddressedTo, isCurrent } from "@/server/core/collab/calendar-rules";

/**
 * §5's announcements — ISO 9001 clause 7.4 communication evidence.
 *
 * ## The list is the feature
 *
 * The notice is easy; the value is *"a compliance list showing who has not acknowledged"*. A policy
 * change nobody can prove was read is a policy change that did not happen, and the first time a
 * procedure is revised is the first time somebody asks who has seen it.
 *
 * ## Absence is the evidence
 *
 * An acknowledgement row exists only once somebody has ticked. Nobody is pre-loaded as "not read" —
 * the *absence* of a row is what says they have not, which means the answer stays right when
 * somebody joins the company after the notice went out.
 */

export const ANNOUNCEMENT_ENTITY_TYPE = "Announcement";
export const ANNOUNCEMENT_NOTIFICATION_TYPE = "announcement.published";

registerNotificationType({
  key: ANNOUNCEMENT_NOTIFICATION_TYPE,
  label: "A company announcement",
  // Never coalesced. Two safety bulletins rolled into "2 announcements" is the one case where
  // summarising defeats the entire purpose of sending it.
  defaultChannels: { inApp: true, email: false, digest: true },
});

interface PublishInput {
  title: string;
  body: string;
  audienceRoleKeys?: string[];
  requiresAck?: boolean;
  priority?: "low" | "normal" | "urgent";
  expiresAt?: Date | null;
}

export async function publishAnnouncementService(actor: ActorMeta, input: PublishInput) {
  const title = input.title.trim();
  const body = input.body.trim();

  if (title.length < 4) {
    throw new TRPCError({ code: "BAD_REQUEST", message: "Give it a headline people can scan." });
  }
  if (body.length < 20) {
    /*
      Twenty characters, deliberately more than "a title would pass".

      An announcement short enough to fit in its own headline is a headline, and this one carries a
      tick that becomes evidence. Somebody acknowledging "see attached" has acknowledged nothing.
    */
    throw new TRPCError({
      code: "BAD_REQUEST",
      message:
        "Say what changed and what people must do. This is the text somebody will later be shown " +
        "as proof of what they agreed they had read.",
    });
  }

  const audience = input.audienceRoleKeys ?? [];
  if (audience.length > 0) {
    const known = await db.role.findMany({
      where: { key: { in: audience } },
      select: { key: true },
    });
    const missing = audience.filter((key) => !known.some((role) => role.key === key));
    if (missing.length > 0) {
      // A role nobody holds means an announcement nobody receives, published as though it had been.
      throw new TRPCError({
        code: "BAD_REQUEST",
        message: `No such role: ${missing.join(", ")}.`,
      });
    }
  }

  const announcement = await db.$transaction(async (tx) => {
    const created = await tx.announcement.create({
      data: {
        title,
        body,
        audienceRoleKeys: audience,
        requiresAck: input.requiresAck ?? false,
        priority: input.priority ?? "normal",
        publishedById: actor.actorId,
        expiresAt: input.expiresAt ?? null,
      },
    });

    await writeAuditLog(tx, {
      actorId: actor.actorId,
      actorLabel: actor.actorLabel,
      action: "create",
      entityType: ANNOUNCEMENT_ENTITY_TYPE,
      entityId: created.id,
      summary:
        `Published "${title}"` +
        (audience.length > 0 ? ` to ${audience.join(", ")}` : " to everybody") +
        (input.requiresAck ? ", acknowledgement required" : ""),
      ip: actor.ip,
      userAgent: actor.userAgent,
      requestId: actor.requestId,
    });

    await emit(
      tx,
      "announcement.published",
      { announcementId: created.id, requiresAck: created.requiresAck, audience },
      { actorId: actor.actorId },
    );

    return created;
  });

  for (const user of await audienceUsers(audience)) {
    if (user.id === actor.actorId) continue;
    try {
      await notify({
        recipientId: user.id,
        type: ANNOUNCEMENT_NOTIFICATION_TYPE,
        title: input.requiresAck ? `Please read and confirm: ${title}` : title,
        body: body.slice(0, 200),
        entityType: ANNOUNCEMENT_ENTITY_TYPE,
        entityId: announcement.id,
      });
    } catch {
      // Swallowed as everywhere else. The announcement exists whatever the bell does — and for one
      // needing acknowledgement, the outstanding list is the real chaser anyway.
    }
  }

  return { id: announcement.id };
}

/** Everybody the announcement is addressed to. An empty audience is the whole company. */
async function audienceUsers(audienceRoleKeys: string[]) {
  return db.user.findMany({
    where: {
      isActive: true,
      deletedAt: null,
      ...(audienceRoleKeys.length > 0
        ? { roles: { some: { role: { key: { in: audienceRoleKeys } } } } }
        : {}),
    },
    select: { id: true, name: true },
  });
}

/**
 * What this person should see, and what they still owe a tick on.
 *
 * Expired announcements drop out of the list and keep their acknowledgements: clause 7.4 asks who
 * was told, not who is still being told.
 */
export async function announcementsService(viewer: { id: string; roleKeys: string[] }) {
  const announcements = await db.announcement.findMany({
    where: { deletedAt: null },
    orderBy: { publishedAt: "desc" },
    take: 100,
    select: {
      id: true,
      title: true,
      body: true,
      audienceRoleKeys: true,
      requiresAck: true,
      priority: true,
      publishedAt: true,
      publishedById: true,
      expiresAt: true,
      acknowledgements: {
        where: { userId: viewer.id },
        select: { acknowledgedAt: true },
      },
    },
  });

  const mine = announcements.filter((announcement) =>
    isAddressedTo(announcement.audienceRoleKeys, viewer.roleKeys),
  );

  const publisherNames = await db.user.findMany({
    where: { id: { in: [...new Set(mine.map((row) => row.publishedById))] } },
    select: { id: true, name: true },
  });
  const names = new Map(publisherNames.map((user) => [user.id, user.name]));

  const now = new Date();
  const rows = mine.map((announcement) => ({
    id: announcement.id,
    title: announcement.title,
    body: announcement.body,
    audienceRoleKeys: announcement.audienceRoleKeys,
    requiresAck: announcement.requiresAck,
    priority: announcement.priority,
    publishedAt: announcement.publishedAt,
    publishedByName: names.get(announcement.publishedById) ?? "somebody",
    expiresAt: announcement.expiresAt,
    current: isCurrent(announcement, now),
    acknowledgedAt: announcement.acknowledgements[0]?.acknowledgedAt ?? null,
  }));

  return {
    rows,
    /** What is being waited on from this person, which is the only number they need to act on. */
    awaitingMe: rows.filter((row) => row.current && row.requiresAck && !row.acknowledgedAt).length,
  };
}

export async function acknowledgeAnnouncementService(
  actor: ActorMeta,
  input: { announcementId: string },
) {
  const announcement = await db.announcement.findFirst({
    where: { id: input.announcementId, deletedAt: null },
    select: { id: true, title: true, requiresAck: true },
  });
  if (!announcement) throw new TRPCError({ code: "NOT_FOUND", message: "That notice is gone." });

  /*
    Idempotent, and silently so.

    Somebody tapping twice on a slow connection has not done anything wrong, and a second row would
    make the compliance list ambiguous about when they actually read it. The first tick stands.
  */
  await db.announcementAck.upsert({
    where: {
      announcementId_userId: { announcementId: announcement.id, userId: actor.actorId },
    },
    create: { announcementId: announcement.id, userId: actor.actorId },
    update: {},
  });

  return { announcementId: announcement.id };
}

/**
 * §5's compliance list: who has acknowledged, and — the part that matters — who has not.
 *
 * Computed from the audience **now** rather than from a list captured at publication. Somebody who
 * joined last week is still bound by the safety bulletin, and somebody who left is not somebody to
 * chase.
 */
export async function acknowledgementListService(input: { announcementId: string }) {
  const announcement = await db.announcement.findFirst({
    where: { id: input.announcementId, deletedAt: null },
    select: {
      id: true,
      title: true,
      requiresAck: true,
      audienceRoleKeys: true,
      publishedAt: true,
      acknowledgements: { select: { userId: true, acknowledgedAt: true } },
    },
  });
  if (!announcement) throw new TRPCError({ code: "NOT_FOUND", message: "That notice is gone." });

  const audience = await audienceUsers(announcement.audienceRoleKeys);
  const acked = new Map(
    announcement.acknowledgements.map((row) => [row.userId, row.acknowledgedAt]),
  );

  const people = audience
    .map((user) => ({
      userId: user.id,
      name: user.name,
      acknowledgedAt: acked.get(user.id) ?? null,
    }))
    // Outstanding first: this list exists to be acted on, not admired.
    .sort((a, b) => {
      if (!a.acknowledgedAt && b.acknowledgedAt) return -1;
      if (a.acknowledgedAt && !b.acknowledgedAt) return 1;
      return a.name.localeCompare(b.name);
    });

  return {
    id: announcement.id,
    title: announcement.title,
    requiresAck: announcement.requiresAck,
    publishedAt: announcement.publishedAt,
    people,
    outstanding: people.filter((person) => !person.acknowledgedAt).length,
    /*
      Acknowledgements from people no longer in the audience.

      Kept as a count rather than hidden: somebody who read it and then changed role still read it,
      and a compliance list that quietly dropped them would understate what the company can prove.
    */
    acknowledgedByOthers: announcement.acknowledgements.filter(
      (row) => !audience.some((user) => user.id === row.userId),
    ).length,
  };
}
