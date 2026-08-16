import { randomUUID } from "node:crypto";
import { db } from "@/lib/db";
import { parseFormat } from "./format";

export interface AllocateOptions {
  extra?: Record<string, string>;
  now?: Date;
}

async function resolveFormat(documentType: string) {
  const row = await db.numberingFormat.findUnique({ where: { documentType } });
  if (!row) {
    throw new Error(`No numbering format configured for document type "${documentType}".`);
  }
  return row.format;
}

/**
 * Refuses to issue a number when a format's *shape* has changed and nothing has reconciled the
 * counters.
 *
 * ## The failure this exists to make impossible
 *
 * A counter's identity is `(documentType, scopeKey)` and `scopeKey` is **derived from the format**.
 * So changing a format's shape does not move the counter — it mints a *new* one, starting at zero.
 * On 2026-08-16 the inquiry format lost its `{MM}` (`INQ-{YY}{MM}-{####}` → `AIESINQ-{YY}{####}`),
 * which moved its counter from scope `26:08` to scope `26`. Scope `26` had no row. The next inquiry
 * would have been issued `AIESINQ-260001` — a number already on a record — and the unique index
 * would have rejected it in a salesperson's face while they were logging a customer's call.
 *
 * ## Why the check has to look at siblings rather than at this row
 *
 * The dangerous case is precisely the one where **this scope has no row yet**, so there is nothing
 * on it to compare. And a brand-new scope is otherwise indistinguishable from a legitimate January
 * rollover, which must keep working without ceremony.
 *
 * The discriminator is the *other* scopes of the same document type. If they all carry today's
 * format, a new scope is a new period — start at 1, correct. If any carries a different one, the
 * shape moved underneath the counters and they have not been reconciled — refuse, before a number
 * is issued rather than after.
 *
 * A refusal is recoverable in one command; a duplicate number is not. `scripts/renumber-*.ts` and
 * `scripts/reset-numbering-counters.ts` are the reconciliation, and the latter stamps the new format
 * on every row, which clears this.
 */
async function assertFormatUnchanged(documentType: string, format: string): Promise<void> {
  const rows = await db.documentSequence.findMany({
    where: { documentType },
    select: { scopeKey: true, format: true },
  });

  // A row with no recorded format predates this column and cannot be judged; the migration
  // backfilled every one that existed, so in practice this is only a row written by an older build.
  const stale = rows.filter((row) => row.format !== null && row.format !== format);
  if (stale.length === 0) return;

  throw new Error(
    `The numbering format for "${documentType}" has changed to "${format}", but ` +
      `${stale.length} counter(s) are still on "${stale[0]!.format}" ` +
      `(scope ${stale.map((row) => row.scopeKey).join(", ")}). Issuing a number now could ` +
      `duplicate one that already exists, because a format change starts a fresh counter at zero. ` +
      `Reconcile first: \`npx tsx scripts/reset-numbering-counters.ts --apply\`.`,
  );
}

/**
 * Allocates and consumes the next number for `documentType` (Spec.md §5). The insert is a single
 * atomic upsert-increment (`ON CONFLICT ... DO UPDATE ... RETURNING`) rather than a separate
 * `SELECT ... FOR UPDATE` + `UPDATE` — Postgres serialises concurrent writers on the same row
 * either way; this is the same proven pattern as src/server/core/rate-limit.ts's bucket upsert.
 * Numbers are never reused or reordered; gaps (e.g. from a rolled-back transaction) are permitted.
 */
export async function allocateNumber(
  documentType: string,
  options: AllocateOptions = {},
): Promise<string> {
  const now = options.now ?? new Date();
  const extra = options.extra ?? {};

  const format = await resolveFormat(documentType);
  const parsed = parseFormat(format, now, extra);
  const scopeKey = parsed.scopeParts.join(":");
  const id = randomUUID();

  // Before anything is consumed. A refusal costs a command; a duplicate number costs a document.
  await assertFormatUnchanged(documentType, format);

  const rows = await db.$queryRaw<{ counter: number }[]>`
    INSERT INTO "DocumentSequence" (id, "documentType", "scopeKey", counter, "updatedAt", "format")
    VALUES (${id}, ${documentType}, ${scopeKey}, 1, now(), ${format})
    ON CONFLICT ("documentType", "scopeKey") DO UPDATE SET
      counter = "DocumentSequence".counter + 1,
      "updatedAt" = now(),
      -- Stamped on every advance, so a row can never drift from the format that produced it.
      "format" = ${format}
    RETURNING counter
  `;

  const counter = rows[0]?.counter;
  if (counter === undefined) {
    throw new Error("Numbering allocation returned no row.");
  }

  return parsed.render(counter);
}

/** Peeks the next number without consuming it — for showing "this will be QTN-2608-0043" in the UI. */
export async function previewNumber(
  documentType: string,
  options: AllocateOptions = {},
): Promise<string> {
  const now = options.now ?? new Date();
  const extra = options.extra ?? {};

  const format = await resolveFormat(documentType);
  const parsed = parseFormat(format, now, extra);
  const scopeKey = parsed.scopeParts.join(":");

  const existing = await db.documentSequence.findUnique({
    where: { documentType_scopeKey: { documentType, scopeKey } },
  });

  return parsed.render((existing?.counter ?? 0) + 1);
}
