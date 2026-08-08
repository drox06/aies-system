import { db } from "@/lib/db";

export type ActivityEntry =
  | {
      kind: "comment";
      id: string;
      at: Date;
      authorId: string;
      authorLabel: string;
      body: string;
      editedAt: Date | null;
      parentId: string | null;
    }
  | { kind: "audit"; id: string; at: Date; actorLabel: string; action: string; summary: string };

/**
 * specs/00-foundation.md §7.6: "<ActivityFeed /> merges comments + audit entries + status changes
 * into one chronological stream." Status changes ride along as ordinary AuditLog rows (e.g. a
 * future "approved" action) rather than a third, separate concept.
 */
export async function getActivityFeed(
  entityType: string,
  entityId: string,
): Promise<ActivityEntry[]> {
  const [comments, auditRows] = await Promise.all([
    db.comment.findMany({
      where: { entityType, entityId, deletedAt: null },
      orderBy: { createdAt: "asc" },
    }),
    db.auditLog.findMany({ where: { entityType, entityId }, orderBy: { at: "asc" } }),
  ]);

  // Comment.authorId is a plain id (same decoupled-from-User convention as AuditLog.actorId /
  // EventOutbox.actorId), so authors are resolved here rather than via a schema relation.
  const authorIds = [...new Set(comments.map((c) => c.authorId))];
  const authors = await db.user.findMany({
    where: { id: { in: authorIds } },
    select: { id: true, name: true },
  });
  const authorLabelById = new Map(authors.map((a) => [a.id, a.name]));

  const entries: ActivityEntry[] = [
    ...comments.map((c): ActivityEntry => ({
      kind: "comment",
      id: c.id,
      at: c.createdAt,
      authorId: c.authorId,
      authorLabel: authorLabelById.get(c.authorId) ?? c.authorId,
      body: c.body,
      editedAt: c.editedAt,
      parentId: c.parentId,
    })),
    ...auditRows.map((a): ActivityEntry => ({
      kind: "audit",
      id: a.id,
      at: a.at,
      actorLabel: a.actorLabel,
      action: a.action,
      summary: a.summary,
    })),
  ];

  return entries.sort((a, b) => a.at.getTime() - b.at.getTime());
}
