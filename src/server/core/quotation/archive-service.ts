import { TRPCError } from "@trpc/server";
import { db } from "@/lib/db";
import { writeAuditLog } from "@/server/core/audit/audit";
import type { ActorMeta } from "@/server/core/quotation/quotation-service";
import { ARCHIVE_AFTER_PO_DAYS, QUOTATION_ARCHIVE_PERMISSION } from "./archive-rules";

/**
 * Taking finished quotations off the working list.
 *
 * The company asked for it in one sentence — *"apply auto archiving of quotations that have already
 * received POs, archive them after 14 days of PO receipt"* — and the reason is visible on their own
 * screen: the Quotations list is where somebody goes to find the document they are working on, and
 * every won deal that stays on it makes that job slower forever.
 *
 * ## Why fourteen days rather than the moment the PO lands
 *
 * Because the fortnight after a purchase order is exactly when people still open the quotation: to
 * check what was actually quoted against what the PO says, to answer a question about scope, to
 * correct a discrepancy. Archiving on receipt would hide the document during the only period it is
 * still in daily use. Two weeks is past that and well short of memory.
 *
 * ## Why archived is not deleted, and not a status
 *
 * `deletedAt` means the record should not have existed. `status` records what the *customer* did —
 * and an archived quotation is still `accepted`, which is the point of it. Archiving says only which
 * screen a document belongs on, so it gets its own column and its own permission.
 *
 * Nothing is destroyed and nothing is unreachable: the record page still opens by id for anybody who
 * could open it before, so a link in an email from last year keeps working. What changes is the
 * list, and who can ask to see the archived half of it.
 */

export { ARCHIVE_AFTER_PO_DAYS, QUOTATION_ARCHIVE_PERMISSION };

const DAY_MS = 86_400_000;

export interface ArchiveSweepResult {
  archived: { quotationId: string; number: string; daysSincePo: number }[];
  scanned: number;
}

/**
 * The nightly pass.
 *
 * Only quotations that are **both** `accepted` and carry a purchase order at least fourteen days
 * old. Status alone is not enough — `accepted` is set by the `customer_po.received` subscriber, but
 * it can also be reached from a revision chain, and a quotation with no PO behind it is not finished
 * work whatever its status says.
 */
export async function sweepQuotationsToArchive(
  now: Date = new Date(),
): Promise<ArchiveSweepResult> {
  const cutoff = new Date(now.getTime() - ARCHIVE_AFTER_PO_DAYS * DAY_MS);

  const candidates = await db.quotation.findMany({
    where: {
      deletedAt: null,
      archivedAt: null,
      status: "accepted",
      customerPOs: { some: { deletedAt: null, receivedAt: { lte: cutoff } } },
    },
    select: {
      id: true,
      number: true,
      revision: true,
      customerPOs: {
        where: { deletedAt: null },
        orderBy: { receivedAt: "asc" },
        take: 1,
        select: { receivedAt: true, poNumber: true },
      },
    },
  });

  const archived: ArchiveSweepResult["archived"] = [];

  for (const quotation of candidates) {
    const po = quotation.customerPOs[0];
    if (!po) continue;
    const daysSincePo = Math.floor((now.getTime() - po.receivedAt.getTime()) / DAY_MS);

    await db.$transaction(async (tx) => {
      await tx.quotation.update({
        where: { id: quotation.id },
        data: { archivedAt: now },
      });
      await writeAuditLog(tx, {
        // Nobody did this. The audit log's system convention, same as the expiry sweep's.
        actorId: null,
        actorLabel: "System (archive sweep)",
        action: "archived",
        entityType: "Quotation",
        entityId: quotation.id,
        summary:
          `Archived ${quotation.number}: PO ${po.poNumber} was received ${daysSincePo} days ago. ` +
          `Still readable by anyone who could read it before.`,
        diff: { archivedAt: { from: null, to: now.toISOString() } },
      });
    });

    archived.push({ quotationId: quotation.id, number: quotation.number, daysSincePo });
  }

  return { archived, scanned: candidates.length };
}

/**
 * Puts one back, by hand.
 *
 * The sweep is automatic and therefore occasionally wrong — a PO gets cancelled, a discrepancy turns
 * a finished job back into a live one. Without this the only remedy would be a database edit.
 *
 * Restricted to the same people who can see the archive at all, because being able to put a document
 * back on everybody's working list is at least as consequential as being able to look at it.
 */
export async function unarchiveQuotationService(
  actor: ActorMeta,
  input: { quotationId: string; reason: string },
) {
  const quotation = await db.quotation.findFirst({
    where: { id: input.quotationId, deletedAt: null },
    select: { id: true, number: true, archivedAt: true },
  });
  if (!quotation) {
    throw new TRPCError({ code: "NOT_FOUND", message: "That quotation no longer exists." });
  }
  const archivedAt = quotation.archivedAt;
  if (!archivedAt) {
    throw new TRPCError({
      code: "BAD_REQUEST",
      message: `${quotation.number} is not archived.`,
    });
  }

  await db.$transaction(async (tx) => {
    await tx.quotation.update({ where: { id: quotation.id }, data: { archivedAt: null } });
    await writeAuditLog(tx, {
      actorId: actor.actorId,
      actorLabel: actor.actorLabel,
      action: "unarchived",
      entityType: "Quotation",
      entityId: quotation.id,
      summary: `Brought ${quotation.number} back onto the working list: ${input.reason}`,
      diff: { archivedAt: { from: archivedAt.toISOString(), to: null } },
      ip: actor.ip,
      userAgent: actor.userAgent,
      requestId: actor.requestId,
    });
  });

  // The sweep would archive it again tonight if the PO is still fourteen days old, which is not
  // what "bring this back" means. Said rather than silently prevented, because the fix — cancelling
  // or correcting the PO — is module 03's and does not exist yet.
  return {
    quotationId: quotation.id,
    warning:
      "The nightly sweep archives on the purchase order's age, so this will be archived again " +
      "tonight unless the PO itself changes.",
  };
}
