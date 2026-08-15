import { TRPCError } from "@trpc/server";
import { db } from "@/lib/db";
import { writeAuditLog } from "@/server/core/audit/audit";
import type { ActorMeta } from "@/server/core/crm/account-service";

/**
 * The people at a customer (specs/01-crm-inquiry.md §1-2).
 *
 * The `Contact` model has held many contacts per account, and a `siteId` on each, since session 2 —
 * §1's "each has plants, each plant has equipment" was modelled properly from the start. What did
 * not exist was any way to *add* one: the only writer was `setPrimaryContactService`, which
 * creates or edits exactly one contact per account and marks it primary. So an account with four
 * plants had one name against it and the other three lived in somebody's phone.
 *
 * The company asked for the missing half, and gave the reason: "this is needed when handling
 * multiple plant locations of 1 client". Which is why `siteId` is on the form rather than optional
 * housekeeping — a contact list with eleven names and no indication of which plant each one runs is
 * only marginally better than no list.
 */

export interface UpsertContactInput {
  contactId?: string | null;
  accountId: string;
  siteId?: string | null;
  firstName: string;
  lastName: string;
  position?: string | null;
  department?: string | null;
  email?: string | null;
  mobile?: string | null;
  phone?: string | null;
  isPrimary?: boolean;
  isDecisionMaker?: boolean;
  notes?: string | null;
}

/**
 * Adds a person, or edits one.
 *
 * **Exactly one primary per account**, enforced here rather than by a database constraint: a
 * partial unique index on `(accountId) where isPrimary` would be the tighter answer, but it would
 * also make "promote this person" a two-statement dance that fails halfway on a constraint
 * violation. Demoting the incumbent in the same transaction is the same guarantee with a better
 * failure mode, and it is what the person clicking "make primary" means.
 */
export async function upsertContactService(actor: ActorMeta, input: UpsertContactInput) {
  const account = await db.customerAccount.findFirst({
    where: { id: input.accountId, deletedAt: null },
    select: { id: true, code: true, name: true },
  });
  if (!account) {
    throw new TRPCError({ code: "NOT_FOUND", message: "That account no longer exists." });
  }

  if (input.siteId) {
    // A contact pointed at another customer's plant is a data error that only shows up when
    // somebody rings the wrong site.
    const site = await db.site.findFirst({
      where: { id: input.siteId, accountId: account.id, deletedAt: null },
      select: { id: true },
    });
    if (!site) {
      throw new TRPCError({
        code: "BAD_REQUEST",
        message: "That site does not belong to this customer.",
      });
    }
  }

  const data = {
    siteId: input.siteId ?? null,
    firstName: input.firstName.trim(),
    lastName: input.lastName.trim(),
    position: input.position ?? null,
    department: input.department ?? null,
    email: input.email?.trim() || null,
    mobile: input.mobile ?? null,
    phone: input.phone ?? null,
    isDecisionMaker: input.isDecisionMaker ?? false,
    notes: input.notes ?? null,
  };

  return db.$transaction(async (tx) => {
    const existing = input.contactId
      ? await tx.contact.findFirst({
          where: { id: input.contactId, accountId: account.id, deletedAt: null },
        })
      : null;
    if (input.contactId && !existing) {
      throw new TRPCError({ code: "NOT_FOUND", message: "That contact no longer exists." });
    }

    // The first person on an account is the primary whether or not anybody ticked the box: an
    // account whose only contact is not its primary contact reads as an oversight everywhere it
    // appears, starting with the accounts list.
    const liveCount = await tx.contact.count({
      where: { accountId: account.id, deletedAt: null },
    });
    const isPrimary = input.isPrimary ?? existing?.isPrimary ?? liveCount === 0;

    if (isPrimary) {
      await tx.contact.updateMany({
        where: {
          accountId: account.id,
          deletedAt: null,
          isPrimary: true,
          ...(existing ? { id: { not: existing.id } } : {}),
        },
        data: { isPrimary: false },
      });
    }

    const contact = existing
      ? await tx.contact.update({ where: { id: existing.id }, data: { ...data, isPrimary } })
      : await tx.contact.create({
          data: { ...data, accountId: account.id, isPrimary },
        });

    await writeAuditLog(tx, {
      actorId: actor.actorId,
      actorLabel: actor.actorLabel,
      action: existing ? "update" : "create",
      entityType: "Contact",
      entityId: contact.id,
      summary:
        `${existing ? "Updated" : "Added"} ${contact.firstName} ${contact.lastName}` +
        `${contact.position ? ` (${contact.position})` : ""} on ${account.code}` +
        `${isPrimary ? " — primary contact" : ""}`,
      ip: actor.ip,
      userAgent: actor.userAgent,
      requestId: actor.requestId,
    });

    return contact;
  });
}

/**
 * Takes a person off the account.
 *
 * Soft, like everything else (Spec.md §10) — and necessarily so: a contact is named on inquiries
 * and quotations, and a hard delete would either break those foreign keys or silently blank the
 * "who asked for this?" on a document already sent.
 *
 * Removing the primary contact leaves the account with none rather than promoting somebody at
 * random. Which of four plant engineers speaks for the company is not a question software should
 * answer by picking the alphabetically first.
 */
export async function deleteContactService(
  actor: ActorMeta,
  input: { contactId: string; reason?: string | null },
) {
  const contact = await db.contact.findFirst({
    where: { id: input.contactId, deletedAt: null },
    include: { account: { select: { code: true } } },
  });
  if (!contact) {
    throw new TRPCError({ code: "NOT_FOUND", message: "That contact is already gone." });
  }

  return db.$transaction(async (tx) => {
    await tx.contact.update({
      where: { id: contact.id },
      data: { deletedAt: new Date(), deletedBy: actor.actorId, isPrimary: false },
    });

    await writeAuditLog(tx, {
      actorId: actor.actorId,
      actorLabel: actor.actorLabel,
      action: "delete",
      entityType: "Contact",
      entityId: contact.id,
      summary:
        `Removed ${contact.firstName} ${contact.lastName} from ${contact.account.code}` +
        (input.reason ? ` — ${input.reason}` : "") +
        (contact.isPrimary ? ". This account now has no primary contact." : ""),
      ip: actor.ip,
      userAgent: actor.userAgent,
      requestId: actor.requestId,
    });

    return { removed: true, wasPrimary: contact.isPrimary };
  });
}

/** Everyone at one customer, primary first, then by plant and surname. */
export async function listContactsService(accountId: string) {
  const contacts = await db.contact.findMany({
    where: { accountId, deletedAt: null },
    orderBy: [{ isPrimary: "desc" }, { lastName: "asc" }, { firstName: "asc" }],
    include: { site: { select: { id: true, name: true } } },
  });
  return contacts;
}
