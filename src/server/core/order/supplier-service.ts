import { TRPCError } from "@trpc/server";
import type { Prisma, PrismaClient } from "@prisma/client";
import { db } from "@/lib/db";
import { writeAuditLog } from "@/server/core/audit/audit";
import type { ActorMeta } from "@/server/core/crm/account-service";
import { allocateNumber } from "@/server/core/numbering/numbering";
import { SUPPLIER_DOCUMENT_TYPE, SUPPLIER_ENTITY_TYPE } from "./supplier-rules";

/**
 * The supplier directory (specs/03-order-procurement.md §2).
 *
 * §2 is unusually prescriptive about how this gets filled, and it drove the whole shape:
 *
 * > Confirmed: this directory is maintained by users, not by any integration. Make the create/edit
 * > form fast and forgiving — it is the only way suppliers get in.
 *
 * So **`name` is the only thing required**. Country, currency, contact, payment terms, lead time,
 * incoterm — every one of them can follow later. A form that demands a TIN before it will save a
 * supplier is a form somebody works around by putting the order through on WhatsApp, and then the
 * directory is wrong *and* incomplete.
 *
 * ## The ISO 9001 clause 8.4 half
 *
 * `isApproved` is the approved-supplier control docs/PROGRESS.md has listed as owed since module 01.
 * The company asked two questions that sound alike and are opposites: "can we legally sell to this
 * customer" — §5b's accreditation, built — and "is this vendor approved to buy from", which is this.
 *
 * Approval is deliberately **not** required to create a supplier or to record what they quoted.
 * Knowing a price from an unapproved vendor is useful; *ordering* from one is the thing clause 8.4
 * governs, and that gate belongs on the supplier PO in session 2 where it can be overridden with a
 * reason by somebody accountable.
 */

// Re-exported rather than redeclared: the screen imports them from supplier-rules.ts, which it is
// allowed to, and two copies of a string like "Supplier" is how an audit trail quietly splits in
// half.
export { SUPPLIER_DOCUMENT_TYPE, SUPPLIER_ENTITY_TYPE } from "./supplier-rules";

export interface UpsertSupplierInput {
  supplierId?: string | null;
  name: string;
  isPrincipal?: boolean;
  country?: string | null;
  currency?: string;
  contactName?: string | null;
  email?: string | null;
  phone?: string | null;
  address?: unknown;
  paymentTerms?: string | null;
  leadTimeDaysTypical?: number | null;
  incoterm?: string | null;
  productLines?: string[];
  rating?: number | null;
  notes?: string | null;
}

export async function upsertSupplierService(actor: ActorMeta, input: UpsertSupplierInput) {
  const name = input.name.trim();
  if (name.length === 0) {
    throw new TRPCError({ code: "BAD_REQUEST", message: "A supplier needs a name." });
  }

  const data = {
    name,
    isPrincipal: input.isPrincipal ?? false,
    country: input.country ?? null,
    currency: input.currency ?? "PHP",
    contactName: input.contactName ?? null,
    email: input.email?.trim() || null,
    phone: input.phone ?? null,
    paymentTerms: input.paymentTerms ?? null,
    leadTimeDaysTypical: input.leadTimeDaysTypical ?? null,
    incoterm: input.incoterm ?? null,
    productLines: input.productLines ?? [],
    rating: input.rating ?? null,
    notes: input.notes ?? null,
    // Omitted entirely when the caller does not mention it — the way to say "leave the address
    // alone" to Prisma is to not send the key.
    ...(input.address === undefined
      ? {}
      : { address: (input.address ?? {}) as Prisma.InputJsonValue }),
  };

  if (input.supplierId) {
    const existing = await db.supplier.findFirst({
      where: { id: input.supplierId, deletedAt: null },
    });
    if (!existing) {
      throw new TRPCError({ code: "NOT_FOUND", message: "That supplier no longer exists." });
    }

    return db.$transaction(async (tx) => {
      const supplier = await tx.supplier.update({ where: { id: existing.id }, data });
      await writeAuditLog(tx, {
        actorId: actor.actorId,
        actorLabel: actor.actorLabel,
        action: "update",
        entityType: SUPPLIER_ENTITY_TYPE,
        entityId: supplier.id,
        summary: `Updated supplier ${supplier.code} ${supplier.name}`,
        ip: actor.ip,
        userAgent: actor.userAgent,
        requestId: actor.requestId,
      });
      return supplier;
    });
  }

  // Outside the transaction, like every other number in this build: `allocateNumber` commits its
  // own increment so a rolled-back creation leaves a gap rather than reusing a code.
  const code = await allocateNumber(SUPPLIER_DOCUMENT_TYPE);

  return db.$transaction(async (tx) => {
    const supplier = await tx.supplier.create({ data: { ...data, code } });
    await writeAuditLog(tx, {
      actorId: actor.actorId,
      actorLabel: actor.actorLabel,
      action: "create",
      entityType: SUPPLIER_ENTITY_TYPE,
      entityId: supplier.id,
      summary: `Added supplier ${supplier.code} ${supplier.name}`,
      ip: actor.ip,
      userAgent: actor.userAgent,
      requestId: actor.requestId,
    });
    return supplier;
  });
}

