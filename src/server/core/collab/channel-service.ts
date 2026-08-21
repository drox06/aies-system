import { TRPCError } from "@trpc/server";
import { Prisma } from "@prisma/client";
import { db } from "@/lib/db";
import { writeAuditLog } from "@/server/core/audit/audit";
import { emit } from "@/server/core/events/emit";
import { notify } from "@/server/core/notify/notify";
import { registerNotificationType } from "@/server/core/notify/registry";
import type { ActorMeta } from "@/server/core/crm/account-service";
import { createTaskService } from "@/server/core/collab/task-service";
import {
  canPost,
  canRead,
  checkChannel,
  findMentions,
  findRecordReferences,
  recipientsFor,
  unreadCount,
  withinEditWindow,
  type ChannelType,
  type NotificationLevel,
  type RecordReference,
} from "@/server/core/collab/channel-rules";
import { TASK_ENTITY_TYPES } from "@/server/core/collab/task-rules";

/**
 * §3's channels — the Slack replacement.
 *
 * ## What stops this being a parallel universe
 *
 * §1: *"The fix is not 'build a chat app' — a chat app produces no record either."* Two seams do the
 * work. **Record links**: a message naming `AIESSO-261561` carries a resolved link to that order, so
 * a conversation about a job can be got back to from the job. **Promote to task**: any message
 * becomes an accountable item in one action, carrying its own text and a way back — which is how
 * *"can someone check the Cebu delivery"* stops scrolling away.
 *
 * ## Attachments are not here
 *
 * §3 routes them *"through the module 07 DMS, not loose blobs"*, and module 07 does not exist yet.
 * Wiring them to module 00's storage now would mean moving them later, so they wait. Recorded rather
 * than forgotten: it is the one part of §3 this session does not build.
 */

export const CHANNEL_ENTITY_TYPE = "Channel";
export const MESSAGE_MENTION_NOTIFICATION_TYPE = "message.mentioned";
export const CHANNEL_MESSAGE_NOTIFICATION_TYPE = "channel.message";

registerNotificationType({
  key: MESSAGE_MENTION_NOTIFICATION_TYPE,
  label: "Somebody named you in a message",
  // Not coalesced. Being named is a request for an answer, and rolling three into "3 mentions"
  // would make somebody open a screen to find out what was asked.
  defaultChannels: { inApp: true, email: false, digest: true },
});

registerNotificationType({
  key: CHANNEL_MESSAGE_NOTIFICATION_TYPE,
  label: "A message in a channel you follow every message in",
  defaultChannels: { inApp: true, email: false, digest: true },
  /*
    Coalesced over five minutes, unlike a mention.

    Somebody on `all` in a busy channel would otherwise collect a bell for each line of a
    conversation, and a bell that rings twenty times is a bell people turn off. `mentions` is the
    setting for people who want the quieter version, and this window is what makes `all` survivable.
  */
  coalesceWindowMs: 5 * 60_000,
});

interface CreateChannelInput {
  name: string;
  description?: string | null;
  type?: ChannelType;
  isPrivate?: boolean;
  memberIds?: string[];
  entityType?: string | null;
  entityId?: string | null;
}

export async function createChannelService(actor: ActorMeta, input: CreateChannelInput) {
  const type = input.type ?? "topic";
  // Whoever makes a channel is in it. A channel its creator has to join is a small papercut that
  // every single person hits once.
  const memberIds = [...new Set([...(input.memberIds ?? []), actor.actorId])];

  const check = checkChannel({
    name: input.name,
    type,
    memberIds,
    isPrivate: input.isPrivate ?? false,
  });
  if (!check.ok) throw new TRPCError({ code: "BAD_REQUEST", message: check.errors.join(" ") });

  const channel = await db.$transaction(async (tx) => {
    const created = await tx.channel.create({
      data: {
        name: input.name.trim(),
        description: input.description?.trim() || null,
        type,
        isPrivate: input.isPrivate ?? false,
        entityType: input.entityType ?? null,
        entityId: input.entityId ?? null,
        memberIds,
        createdById: actor.actorId,
        members: { create: memberIds.map((userId) => ({ userId })) },
      },
    });

    await writeAuditLog(tx, {
      actorId: actor.actorId,
      actorLabel: actor.actorLabel,
      action: "create",
      entityType: CHANNEL_ENTITY_TYPE,
      entityId: created.id,
      summary: `Opened the ${input.isPrivate ? "private " : ""}channel "${created.name}"`,
      ip: actor.ip,
      userAgent: actor.userAgent,
      requestId: actor.requestId,
    });

    return created;
  });

  return { id: channel.id, name: channel.name };
}

