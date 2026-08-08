import { db } from "@/lib/db";

export interface IndexEntityInput {
  entityType: string;
  entityId: string;
  title: string;
  body?: string;
  href: string;
}

/** A business module calls this (typically from its own event-driven side effect, since
 *  specs/00-foundation.md §7.7 says the index is "refreshed by event subscription") whenever a
 *  record's searchable content changes. */
export function indexEntity(input: IndexEntityInput) {
  return db.searchIndex.upsert({
    where: { entityType_entityId: { entityType: input.entityType, entityId: input.entityId } },
    update: { title: input.title, body: input.body ?? "", href: input.href },
    create: {
      entityType: input.entityType,
      entityId: input.entityId,
      title: input.title,
      body: input.body ?? "",
      href: input.href,
    },
  });
}

export function removeFromIndex(entityType: string, entityId: string) {
  return db.searchIndex.deleteMany({ where: { entityType, entityId } });
}