/**
 * Converts an appointed principal into a supplier — §5c's promise, finally kept.
 *
 * §5c: "On `stage = appointed`, the prospect converts into a `Supplier` (module 03) with
 * `isPrincipal = true`, carrying the agreement, price list, and contacts across. **No re-keying.**"
 * Module 01 has been emitting `principal.appointed` with everything needed since session 3, and
 * `linkPrincipalSupplierService` has been waiting for a caller. This is it.
 *
 * **Idempotent**, because module 00's job queue guarantees at-least-once delivery, not exactly-once
 * — a redelivered event must not produce a second supplier. The prospect's `supplierId` is the
 * guard, and it is now a unique foreign key, so the database enforces what the check intends.
 *
 * Approved on creation, unlike a typed-in supplier: an appointment means the distributor agreement
 * was signed and the officers weighed it, which is exactly the evidence clause 8.4 asks for. The
 * expiry follows the agreement's, so a lapsed agreement lapses the approval with it.
 */
export async function createSupplierFromPrincipalService(
  actor: ActorMeta,
  prospectId: string,
  tx: Prisma.TransactionClient | PrismaClient = db,
): Promise<{ supplierId: string; created: boolean }> {
  const prospect = await tx.principalProspect.findFirst({
    where: { id: prospectId, deletedAt: null },
  });
  if (!prospect) {
    throw new TRPCError({ code: "NOT_FOUND", message: "That prospect no longer exists." });
  }
  if (prospect.supplierId) {
    // Already converted. The redelivered-event case, and not an error.
    return { supplierId: prospect.supplierId, created: false };
  }
  if (prospect.stage !== "appointed") {
    throw new TRPCError({
      code: "BAD_REQUEST",
      message: `${prospect.companyName} is not appointed, so it has no supplier record to create.`,
    });
  }

  const code = await allocateNumber(SUPPLIER_DOCUMENT_TYPE);

  const supplier = await tx.supplier.create({
    data: {
      code,
      name: prospect.companyName,
      isPrincipal: true,
      country: prospect.country,
      contactName: prospect.contactName,
      email: prospect.email,
      phone: prospect.phone,
      productLines: prospect.productLines,
      incoterm: null,
      isApproved: true,
      approvedAt: new Date(),
      // The agreement is the approval's evidence, so they expire together.
      approvalExpiry: prospect.agreementExpiresAt,
      notes: prospect.notes,
    },
  });

  await tx.principalProspect.update({
    where: { id: prospect.id },
    data: { supplierId: supplier.id },
  });

  await writeAuditLog(tx, {
    actorId: actor.actorId,
    actorLabel: actor.actorLabel,
    action: "converted_to_supplier",
    entityType: SUPPLIER_ENTITY_TYPE,
    entityId: supplier.id,
    summary:
      `Created supplier ${supplier.code} from appointed principal ${prospect.companyName}. ` +
      `Approved under ISO 9001 clause 8.4 on the strength of the signed distributor agreement` +
      (prospect.agreementExpiresAt
        ? `, expiring with it on ${prospect.agreementExpiresAt.toISOString().slice(0, 10)}.`
        : "."),
  });

  return { supplierId: supplier.id, created: true };
}

/**
 * Records the clause 8.4 approval decision by hand, for suppliers that did not arrive through §5c.
 *
 * Most suppliers are typed in — a local fabricator, a bearing distributor — and approving one is a
 * judgement somebody makes and should be able to point at later. Hence the reason, and hence the
 * expiry: an approval with no end date is one nobody ever revisits.
 */
export async function setSupplierApprovalService(
  actor: ActorMeta,
  input: {
    supplierId: string;
    isApproved: boolean;
    approvalExpiry?: Date | null;
    reason: string;
  },
) {
  const supplier = await db.supplier.findFirst({
    where: { id: input.supplierId, deletedAt: null },
  });
  if (!supplier) {
    throw new TRPCError({ code: "NOT_FOUND", message: "That supplier no longer exists." });
  }
  if (input.reason.trim().length < 3) {
    throw new TRPCError({
      code: "BAD_REQUEST",
      message: "Say why. An approval nobody can explain is not evidence of anything.",
    });
  }

  return db.$transaction(async (tx) => {
    const updated = await tx.supplier.update({
      where: { id: supplier.id },
      data: {
        isApproved: input.isApproved,
        approvedAt: input.isApproved ? new Date() : null,
        approvalExpiry: input.isApproved ? (input.approvalExpiry ?? null) : null,
      },
    });

    await writeAuditLog(tx, {
      actorId: actor.actorId,
      actorLabel: actor.actorLabel,
      action: input.isApproved ? "supplier_approved" : "supplier_approval_withdrawn",
      entityType: SUPPLIER_ENTITY_TYPE,
      entityId: supplier.id,
      summary:
        `${input.isApproved ? "Approved" : "Withdrew approval for"} ${supplier.code} ` +
        `${supplier.name} — ${input.reason.trim()}`,
      diff: { isApproved: { from: supplier.isApproved, to: input.isApproved } },
      ip: actor.ip,
      userAgent: actor.userAgent,
      requestId: actor.requestId,
    });

    return updated;
  });
}

