import { randomUUID } from "node:crypto";
import { afterAll, describe, expect, it } from "vitest";
import { db } from "@/lib/db";
import {
  ANNOUNCEMENT_NOTIFICATION_TYPE,
  acknowledgeAnnouncementService,
  acknowledgementListService,
  announcementsService,
  publishAnnouncementService,
} from "@/server/core/collab/announcement-service";

/**
 * §5's announcements against the real database.
 *
 * ## What is pinned
 *
 *  1. **Everybody addressed is told.**
 *  2. **The compliance list names who has *not* read it**, computed from the audience now — so
 *     somebody who joined after publication is still on the hook and somebody who left is not still
 *     being chased.
 *  3. **Acknowledging twice does not make two records**, or the list becomes ambiguous about when
 *     somebody actually read it.
 *  4. **An expired notice keeps its acknowledgements.** ISO clause 7.4 asks who was told, not who is
 *     still being told.
 *  5. **A notice too short to stand on its own is refused**, because the tick becomes evidence of
 *     having read it.
 */

const suffix = randomUUID().slice(0, 8);
const meta = (id: string, label: string) => ({
  actorId: id,
  actorLabel: label,
  ip: null,
  userAgent: null,
  requestId: null,
});

const announcementIds: string[] = [];
const userIds: string[] = [];

const BODY =
  "The lifting procedure has been revised. Read the new method statement before the next job.";

async function makeUser(name: string, roleKey = "viewer") {
  const role = await db.role.findUniqueOrThrow({ where: { key: roleKey } });
  const user = await db.user.create({
    data: {
      name: `${name} ${suffix}`,
      email: `ann-${randomUUID().slice(0, 8)}@test.local`,
      passwordHash: "x",
      isActive: true,
      roles: { create: { roleId: role.id } },
    },
  });
  userIds.push(user.id);
  return user;
}

async function publish(actor: ReturnType<typeof meta>, over: Record<string, unknown> = {}) {
  const announcement = await publishAnnouncementService(actor, {
    title: `Revised procedure ${suffix}`,
    body: BODY,
    requiresAck: true,
    // `viewer` is used throughout: nobody real holds it, so no colleague is notified by a test run.
    audienceRoleKeys: ["viewer"],
    ...over,
  });
  announcementIds.push(announcement.id);
  return announcement;
}

afterAll(async () => {
  const step = async (label: string, run: () => Promise<unknown>) => {
    try {
      await run();
    } catch (error) {
      console.error(`[announcement.test cleanup] ${label} failed`, error);
    }
  };

  await step("notifications", () =>
    db.notification.deleteMany({ where: { entityId: { in: announcementIds } } }),
  );
  await step("audit", () =>
    db.auditLog.deleteMany({ where: { entityId: { in: announcementIds } } }),
  );
  await step("events", () => db.eventOutbox.deleteMany({ where: { actorId: { in: userIds } } }));
  await step("acks", () =>
    db.announcementAck.deleteMany({ where: { announcementId: { in: announcementIds } } }),
  );
  await step("announcements", () =>
    db.announcement.deleteMany({ where: { id: { in: announcementIds } } }),
  );
  await step("user roles", () => db.userRole.deleteMany({ where: { userId: { in: userIds } } }));
  await step("users", () => db.user.deleteMany({ where: { id: { in: userIds } } }));
  await db.$disconnect();
});

describe("publishing", () => {
  it("tells everybody addressed, and not the person who published it", async () => {
    const publisher = await makeUser("Publisher", "viewer");
    const reader = await makeUser("Reader", "viewer");
    const announcement = await publish(meta(publisher.id, publisher.name));

    const told = await db.notification.findMany({
      where: { entityId: announcement.id, type: ANNOUNCEMENT_NOTIFICATION_TYPE },
      select: { recipientId: true },
    });
    const recipients = told.map((row) => row.recipientId);

    expect(recipients).toContain(reader.id);
    // Nobody needs telling about their own notice.
    expect(recipients).not.toContain(publisher.id);
  });

  it("refuses a notice too short to stand on its own", async () => {
    const publisher = await makeUser("Terse", "viewer");
    await expect(
      publishAnnouncementService(meta(publisher.id, publisher.name), {
        title: "Please read",
        body: "See attached",
        requiresAck: true,
      }),
    ).rejects.toThrow(/proof of what they agreed/);
  });

  it("refuses an audience role that does not exist", async () => {
    // A role nobody holds means a notice nobody receives, published as though it had been.
    const publisher = await makeUser("Wrong audience", "viewer");
    await expect(
      publishAnnouncementService(meta(publisher.id, publisher.name), {
        title: `Bad audience ${suffix}`,
        body: BODY,
        audienceRoleKeys: ["welder"],
      }),
    ).rejects.toThrow(/No such role/);
  });
});

