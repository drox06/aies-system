import { TRPCError } from "@trpc/server";
import { db } from "@/lib/db";
import { writeAuditLog } from "@/server/core/audit/audit";
import { emit } from "@/server/core/events/emit";
import { allocateNumber } from "@/server/core/numbering/numbering";

/**
 * Account writes. Kept out of the router for the reason established in module 00 session 3: a
 * router module pulls in Auth.js, which cannot load outside the Next.js runtime, so anything
 * defined there is untestable.
 */

export interface ActorMeta {
  actorId: string;
  actorLabel: string;
  ip?: string | null;
  userAgent?: string | null;
  requestId?: string | null;
}

export interface CreateAccountInput {
  name: string;
  legalName?: string | null;
  tin?: string | null;
  industry?: string | null;
  accountType?: string;
  website?: string | null;
  phone?: string | null;
  email?: string | null;
  billingAddress?: unknown;
  shippingAddress?: unknown;
  creditLimit?: string | null;
  currency?: string;
  ownerId?: string | null;
  parentAccountId?: string | null;
  customFields?: unknown;
}

export const ACCOUNT_TYPES = ["customer", "prospect", "both"] as const;
export const ACCOUNT_STATUSES = ["active", "dormant", "blacklisted"] as const;

export async function createAccountService(actor: ActorMeta, input: CreateAccountInput) {
  const name = input.name.trim();
  if (name.length === 0) {
    throw new TRPCError({ code: "BAD_REQUEST", message: "An account needs a name." });
  }

  // ACC-{####}, allocated on its own connection *before* the transaction opens, because
  // allocateNumber takes no transaction client. That is deliberate in module 00, whose contract
  // states "numbers are never reused or reordered; gaps (e.g. from a rolled-back transaction) are
  // permitted" — so a failure below burns a code. Acceptable here: an account code is an internal
  // identifier, and a missing ACC-0042 costs nothing. Revisit for anything the BIR counts, where a
  // gap in a sequence has to be explainable.
  const code = await allocateNumber("account");

  return db.$transaction(async (tx) => {
    if (input.parentAccountId) {
      // A parent that does not exist would otherwise surface as an opaque foreign-key violation.
      const parent = await tx.customerAccount.findFirst({
        where: { id: input.parentAccountId, deletedAt: null },
        select: { id: true },
      });
      if (!parent) {
        throw new TRPCError({
          code: "BAD_REQUEST",
          message: "That parent account does not exist.",
        });
      }
    }

    const account = await tx.customerAccount.create({
      data: {
        code,
        name,
        legalName: input.legalName ?? null,
        tin: input.tin ?? null,
        industry: input.industry ?? null,
        accountType: input.accountType ?? "prospect",
        website: input.website ?? null,
        phone: input.phone ?? null,
        email: input.email ?? null,
        billingAddress: (input.billingAddress ?? {}) as object,
        shippingAddress: (input.shippingAddress ?? {}) as object,
        creditLimit: input.creditLimit ?? null,
        currency: input.currency ?? "PHP",
        // Unowned accounts are how records go stale unnoticed (§6's follow-up engine keys off the
        // owner), so the creator owns it until someone reassigns.
        ownerId: input.ownerId ?? actor.actorId,
        parentAccountId: input.parentAccountId ?? null,
        customFields: (input.customFields ?? {}) as object,
      },
    });

    await writeAuditLog(tx, {
      actorId: actor.actorId,
      actorLabel: actor.actorLabel,
      action: "create",
      entityType: "CustomerAccount",
      entityId: account.id,
      summary: `Created account ${account.code} — ${account.name}`,
      ip: actor.ip,
      userAgent: actor.userAgent,
      requestId: actor.requestId,
    });

    // specs/01-crm-inquiry.md §8. In the same transaction as the write, per the outbox guarantee.
    await emit(
      tx,
      "account.created",
      { accountId: account.id, code: account.code, name: account.name },
      { actorId: actor.actorId, requestId: actor.requestId },
    );

    return account;
  });
}

