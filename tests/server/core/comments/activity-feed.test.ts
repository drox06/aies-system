import { randomUUID } from "node:crypto";
import { afterEach, describe, expect, it } from "vitest";
import { db } from "@/lib/db";
import { getActivityFeed } from "@/server/core/comments/activity-feed";

const entityType = `test_feed_${randomUUID().replace(/-/g, "")}`;
const entityId = "e1";
const createdCommentIds: string[] = [];
const createdAuditIds: string[] = [];

afterEach(async () => {
  if (createdCommentIds.length > 0) {
    await db.comment.deleteMany({ where: { id: { in: createdCommentIds } } });
    createdCommentIds.length = 0;
  }
  if (createdAuditIds.length > 0) {
    await db.auditLog.deleteMany({ where: { id: { in: createdAuditIds } } });
    createdAuditIds.length = 0;
  }
});

describe("getActivityFeed", () => {
  it("merges comments and audit entries into one chronological stream", async () => {
    const t0 = new Date("2026-08-08T09:00:00Z");
    const t1 = new Date("2026-08-08T09:05:00Z");
    const t2 = new Date("2026-08-08T09:10:00Z");

    const comment = await db.comment.create({
      data: { entityType, entityId, authorId: "u1", body: "first comment", createdAt: t0 },
    });
    createdCommentIds.push(comment.id);

    const audit = await db.auditLog.create({
      data: {
        entityType,
        entityId,
        actorId: "u2",
        actorLabel: "U2",
        action: "update",
        summary: "Changed status to In Progress",
        at: t1,
      },
    });
    createdAuditIds.push(audit.id);

    const comment2 = await db.comment.create({
      data: { entityType, entityId, authorId: "u1", body: "second comment", createdAt: t2 },
    });
    createdCommentIds.push(comment2.id);

    const feed = await getActivityFeed(entityType, entityId);

    expect(feed.map((e) => e.kind)).toEqual(["comment", "audit", "comment"]);
    expect(feed[0]).toMatchObject({ kind: "comment", body: "first comment" });
    expect(feed[1]).toMatchObject({ kind: "audit", summary: "Changed status to In Progress" });
    expect(feed[2]).toMatchObject({ kind: "comment", body: "second comment" });
  }, 30_000);

  it("excludes soft-deleted comments", async () => {
    const comment = await db.comment.create({
      data: {
        entityType,
        entityId: "e2",
        authorId: "u1",
        body: "deleted",
        deletedAt: new Date(),
        deletedBy: "u1",
      },
    });
    createdCommentIds.push(comment.id);

    const feed = await getActivityFeed(entityType, "e2");
    expect(feed).toHaveLength(0);
  }, 30_000);
});
