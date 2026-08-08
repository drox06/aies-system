import { randomUUID } from "node:crypto";
import { afterEach, describe, expect, it } from "vitest";
import { db } from "@/lib/db";
import {
  createComment,
  deleteComment,
  editComment,
  listComments,
} from "@/server/core/comments/service";

const entityType = `test_thread_${randomUUID().replace(/-/g, "")}`;
const createdCommentIds: string[] = [];
const notifiedUserId = `test-mention-target-${randomUUID()}`;

afterEach(async () => {
  if (createdCommentIds.length > 0) {
    await db.commentEdit.deleteMany({ where: { commentId: { in: createdCommentIds } } });
    await db.comment.deleteMany({ where: { id: { in: createdCommentIds } } });
    createdCommentIds.length = 0;
  }
  await db.notification.deleteMany({ where: { recipientId: notifiedUserId } });
});

describe("createComment", () => {
  it("creates a comment and it appears in listComments", async () => {
    const comment = await createComment({
      entityType,
      entityId: "e1",
      authorId: "author1",
      body: "Hello there",
    });
    createdCommentIds.push(comment.id);

    const list = await listComments(entityType, "e1");
    expect(list.map((c) => c.id)).toContain(comment.id);
  }, 30_000);

  it("notifies mentioned users (not the author themselves)", async () => {
    const comment = await createComment({
      entityType,
      entityId: "e2",
      authorId: "author1",
      body: `Hey @you`,
      mentions: [notifiedUserId, "author1"],
    });
    createdCommentIds.push(comment.id);

    const notifications = await db.notification.findMany({
      where: { recipientId: notifiedUserId },
    });
    expect(notifications).toHaveLength(1);
    expect(notifications[0]?.type).toBe("comment.mentioned");

    const selfNotifications = await db.notification.findMany({ where: { recipientId: "author1" } });
    expect(selfNotifications).toHaveLength(0);
  }, 30_000);
});

describe("editComment", () => {
  it("allows the author to edit within the 15-minute window, keeping history", async () => {
    const comment = await createComment({
      entityType,
      entityId: "e3",
      authorId: "author1",
      body: "original",
    });
    createdCommentIds.push(comment.id);

    const edited = await editComment(comment.id, "author1", "updated");
    expect(edited.body).toBe("updated");
    expect(edited.editedAt).not.toBeNull();

    const history = await db.commentEdit.findMany({ where: { commentId: comment.id } });
    expect(history).toHaveLength(1);
    expect(history[0]?.body).toBe("original");
  }, 30_000);

  it("rejects an edit from someone other than the author", async () => {
    const comment = await createComment({
      entityType,
      entityId: "e4",
      authorId: "author1",
      body: "original",
    });
    createdCommentIds.push(comment.id);

    await expect(editComment(comment.id, "someone-else", "hijacked")).rejects.toThrow(
      /Only the author/,
    );
  }, 30_000);

  it("rejects an edit after the 15-minute window has passed", async () => {
    const comment = await createComment({
      entityType,
      entityId: "e5",
      authorId: "author1",
      body: "original",
    });
    createdCommentIds.push(comment.id);

    await db.comment.update({
      where: { id: comment.id },
      data: { createdAt: new Date(Date.now() - 20 * 60_000) },
    });

    await expect(editComment(comment.id, "author1", "too late")).rejects.toThrow(
      /edit window has passed/,
    );
  }, 30_000);
});

describe("deleteComment", () => {
  it("soft-deletes and excludes it from listComments", async () => {
    const comment = await createComment({
      entityType,
      entityId: "e6",
      authorId: "author1",
      body: "delete me",
    });
    createdCommentIds.push(comment.id);

    const deleted = await deleteComment(comment.id, "author1");
    expect(deleted.deletedAt).not.toBeNull();
    expect(deleted.deletedBy).toBe("author1");

    const list = await listComments(entityType, "e6");
    expect(list.map((c) => c.id)).not.toContain(comment.id);
  }, 30_000);

  it("rejects deletion from someone other than the author", async () => {
    const comment = await createComment({
      entityType,
      entityId: "e7",
      authorId: "author1",
      body: "keep me",
    });
    createdCommentIds.push(comment.id);

    await expect(deleteComment(comment.id, "someone-else")).rejects.toThrow(/Only the author/);
  }, 30_000);
});
