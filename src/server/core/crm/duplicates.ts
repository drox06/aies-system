import { db } from "@/lib/db";

/**
 * specs/01-crm-inquiry.md §7: "Industrial customers get entered three times with three spellings."
 *
 * Three independent signals, because each catches a different mistake:
 *   - **TIN** — an exact match is near-proof. Two records with one TIN are the same legal entity.
 *   - **Name trigram similarity** — catches "Maynilad Water Services" vs "Maynilad Water Svcs Inc"
 *     and the spelling drift the spec warns about. Uses `pg_trgm`, enabled in module 00's
 *     migration 20260808041300_enable_pg_trgm.
 *   - **Contact email domain** — catches a rename the other two miss: two accounts whose people
 *     all use @maynilad.com.ph are one customer, whatever the records are called.
 *
 * This *warns*, it never blocks. A genuine near-name collision does exist in Philippine industry
 * (several unrelated "... Water District" entities), so the person entering the record is better
 * placed to judge than a similarity threshold is.
 */

/** Below this, trigram similarity is mostly noise on short industrial names. Tuned against the
 *  spec's own example of a real duplicate rather than a general-purpose default. */
const NAME_SIMILARITY_THRESHOLD = 0.4;

export type DuplicateReason = "tin" | "name" | "email_domain";

export interface DuplicateCandidate {
  id: string;
  code: string;
  name: string;
  tin: string | null;
  /** Why this was flagged. A candidate matching on several signals is far more likely real. */
  reasons: DuplicateReason[];
  /** 0–1 trigram score when `name` is among the reasons. */
  nameSimilarity: number | null;
}

export interface DuplicateQuery {
  name: string;
  tin?: string | null;
  /** Any known contact email; only its domain is used. */
  email?: string | null;
  /** Excluded from results — set when re-checking an existing account after an edit. */
  excludeAccountId?: string | null;
}

/** Free public mailboxes say nothing about which company someone works for, so they must never
 *  drive a match — otherwise every account with a gmail contact looks like every other one. */
const PUBLIC_EMAIL_DOMAINS = new Set([
  "gmail.com",
  "yahoo.com",
  "yahoo.com.ph",
  "hotmail.com",
  "outlook.com",
  "live.com",
  "icloud.com",
  "aol.com",
  "protonmail.com",
  "mail.com",
]);

export function emailDomain(email: string | null | undefined): string | null {
  if (!email) return null;
  const at = email.lastIndexOf("@");
  if (at === -1 || at === email.length - 1) return null;
  const domain = email
    .slice(at + 1)
    .trim()
    .toLowerCase();
  if (domain.length === 0 || PUBLIC_EMAIL_DOMAINS.has(domain)) return null;
  return domain;
}

interface RawRow {
  id: string;
  code: string;
  name: string;
  tin: string | null;
  similarity: number | null;
  matched_tin: boolean;
  matched_domain: boolean;
}

export async function findDuplicateAccounts(query: DuplicateQuery): Promise<DuplicateCandidate[]> {
  const name = query.name.trim();
  if (name.length === 0) return [];

  // Normalised so "123-456-789-000" and "123456789000" match: TIN formatting is entered by hand
  // and inconsistently.
  const tin = query.tin?.replace(/\D/g, "") || null;
  const domain = emailDomain(query.email);
  const exclude = query.excludeAccountId ?? "";

  // One query rather than three round-trips. Each signal is computed per row so the caller can be
  // told *why* something matched, which is what makes the warning actionable.
  const rows = await db.$queryRaw<RawRow[]>`
    SELECT
      a.id,
      a.code,
      a.name,
      a.tin,
      similarity(a.name, ${name}) AS similarity,
      (${tin}::text IS NOT NULL
        AND regexp_replace(coalesce(a.tin, ''), '\\D', '', 'g') = ${tin}::text) AS matched_tin,
      (${domain}::text IS NOT NULL AND EXISTS (
        SELECT 1 FROM "Contact" c
        WHERE c."accountId" = a.id
          AND c."deletedAt" IS NULL
          AND lower(split_part(c.email, '@', 2)) = ${domain}::text
      )) AS matched_domain
    FROM "CustomerAccount" a
    WHERE a."deletedAt" IS NULL
      AND a.id <> ${exclude}
      AND (
        similarity(a.name, ${name}) >= ${NAME_SIMILARITY_THRESHOLD}
        OR (${tin}::text IS NOT NULL
            AND regexp_replace(coalesce(a.tin, ''), '\\D', '', 'g') = ${tin}::text)
        OR (${domain}::text IS NOT NULL AND EXISTS (
          SELECT 1 FROM "Contact" c
          WHERE c."accountId" = a.id
            AND c."deletedAt" IS NULL
            AND lower(split_part(c.email, '@', 2)) = ${domain}::text
        ))
      )
    ORDER BY matched_tin DESC, similarity DESC NULLS LAST
    LIMIT 10
  `;

  return rows.map((row) => {
    const reasons: DuplicateReason[] = [];
    if (row.matched_tin) reasons.push("tin");
    if ((row.similarity ?? 0) >= NAME_SIMILARITY_THRESHOLD) reasons.push("name");
    if (row.matched_domain) reasons.push("email_domain");
    return {
      id: row.id,
      code: row.code,
      name: row.name,
      tin: row.tin,
      reasons,
      nameSimilarity: row.similarity === null ? null : Number(row.similarity),
    };
  });
}