/**
 * Channels this person can see, with what they have not read.
 *
 * Archived ones are included and marked. §3 keeps a closed project's channel as part of the project
 * record, and a record that disappears from every list is one nobody will find again.
 */
export async function channelsService(viewerId: string) {
  const channels = await db.channel.findMany({
    where: {
      deletedAt: null,
      OR: [{ isPrivate: false }, { memberIds: { has: viewerId } }],
    },
    orderBy: [{ archivedAt: "asc" }, { type: "asc" }, { name: "asc" }],
    select: {
      id: true,
      name: true,
      description: true,
      type: true,
      isPrivate: true,
      entityType: true,
      entityId: true,
      memberIds: true,
      archivedAt: true,
      members: { where: { userId: viewerId }, select: { lastReadAt: true } },
      messages: {
        where: { deletedAt: null },
        select: { createdAt: true, authorId: true },
        orderBy: { createdAt: "desc" },
        take: 100,
      },
    },
  });

  return channels.map((channel) => ({
    id: channel.id,
    name: channel.name,
    description: channel.description,
    type: channel.type,
    isPrivate: channel.isPrivate,
    entityType: channel.entityType,
    entityId: channel.entityId,
    archivedAt: channel.archivedAt,
    isMember: channel.memberIds.includes(viewerId),
    memberCount: channel.memberIds.length,
    lastMessageAt: channel.messages[0]?.createdAt ?? null,
    /*
      Capped at the last hundred messages.

      An unread count of "99+" tells somebody everything an exact 4,312 would, and counting every
      message in every channel on every page load is how a channel list becomes the slowest screen
      in the platform.
    */
    unread: unreadCount(channel.messages, channel.members[0]?.lastReadAt ?? null, viewerId),
  }));
}

/** Turning the numbers in a message into links that go somewhere. */
async function resolveReferences(references: RecordReference[]) {
  const resolved: { entityType: string; entityId: string; number: string; label: string }[] = [];

  for (const reference of references) {
    let id: string | null = null;
    switch (reference.entityType) {
      case "Quotation":
        id = (await db.quotation.findFirst({ where: { number: reference.number } }))?.id ?? null;
        break;
      case "Inquiry":
        id = (await db.inquiry.findFirst({ where: { number: reference.number } }))?.id ?? null;
        break;
      case "SalesOrder":
        id = (await db.salesOrder.findFirst({ where: { number: reference.number } }))?.id ?? null;
        break;
      case "Ticket":
        id = (await db.ticket.findFirst({ where: { number: reference.number } }))?.id ?? null;
        break;
      case "Project":
        id = (await db.project.findFirst({ where: { code: reference.number } }))?.id ?? null;
        break;
      case "CashAdvance":
        id = (await db.cashAdvance.findFirst({ where: { number: reference.number } }))?.id ?? null;
        break;
      case "MaterialRequest":
        id =
          (await db.materialRequest.findFirst({ where: { number: reference.number } }))?.id ?? null;
        break;
      case "Task":
        id = (await db.task.findFirst({ where: { number: reference.number } }))?.id ?? null;
        break;
    }

    // A number that matches nothing is left as plain text rather than rendered as a dead link. Most
    // of those are typos, and a card that goes nowhere is worse than no card.
    if (id) {
      resolved.push({
        entityType: reference.entityType,
        entityId: id,
        number: reference.number,
        label: reference.label,
      });
    }
  }

  return resolved;
}

