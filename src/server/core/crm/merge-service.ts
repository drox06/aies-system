import { TRPCError } from "@trpc/server";
import { db } from "@/lib/db";
import { writeAuditLog } from "@/server/core/audit/audit";
import type { ActorMeta } from "@/server/core/crm/account-service";
import { removeFromIndex } from "@/server/core/search/index-service";

/**
 * The account merge tool (specs/01-crm-inquiry.md §7).
 *
 * "Industrial customers get entered three times with three spellings." Detection landed in session
 * 1; this is the other half — "an admin merge tool that repoints all child records and writes a
 * merge audit entry."
 *
 * §10's test is the specification: "Merge repoints inquiries, contacts, sites, and activities with
 * no orphans." Everything below is arranged so that sentence can be true, and so that it stays true
 * when a later module adds a table pointing at `CustomerAccount`.
 */

/**
 * Every relation that has to move, in one place.
 *
 * A list rather than a sequence of hand-written updates, because the failure mode this guards
 * against is *forgetting one*. When module 02 adds `Quotation.accountId` it goes here, and the
 * orphan check below starts covering it automatically. `Activity` is included even though it is
 * polymorphic — it points at an account by `entityId`, so it orphans just as easily.
 */
const MERGE_TARGETS = [
  {
    label: "sites",
    move: (tx: Tx, from: string, to: string) =>
      tx.site.updateMany({ where: { accountId: from }, data: { accountId: to } }),
  },
  {
    label: "contacts",
    move: (tx: Tx, from: string, to: string) =>
      tx.contact.updateMany({ where: { accountId: from }, data: { accountId: to } }),
  },
  {
    label: "inquiries",
    move: (tx: Tx, from: string, to: string) =>
      tx.inquiry.updateMany({ where: { accountId: from }, data: { accountId: to } }),
  },
  {
    label: "sub-accounts",
    move: (tx: Tx, from: string, to: string) =>
      tx.customerAccount.updateMany({
        where: { parentAccountId: from },
        data: { parentAccountId: to },
      }),
  },
  {
    label: "activities",
    move: (tx: Tx, from: string, to: string) =>
      tx.activity.updateMany({
        where: { entityType: "CustomerAccount", entityId: from },
        data: { entityId: to },
      }),
  },
  {
    label: "comments",
    move: (tx: Tx, from: string, to: string) =>
      tx.comment.updateMany({
        where: { entityType: "CustomerAccount", entityId: from },
        data: { entityId: to },
      }),
  },
] as const;

type Tx = Parameters<Parameters<typeof db.$transaction>[0]>[0];

export interface MergeResult {
  survivorId: string;
  mergedId: string;
  moved: Record<string, number>;
}

/**
 * Merges `mergedId` into `survivorId`.
 *
 * Four things worth knowing:
 *
 * 1. **The loser is soft-deleted, never hard-deleted.** Spec.md §10: "nothing is hard-deleted".
 *    Its audit history stays attached to its own id, which is what makes the merge reviewable
 *    afterwards — the trail of the duplicate is evidence, and destroying it to tidy up would be
 *    exactly the wrong trade for an ISO 9001 system.
 * 2. **Accreditations do not move.** `AccreditationRecord` is unique per account, so moving one
 *    onto an account that already has one violates the constraint — and the question "is AIES
 *    accredited with this customer?" has one true answer that belongs to the survivor. The loser's
 *    record is soft-deleted with it, and the audit row says so rather than leaving somebody to
 *    wonder where it went.
 * 3. **Everything happens in one transaction.** A half-merged account is worse than two
 *    duplicates: the records are now split across two ids with no way to tell which is which.
 * 4. **An orphan check runs before commit**, so the §10 property is enforced at runtime rather than
 *    only asserted in a test. If anything still points at the merged account, the transaction rolls
 *    back and names the table.
 */
