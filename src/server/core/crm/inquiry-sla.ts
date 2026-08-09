import { db } from "@/lib/db";
import { writeAuditLog } from "@/server/core/audit/audit";
import {
  assessInquirySla,
  INQUIRY_ACK_SLA_BUSINESS_DAYS,
} from "@/server/core/crm/inquiry-lifecycle";
import { INQUIRY_ENTITY_TYPE } from "@/server/core/crm/inquiry-service";
import { notify } from "@/server/core/notify/notify";
import { registerNotificationType } from "@/server/core/notify/registry";

/**
 * The acknowledgement SLA escalation (specs/01-crm-inquiry.md §3).
 *
 * §3 says why this exists in one line: "This directly addresses the 'inquiries get lost' problem."
 * Spec.md §1.2's table names the same failure — "no CRM or pipeline tool → no forecast, no
 * follow-up discipline, lost inquiries" — so this sweep is the module's whole reason for being,
 * expressed as about forty lines of code.
 */

export const SLA_BREACH_NOTIFICATION_TYPE = "inquiry.sla_breached";

registerNotificationType({
  key: SLA_BREACH_NOTIFICATION_TYPE,
  label: "An inquiry was not acknowledged within its SLA",
  // In-app only *for now*, and for a different reason than the accreditation reminders.
  //
  // Those are in-app by design: the work happens on the customer's portal, so an email would point
  // nowhere useful. This one is the opposite — the action is right here, and an escalation that
  // only appears once the VP happens to open the app is a weak escalation. It stays in-app solely
  // because the `notify_email` queue has no handler (docs/DECISIONS.md #10) and every send would
  // dead-letter. Turn `email` on in the same change that wires a real provider.
  defaultChannels: { inApp: true, email: false, digest: false },
  // No coalescing: `slaEscalatedAt` already guarantees one notification per inquiry, and coalescing
  // across *different* inquiries would merge two separate problems into one badge.
});

export interface SlaSweepResult {
  escalated: { inquiryId: string; number: string; overdueByMs: number }[];
  scanned: number;
  recipients: number;
}

/**
 * Escalates unacknowledged inquiries past their deadline to the vice-president and president.
 *
 * Three things worth knowing about the query:
 *
 * 1. It only considers inquiries that are still `new`. Once acknowledged the clock is stopped, and
 *    §3 escalates "an overdue **unacknowledged** inquiry" — nothing else.
 * 2. `slaEscalatedAt: null` makes this fire once rather than nightly forever. A daily repeat is how
 *    an escalation becomes background noise, which is the failure mode it exists to prevent.
 * 3. The deadline itself is not in the query, because it is derived rather than stored. The filter
 *    is a cheap pre-cut — everything received longer ago than the SLA could possibly stretch to —
 *    and `assessInquirySla` makes the real decision per row against the working calendar.
 *
 * Recipients resolve by *role*, never by hardcoded user id: EA and KJ hold president and
 * vice-president today, and naming them directly quietly stops working the day somebody changes job.
 */
export async function sweepInquirySla(now: Date = new Date()): Promise<SlaSweepResult> {
  const candidates = await db.inquiry.findMany({
    where: {
      deletedAt: null,
      acknowledgedAt: null,
      slaEscalatedAt: null,
      status: "new",
      receivedAt: { lte: new Date(now.getTime() - INQUIRY_ACK_SLA_BUSINESS_DAYS * 86_400_000) },
    },
    select: {
      id: true,
      number: true,
      subject: true,
      status: true,
      receivedAt: true,
      acknowledgedAt: true,
      slaPausedAt: true,
      slaPausedMs: true,
      ownerId: true,
      account: { select: { name: true } },
    },
  });

  const recipients = await db.user.findMany({
    where: {
      isActive: true,
      deletedAt: null,
      roles: { some: { role: { key: { in: ["vice_president", "president"] } } } },
    },
    select: { id: true },
  });

  const escalated: SlaSweepResult["escalated"] = [];

  for (const inquiry of candidates) {
    const sla = assessInquirySla(inquiry, now);
    if (!sla.escalatable) continue;

    for (const recipient of recipients) {
      await notify({
        recipientId: recipient.id,
        type: SLA_BREACH_NOTIFICATION_TYPE,
        title: `Unacknowledged inquiry past its SLA — ${inquiry.number}`,
        body:
          `${inquiry.subject}` +
          (inquiry.account?.name ? ` (${inquiry.account.name})` : "") +
          `. Received ${inquiry.receivedAt.toISOString().slice(0, 10)}, due ` +
          `${sla.dueAt.toISOString().slice(0, 10)}, still not acknowledged.`,
        entityType: INQUIRY_ENTITY_TYPE,
        entityId: inquiry.id,
      });
    }

    await db.$transaction(async (tx) => {
      await tx.inquiry.update({ where: { id: inquiry.id }, data: { slaEscalatedAt: now } });
      await writeAuditLog(tx, {
        // A system action, not a person's. `actorLabel` says so plainly rather than borrowing the
        // name of whoever the sweep happens to escalate to, which would misattribute it in the feed.
        actorId: "system",
        actorLabel: "System (SLA sweep)",
        action: "sla_escalated",
        entityType: INQUIRY_ENTITY_TYPE,
        entityId: inquiry.id,
        summary:
          `${inquiry.number} was not acknowledged within ${INQUIRY_ACK_SLA_BUSINESS_DAYS} ` +
          `business day(s); escalated to the vice-president and president`,
      });
    });

    escalated.push({
      inquiryId: inquiry.id,
      number: inquiry.number,
      overdueByMs: -sla.remainingMs,
    });
  }

  return { escalated, scanned: candidates.length, recipients: recipients.length };
}