export async function postMessageService(
  actor: ActorMeta,
  input: { channelId: string; body: string; threadRootId?: string | null },
) {
  const body = input.body.trim();
  if (body.length === 0) throw new TRPCError({ code: "BAD_REQUEST", message: "Say something." });
  if (body.length > 8000) {
    throw new TRPCError({
      code: "BAD_REQUEST",
      message: "That is longer than a message should be.",
    });
  }

  const channel = await db.channel.findFirst({
    where: { id: input.channelId, deletedAt: null },
    select: { id: true, name: true, isPrivate: true, memberIds: true, archivedAt: true },
  });
  if (!channel) throw new TRPCError({ code: "NOT_FOUND", message: "That channel is gone." });
  if (!canPost(channel, actor.actorId)) {
    throw new TRPCError({
      code: "FORBIDDEN",
      message: channel.archivedAt
        ? `"${channel.name}" is archived. It is kept as a record of what was said, so nothing more can be added.`
        : "That channel is private.",
    });
  }

  const people = await db.user.findMany({
    where: { isActive: true, deletedAt: null },
    select: { id: true, name: true },
  });
  const { userIds: mentions, here } = findMentions(body, people);
  const links = await resolveReferences(findRecordReferences(body));

  /*
    A reply attaches to the root, never to another reply.

    §3's threading is one level deep on purpose: a tree is unreadable in a narrow column, and every
    chat tool that allowed one ended up hiding the depth anyway.
  */
  let threadRootId: string | null = null;
  if (input.threadRootId) {
    const parent = await db.message.findFirst({
      where: { id: input.threadRootId, channelId: channel.id, deletedAt: null },
      select: { id: true, threadRootId: true },
    });
    if (!parent) throw new TRPCError({ code: "BAD_REQUEST", message: "That message is gone." });
    threadRootId = parent.threadRootId ?? parent.id;
  }

  const message = await db.$transaction(async (tx) => {
    const created = await tx.message.create({
      data: {
        channelId: channel.id,
        authorId: actor.actorId,
        body,
        threadRootId,
        mentions,
        mentionedHere: here,
        links: links as unknown as Prisma.InputJsonValue,
      },
    });

    // The author has read what they just wrote.
    await tx.channelMember.updateMany({
      where: { channelId: channel.id, userId: actor.actorId },
      data: { lastReadAt: created.createdAt },
    });

    if (mentions.length > 0) {
      await emit(
        tx,
        "message.mentioned",
        { messageId: created.id, channelId: channel.id, mentions },
        { actorId: actor.actorId },
      );
    }

    return created;
  });

  const members = await db.channelMember.findMany({
    where: { channelId: channel.id },
    select: { userId: true, notificationLevel: true },
  });

  for (const recipient of recipientsFor(members, {
    authorId: actor.actorId,
    mentions,
    mentionedHere: here,
  })) {
    try {
      await notify({
        recipientId: recipient.userId,
        type:
          recipient.because === "all"
            ? CHANNEL_MESSAGE_NOTIFICATION_TYPE
            : MESSAGE_MENTION_NOTIFICATION_TYPE,
        title:
          recipient.because === "mentioned"
            ? `${actor.actorLabel} named you in ${channel.name}`
            : recipient.because === "here"
              ? `${actor.actorLabel} used @here in ${channel.name}`
              : `${actor.actorLabel} posted in ${channel.name}`,
        body: body.slice(0, 200),
        entityType: CHANNEL_ENTITY_TYPE,
        entityId: channel.id,
      });
    } catch {
      // Swallowed, as everywhere else: the message is posted whatever the bell does.
    }
  }

  return { id: message.id };
}

