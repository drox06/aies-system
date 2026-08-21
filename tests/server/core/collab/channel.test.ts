import { randomUUID } from "node:crypto";
import { afterAll, describe, expect, it } from "vitest";
import { db } from "@/lib/db";
import {
  MESSAGE_MENTION_NOTIFICATION_TYPE,
  createChannelService,
  editMessageService,
  markReadService,
  messagesService,
  postMessageService,
  promoteMessageService,
  reactService,
  searchMessagesService,
} from "@/server/core/collab/channel-service";
import { createTaskService } from "@/server/core/collab/task-service";

/**
 * §3's channels against the real database.
 *
 * ## What is pinned
 *
 *  1. **A mention reaches the person named.** The whole point of naming somebody.
 *  2. **A document number becomes a link that goes somewhere** — and a number matching nothing stays
 *     plain text rather than becoming a dead card.
 *  3. **Threads are one level deep.** A reply to a reply joins the same thread rather than starting
 *     a tree nobody can follow in a narrow column.
 *  4. **An edit does not rewrite who was told.** They have already been notified; changing the list
 *     afterwards would either notify somebody about a message they were never in, or erase the
 *     record of a notification that did go out.
 *  5. **An archived channel refuses new messages**, because it is part of a closed job's record.
 *  6. **Promote-to-task raises a real task and says so in the channel**, so the same request is not
 *     raised twice by somebody scrolling past it later.
 *  7. **Search does not cross into a private channel** the reader is not in.
 */

const suffix = randomUUID().slice(0, 8);
const meta = (id: string, label: string) => ({
  actorId: id,
  actorLabel: label,
  ip: null,
  userAgent: null,
  requestId: null,
});

const channelIds: string[] = [];
const taskIds: string[] = [];
const userIds: string[] = [];

async function makeUser(name: string) {
  const user = await db.user.create({
    data: {
      name: `${name} ${suffix}`,
      email: `chan-${randomUUID().slice(0, 8)}@test.local`,
      passwordHash: "x",
      isActive: true,
    },
  });
  userIds.push(user.id);
  return user;
}

async function makeChannel(
  actor: ReturnType<typeof meta>,
  input: Parameters<typeof createChannelService>[1],
) {
  const channel = await createChannelService(actor, input);
  channelIds.push(channel.id);
  return channel;
}

afterAll(async () => {
  const step = async (label: string, run: () => Promise<unknown>) => {
    try {
      await run();
    } catch (error) {
      console.error(`[channel.test cleanup] ${label} failed`, error);
    }
  };

  await step("notifications", () =>
    db.notification.deleteMany({ where: { entityId: { in: [...channelIds, ...taskIds] } } }),
  );
  await step("audit", () =>
    db.auditLog.deleteMany({ where: { entityId: { in: [...channelIds, ...taskIds] } } }),
  );
  await step("events", () => db.eventOutbox.deleteMany({ where: { actorId: { in: userIds } } }));
  await step("messages", () => db.message.deleteMany({ where: { channelId: { in: channelIds } } }));
  await step("members", () =>
    db.channelMember.deleteMany({ where: { channelId: { in: channelIds } } }),
  );
  await step("channels", () => db.channel.deleteMany({ where: { id: { in: channelIds } } }));
  await step("tasks", () => db.task.deleteMany({ where: { id: { in: taskIds } } }));
  await step("users", () => db.user.deleteMany({ where: { id: { in: userIds } } }));
  await db.$disconnect();
});

describe("posting", () => {
  it("tells the person who was named, and links the record that was mentioned", async () => {
    const author = await makeUser("Author");
    const named = await makeUser("Named");
    const actor = meta(author.id, author.name);

    // A real record for the message to point at. A task is the cheapest one to make.
    const task = await createTaskService(actor, { title: "Something to refer to" });
    taskIds.push(task.id);

    const channel = await makeChannel(actor, {
      name: `Linking ${suffix}`,
      memberIds: [named.id],
    });

    await postMessageService(actor, {
      channelId: channel.id,
      body: `@${named.name} can you look at ${task.number}, and also AIESSO-000000 which is nothing`,
    });

    const view = await messagesService(author.id, { channelId: channel.id });
    expect(view.messages).toHaveLength(1);

    const message = view.messages[0]!;
    expect(message.mentions).toContain(named.id);
    // Only the number that resolves becomes a card. A dead link is worse than plain text.
    expect(message.links).toHaveLength(1);
    expect(message.links[0]!.entityType).toBe("Task");
    expect(message.links[0]!.entityId).toBe(task.id);

    const told = await db.notification.findMany({
      where: {
        recipientId: named.id,
        type: MESSAGE_MENTION_NOTIFICATION_TYPE,
        entityId: channel.id,
      },
    });
    expect(told).toHaveLength(1);
  });

  it("keeps a thread one level deep", async () => {
    const author = await makeUser("Threader");
    const actor = meta(author.id, author.name);
    const channel = await makeChannel(actor, { name: `Threads ${suffix}` });

    await postMessageService(actor, { channelId: channel.id, body: "The root" });
    const root = (await messagesService(author.id, { channelId: channel.id })).messages[0]!;

    await postMessageService(actor, {
      channelId: channel.id,
      body: "A reply",
      threadRootId: root.id,
    });
    const reply = (
      await messagesService(author.id, { channelId: channel.id, threadRootId: root.id })
    ).messages.find((message) => message.body === "A reply")!;

    // Replying to the reply attaches to the same root, not to the reply.
    await postMessageService(actor, {
      channelId: channel.id,
      body: "A reply to the reply",
      threadRootId: reply.id,
    });

    const thread = await messagesService(author.id, {
      channelId: channel.id,
      threadRootId: root.id,
    });
    expect(thread.messages).toHaveLength(3);

    // And the channel itself still shows one message, with two replies hanging off it.
    const top = await messagesService(author.id, { channelId: channel.id });
    expect(top.messages).toHaveLength(1);
    expect(top.messages[0]!.replyCount).toBe(2);
  });

  it("does not rewrite who was told when a message is edited", async () => {
    const author = await makeUser("Editor");
    const first = await makeUser("First named");
    const second = await makeUser("Second named");
    const actor = meta(author.id, author.name);

    const channel = await makeChannel(actor, {
      name: `Edits ${suffix}`,
      memberIds: [first.id, second.id],
    });

    await postMessageService(actor, {
      channelId: channel.id,
      body: `@${first.name} please check`,
    });
    const message = (await messagesService(author.id, { channelId: channel.id })).messages[0]!;

    await editMessageService(actor, {
      messageId: message.id,
      body: `@${second.name} please check instead`,
    });

    const after = await db.message.findUniqueOrThrow({ where: { id: message.id } });
    /*
      The first person was told and the second was not. Recomputing on edit would either notify
      somebody about a message they were never named in, or quietly erase the record of a
      notification that really did go out.
    */
    expect(after.mentions).toEqual([first.id]);
    expect(after.editedAt).not.toBeNull();

    // Counted by type: the second person is a member on the default `all`, so they were told about
    // the original message. What must not exist is a *mention* — they were named only by the edit.
    const secondNamed = await db.notification.count({
      where: {
        recipientId: second.id,
        entityId: channel.id,
        type: MESSAGE_MENTION_NOTIFICATION_TYPE,
      },
    });
    expect(secondNamed).toBe(0);
  });

  it("refuses a message to an archived channel and says why", async () => {
    const author = await makeUser("Archiver");
    const actor = meta(author.id, author.name);
    const channel = await makeChannel(actor, { name: `Archived ${suffix}` });

    await db.channel.update({ where: { id: channel.id }, data: { archivedAt: new Date() } });

    await expect(
      postMessageService(actor, { channelId: channel.id, body: "One more thing" }),
    ).rejects.toThrow(/archived/i);

    // Still readable — that is the point of archiving rather than deleting.
    const view = await messagesService(author.id, { channelId: channel.id });
    expect(view.channel.canPost).toBe(false);
  });
});

