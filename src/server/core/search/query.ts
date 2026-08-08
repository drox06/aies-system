import { db } from "@/lib/db";
import { registry as defaultRegistry } from "@/server/core/manifests";
import type { ModuleRegistry, SearchResult } from "@/server/core/module-registry";

interface IndexRow {
  entityType: string;
  entityId: string;
  title: string;
  href: string;
}

async function searchIndexFullText(query: string, limit: number): Promise<IndexRow[]> {
  return db.$queryRaw<IndexRow[]>`
    SELECT "entityType", "entityId", title, href
    FROM "SearchIndex"
    WHERE to_tsvector('english', title || ' ' || body) @@ plainto_tsquery('english', ${query})
    ORDER BY ts_rank(to_tsvector('english', title || ' ' || body), plainto_tsquery('english', ${query})) DESC
    LIMIT ${limit}
  `;
}

/** specs/00-foundation.md §7.7: "pg_trgm fuzzy fallback for part numbers and customer names with
 *  typos" — only consulted when the full-text query comes back empty. */
async function searchIndexFuzzy(query: string, limit: number): Promise<IndexRow[]> {
  return db.$queryRaw<IndexRow[]>`
    SELECT "entityType", "entityId", title, href
    FROM "SearchIndex"
    WHERE title % ${query} OR body % ${query}
    ORDER BY GREATEST(similarity(title, ${query}), similarity(body, ${query})) DESC
    LIMIT ${limit}
  `;
}

/**
 * Merges the indexed (SearchIndex) results with each registered module SearchProvider's own live
 * results (src/server/core/module-registry.ts), deduplicated by entityType+entityId. Takes the
 * registry as a parameter (defaulting to the real singleton) so provider-merging is testable with
 * a fake registry, independent of whatever modules are actually registered at test time.
 */
export async function search(
  query: string,
  limit = 20,
  reg: Pick<ModuleRegistry, "searchProviders"> = defaultRegistry,
): Promise<SearchResult[]> {
  const trimmed = query.trim();
  if (trimmed.length === 0) return [];

  const [indexed, providerResults] = await Promise.all([
    searchIndexFullText(trimmed, limit).then((rows) =>
      rows.length > 0 ? rows : searchIndexFuzzy(trimmed, limit),
    ),
    Promise.all(reg.searchProviders.map((provider) => provider.search(trimmed))).then((lists) =>
      lists.flat(),
    ),
  ]);

  const seen = new Set<string>();
  const merged: SearchResult[] = [];
  for (const result of [...indexed, ...providerResults]) {
    const key = `${result.entityType}:${result.entityId}`;
    if (seen.has(key)) continue;
    seen.add(key);
    merged.push(result);
  }

  return merged.slice(0, limit);
}