export async function messagesService(
  viewerId: string,
  input: { channelId: string; threadRootId?: string | null },
) {
  const channel = await db.channel.findFirst({
    where: { id: input.channelId, deletedAt: null },
    select: {
      id: true,
      name: true,
      description: true,
      type: true,
      isPrivate: true,
      memberIds: true,
      archivedAt: true,
      entityType: true,
      entityId: true,
    },
  });
  if (!channel) throw new TRPCError({ code: "NOT_FOUND", message: "That channel is gone." });
  if (!canRead(channel, viewerId)) {
    throw new TRPCError({ code: "FORBIDDEN", message: "That channel is private." });
  }

  const messages = await db.message.findMany({
    where: {
      channelId: channel.id,
      deletedAt: null,
      ...(input.threadRootId
        ? { OR: [{ id: input.threadRootId }, { threadRootId: input.threadRootId }] }
        : { threadRootId: null }),
    },
    orderBy: { createdAt: "asc" },
    take: 200,
    select: {
      id: true,
      authorId: true,
      body: true,
      mentions: true,
      mentionedHere: true,
      reactions: true,
      links: true,
      editedAt: true,
      createdAt: true,
      threadRootId: true,
    },
  });

  const replyCounts = await db.message.groupBy({
    by: ["threadRootId"],
    where: { channelId: channel.id, deletedAt: null, threadRootId: { not: null } },
    _count: { _all: true },
  });
  const repliesByRoot = new Map(replyCounts.map((row) => [row.threadRootId, row._count._all]));

  const authorIds = [...new Set(messages.map((message) => message.authorId))];
  const authors = await db.user.findMany({
    where: { id: { in: authorIds } },
    select: { id: true, name: true },
  });
  const names = new Map(authors.map((author) => [author.id, author.name]));

  return {
    channel: {
      id: channel.id,
      name: channel.name,
      description: channel.description,
      type: channel.type,
      isPrivate: channel.isPrivate,
      entityType: channel.entityType,
      entityId: channel.entityId,
      archivedAt: channel.archivedAt,
      isMember: channel.memberIds.includes(viewerId),
      canPost: canPost(channel, viewerId),
    },
    messages: messages.map((message) => ({
      ...message,
      authorName: names.get(message.authorId) ?? "somebody",
      links: (Array.isArray(message.links) ? message.links : []) as unknown as {
        entityType: string;
        entityId: string;
        number: string;
        label: string;
      }[],
      reactions: (message.reactions ?? {}) as Record<string, string[]>,
      replyCount: repliesByRoot.get(message.id) ?? 0,
      canEdit: message.authorId === viewerId && withinEditWindow(message.createdAt),
    })),
  };
}

export async function markReadService(viewerId: string, input: { channelId: string }) {
  await db.channelMember.updateMany({
    where: { channelId: input.channelId, userId: viewerId },
    data: { lastReadAt: new Date() },
  });
  return { channelId: input.channelId };
}

export async function joinChannelService(actor: ActorMeta, input: { channelId: string }) {
  const channel = await db.channel.findFirst({
    where: { id: input.channelId, deletedAt: null },
    select: { id: true, name: true, isPrivate: true, memberIds: true, archivedAt: true },
  });
  if (!channel) throw new TRPCError({ code: "NOT_FOUND", message: "That channel is gone." });
  if (channel.isPrivate && !channel.memberIds.includes(actor.actorId)) {
    throw new TRPCError({
      code: "FORBIDDEN",
      message: "That channel is private. Somebody already in it has to add you.",
    });
  }
  if (channel.memberIds.includes(actor.actorId)) return { channelId: channel.id };

  await db.$transaction(async (tx) => {
    await tx.channel.update({
      where: { id: channel.id },
      data: { memberIds: { push: actor.actorId } },
    });
    await tx.channelMember.create({ data: { channelId: channel.id, userId: actor.actorId } });
  });

  return { channelId: channel.id };
}