export interface UpdateAccountInput extends Partial<CreateAccountInput> {
  accountId: string;
  status?: string;
}

export async function updateAccountService(actor: ActorMeta, input: UpdateAccountInput) {
  return db.$transaction(async (tx) => {
    const before = await tx.customerAccount.findFirst({
      where: { id: input.accountId, deletedAt: null },
      select: {
        id: true,
        code: true,
        name: true,
        status: true,
        accountType: true,
        ownerId: true,
        tin: true,
      },
    });
    if (!before) {
      throw new TRPCError({ code: "NOT_FOUND", message: "That account no longer exists." });
    }

    if (input.parentAccountId === input.accountId) {
      throw new TRPCError({ code: "BAD_REQUEST", message: "An account cannot be its own parent." });
    }

    const data: Record<string, unknown> = {};
    const diff: Record<string, { from: unknown; to: unknown }> = {};
    const track = <K extends keyof typeof before>(field: K, next: unknown) => {
      if (next === undefined) return;
      if (before[field] !== next) diff[field as string] = { from: before[field], to: next };
      data[field as string] = next;
    };

    track("name", input.name?.trim());
    track("status", input.status);
    track("accountType", input.accountType);
    track("ownerId", input.ownerId ?? undefined);
    track("tin", input.tin);
    for (const field of [
      "legalName",
      "industry",
      "website",
      "phone",
      "email",
      "billingAddress",
      "shippingAddress",
      "creditLimit",
      "currency",
      "parentAccountId",
      "customFields",
    ] as const) {
      if (input[field] !== undefined) data[field] = input[field];
    }

    const account = await tx.customerAccount.update({
      where: { id: input.accountId },
      data,
    });

    await writeAuditLog(tx, {
      actorId: actor.actorId,
      actorLabel: actor.actorLabel,
      action: "update",
      entityType: "CustomerAccount",
      entityId: account.id,
      summary: `Updated account ${account.code} — ${account.name}`,
      // Only changed fields, per specs/00-foundation.md §5's "omit unchanged fields".
      diff: Object.keys(diff).length > 0 ? diff : undefined,
      ip: actor.ip,
      userAgent: actor.userAgent,
      requestId: actor.requestId,
    });

    return account;
  });
}

/** Soft delete (Spec.md §10). Never a hard delete: inquiries, quotations and orders reference the
 *  account, and losing who a quotation was for destroys the record of the sale. */
export async function deleteAccountService(actor: ActorMeta, input: { accountId: string }) {
  return db.$transaction(async (tx) => {
    const account = await tx.customerAccount.findFirst({
      where: { id: input.accountId, deletedAt: null },
      select: { id: true, code: true, name: true },
    });
    if (!account) {
      throw new TRPCError({ code: "NOT_FOUND", message: "That account no longer exists." });
    }

    // Children would be orphaned into an unreachable hierarchy.
    const childCount = await tx.customerAccount.count({
      where: { parentAccountId: account.id, deletedAt: null },
    });
    if (childCount > 0) {
      throw new TRPCError({
        code: "BAD_REQUEST",
        message: `Reassign this account's ${childCount} sub-account(s) before deleting it.`,
      });
    }

    const deletedAt = new Date();
    await tx.customerAccount.update({
      where: { id: account.id },
      data: { deletedAt, deletedBy: actor.actorId, status: "dormant" },
    });

    await writeAuditLog(tx, {
      actorId: actor.actorId,
      actorLabel: actor.actorLabel,
      action: "delete",
      entityType: "CustomerAccount",
      entityId: account.id,
      summary: `Deleted account ${account.code} — ${account.name}`,
      diff: { deletedAt: { from: null, to: deletedAt.toISOString() } },
      ip: actor.ip,
      userAgent: actor.userAgent,
      requestId: actor.requestId,
    });

    return { ok: true as const };
  });
}