describe("reactions and reading", () => {
  it("toggles a reaction off when the same person taps it again", async () => {
    const author = await makeUser("Reactor");
    const actor = meta(author.id, author.name);
    const channel = await makeChannel(actor, { name: `Reactions ${suffix}` });
    await postMessageService(actor, { channelId: channel.id, body: "Agreed?" });
    const message = (await messagesService(author.id, { channelId: channel.id })).messages[0]!;

    const on = await reactService(actor, { messageId: message.id, emoji: "👍" });
    expect(on.reactions["👍"]).toEqual([author.id]);

    const off = await reactService(actor, { messageId: message.id, emoji: "👍" });
    // The key is removed rather than left as an empty list, so the screen shows nothing at all.
    expect(off.reactions["👍"]).toBeUndefined();
  });

  it("marks a channel read", async () => {
    const author = await makeUser("Reader");
    const actor = meta(author.id, author.name);
    const channel = await makeChannel(actor, { name: `Reading ${suffix}` });

    await markReadService(author.id, { channelId: channel.id });
    const member = await db.channelMember.findFirstOrThrow({
      where: { channelId: channel.id, userId: author.id },
    });
    expect(member.lastReadAt).not.toBeNull();
  });
});

describe("promote to task", () => {
  it("raises a real task and says so in the channel", async () => {
    const author = await makeUser("Asker");
    const doer = await makeUser("Doer");
    const actor = meta(author.id, author.name);

    const channel = await makeChannel(actor, {
      name: `Promoting ${suffix}`,
      memberIds: [doer.id],
    });
    await postMessageService(actor, {
      channelId: channel.id,
      body: "can someone check the Cebu delivery",
    });
    const message = (await messagesService(author.id, { channelId: channel.id })).messages[0]!;

    const task = await promoteMessageService(actor, {
      messageId: message.id,
      title: "Check the Cebu delivery",
      assigneeId: doer.id,
    });
    taskIds.push(task.id);

    const row = await db.task.findUniqueOrThrow({ where: { id: task.id } });
    expect(row.assigneeId).toBe(doer.id);
    // What was said travels with it, so the task is not a title with no context behind it.
    expect(row.description).toContain("can someone check the Cebu delivery");
    expect(row.description).toContain(channel.name);

    /*
      And the channel is told. Without this, the next person to scroll past the question raises the
      same task again — which is the duplicate-work problem this module exists to solve, reproduced
      inside the tool meant to solve it.
    */
    const thread = await messagesService(author.id, {
      channelId: channel.id,
      threadRootId: message.id,
    });
    expect(thread.messages.some((entry) => entry.body.includes(task.number))).toBe(true);
  });
});

describe("privacy", () => {
  it("keeps a private channel out of another person's search and view", async () => {
    const insider = await makeUser("Insider");
    const outsider = await makeUser("Outsider");
    const actor = meta(insider.id, insider.name);

    const channel = await makeChannel(actor, {
      name: `Private ${suffix}`,
      isPrivate: true,
      memberIds: [insider.id],
    });
    const secret = `pineapple-${suffix}`;
    await postMessageService(actor, { channelId: channel.id, body: `the word is ${secret}` });

    expect(await searchMessagesService(insider.id, { query: secret })).toHaveLength(1);
    // Search is scoped by what the reader may see, not filtered afterwards on the screen.
    expect(await searchMessagesService(outsider.id, { query: secret })).toHaveLength(0);

    await expect(messagesService(outsider.id, { channelId: channel.id })).rejects.toThrow(
      /private/i,
    );
  });
});