export async function leaveChannelService(actor: ActorMeta, input: { channelId: string }) {
  const channel = await db.channel.findFirst({
    where: { id: input.channelId, deletedAt: null },
    select: { id: true, memberIds: true },
  });
  if (!channel) throw new TRPCError({ code: "NOT_FOUND", message: "That channel is gone." });

  await db.$transaction(async (tx) => {
    await tx.channel.update({
      where: { id: channel.id },
      data: { memberIds: channel.memberIds.filter((id) => id !== actor.actorId) },
    });
    await tx.channelMember.deleteMany({ where: { channelId: channel.id, userId: actor.actorId } });
  });

  return { channelId: channel.id };
}

export async function setNotificationLevelService(
  viewerId: string,
  input: { channelId: string; level: NotificationLevel },
) {
  await db.channelMember.updateMany({
    where: { channelId: input.channelId, userId: viewerId },
    data: { notificationLevel: input.level },
  });
  return { level: input.level };
}

/**
 * Reactions.
 *
 * Toggling: a second tap by the same person takes theirs off. Stored as a map of emoji to the people
 * who used it, so the screen can say *who* agreed rather than only how many — which in a company of
 * nine is the whole value of a reaction.
 */
export async function reactService(actor: ActorMeta, input: { messageId: string; emoji: string }) {
  const message = await db.message.findFirst({
    where: { id: input.messageId, deletedAt: null },
    select: { id: true, reactions: true, channelId: true },
  });
  if (!message) throw new TRPCError({ code: "NOT_FOUND", message: "That message is gone." });

  const reactions = { ...((message.reactions ?? {}) as Record<string, string[]>) };
  const already = reactions[input.emoji] ?? [];
  reactions[input.emoji] = already.includes(actor.actorId)
    ? already.filter((id) => id !== actor.actorId)
    : [...already, actor.actorId];
  if (reactions[input.emoji]!.length === 0) delete reactions[input.emoji];

  await db.message.update({
    where: { id: message.id },
    data: { reactions: reactions as unknown as Prisma.InputJsonValue },
  });

  return { reactions };
}

export async function editMessageService(
  actor: ActorMeta,
  input: { messageId: string; body: string },
) {
  const message = await db.message.findFirst({
    where: { id: input.messageId, deletedAt: null },
    select: { id: true, authorId: true, createdAt: true, channelId: true },
  });
  if (!message) throw new TRPCError({ code: "NOT_FOUND", message: "That message is gone." });
  if (message.authorId !== actor.actorId) {
    throw new TRPCError({ code: "FORBIDDEN", message: "You can only edit your own messages." });
  }
  if (!withinEditWindow(message.createdAt)) {
    throw new TRPCError({
      code: "BAD_REQUEST",
      message: "The fifteen minutes for editing this have passed. Post a correction instead.",
    });
  }

  const body = input.body.trim();
  if (body.length === 0) throw new TRPCError({ code: "BAD_REQUEST", message: "Say something." });

  /*
    The mention list is **not** recomputed on an edit.

    Whoever was named has already been told; rewriting the list would either notify somebody about a
    message they were never named in, or quietly erase the record of a notification that did go out.
    Links are re-resolved, because those are navigation rather than a record of who was told.
  */
  const links = await resolveReferences(findRecordReferences(body));

  await db.message.update({
    where: { id: message.id },
    data: { body, editedAt: new Date(), links: links as unknown as Prisma.InputJsonValue },
  });

  return { id: message.id };
}