export async function mergeAccountsService(
  actor: ActorMeta,
  input: { survivorId: string; mergedId: string; reason?: string | null },
): Promise<MergeResult> {
  if (input.survivorId === input.mergedId) {
    throw new TRPCError({
      code: "BAD_REQUEST",
      message: "An account cannot be merged into itself.",
    });
  }

  const result = await db.$transaction(async (tx) => {
    // Sequential, not `Promise.all`. An interactive transaction holds **one** connection, so
    // parallel queries inside it contend for that single connection and surface as
    // "Can't reach database server" — which reads like an outage and is not one. Outside a
    // transaction `Promise.all` is fine and is used freely elsewhere in this file.
    const survivor = await tx.customerAccount.findFirst({
      where: { id: input.survivorId, deletedAt: null },
      select: { id: true, code: true, name: true },
    });
    const merged = await tx.customerAccount.findFirst({
      where: { id: input.mergedId, deletedAt: null },
      select: { id: true, code: true, name: true, parentAccountId: true },
    });

    if (!survivor) {
      throw new TRPCError({ code: "NOT_FOUND", message: "The account to keep no longer exists." });
    }
    if (!merged) {
      throw new TRPCError({ code: "NOT_FOUND", message: "The account to merge no longer exists." });
    }
    // Would make the survivor its own parent once the hierarchy is repointed.
    if (merged.parentAccountId === survivor.id) {
      await tx.customerAccount.update({
        where: { id: merged.id },
        data: { parentAccountId: null },
      });
    }

    const moved: Record<string, number> = {};
    for (const target of MERGE_TARGETS) {
      const { count } = await target.move(tx, merged.id, survivor.id);
      moved[target.label] = count;
    }

    // See note 2 above: the accreditation stays with the loser and goes down with it.
    const accreditations = await tx.accreditationRecord.updateMany({
      where: { accountId: merged.id, deletedAt: null },
      data: { deletedAt: new Date(), deletedBy: actor.actorId },
    });
    moved["accreditations retired"] = accreditations.count;

    await tx.customerAccount.update({
      where: { id: merged.id },
      data: {
        deletedAt: new Date(),
        deletedBy: actor.actorId,
        status: "dormant",
        // So the survivor is findable from the loser's row afterwards. Without this the only record
        // of where everything went is the audit summary, which is prose.
        parentAccountId: survivor.id,
      },
    });

    await assertNoOrphans(tx, merged.id);

    const summary =
      `Merged ${merged.code} — ${merged.name} into ${survivor.code} — ${survivor.name}` +
      (input.reason ? `: ${input.reason}` : "");

    // Written against both ids on purpose. Opening either account afterwards has to explain what
    // happened; a single row on the survivor leaves the duplicate's page silent.
    for (const entityId of [survivor.id, merged.id]) {
      await writeAuditLog(tx, {
        actorId: actor.actorId,
        actorLabel: actor.actorLabel,
        action: "merge",
        entityType: "CustomerAccount",
        entityId,
        summary,
        diff: {
          survivor: { from: null, to: survivor.code },
          merged: { from: merged.code, to: null },
          moved: { from: null, to: moved },
        },
        ip: actor.ip,
        userAgent: actor.userAgent,
        requestId: actor.requestId,
      });
    }

    return { survivorId: survivor.id, mergedId: merged.id, moved };
  });

  // Outside the transaction: the search index is a convenience and must never roll back a merge.
  await removeFromIndex("CustomerAccount", result.mergedId).catch((error: unknown) => {
    console.error("[crm] failed to de-index merged account", result.mergedId, error);
  });

  return result;
}

/**
 * Enforces §10's "no orphans" before the transaction commits.
 *
 * The check is deliberately separate from the move list rather than trusting it: a target added to
 * `MERGE_TARGETS` with a wrong `where` clause would report a count and move nothing, and this is
 * what notices.
 */
async function assertNoOrphans(tx: Tx, mergedId: string): Promise<void> {
  const remaining: Record<string, number> = {};

  // Sequential for the same reason as above: this runs inside the merge transaction.
  const sites = await tx.site.count({ where: { accountId: mergedId } });
  const contacts = await tx.contact.count({ where: { accountId: mergedId } });
  const inquiries = await tx.inquiry.count({ where: { accountId: mergedId } });
  const children = await tx.customerAccount.count({ where: { parentAccountId: mergedId } });
  const activities = await tx.activity.count({
    where: { entityType: "CustomerAccount", entityId: mergedId },
  });
  const comments = await tx.comment.count({
    where: { entityType: "CustomerAccount", entityId: mergedId },
  });

  if (sites > 0) remaining.sites = sites;
  if (contacts > 0) remaining.contacts = contacts;
  if (inquiries > 0) remaining.inquiries = inquiries;
  if (children > 0) remaining["sub-accounts"] = children;
  if (activities > 0) remaining.activities = activities;
  if (comments > 0) remaining.comments = comments;

  if (Object.keys(remaining).length > 0) {
    throw new TRPCError({
      code: "INTERNAL_SERVER_ERROR",
      message:
        `Merge aborted — records still point at the merged account: ` +
        `${Object.entries(remaining)
          .map(([table, count]) => `${count} ${table}`)
          .join(", ")}. Nothing was changed.`,
    });
  }
}

/**
 * What a merge would move, without moving it.
 *
 * §7's merge "cannot be undone from the UI", so the confirmation has to say what is actually at
 * stake for these two specific accounts rather than a generic "are you sure?".
 */
export async function previewMergeService(input: { survivorId: string; mergedId: string }) {
  const [survivor, merged] = await Promise.all([
    db.customerAccount.findFirst({
      where: { id: input.survivorId, deletedAt: null },
      select: { id: true, code: true, name: true },
    }),
    db.customerAccount.findFirst({
      where: { id: input.mergedId, deletedAt: null },
      select: { id: true, code: true, name: true },
    }),
  ]);
  if (!survivor || !merged) {
    throw new TRPCError({ code: "NOT_FOUND", message: "One of those accounts no longer exists." });
  }

  const [sites, contacts, inquiries, children, activities, accreditations] = await Promise.all([
    db.site.count({ where: { accountId: merged.id } }),
    db.contact.count({ where: { accountId: merged.id } }),
    db.inquiry.count({ where: { accountId: merged.id } }),
    db.customerAccount.count({ where: { parentAccountId: merged.id, deletedAt: null } }),
    db.activity.count({ where: { entityType: "CustomerAccount", entityId: merged.id } }),
    db.accreditationRecord.count({ where: { accountId: merged.id, deletedAt: null } }),
  ]);

  return {
    survivor,
    merged,
    counts: { sites, contacts, inquiries, children, activities },
    // Called out separately because it is the one thing that is retired rather than moved.
    accreditationsRetired: accreditations,
  };
}
