import { TRPCError } from "@trpc/server";
import { db } from "@/lib/db";
import { writeAuditLog } from "@/server/core/audit/audit";
import type { ActorMeta } from "@/server/core/crm/account-service";
import "./accreditation-access";
import {
  assertCanBeAccredited,
  assessAccreditation,
  type AccreditationStatus,
} from "./accreditation-rules";

/**
 * specs/01-crm-inquiry.md §5b — customer accreditation.
 *
 * AIES being accredited *by* a customer, so that customer will issue it a PO. Not ISO 9001 clause
 * 8.4 supplier approval, which points the other way and lives in spec 08 §5.
 */

export {
  ACCREDITATION_ENTITY_TYPE,
  ACCREDITATION_STATUSES,
  assertCanBeAccredited,
  assessAccreditation,
  RENEWAL_WARNING_DAYS,
  type AccreditationHealth,
  type AccreditationStatus,
} from "./accreditation-rules";

// ---- writes ----------------------------------------------------------------------------------

export async function getAccreditationForAccount(accountId: string) {
  return db.accreditationRecord.findFirst({ where: { accountId, deletedAt: null } });
}

export async function startAccreditationService(
  actor: ActorMeta,
  input: { accountId: string; ownerId?: string | null },
) {
  return db.$transaction(async (tx) => {
    const account = await tx.customerAccount.findFirst({
      where: { id: input.accountId, deletedAt: null },
      select: { id: true, code: true, name: true },
    });
    if (!account) {
      throw new TRPCError({ code: "NOT_FOUND", message: "That account no longer exists." });
    }

    const existing = await tx.accreditationRecord.findFirst({
      where: { accountId: input.accountId, deletedAt: null },
      select: { id: true },
    });
    if (existing) {
      throw new TRPCError({
        code: "CONFLICT",
        message: "This customer already has an accreditation record.",
      });
    }

    const record = await tx.accreditationRecord.create({
      data: {
        accountId: input.accountId,
        status: "preparing",
        // §5b: PD owns this work, so it defaults to whoever started it rather than the account's
        // sales owner.
        ownerId: input.ownerId ?? actor.actorId,
      },
    });

    await writeAuditLog(tx, {
      actorId: actor.actorId,
      actorLabel: actor.actorLabel,
      action: "create",
      entityType: "AccreditationRecord",
      entityId: record.id,
      summary: `Started accreditation for ${account.code} — ${account.name}`,
      ip: actor.ip,
      userAgent: actor.userAgent,
      requestId: actor.requestId,
    });

    return record;
  });
}

export interface UpdateAccreditationInput {
  accreditationId: string;
  status?: AccreditationStatus;
  submittedAt?: string | null;
  accreditedAt?: string | null;
  expiresAt?: string | null;
  referenceNumber?: string | null;
  customerPortalUrl?: string | null;
  customerContactId?: string | null;
  rejectionReason?: string | null;
  notes?: string | null;
  ownerId?: string | null;
  /** FileObject id of the customer-issued certificate. */
  certificateFileId?: string | null;
}

export async function updateAccreditationService(
  actor: ActorMeta,
  input: UpdateAccreditationInput,
) {
  return db.$transaction(async (tx) => {
    const before = await tx.accreditationRecord.findFirst({
      where: { id: input.accreditationId, deletedAt: null },
      include: { account: { select: { code: true, name: true } } },
    });
    if (!before) {
      throw new TRPCError({ code: "NOT_FOUND", message: "That accreditation no longer exists." });
    }

    // Marking accredited is a claim that this customer will issue a PO, so it needs evidence.
    // Checked against the values *after* this update, not the stored ones, so uploading the
    // certificate and setting accredited in one save works.
    if (input.status === "accredited") {
      const gate = assertCanBeAccredited({
        certificateFileId:
          input.certificateFileId !== undefined
            ? input.certificateFileId
            : before.certificateFileId,
        expiresAt: input.expiresAt !== undefined ? input.expiresAt : before.expiresAt,
      });
      if (!gate.ok) {
        throw new TRPCError({ code: "BAD_REQUEST", message: gate.reasons.join(" ") });
      }
    }

    if (input.status === "rejected" && !(input.rejectionReason ?? before.rejectionReason)) {
      // Without the reason the record cannot be acted on later, which is the same failure §3
      // guards against for lost inquiries.
      throw new TRPCError({
        code: "BAD_REQUEST",
        message: "A rejected accreditation needs a reason.",
      });
    }

    const data: Record<string, unknown> = {};
    const diff: Record<string, { from: unknown; to: unknown }> = {};

    if (input.status !== undefined && input.status !== before.status) {
      diff.status = { from: before.status, to: input.status };
      data.status = input.status;
    }
    if (
      input.certificateFileId !== undefined &&
      input.certificateFileId !== before.certificateFileId
    ) {
      diff.certificateFileId = { from: before.certificateFileId, to: input.certificateFileId };
      data.certificateFileId = input.certificateFileId;
      // Stamped server-side: when the evidence arrived is itself part of the evidence.
      data.certificateUploadedAt = input.certificateFileId ? new Date() : null;
    }
    for (const field of [
      "referenceNumber",
      "customerPortalUrl",
      "customerContactId",
      "rejectionReason",
      "notes",
      "ownerId",
    ] as const) {
      const next = input[field];
      if (next === undefined) continue;
      if (before[field] !== next) diff[field] = { from: before[field], to: next };
      data[field] = next;
    }
    for (const field of ["submittedAt", "accreditedAt", "expiresAt"] as const) {
      const next = input[field];
      if (next === undefined) continue;
      const parsed = next === null ? null : new Date(next);
      const beforeIso = before[field]?.toISOString() ?? null;
      const nextIso = parsed?.toISOString() ?? null;
      if (beforeIso !== nextIso) diff[field] = { from: beforeIso, to: nextIso };
      data[field] = parsed;
    }

    const record = await tx.accreditationRecord.update({
      where: { id: input.accreditationId },
      data,
    });

    await writeAuditLog(tx, {
      actorId: actor.actorId,
      actorLabel: actor.actorLabel,
      action: "update",
      entityType: "AccreditationRecord",
      entityId: record.id,
      summary: `Updated accreditation for ${before.account.code} — ${before.account.name}`,
      diff: Object.keys(diff).length > 0 ? diff : undefined,
      ip: actor.ip,
      userAgent: actor.userAgent,
      requestId: actor.requestId,
    });

    return record;
  });
}

/** Every accreditation, newest concern first — the register PD works from. */
export async function listAccreditationsService() {
  const rows = await db.accreditationRecord.findMany({
    where: { deletedAt: null },
    include: { account: { select: { id: true, code: true, name: true } } },
    orderBy: { updatedAt: "desc" },
  });

  return rows.map((row) => ({
    id: row.id,
    accountId: row.accountId,
    account: row.account,
    status: row.status,
    referenceNumber: row.referenceNumber,
    certificateFileId: row.certificateFileId,
    expiresAt: row.expiresAt,
    ownerId: row.ownerId,
    updatedAt: row.updatedAt,
    health: assessAccreditation(row),
  }));
}