export async function deleteMessageService(
  actor: ActorMeta,
  input: { messageId: string; canDeleteAny?: boolean },
) {
  const message = await db.message.findFirst({
    where: { id: input.messageId, deletedAt: null },
    select: { id: true, authorId: true, createdAt: true, channelId: true },
  });
  if (!message) throw new TRPCError({ code: "NOT_FOUND", message: "That message is gone." });

  const isAuthor = message.authorId === actor.actorId;
  if (!isAuthor && !input.canDeleteAny) {
    throw new TRPCError({ code: "FORBIDDEN", message: "That is not your message." });
  }
  if (isAuthor && !input.canDeleteAny && !withinEditWindow(message.createdAt)) {
    throw new TRPCError({
      code: "BAD_REQUEST",
      message: "The fifteen minutes for withdrawing this have passed.",
    });
  }

  await db.$transaction(async (tx) => {
    // Soft, always. A conversation with holes in it cannot be read back as a record of what was
    // decided, and §3 keeps project channels as evidence.
    await tx.message.update({
      where: { id: message.id },
      data: { deletedAt: new Date(), deletedBy: actor.actorId },
    });

    if (!isAuthor) {
      await writeAuditLog(tx, {
        actorId: actor.actorId,
        actorLabel: actor.actorLabel,
        action: "delete",
        entityType: "Message",
        entityId: message.id,
        summary: `Removed somebody else's message from a channel`,
        ip: actor.ip,
        userAgent: actor.userAgent,
        requestId: actor.requestId,
      });
    }
  });

  return { id: message.id };
}

/**
 * §3's promote-to-task: *"any message → task, in one action, carrying the message as the description
 * and linking back."*
 *
 * This is the seam that turns *"can someone check the Cebu delivery"* into something with an owner
 * and a date instead of a line that scrolls away — which is §1's whole complaint, happening in a
 * chat window rather than a meeting room.
 */
export async function promoteMessageService(
  actor: ActorMeta,
  input: {
    messageId: string;
    title: string;
    assigneeId?: string | null;
    dueAt?: Date | null;
  },
) {
  const message = await db.message.findFirst({
    where: { id: input.messageId, deletedAt: null },
    select: {
      id: true,
      body: true,
      authorId: true,
      channelId: true,
      links: true,
      channel: { select: { name: true, entityType: true, entityId: true } },
    },
  });
  if (!message) throw new TRPCError({ code: "NOT_FOUND", message: "That message is gone." });

  const authors = await db.user.findMany({
    where: { id: message.authorId },
    select: { name: true },
  });
  const authorName = authors[0]?.name ?? "somebody";

  /*
    Where the task hangs.

    The channel's own record first — a project channel's tasks belong to that project. Otherwise the
    first record the message itself mentioned, which is how a passing "AIESSO-261561 is short two
    valves" becomes a task on that order. Failing both, an unattached task, which is legitimate.
  */
  const links = (Array.isArray(message.links) ? message.links : []) as unknown as {
    entityType: string;
    entityId: string;
  }[];
  const usable = (entityType: string | null | undefined) =>
    !!entityType && (TASK_ENTITY_TYPES as readonly string[]).includes(entityType);

  const from = usable(message.channel.entityType)
    ? { entityType: message.channel.entityType!, entityId: message.channel.entityId! }
    : (links.find((link) => usable(link.entityType)) ?? null);

  const task = await createTaskService(actor, {
    title: input.title,
    description: `From ${authorName} in "${message.channel.name}":\n\n${message.body}`.slice(
      0,
      4000,
    ),
    entityType: from?.entityType ?? null,
    entityId: from?.entityId ?? null,
    assigneeId: input.assigneeId ?? null,
    dueAt: input.dueAt ?? null,
  });

  // The channel says out loud that the work was captured, so the same request is not raised twice
  // by somebody scrolling past it later.
  await postMessageService(
    { ...actor, actorLabel: actor.actorLabel },
    {
      channelId: message.channelId,
      body: `Raised ${task.number} from this: ${input.title}`,
      threadRootId: message.id,
    },
  );

  return task;
}

