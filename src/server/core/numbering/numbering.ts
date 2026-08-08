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

  const rows = await db.$queryRaw<{ counter: number }[]>`
    INSERT INTO "DocumentSequence" (id, "documentType", "scopeKey", counter, "updatedAt")
    VALUES (${id}, ${documentType}, ${scopeKey}, 1, now())
    ON CONFLICT ("documentType", "scopeKey") DO UPDATE SET
      counter = "DocumentSequence".counter + 1,
      "updatedAt" = now()
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
