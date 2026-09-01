import { TRPCError } from "@trpc/server";
import type { Prisma } from "@prisma/client";
import { db } from "@/lib/db";
import { writeAuditLog } from "@/server/core/audit/audit";
import type { ActorMeta } from "@/server/core/crm/account-service";

/**
 * A customer's plants (specs/01-crm-inquiry.md §1-2).
 *
 * §1 is explicit about why this is a real model rather than a text field on the account: *"Accounts
 * are industrial: a water district, a power plant, a food manufacturer. Each has plants, each plant
 * has equipment, and the same account may run several unrelated inquiries at once through different
 * engineers. Model the hierarchy properly."*
 *
 * It was modelled properly and then had no way in — the same gap as contacts and accreditation. An
 * inquiry, a quotation and an inspection can all point at a `Site`, and every one of those pickers
 * was empty because nothing could create one.
 *
 * **`accessNotes` is the field that earns this model its keep.** §2 calls out gate pass, PPE and
 * induction requirements by name, and it is the difference between a technician arriving at a
 * refinery with the right paperwork and losing a day at the gate.
 */

export interface UpsertSiteInput {
  siteId?: string | null;
  accountId: string;
  name: string;
  address?: unknown;
  accessNotes?: string | null;
  contactId?: string | null;
}

export async function upsertSiteService(actor: ActorMeta, input: UpsertSiteInput) {
  const name = input.name.trim();
  if (name.length === 0) {
    throw new TRPCError({ code: "BAD_REQUEST", message: "A plant needs a name." });
  }

  const account = await db.customerAccount.findFirst({
    where: { id: input.accountId, deletedAt: null },
    select: { id: true, code: true },
  });
  if (!account) {
    throw new TRPCError({ code: "NOT_FOUND", message: "That account no longer exists." });
  }

  if (input.contactId) {
    // The site's main contact must be somebody at this customer. `Site.contactId` is deliberately
    // not a foreign key (crm.prisma explains the cycle), so nothing else checks this.
    const contact = await db.contact.findFirst({
      where: { id: input.contactId, accountId: account.id, deletedAt: null },
      select: { id: true },
    });
    if (!contact) {
      throw new TRPCError({
        code: "BAD_REQUEST",
        message: "That contact does not belong to this customer.",
      });
    }
  }

  return db.$transaction(async (tx) => {
    const existing = input.siteId
      ? await tx.site.findFirst({
          where: { id: input.siteId, accountId: account.id, deletedAt: null },
        })
      : null;
    if (input.siteId && !existing) {
      throw new TRPCError({ code: "NOT_FOUND", message: "That plant no longer exists." });
    }

    const data = {
      name,
      accessNotes: input.accessNotes ?? null,
      contactId: input.contactId ?? null,
      // Json, and left alone entirely when the caller does not mention it — omitting the key is how
      // "do not touch the address" is said to Prisma. `Prisma.InputJsonValue` rather than a plain
      // Record, because Prisma's Json input type is a union that a Record does not satisfy.
      ...(input.address === undefined
        ? {}
        : { address: (input.address ?? {}) as Prisma.InputJsonValue }),
    };

    const site = existing
      ? await tx.site.update({ where: { id: existing.id }, data })
      : await tx.site.create({ data: { ...data, accountId: account.id } });

    await writeAuditLog(tx, {
      actorId: actor.actorId,
      actorLabel: actor.actorLabel,
      action: existing ? "update" : "create",
      entityType: "Site",
      entityId: site.id,
      summary: `${existing ? "Updated" : "Added"} plant "${site.name}" on ${account.code}`,
      ip: actor.ip,
      userAgent: actor.userAgent,
      requestId: actor.requestId,
    });

    return site;
  });
}

/**
 * Removes a plant.
 *
 * Soft, and it **refuses while anything still points at it**. A site named on an inquiry, a
 * quotation or an inspection request is part of those records — soft-deleting it underneath them
 * would leave a delivery address that resolves to nothing on a document already sent, and the
 * symptom would appear months later on the one job where it mattered.
 */
export async function deleteSiteService(
  actor: ActorMeta,
  input: { siteId: string; reason?: string | null },
) {
  const site = await db.site.findFirst({
    where: { id: input.siteId, deletedAt: null },
    include: {
      account: { select: { code: true } },
      _count: { select: { inquiries: true, quotations: true, inspections: true, contacts: true } },
    },
  });
  if (!site) {
    throw new TRPCError({ code: "NOT_FOUND", message: "That plant is already gone." });
  }

  const blockers: string[] = [];
  if (site._count.inquiries > 0) blockers.push(`${site._count.inquiries} inquiry/inquiries`);
  if (site._count.quotations > 0) blockers.push(`${site._count.quotations} quotation(s)`);
  if (site._count.inspections > 0) blockers.push(`${site._count.inspections} inspection(s)`);
  if (blockers.length > 0) {
    throw new TRPCError({
      code: "BAD_REQUEST",
      message:
        `"${site.name}" is named on ${blockers.join(", ")}. Removing it would leave those records ` +
        `pointing at a plant that no longer exists — rename it instead if it has changed.`,
    });
  }

  return db.$transaction(async (tx) => {
    // Contacts attached to this plant survive; they belong to the customer, not to the building.
    if (site._count.contacts > 0) {
      await tx.contact.updateMany({
        where: { siteId: site.id, deletedAt: null },
        data: { siteId: null },
      });
    }

    await tx.site.update({
      where: { id: site.id },
      data: { deletedAt: new Date(), deletedBy: actor.actorId },
    });

    await writeAuditLog(tx, {
      actorId: actor.actorId,
      actorLabel: actor.actorLabel,
      action: "delete",
      entityType: "Site",
      entityId: site.id,
      summary:
        `Removed plant "${site.name}" from ${site.account.code}` +
        (input.reason ? ` — ${input.reason}` : "") +
        (site._count.contacts > 0
          ? `. ${site._count.contacts} contact(s) kept, no longer tied to a plant.`
          : ""),
      ip: actor.ip,
      userAgent: actor.userAgent,
      requestId: actor.requestId,
    });

    return { removed: true, contactsDetached: site._count.contacts };
  });
}

/** Every plant on one customer, with what is going on at each. */
export async function listSitesService(accountId: string) {
  return db.site.findMany({
    where: { accountId, deletedAt: null },
    orderBy: { name: "asc" },
    include: {
      contacts: {
        where: { deletedAt: null },
        select: {
          id: true,
          firstName: true,
          lastName: true,
          mobile: true,
          email: true,
          position: true,
        },
      },
      _count: { select: { inquiries: true, quotations: true, inspections: true } },
    },
  });
}
