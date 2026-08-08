import type { Prisma } from "@prisma/client";

export interface DiffEntry {
  from: unknown;
  to: unknown;
}

export type Diff = Record<string, DiffEntry>;

export interface AuditLogInput {
  actorId: string | null;
  actorLabel: string;
  action: string;
  entityType: string;
  entityId: string;
  summary: string;
  diff?: Diff;
  ip?: string | null;
  userAgent?: string | null;
  requestId?: string | null;
}

// specs/00-foundation.md §5: "Sensitive values (password hashes, tokens) are never written to
// diff. Maintain a redaction list." Matched by field name regardless of which entity it came
// from, since new sensitive fields will keep appearing as modules are added.
const REDACTED_FIELD_NAMES = new Set([
  "password",
  "passwordHash",
  "currentPassword",
  "newPassword",
  "tempPassword",
  "totpSecret",
  "token",
  "refresh_token",
  "access_token",
  "id_token",
  "sessionToken",
]);

export function redactDiff(diff: Diff | undefined): Diff | undefined {
  if (!diff) return diff;

  const redacted: Diff = {};
  for (const [field, entry] of Object.entries(diff)) {
    redacted[field] = REDACTED_FIELD_NAMES.has(field)
      ? { from: "[redacted]", to: "[redacted]" }
      : entry;
  }
  return redacted;
}

/**
 * Must be called with the same transaction client as the business change it records — never the
 * top-level `db` — so a failed audit write rolls back the change with it (specs/00-foundation.md
 * §5: "If the audit write fails, the change rolls back. This is non-negotiable for ISO evidence.")
 */
export async function writeAuditLog(
  tx: Prisma.TransactionClient,
  input: AuditLogInput,
): Promise<void> {
  await tx.auditLog.create({
    data: {
      actorId: input.actorId,
      actorLabel: input.actorLabel,
      action: input.action,
      entityType: input.entityType,
      entityId: input.entityId,
      summary: input.summary,
      diff: (redactDiff(input.diff) ?? undefined) as Prisma.InputJsonValue | undefined,
      ip: input.ip ?? null,
      userAgent: input.userAgent ?? null,
      requestId: input.requestId ?? null,
    },
  });
}
