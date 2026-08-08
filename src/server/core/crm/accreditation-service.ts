import { TRPCError } from "@trpc/server";
import { db } from "@/lib/db";
import { writeAuditLog } from "@/server/core/audit/audit";
import type { ActorMeta } from "@/server/core/crm/account-service";
import {
  accreditationRequirementsSchema,
  assessAccreditation,
  defaultRequirements,
  parseRequirements,
  type AccreditationRequirement,
  type AccreditationStatus,
} from "./accreditation-rules";

/**
 * specs/01-crm-inquiry.md §5b — customer accreditation.
 *
 * AIES being accredited *by* a customer, so that customer will issue it a PO. Not ISO 9001 clause
 * 8.4 supplier approval, which points the other way and lives in spec 08 §5.
 */

export {
  ACCREDITATION_STATUSES,
  accreditationRequirementSchema,
  accreditationRequirementsSchema,
  assessAccreditation,
  DEFAULT_ACCREDITATION_REQUIREMENTS,
  defaultRequirements,
  parseRequirements,
  RENEWAL_WARNING_DAYS,
  type AccreditationHealth,
  type AccreditationRequirement,
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
        requirements: defaultRequirements(),
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
  requirements?: AccreditationRequirement[];
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
    if (input.requirements !== undefined) {
      const parsed = accreditationRequirementsSchema.parse(input.requirements);
      // The whole checklist is one field, so a per-row diff would be noise. Record the counts that
      // matter for the evidence trail instead.
      const beforeList = parseRequirements(before.requirements);
      diff.requirements = {
        from: `${beforeList.length} items, ${beforeList.filter((r) => r.acceptedAt).length} accepted`,
        to: `${parsed.length} items, ${parsed.filter((r) => r.acceptedAt).length} accepted`,
      };
      data.requirements = parsed;
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
    expiresAt: row.expiresAt,
    ownerId: row.ownerId,
    updatedAt: row.updatedAt,
    health: assessAccreditation(row),
  }));
}
