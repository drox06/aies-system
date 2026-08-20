import { db } from "@/lib/db";

/**
 * §5b's release queue — approved cash advances waiting for finance to hand the money over.
 *
 * ## Why this is finance's screen and not another filter on the register
 *
 * §5b is explicit that finance owns the money side of module 04's loop and must not duplicate its
 * model, so nothing here is a new record: this reads `CashAdvance` and the release action is module
 * 04's own. What is new is the **question**. The register at `/cash-advances` answers "what is
 * outstanding", sorted by liquidation deadline — a backward-looking list about money already gone.
 * This answers "who is waiting for money, and when do they need it", which is a different sort order
 * and a different urgency.
 *
 * Conflating them was tempting and would have been wrong. An advance approved this morning for a
 * crew leaving tomorrow is invisible near the bottom of a register sorted by a liquidation date it
 * does not have yet.
 *
 * ## Why operations can see it
 *
 * §5b: "visible to operations too, so nobody has to chase it in a chat app." A dispatcher who can
 * see that an advance is third in the queue and needed on Thursday does not ring finance; one who
 * can see nothing rings finance every hour. The read is gated on `cash_advance.view_register`,
 * which operations already holds — the *release* is finance's, and that is the permission that
 * matters.
 */

export interface ReleaseQueueRow {
  id: string;
  number: string;
  purpose: string;
  amount: string;
  currency: string;
  neededBy: Date;
  /** Whole days from today. Negative means the crew needed it before now. */
  daysUntilNeeded: number;
  /**
   * How loudly the row should read.
   *
   * `late` is the case §5b names — "a crew scheduled to mobilize tomorrow morning with an unreleased
   * advance is the top of this list" — and it is deliberately reached a day early. An advance needed
   * tomorrow is already a problem this afternoon, because banks close and cash has to be counted.
   */
  urgency: "late" | "urgent" | "soon" | "later";
  ticket: { id: string; number: string; title: string } | null;
  project: { id: string; code: string; name: string } | null;
  approvedAt: Date | null;
}

export function urgencyFor(daysUntilNeeded: number): ReleaseQueueRow["urgency"] {
  if (daysUntilNeeded < 0) return "late";
  if (daysUntilNeeded <= 1) return "urgent";
  if (daysUntilNeeded <= 3) return "soon";
  return "later";
}

/**
 * Approved and unreleased, soonest needed first.
 *
 * `approved` only. A draft or a pending request is not finance's to act on yet, and including them
 * would make the queue a list of things somebody else has to do first — which is how a queue stops
 * being read.
 */
export async function releaseQueueService(): Promise<{
  rows: ReleaseQueueRow[];
  totalWaiting: string;
  lateCount: number;
}> {
  const rows = await db.cashAdvance.findMany({
    where: { deletedAt: null, status: "approved" },
    include: {
      ticket: { select: { id: true, number: true, title: true } },
      project: { select: { id: true, code: true, name: true } },
    },
    orderBy: [{ neededBy: "asc" }],
    take: 200,
  });

  const startOfToday = new Date();
  startOfToday.setHours(0, 0, 0, 0);

  let total = 0;
  const decorated = rows.map((row) => {
    /*
      Whole days, from midnight to midnight.

      Measuring from *now* would make an advance needed at 08:00 tomorrow read as "0 days" at 09:00
      today and "1 day" at 07:00, which is the wrong way round and unreadable on a screen somebody
      glances at. Calendar days are what the person answering the question is thinking in.
    */
    const neededDay = new Date(row.neededBy);
    neededDay.setHours(0, 0, 0, 0);
    const daysUntilNeeded = Math.round((neededDay.getTime() - startOfToday.getTime()) / 86_400_000);

    // The approved figure is what finance hands over; the requested one is what was asked for, and
    // they differ whenever an approver trimmed it.
    const amount = row.amountApproved ?? row.amountRequested;
    total += Number(amount);

    return {
      id: row.id,
      number: row.number,
      purpose: row.purpose,
      amount: amount.toString(),
      currency: row.currency,
      neededBy: row.neededBy,
      daysUntilNeeded,
      urgency: urgencyFor(daysUntilNeeded),
      ticket: row.ticket,
      project: row.project,
      approvedAt: row.approvedAt,
    } satisfies ReleaseQueueRow;
  });

  return {
    rows: decorated,
    totalWaiting: total.toFixed(2),
    lateCount: decorated.filter((row) => row.urgency === "late").length,
  };
}
