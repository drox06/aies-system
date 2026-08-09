import { TRPCError } from "@trpc/server";
import { db } from "@/lib/db";
import { writeAuditLog } from "@/server/core/audit/audit";
import { emit } from "@/server/core/events/emit";
import { getAccountFlags } from "@/server/core/crm/account-health";
import { allocateNumber } from "@/server/core/numbering/numbering";
import { indexEntity, removeFromIndex } from "@/server/core/search/index-service";

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

export const ACCOUNT_ENTITY_TYPE = "CustomerAccount";

/**
 * Keeps Ctrl+K able to find accounts.
 *
 * Outside the transaction and deliberately non-fatal, mirroring `reindexInquiry`: the search index
 * is a convenience, and a failed upsert into it must never roll back a created customer.
 *
 * Inquiries have been indexed since session 2 and accounts were not, which produced a genuinely
 * confusing result — searching a customer's name found their inquiries but not the customer.
 */
export async function reindexAccount(accountId: string): Promise<void> {
  try {
    const account = await db.customerAccount.findUnique({
      where: { id: accountId },
      select: {
        id: true,
        code: true,
        name: true,
        legalName: true,
        tin: true,
        industry: true,
        deletedAt: true,
      },
    });
    if (!account) return;

    // A soft-deleted account is gone as far as anybody searching is concerned. Leaving it indexed
    // is how a merged duplicate keeps surfacing after somebody deliberately closed it.
    if (account.deletedAt) {
      await removeFromIndex(ACCOUNT_ENTITY_TYPE, account.id);
      return;
    }

    await indexEntity({
      entityType: ACCOUNT_ENTITY_TYPE,
      entityId: account.id,
      title: `${account.code} — ${account.name}`,
      // Legal name and TIN are here because §7's duplicate problem means people search for the
      // spelling they have, not the one that was typed.
      body: [account.legalName, account.tin, account.industry].filter(Boolean).join(" "),
      href: `/crm/accounts/${account.id}`,
    });
  } catch (error) {
    console.error("[crm] failed to index account", accountId, error);
  }
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

  const account = await db.$transaction(async (tx) => {
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

  await reindexAccount(account.id);
  return account;
}

export interface UpdateAccountInput extends Partial<CreateAccountInput> {
  accountId: string;
  status?: string;
}

export async function updateAccountService(actor: ActorMeta, input: UpdateAccountInput) {
  const updated = await db.$transaction(async (tx) => {
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

  await reindexAccount(updated.id);
  return updated;
}

/** Soft delete (Spec.md §10). Never a hard delete: inquiries, quotations and orders reference the
 *  account, and losing who a quotation was for destroys the record of the sale. */
export async function deleteAccountService(actor: ActorMeta, input: { accountId: string }) {
  const result = await db.$transaction(async (tx) => {
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

  // Removes it from the palette — see reindexAccount.
  await reindexAccount(input.accountId);
  return result;
}

/**
 * specs/00-foundation.md §4.2's record-level scoping, for accounts.
 *
 * A Prisma `where` fragment, not a post-filter: filtering after the query would page wrongly
 * (25 rows fetched, 6 shown) and would still have pulled records the user may not read.
 *
 * §10's test is "salesperson A cannot read salesperson B's inquiry without crm.view_all", and the
 * same rule governs the account the inquiry hangs off. `crm.view_all` lifts it entirely.
 *
 * Exported as a plain function rather than going through `registerScope` because nothing outside
 * this module scopes accounts yet, and a module-load-time registration would throw on the second
 * evaluation under dev hot-reload. Register it in the core registry the moment a second module
 * needs it — that is a one-liner.
 */
export function accountScopeWhere(user: {
  id: string;
  permissions: ReadonlySet<string>;
}): Record<string, unknown> {
  if (user.permissions.has("crm.view_all")) return {};
  return { ownerId: user.id };
}

export interface ListAccountsParams {
  search?: string;
  status?: string;
  page?: number;
  pageSize?: number;
  sortKey?: string | null;
  sortDir?: "asc" | "desc";
}

/** Columns a client may sort by. An allow-list, because the sort key arrives from the query
 *  string and interpolating it into `orderBy` unchecked is how you leak a schema. */
const SORTABLE = new Set(["code", "name", "accountType", "status", "createdAt", "updatedAt"]);

export async function listAccountsService(
  user: { id: string; permissions: ReadonlySet<string> },
  params: ListAccountsParams = {},
) {
  const page = Math.max(1, params.page ?? 1);
  const pageSize = Math.min(100, Math.max(1, params.pageSize ?? 25));
  const search = params.search?.trim();

  const where = {
    deletedAt: null,
    ...accountScopeWhere(user),
    ...(params.status ? { status: params.status } : {}),
    ...(search
      ? {
          OR: [
            { name: { contains: search, mode: "insensitive" as const } },
            { code: { contains: search, mode: "insensitive" as const } },
            { legalName: { contains: search, mode: "insensitive" as const } },
            { tin: { contains: search } },
          ],
        }
      : {}),
  };

  const sortKey = params.sortKey && SORTABLE.has(params.sortKey) ? params.sortKey : "name";
  const sortDir = params.sortDir === "desc" ? "desc" : "asc";

  // One round-trip for both, since the pager needs the total and the DB is ~183ms away.
  const [rows, total] = await Promise.all([
    db.customerAccount.findMany({
      where,
      orderBy: { [sortKey]: sortDir },
      skip: (page - 1) * pageSize,
      take: pageSize,
      select: {
        id: true,
        code: true,
        name: true,
        accountType: true,
        status: true,
        industry: true,
        ownerId: true,
        createdAt: true,
        _count: { select: { sites: true, contacts: true } },
        // §5b wants the accreditation visible on the account. The primary contact rides along
        // because a CRM row without a person to call is not much use.
        contacts: {
          where: { deletedAt: null, isPrimary: true },
          take: 1,
          select: { id: true, firstName: true, lastName: true, mobile: true, email: true },
        },
      },
    }),
    db.customerAccount.count({ where }),
  ]);

  // Batched across the page, not per row — see account-health.ts.
  const flags = await getAccountFlags(rows.map((r) => r.id));

  return {
    rows: rows.map((row) => {
      const primary = row.contacts[0] ?? null;
      // Destructured off so the wire payload carries primaryContact instead of a one-item array.
      const { contacts, ...rest } = row;
      void contacts;
      return {
        ...rest,
        primaryContact: primary
          ? {
              id: primary.id,
              name: `${primary.firstName} ${primary.lastName}`.trim(),
              mobile: primary.mobile,
              email: primary.email,
            }
          : null,
        flags: flags.get(row.id) ?? [],
      };
    }),
    total,
  };
}

export async function getAccountService(
  user: { id: string; permissions: ReadonlySet<string> },
  accountId: string,
) {
  // Scope is applied in the lookup itself, so an out-of-scope id is indistinguishable from a
  // missing one — a 403 would confirm the record exists to someone not allowed to know that.
  const account = await db.customerAccount.findFirst({
    where: { id: accountId, deletedAt: null, ...accountScopeWhere(user) },
    include: {
      sites: { where: { deletedAt: null }, orderBy: { name: "asc" } },
      contacts: {
        where: { deletedAt: null },
        orderBy: [{ isPrimary: "desc" }, { lastName: "asc" }],
      },
      parent: { select: { id: true, code: true, name: true } },
    },
  });
  if (!account) {
    throw new TRPCError({ code: "NOT_FOUND", message: "That account no longer exists." });
  }
  return account;
}

/**
 * Creates or updates the account's primary contact in one step.
 *
 * A named person with a mobile number is a `Contact`, not three more columns on the account —
 * `CustomerAccount.phone`/`email` are the company switchboard, and §1 leans on knowing "who can
 * actually say yes". Keeping one model means the same person can later be attached to a site, an
 * inquiry, or an accreditation without being re-typed.
 */
export async function setPrimaryContactService(
  actor: ActorMeta,
  input: {
    accountId: string;
    firstName: string;
    lastName: string;
    position?: string | null;
    mobile?: string | null;
    email?: string | null;
    phone?: string | null;
  },
) {
  return db.$transaction(async (tx) => {
    const account = await tx.customerAccount.findFirst({
      where: { id: input.accountId, deletedAt: null },
      select: { id: true, code: true, name: true },
    });
    if (!account) {
      throw new TRPCError({ code: "NOT_FOUND", message: "That account no longer exists." });
    }

    const existing = await tx.contact.findFirst({
      where: { accountId: input.accountId, deletedAt: null, isPrimary: true },
      select: { id: true },
    });

    const data = {
      firstName: input.firstName.trim(),
      lastName: input.lastName.trim(),
      position: input.position ?? null,
      mobile: input.mobile ?? null,
      email: input.email ?? null,
      phone: input.phone ?? null,
    };

    const contact = existing
      ? await tx.contact.update({ where: { id: existing.id }, data })
      : await tx.contact.create({
          data: { ...data, accountId: input.accountId, isPrimary: true },
        });

    await writeAuditLog(tx, {
      actorId: actor.actorId,
      actorLabel: actor.actorLabel,
      action: existing ? "update" : "create",
      entityType: "Contact",
      entityId: contact.id,
      summary: `${existing ? "Updated" : "Added"} primary contact ${contact.firstName} ${contact.lastName} on ${account.code}`,
      ip: actor.ip,
      userAgent: actor.userAgent,
      requestId: actor.requestId,
    });

    return contact;
  });
}
