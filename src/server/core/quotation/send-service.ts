import { TRPCError } from "@trpc/server";
import { db } from "@/lib/db";
import { writeAuditLog } from "@/server/core/audit/audit";
import { emit } from "@/server/core/events/emit";
import { notify } from "@/server/core/notify/notify";
import { registerNotificationType } from "@/server/core/notify/registry";
import { quotationDisplayNumber } from "@/server/core/quotation/quotation-number";
import type { ActorMeta } from "@/server/core/quotation/quotation-service";

/**
 * Issuing a quotation (specs/02-quotation.md §7), as AIES actually does it.
 *
 * §7 assumes the app sends the email itself. It does not yet — module 10 owns outbound document
 * email, and Spec.md §3.4 removed inbound ingest entirely. So today the PDF is downloaded and
 * attached to an external mail client, and **this system cannot observe that it was sent.**
 *
 * That gap is the whole design here, at the company's direction. Two distinct facts, recorded
 * separately, because conflating them would make the pipeline lie:
 *
 * 1. **Downloaded** — the document was produced and a named person has it. The last fact this app
 *    can establish on its own. It moves no status: a quotation is routinely printed to check it
 *    reads properly, and treating that as issuance would tell the customer's pipeline column
 *    something that never happened.
 * 2. **Sent** — asserted by a person, with the date it actually went. That is what fires
 *    `quotation.sent`, supersedes the prior revision (§5), and moves the inquiry to `quoted`.
 *
 * Because step 2 is an assertion rather than an observation, the reliability has to come from
 * somewhere else: `sweepUnsentDownloads` chases anything downloaded and never confirmed. Spec.md
 * §1.2 lists "work assigned verbally… no accountability" as a problem to design out, and an
 * unconfirmed send is exactly that failure wearing a different hat.
 *
 * **When module 10 lands this collapses.** Sending from the record makes `sentAt` an observed fact,
 * the confirmation step disappears, and the sweep has nothing to find.
 */

export const UNSENT_DOWNLOAD_NOTIFICATION_TYPE = "quotation.downloaded_not_sent";

registerNotificationType({
  key: UNSENT_DOWNLOAD_NOTIFICATION_TYPE,
  label: "A quotation was downloaded but never confirmed sent",
  // In-app only while `notify_email` has no handler (docs/DECISIONS.md #10). This one wants email
  // when a provider exists — the person who forgot to send is, by definition, not in the app.
  defaultChannels: { inApp: true, email: false, digest: false },
});

/** Days after a download at which an unconfirmed quotation is chased. */
export const UNSENT_REMINDER_DAYS = [2, 5] as const;

const DAY_MS = 86_400_000;

/**
 * Records that somebody produced the document.
 *
 * Called by the PDF route, not by a button — the fact being recorded is "the bytes left the
 * server", and anything else is a guess about intent.
 *
 * Deliberately does not change `status`. It is safe to call repeatedly, and the count is the useful
 * signal: a quotation downloaded three times and still not confirmed is one somebody keeps meaning
 * to send.
 */
