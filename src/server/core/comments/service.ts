import { db } from "@/lib/db";
import { notify } from "@/server/core/notify/notify";
import { registerNotificationType } from "@/server/core/notify/registry";

// specs/00-foundation.md §7.6: "@mention triggers a notification." Coalesce window matches §7.3's
// own worked example almost exactly ("Ten comments on one quote in five minutes is one
// notification").
registerNotificationType({
  key: "comment.mentioned",
  label: "You were mentioned in a comment",
  /**
   * `email: false` until something consumes the queue.
   *
   * `notify_email` has no handler by design — docs/DECISIONS.md #10 — and every other module sets
   * this false for that reason. This one did not, so in production each @mention would enqueue a job
   * that dies. Found on 2026-08-18: the first drain on the live deployment picked up exactly such a
   * job and dead-lettered it with "No handler registered".
   *
   * The cost is not the wasted row. It is that dead jobs are the pile you look at when something is
   * wrong, and filling it with failures you expect is how a real one goes unnoticed — the same
   * reasoning as DECISIONS #70's warning that always fires.
   *
   * **Turn this back to true when module 10 registers an email handler.** A user who has explicitly
   * chosen email in their preferences still overrides this; only the default changes.
   */
  defaultChannels: { inApp: true, email: false, digest: false },
  coalesceWindowMs: 5 * 60_000,
});

// specs/00-foundation.md §7.6: "Editing is allowed for 15 minutes, then locked." Measured from
// creation, not from the most recent edit — otherwise re-editing just before each deadline would
// keep a comment open indefinitely, which isn't what "15 minutes" is meant to guarantee.
const EDIT_WINDOW_MS = 15 * 60_000;

export interface CreateCommentInput {
  entityType: string;
  entityId: string;
  authorId: string;
  body: string;
  parentId?: string;
  mentions?: string[];
}

export async function createComment(input: CreateCommentInput) {
  const comment = await db.comment.create({
    data: {
      entityType: input.entityType,
      entityId: input.entityId,
      authorId: input.authorId,
      body: input.body,
      parentId: input.parentId,
      mentions: input.mentions ?? [],
    },
  });

  for (const mentionedUserId of comment.mentions) {
    if (mentionedUserId === input.authorId) continue;
    await notify({
      recipientId: mentionedUserId,
      type: "comment.mentioned",
      title: "You were mentioned in a comment",
      body: input.body.slice(0, 200),
      entityType: input.entityType,
      entityId: input.entityId,
    });
  }

  return comment;
}

export async function editComment(commentId: string, authorId: string, newBody: string) {
  return db.$transaction(async (tx) => {
    const comment = await tx.comment.findUniqueOrThrow({ where: { id: commentId } });
    if (comment.deletedAt) {
      throw new Error("Cannot edit a deleted comment.");
    }
    if (comment.authorId !== authorId) {
      throw new Error("Only the author can edit this comment.");
    }
    if (Date.now() - comment.createdAt.getTime() > EDIT_WINDOW_MS) {
      throw new Error("The 15-minute edit window has passed.");
    }

    await tx.commentEdit.create({ data: { commentId, body: comment.body } });

    return tx.comment.update({
      where: { id: commentId },
      data: { body: newBody, editedAt: new Date() },
    });
  });
}

export async function deleteComment(commentId: string, requestedById: string) {
  const comment = await db.comment.findUniqueOrThrow({ where: { id: commentId } });
  if (comment.authorId !== requestedById) {
    throw new Error("Only the author can delete this comment.");
  }
  return db.comment.update({
    where: { id: commentId },
    data: { deletedAt: new Date(), deletedBy: requestedById },
  });
}

export function listComments(entityType: string, entityId: string) {
  return db.comment.findMany({
    where: { entityType, entityId, deletedAt: null },
    orderBy: { createdAt: "asc" },
  });
}