/** §3's message search, scoped by what the reader may see. */
export async function searchMessagesService(viewerId: string, input: { query: string }) {
  const query = input.query.trim();
  if (query.length < 2) return [];

  const readable = await db.channel.findMany({
    where: { deletedAt: null, OR: [{ isPrivate: false }, { memberIds: { has: viewerId } }] },
    select: { id: true, name: true },
  });
  const byId = new Map(readable.map((channel) => [channel.id, channel.name]));

  const messages = await db.message.findMany({
    where: {
      deletedAt: null,
      channelId: { in: [...byId.keys()] },
      body: { contains: query, mode: "insensitive" },
    },
    orderBy: { createdAt: "desc" },
    take: 50,
    select: {
      id: true,
      body: true,
      authorId: true,
      channelId: true,
      createdAt: true,
      threadRootId: true,
    },
  });

  const authors = await db.user.findMany({
    where: { id: { in: [...new Set(messages.map((message) => message.authorId))] } },
    select: { id: true, name: true },
  });
  const names = new Map(authors.map((author) => [author.id, author.name]));

  return messages.map((message) => ({
    ...message,
    channelName: byId.get(message.channelId) ?? "",
    authorName: names.get(message.authorId) ?? "somebody",
  }));
}

/**
 * §3's automatic channels, driven by module 04's events.
 *
 * Projects get one always. Tickets get one **only when they are `high` or `emergency`** — §3 is
 * explicit that routine deliveries must not each open a channel *"or the channel list becomes
 * noise"*, and routine coordination belongs on the ticket's own activity feed.
 */
export async function ensureProjectChannel(projectId: string) {
  const existing = await db.channel.findFirst({
    where: { entityType: "Project", entityId: projectId, deletedAt: null },
    select: { id: true },
  });
  if (existing) return existing.id;

  const project = await db.project.findFirst({
    where: { id: projectId, deletedAt: null },
    select: { id: true, code: true, name: true, projectManagerId: true, teamMemberIds: true },
  });
  if (!project) return null;

  // §3: the channel "includes the project team". The manager and the crew as the project records
  // them — not everybody, because a project channel the whole company is in is a company channel.
  const memberIds = [
    ...new Set(
      [project.projectManagerId, ...project.teamMemberIds].filter((id): id is string => !!id),
    ),
  ];

  const channel = await db.channel.create({
    data: {
      name: `${project.code} ${project.name}`.slice(0, 60),
      description: "Opened with the project. Archives read-only when it closes.",
      type: "project",
      entityType: "Project",
      entityId: project.id,
      memberIds,
      createdById: "system",
      members: { create: memberIds.map((userId) => ({ userId })) },
    },
  });

  return channel.id;
}

export async function ensureTicketChannel(ticketId: string) {
  const ticket = await db.ticket.findFirst({
    where: { id: ticketId, deletedAt: null },
    select: {
      id: true,
      number: true,
      priority: true,
      title: true,
      assignedLeadId: true,
      assignedUserIds: true,
    },
  });
  if (!ticket) return null;
  // The rule §3 states, and the reason it states it.
  if (ticket.priority !== "high" && ticket.priority !== "emergency") return null;

  const existing = await db.channel.findFirst({
    where: { entityType: "Ticket", entityId: ticket.id, deletedAt: null },
    select: { id: true },
  });
  if (existing) return existing.id;

  const ticketMembers = [
    ...new Set(
      [ticket.assignedLeadId, ...ticket.assignedUserIds].filter((id): id is string => !!id),
    ),
  ];

  const channel = await db.channel.create({
    data: {
      name: `${ticket.number} ${ticket.title}`.slice(0, 60),
      description: `Opened because this ticket is ${ticket.priority}.`,
      type: "project",
      entityType: "Ticket",
      entityId: ticket.id,
      memberIds: ticketMembers,
      createdById: "system",
      members: { create: ticketMembers.map((userId) => ({ userId })) },
    },
  });

  return channel.id;
}

/** A closed project's channel becomes part of its record: readable forever, writable never. */
export async function archiveProjectChannel(projectId: string) {
  const channel = await db.channel.findFirst({
    where: { entityType: "Project", entityId: projectId, deletedAt: null, archivedAt: null },
    select: { id: true },
  });
  if (!channel) return null;

  await db.channel.update({ where: { id: channel.id }, data: { archivedAt: new Date() } });
  return channel.id;
}