describe("the compliance list", () => {
  it("names who has not read it, and does not double-count a second tick", async () => {
    const publisher = await makeUser("Compliance publisher", "viewer");
    const first = await makeUser("Confirms", "viewer");
    await makeUser("Never confirms", "viewer");

    const announcement = await publish(meta(publisher.id, publisher.name));

    const before = await acknowledgementListService({ announcementId: announcement.id });
    // Nobody is pre-loaded as "not read" — the absence of a row is the evidence.
    expect(before.outstanding).toBe(before.people.length);

    await acknowledgeAnnouncementService(meta(first.id, first.name), {
      announcementId: announcement.id,
    });
    await acknowledgeAnnouncementService(meta(first.id, first.name), {
      announcementId: announcement.id,
    });

    const rows = await db.announcementAck.findMany({
      where: { announcementId: announcement.id, userId: first.id },
    });
    // A second tap on a slow connection is not a second reading.
    expect(rows).toHaveLength(1);

    const after = await acknowledgementListService({ announcementId: announcement.id });
    expect(after.outstanding).toBe(before.outstanding - 1);
    expect(
      after.people.find((person) => person.userId === first.id)?.acknowledgedAt,
    ).not.toBeNull();

    // Outstanding first: the list exists to be acted on.
    expect(after.people[0]!.acknowledgedAt).toBeNull();
  });

  it("counts somebody who joins after publication as outstanding", async () => {
    /*
      Computed from the audience *now*, not from a list captured at publication. A technician who
      started last week is still bound by the safety bulletin — and a compliance list that said
      "everybody has read it" would be the most dangerous kind of wrong.
    */
    const publisher = await makeUser("Late-joiner publisher", "viewer");
    const announcement = await publish(meta(publisher.id, publisher.name));

    const before = await acknowledgementListService({ announcementId: announcement.id });
    await makeUser("Joined afterwards", "viewer");
    const after = await acknowledgementListService({ announcementId: announcement.id });

    expect(after.people.length).toBe(before.people.length + 1);
    expect(after.outstanding).toBe(before.outstanding + 1);
  });
});

describe("what a person sees", () => {
  it("counts what is waiting on them, and keeps acknowledgements after expiry", async () => {
    const publisher = await makeUser("Expiry publisher", "viewer");
    const reader = await makeUser("Expiry reader", "viewer");

    const live = await publish(meta(publisher.id, publisher.name));
    const expired = await publish(meta(publisher.id, publisher.name), {
      title: `Old notice ${suffix}`,
      expiresAt: new Date("2020-01-01T00:00:00.000Z"),
    });

    await acknowledgeAnnouncementService(meta(reader.id, reader.name), {
      announcementId: expired.id,
    });

    const view = await announcementsService({ id: reader.id, roleKeys: ["viewer"] });
    const liveRow = view.rows.find((row) => row.id === live.id)!;
    const expiredRow = view.rows.find((row) => row.id === expired.id)!;

    expect(liveRow.current).toBe(true);
    expect(liveRow.acknowledgedAt).toBeNull();
    expect(view.awaitingMe).toBeGreaterThanOrEqual(1);

    // Off the current list, and the evidence survives it.
    expect(expiredRow.current).toBe(false);
    expect(expiredRow.acknowledgedAt).not.toBeNull();
  });

  it("does not show a notice addressed to somebody else", async () => {
    const publisher = await makeUser("Targeted publisher", "viewer");
    const announcement = await publish(meta(publisher.id, publisher.name), {
      audienceRoleKeys: ["finance_officer"],
    });

    const view = await announcementsService({ id: publisher.id, roleKeys: ["viewer"] });
    expect(view.rows.some((row) => row.id === announcement.id)).toBe(false);
  });
});