export async function listSuppliersService(params: { search?: string; principalsOnly?: boolean }) {
  const search = params.search?.trim();
  return db.supplier.findMany({
    where: {
      deletedAt: null,
      ...(params.principalsOnly ? { isPrincipal: true } : {}),
      ...(search
        ? {
            OR: [
              { name: { contains: search, mode: "insensitive" as const } },
              { code: { contains: search, mode: "insensitive" as const } },
              { productLines: { has: search } },
            ],
          }
        : {}),
    },
    orderBy: [{ isPrincipal: "desc" }, { name: "asc" }],
  });
}

export async function getSupplierService(supplierId: string) {
  const supplier = await db.supplier.findFirst({
    where: { id: supplierId, deletedAt: null },
    include: { principalProspect: { select: { id: true, stage: true, companyName: true } } },
  });
  if (!supplier) {
    throw new TRPCError({ code: "NOT_FOUND", message: "That supplier no longer exists." });
  }
  return supplier;
}

/**
 * Soft-deletes a supplier (Spec.md §5 — nothing is hard-deleted, codes are never reused).
 *
 * Asked for by the company on 2026-08-16, and reserved to the President. §2 makes the directory
 * deliberately easy to add to — "fast and forgiving… it is the only way suppliers get in" — which
 * means duplicates and typos get in too, and until now there was no way to take one out. A directory
 * that only grows is one people stop trusting, and then they keep the real list somewhere else.
 *
 * **Refuses whenever something still points at the supplier**, and says which thing. A purchase
 * order or a price request that resolves to a deleted vendor is worse than a cluttered list: the
 * document stops being able to say who it was addressed to.
 */
export async function deleteSupplierService(
  actor: ActorMeta,
  input: { supplierId: string; reason: string },
) {
  const reason = input.reason.trim();
  if (reason.length < 3) {
    throw new TRPCError({
      code: "BAD_REQUEST",
      message: "Say why. The question asked later is never whether it was deleted but why.",
    });
  }

  const supplier = await db.supplier.findFirst({
    where: { id: input.supplierId, deletedAt: null },
    include: {
      principalProspect: { select: { companyName: true } },
      _count: { select: { supplierPOs: true, supplierQuoteRequests: true } },
    },
  });
  if (!supplier) {
    throw new TRPCError({ code: "NOT_FOUND", message: "That supplier no longer exists." });
  }

  const blockers: string[] = [];
  if (supplier._count.supplierPOs > 0) {
    blockers.push(`${supplier._count.supplierPOs} purchase order(s)`);
  }
  if (supplier._count.supplierQuoteRequests > 0) {
    blockers.push(`${supplier._count.supplierQuoteRequests} price request(s)`);
  }
  if (blockers.length > 0) {
    throw new TRPCError({
      code: "BAD_REQUEST",
      message:
        `${supplier.code} ${supplier.name} still has ${blockers.join(" and ")} against it. ` +
        `Deleting it would leave those documents unable to say who they were addressed to. ` +
        `Withdraw its clause 8.4 approval instead if it should not be bought from.`,
    });
  }

  return db.$transaction(async (tx) => {
    // §5c's conversion runs off the prospect's `supplierId`, and it is idempotent *because* of that
    // column. Leaving it set while the supplier is gone would make the prospect permanently
    // unconvertible; clearing it lets an appointment produce a fresh supplier if that is wanted.
    if (supplier.principalProspect) {
      await tx.principalProspect.updateMany({
        where: { supplierId: supplier.id },
        data: { supplierId: null },
      });
    }

    const updated = await tx.supplier.update({
      where: { id: supplier.id },
      data: { deletedAt: new Date(), deletedBy: actor.actorId },
    });

    await writeAuditLog(tx, {
      actorId: actor.actorId,
      actorLabel: actor.actorLabel,
      action: "delete",
      entityType: SUPPLIER_ENTITY_TYPE,
      entityId: supplier.id,
      summary:
        `Deleted supplier ${supplier.code} ${supplier.name}` +
        (supplier.principalProspect
          ? `, and unlinked it from the principal prospect ${supplier.principalProspect.companyName}`
          : "") +
        ` — ${reason}`,
      diff: { deletedAt: { from: null, to: updated.deletedAt?.toISOString() ?? null } },
      ip: actor.ip,
      userAgent: actor.userAgent,
      requestId: actor.requestId,
    });

    return updated;
  });
}
