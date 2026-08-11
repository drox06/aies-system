import { db } from "@/lib/db";
import { writeAuditLog } from "@/server/core/audit/audit";
import { emit } from "@/server/core/events/emit";
import { notify } from "@/server/core/notify/notify";
import { registerNotificationType } from "@/server/core/notify/registry";
import { quotationDisplayNumber } from "@/server/core/quotation/quotation-number";
import { QUOTATION_ENTITY_TYPE } from "@/server/core/quotation/quotation-service";

/**
 * §7's auto-expire: "a job flips `sent` quotes past `validUntil` to `expired` and notifies the owner
 * seven days before."
 *
 * Both halves matter, and the warning is the one that does the work. An expiry notice tells somebody
 * about an opportunity that has already lapsed; the seven-day warning is the last moment anyone can
 * still act — chase the customer, or extend the validity, which §5 already has a revision reason for
 * (`validity_extension`).
 *
 * ## Why `under_negotiation` is warned but not expired
 *
 * §7 names `sent`, and that is taken literally rather than widened to "anything live". A quotation
 * under negotiation is a conversation in progress; flipping it to `expired` underneath the two
 * people having that conversation would misrepresent it, and the pipeline would show a deal as lost
 * that nobody has lost. The lifecycle map still permits `under_negotiation → expired` for the day an
 * explicit action needs it — this sweep simply does not take it.
 *
 * The honest risk of that choice is a negotiation that quietly outlives its own price. The
 * seven-day warning is what answers it: the owner is told, and the fix is a revision that says so in
 * writing, which is what the customer should be getting anyway.
 */

export const QUOTATION_EXPIRING_NOTIFICATION_TYPE = "quotation.expiring_soon";
export const QUOTATION_EXPIRED_NOTIFICATION_TYPE = "quotation.expired";

registerNotificationType({
  key: QUOTATION_EXPIRING_NOTIFICATION_TYPE,
  label: "A quotation is about to expire",
  // In-app only while `notify_email` has no handler (docs/DECISIONS.md #10). Worth email when one
  // exists: this is the last day anybody can still act on it.
  defaultChannels: { inApp: true, email: false, digest: false },
});

registerNotificationType({
  key: QUOTATION_EXPIRED_NOTIFICATION_TYPE,
  label: "A quotation has expired",
  defaultChannels: { inApp: true, email: false, digest: false },
});

/** §7's "seven days before". */
export const EXPIRY_WARNING_DAYS = 7;

const DAY_MS = 86_400_000;

/** Whole days since the epoch, so "the same day" is a comparison of two integers. */
const dayIndex = (date: Date) => Math.floor(date.getTime() / DAY_MS);

export interface ExpirySweepResult {
  expired: { quotationId: string; number: string }[];
  warned: { quotationId: string; number: string; daysLeft: number }[];
}

/**
 * Nightly. Idempotent by construction, like every other sweep here.
 *
 * The expiry half is idempotent because it only selects `sent` rows and leaves them `expired` —
 * a second run that day finds nothing. The warning half fires on the exact day the threshold is
 * crossed rather than every day inside the window, because a reminder that repeats daily for a week
 * is a reminder people learn to dismiss without reading.
 */
export async function sweepQuotationExpiries(now: Date = new Date()): Promise<ExpirySweepResult> {
  const result: ExpirySweepResult = { expired: [], warned: [] };

  // ---- the warning, seven days out --------------------------------------------------------------
  const warningDay = dayIndex(now) + EXPIRY_WARNING_DAYS;
  const upcoming = await db.quotation.findMany({
    where: {
      deletedAt: null,
      status: { in: ["sent", "under_negotiation"] },
      validUntil: {
        gte: new Date(warningDay * DAY_MS),
        lt: new Date((warningDay + 1) * DAY_MS),
      },
    },
    select: {
      id: true,
      number: true,
      revision: true,
      status: true,
      validUntil: true,
      preparedById: true,
      account: { select: { name: true } },
    },
  });

  for (const quotation of upcoming) {
    const label = quotationDisplayNumber(quotation.number, quotation.revision);
    try {
      await notify({
        recipientId: quotation.preparedById,
        type: QUOTATION_EXPIRING_NOTIFICATION_TYPE,
        title: `${label} expires in ${EXPIRY_WARNING_DAYS} days`,
        body:
          `${quotation.account?.name ?? "The customer"} has had it since it was issued. Chase it, ` +
          `or revise it with a new validity date — an expired quotation is a price you can no ` +
          `longer be held to, and a deal nobody is chasing.`,
        entityType: QUOTATION_ENTITY_TYPE,
        entityId: quotation.id,
      });
      result.warned.push({
        quotationId: quotation.id,
        number: label,
        daysLeft: EXPIRY_WARNING_DAYS,
      });
    } catch (error) {
      console.error("[quotation] failed to warn about an expiring quotation", quotation.id, error);
    }
  }

  // ---- the expiry itself ------------------------------------------------------------------------
  const lapsed = await db.quotation.findMany({
    where: {
      deletedAt: null,
      // §7 names `sent`. See the file header for why `under_negotiation` is deliberately excluded.
      status: "sent",
      validUntil: { lt: now },
    },
    select: {
      id: true,
      number: true,
      revision: true,
      validUntil: true,
      preparedById: true,
      accountId: true,
      inquiryId: true,
      account: { select: { name: true } },
    },
  });

  for (const quotation of lapsed) {
    const label = quotationDisplayNumber(quotation.number, quotation.revision);
    try {
      await db.$transaction(async (tx) => {
        // Guarded on the status it was read with, so a quotation accepted between the read and the
        // write is not expired out from under the acceptance.
        const { count } = await tx.quotation.updateMany({
          where: { id: quotation.id, status: "sent" },
          data: { status: "expired" },
        });
        if (count === 0) return;

        await writeAuditLog(tx, {
          // No actor: nobody did this. The audit trail should say so rather than attributing it to
          // whoever happened to trigger the cron.
          actorId: null,
          actorLabel: "System",
          action: "expired",
          entityType: QUOTATION_ENTITY_TYPE,
          entityId: quotation.id,
          summary: `${label} expired — it was valid until ${quotation.validUntil
            .toISOString()
            .slice(0, 10)}`,
          diff: { status: { from: "sent", to: "expired" } },
        });

        await emit(
          tx,
          "quotation.expired",
          {
            quotationId: quotation.id,
            number: quotation.number,
            revision: quotation.revision,
            accountId: quotation.accountId,
            inquiryId: quotation.inquiryId,
            validUntil: quotation.validUntil.toISOString(),
          },
          {},
        );
      });

      result.expired.push({ quotationId: quotation.id, number: label });

      await notify({
        recipientId: quotation.preparedById,
        type: QUOTATION_EXPIRED_NOTIFICATION_TYPE,
        title: `${label} has expired`,
        body:
          `Its validity ran out on ${quotation.validUntil.toISOString().slice(0, 10)}. If ` +
          `${quotation.account?.name ?? "the customer"} is still interested, revise it — the ` +
          `prices in it are no longer ones AIES is standing behind.`,
        entityType: QUOTATION_ENTITY_TYPE,
        entityId: quotation.id,
      });
    } catch (error) {
      // One bad row must not stop the rest, and the next night's run picks it up again.
      console.error("[quotation] failed to expire a quotation", quotation.id, error);
    }
  }

  return result;
}
