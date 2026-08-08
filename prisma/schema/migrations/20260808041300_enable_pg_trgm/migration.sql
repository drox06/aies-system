-- specs/00-foundation.md §7.7: "pg_trgm fuzzy fallback for part numbers and customer names with
-- typos." Not enabled by default on a fresh Supabase Postgres instance.
CREATE EXTENSION IF NOT EXISTS pg_trgm;

-- Speeds up full-text search over SearchIndex once it has real rows in it.
CREATE INDEX IF NOT EXISTS "SearchIndex_fulltext_idx" ON "SearchIndex"
  USING GIN (to_tsvector('english', title || ' ' || body));

-- Speeds up the pg_trgm fuzzy fallback.
CREATE INDEX IF NOT EXISTS "SearchIndex_title_trgm_idx" ON "SearchIndex"
  USING GIN (title gin_trgm_ops);
CREATE INDEX IF NOT EXISTS "SearchIndex_body_trgm_idx" ON "SearchIndex"
  USING GIN (body gin_trgm_ops);