export async function recordQuotationDownloadService(
  actor: ActorMeta,
  input: { quotationId: string; variant?: "customer" | "internal" },
) {
  const quotation = await db.quotation.findFirst({
    where: { id: input.quotationId, deletedAt: null },
    select: { id: true, number: true, revision: true, status: true },
  });
  if (!quotation) {
    throw new TRPCError({ code: "NOT_FOUND", message: "That quotation no longer exists." });
  }

  const label = quotationDisplayNumber(quotation.number, quotation.revision);
  const variant = input.variant ?? "customer";

  return db.$transaction(async (tx) => {
    const updated = await tx.quotation.update({
      where: { id: quotation.id },
      data: {
        // The internal costing sheet is not the customer document, so it does not count as
        // "ready for sending" — it is a management report and nobody emails it to a customer.
        ...(variant === "customer"
          ? {
              downloadedAt: new Date(),
              downloadedBy: actor.actorId,
              downloadCount: { increment: 1 },
            }
          : {}),
      },
      select: { downloadCount: true, downloadedAt: true },
    });

    await writeAuditLog(tx, {
      actorId: actor.actorId,
      actorLabel: actor.actorLabel,
      action: variant === "internal" ? "costing_sheet_downloaded" : "downloaded",
      entityType: "Quotation",
      entityId: quotation.id,
      // The audit row *is* the download log. It carries who and when, and module 00's activity feed
      // merges audit rows by entity, so it appears in the record's timeline for free.
      summary:
        variant === "internal"
          ? `Downloaded the internal costing sheet for ${label}`
          : `Downloaded ${label} — ready for sending`,
      ip: actor.ip,
      userAgent: actor.userAgent,
      requestId: actor.requestId,
    });

    return {
      downloadCount: updated.downloadCount,
      downloadedAt: updated.downloadedAt,
    };
  });
}

export interface ConfirmSentInput {
  quotationId: string;
  /** The date it actually went — not necessarily today. */
  sentAt?: Date | null;
  /** §7: recipients defaulted from the inquiry contacts, confirmed by the sender. */
  sentToContactIds?: string[];
  note?: string | null;
}

/**
 * The human assertion that the quotation reached the customer.
 *
 * Requires a prior download. Confirming a send for a document nobody has produced is either a
 * mistake or a quotation sent by some route this system knows nothing about; refusing it keeps the
 * download log meaningful as evidence.
 *
 * §5's supersession happens here, not at revision time: "the prior revision becomes `superseded` at
 * the moment the new one is sent." A half-written revision must never retire the quotation the
 * customer is holding.
 */
export async function confirmQuotationSentService(actor: ActorMeta, input: ConfirmSentInput) {
  const quotation = await db.quotation.findFirst({
    where: { id: input.quotationId, deletedAt: null },
    include: { inquiry: { select: { id: true, number: true } } },
  });
  if (!quotation) {
    throw new TRPCError({ code: "NOT_FOUND", message: "That quotation no longer exists." });
  }

  if (quotation.status !== "approved") {
    throw new TRPCError({
      code: "BAD_REQUEST",
      message:
        quotation.status === "sent"
          ? `${quotation.number} is already recorded as sent.`
          : `${quotation.number} is ${quotation.status.replace(/_/g, " ")}. ` +
            `§6 requires approval before a quotation can be issued.`,
    });
  }

  if (!quotation.downloadedAt) {
    throw new TRPCError({
      code: "BAD_REQUEST",
      message:
        `Nobody has downloaded ${quotation.number} yet, so there is no document to have sent. ` +
        `Download the PDF first.`,
    });
  }

  const sentAt = input.sentAt ?? new Date();
  if (sentAt.getTime() > Date.now() + DAY_MS) {
    throw new TRPCError({
      code: "BAD_REQUEST",
      message: "A quotation cannot have been sent in the future.",
    });
  }

  const rootId = quotation.parentQuotationId ?? quotation.id;

  return db.$transaction(async (tx) => {
    const updated = await tx.quotation.update({
      where: { id: quotation.id },
      data: {
        status: "sent",
        sentAt,
        sentConfirmedAt: new Date(),
        sentConfirmedBy: actor.actorId,
        sentToContactIds: input.sentToContactIds ?? [],
      },
    });

    // §5: every earlier revision of this chain is now superseded. Scoped to revisions *below* this
    // one so confirming R1 does not retire an R2 draft somebody is already working on.
    const superseded = await tx.quotation.updateMany({
      where: {
        OR: [{ id: rootId }, { parentQuotationId: rootId }],
        id: { not: quotation.id },
        revision: { lt: quotation.revision },
        status: { in: ["sent", "under_negotiation", "approved"] },
        deletedAt: null,
      },
      data: { status: "superseded" },
    });

    await writeAuditLog(tx, {
      actorId: actor.actorId,
      actorLabel: actor.actorLabel,
      action: "sent",
      entityType: "Quotation",
      entityId: quotation.id,
      summary:
        `Confirmed ${quotationDisplayNumber(quotation.number, quotation.revision)} sent on ` +
        `${sentAt.toISOString().slice(0, 10)}` +
        (superseded.count > 0 ? ` (superseded ${superseded.count} earlier revision(s))` : "") +
        (input.note ? ` — ${input.note}` : ""),
      diff: { status: { from: quotation.status, to: "sent" } },
      ip: actor.ip,
      userAgent: actor.userAgent,
      requestId: actor.requestId,
    });

    // §10. Module 01 subscribes to move its inquiry to `quoted` — the transition a person cannot
    // make by hand, because §3 says the quotation's outcome sets it.
    await emit(
      tx,
      "quotation.sent",
      {
        quotationId: updated.id,
        number: updated.number,
        revision: updated.revision,
        inquiryId: quotation.inquiryId,
        accountId: quotation.accountId,
        sentAt: sentAt.toISOString(),
      },
      { actorId: actor.actorId, requestId: actor.requestId },
    );

    return {
      status: updated.status,
      sentAt: updated.sentAt,
      supersededCount: superseded.count,
      inquiryNumber: quotation.inquiry?.number ?? null,
    };
  });
}