/**
 * Renaming a channel, changing who is in it, archiving one by hand.
 *
 * Behind `channel.manage` rather than open to the channel's members, because all three act on other
 * people's access. Archiving in particular ends a conversation for everybody, and §3's archives are
 * permanent: a channel that could be archived by anybody in it, and never reopened by them, is a way
 * to lose a discussion by accident.
 *
 * Restoring is allowed and audited. Archiving by hand is a judgement about whether a conversation is
 * finished, and judgements are sometimes wrong — unlike a project closing, which is a fact.
 */
export async function updateChannelService(
  actor: ActorMeta,
  input: {
    channelId: string;
    name?: string;
    description?: string | null;
    addMemberIds?: string[];
    removeMemberIds?: string[];
    archived?: boolean;
  },
) {
  const channel = await db.channel.findFirst({
    where: { id: input.channelId, deletedAt: null },
    select: {
      id: true,
      name: true,
      type: true,
      isPrivate: true,
      memberIds: true,
      archivedAt: true,
      entityType: true,
    },
  });
  if (!channel) throw new TRPCError({ code: "NOT_FOUND", message: "That channel is gone." });

  const name = input.name?.trim() ?? channel.name;
  const check = checkChannel({
    name,
    type: channel.type as ChannelType,
    memberIds: channel.memberIds,
    isPrivate: channel.isPrivate,
  });
  if (!check.ok) throw new TRPCError({ code: "BAD_REQUEST", message: check.errors.join(" ") });

  const memberIds = [...new Set([...channel.memberIds, ...(input.addMemberIds ?? [])])].filter(
    (id) => !(input.removeMemberIds ?? []).includes(id),
  );

  if (channel.isPrivate && memberIds.length === 0) {
    // Emptying a private channel would leave a conversation nobody on earth can open.
    throw new TRPCError({
      code: "BAD_REQUEST",
      message: "A private channel cannot be emptied of its last member.",
    });
  }

  const archivedAt =
    input.archived === undefined
      ? channel.archivedAt
      : input.archived
        ? (channel.archivedAt ?? new Date())
        : null;

  await db.$transaction(async (tx) => {
    await tx.channel.update({
      where: { id: channel.id },
      data: {
        name,
        ...(input.description === undefined
          ? {}
          : { description: input.description?.trim() || null }),
        memberIds,
        archivedAt,
      },
    });

    for (const userId of input.addMemberIds ?? []) {
      if (channel.memberIds.includes(userId)) continue;
      await tx.channelMember.create({ data: { channelId: channel.id, userId } });
    }
    if ((input.removeMemberIds ?? []).length > 0) {
      await tx.channelMember.deleteMany({
        where: { channelId: channel.id, userId: { in: input.removeMemberIds } },
      });
    }

    const what: string[] = [];
    if (input.name && input.name.trim() !== channel.name) what.push(`renamed it to "${name}"`);
    if ((input.addMemberIds ?? []).length > 0) what.push("added members");
    if ((input.removeMemberIds ?? []).length > 0) what.push("removed members");
    if (input.archived === true && !channel.archivedAt)
      what.push("archived it — nothing more can be posted");
    if (input.archived === false && channel.archivedAt) what.push("reopened it");

    await writeAuditLog(tx, {
      actorId: actor.actorId,
      actorLabel: actor.actorLabel,
      action: "update",
      entityType: CHANNEL_ENTITY_TYPE,
      entityId: channel.id,
      summary:
        what.length > 0
          ? `On "${channel.name}": ${what.join(", ")}`
          : `Changed the channel "${channel.name}"`,
      ip: actor.ip,
      userAgent: actor.userAgent,
      requestId: actor.requestId,
    });
  });

  return { id: channel.id, archived: !!archivedAt };
}