export interface UnsentSweepResult {
  reminded: { quotationId: string; number: string; daysSinceDownload: number }[];
  scanned: number;
}

/**
 * Chases quotations that were downloaded and never confirmed sent.
 *
 * This is the mechanism that makes a human assertion trustworthy. Without it, "confirm sent" is a
 * box people forget, and the pipeline quietly fills with inquiries stuck in `quoting` that were in
 * fact quoted weeks ago — which is precisely the "inquiries get lost" failure module 01 exists to
 * remove, displaced one step down the process.
 *
 * Fires on the exact day a threshold is crossed, like every other sweep here, because a daily
 * repeat is how a notification becomes background noise.
 */
export async function sweepUnsentDownloads(now: Date = new Date()): Promise<UnsentSweepResult> {
  const maxDays = Math.max(...UNSENT_REMINDER_DAYS);

  const candidates = await db.quotation.findMany({
    where: {
      deletedAt: null,
      status: "approved",
      downloadedAt: { not: null, gte: new Date(now.getTime() - (maxDays + 1) * DAY_MS) },
      sentAt: null,
    },
    select: {
      id: true,
      number: true,
      revision: true,
      downloadedAt: true,
      downloadedBy: true,
      preparedById: true,
      account: { select: { name: true } },
    },
  });

  const startOfDay = (d: Date) => Math.floor(d.getTime() / DAY_MS);
  const reminded: UnsentSweepResult["reminded"] = [];

  for (const quotation of candidates) {
    if (!quotation.downloadedAt) continue;
    const elapsed = startOfDay(now) - startOfDay(quotation.downloadedAt);
    const threshold = UNSENT_REMINDER_DAYS.find((t) => t === elapsed);
    if (threshold === undefined) continue;

    // Whoever downloaded it, falling back to whoever prepared it — the download is the more
    // specific signal about who was about to send.
    const recipientId = quotation.downloadedBy ?? quotation.preparedById;
    const label = quotationDisplayNumber(quotation.number, quotation.revision);

    await notify({
      recipientId,
      type: UNSENT_DOWNLOAD_NOTIFICATION_TYPE,
      title: `${label} was downloaded ${threshold} days ago and is not marked sent`,
      body:
        `${quotation.account?.name ?? "This customer"} has not been recorded as having received ` +
        `it. If you have sent it, confirm the date so the inquiry moves to quoted; if not, it is ` +
        `still sitting with you.`,
      entityType: "Quotation",
      entityId: quotation.id,
    });

    reminded.push({
      quotationId: quotation.id,
      number: label,
      daysSinceDownload: threshold,
    });
  }

  return { reminded, scanned: candidates.length };
}
