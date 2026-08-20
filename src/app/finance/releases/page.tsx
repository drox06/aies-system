"use client";

import Link from "next/link";
import { DateCell } from "@/components/ui/cells";
import { Card, PageHeader } from "@/components/ui/layout";
import { StatusBadge, type StatusTone } from "@/components/ui/status-badge";
import { formatMoney } from "@/lib/format";
import { trpc } from "@/lib/trpc/client";

/**
 * §5b's release queue — who is waiting for cash, and when they need it.
 *
 * ## Why this is a screen of its own
 *
 * The register at `/cash-advances` answers "what is outstanding", sorted by liquidation deadline: a
 * backward-looking list about money already gone. This answers a forward-looking question — "who is
 * waiting, and when do they need it" — and the two want opposite sort orders. An advance approved
 * this morning for a crew leaving tomorrow has no liquidation date yet, so on the register it sits
 * near the bottom, which is exactly where it should not be.
 *
 * §5b names the case this exists for: *"a crew scheduled to mobilize tomorrow morning with an
 * unreleased advance is the top of this list."*
 *
 * ## Why operations can see it
 *
 * Also §5b: *"visible to operations too, so nobody has to chase it in a chat app."* A dispatcher who
 * can see their advance is third in the queue and needed Thursday does not ring finance. One who can
 * see nothing rings every hour. Seeing the queue and emptying it are different authorities — the
 * release itself stays on `cash_advance.release`.
 */

const URGENCY_TONE: Record<string, StatusTone> = {
  late: "failed",
  urgent: "failed",
  soon: "pending",
  later: "draft",
};

/**
 * Said in days rather than dates, because the question is always "is this a problem now".
 *
 * "Needed tomorrow" reads as urgent; "needed 21 Aug" needs the reader to work out what day it is.
 * The date is beside it for the person who wants to check.
 */
function urgencyLabel(days: number): string {
  if (days < 0) return `${-days} day${days === -1 ? "" : "s"} late`;
  if (days === 0) return "needed today";
  if (days === 1) return "needed tomorrow";
  return `in ${days} days`;
}

export default function ReleaseQueuePage() {
  const queue = trpc.finance.releaseQueue.useQuery();

  const data = queue.data;

  return (
    <div className="mx-auto max-w-5xl">
      <PageHeader
        title="Cash to release"
        description="Approved advances waiting for the money, soonest needed first."
      />

      {queue.isPending && <p className="mt-4 text-sm text-text-muted">Loading…</p>}
      {queue.error && (
        <Card className="mt-4 p-4">
          <p className="text-sm">{queue.error.message}</p>
        </Card>
      )}

      {data && (
        <>
          <div className="mt-4 grid gap-3 sm:grid-cols-3">
            <Card className="p-3">
              <p className="text-xs text-text-muted">Waiting</p>
              <p className="tabular mt-0.5 text-lg font-semibold">{data.rows.length}</p>
            </Card>
            <Card className="p-3">
              <p className="text-xs text-text-muted">Total to release</p>
              <p className="tabular mt-0.5 text-lg font-semibold">
                {formatMoney(data.totalWaiting, "PHP")}
              </p>
            </Card>
            <Card className="p-3">
              <p className="text-xs text-text-muted">Already late</p>
              {/*
                Late is shown even when it is zero. §5b calls unliquidated advances "the most common
                quiet cash leak in a business of this shape" and asks for the number to be impossible
                to avoid looking at; a figure that disappears when it is good is a figure nobody
                learns to read.
              */}
              <p
                className={`tabular mt-0.5 text-lg font-semibold ${
                  data.lateCount > 0 ? "text-danger" : ""
                }`}
              >
                {data.lateCount}
              </p>
            </Card>
          </div>

          {data.rows.length === 0 ? (
            <Card className="mt-4 p-4">
              <p className="text-sm">Nothing approved is waiting for release.</p>
              <p className="mt-1 text-xs text-text-muted">
                Advances appear here once an approver has passed them, and leave once finance
                records the money going out.
              </p>
            </Card>
          ) : (
            <ul className="mt-4 space-y-2">
              {data.rows.map((row) => (
                <li key={row.id} className="rounded-md border border-border p-3">
                  <div className="flex flex-wrap items-baseline justify-between gap-2">
                    <span className="flex items-baseline gap-2">
                      {/*
                        The advance's own record is where releasing happens — module 04 owns the
                        action, and §5b is explicit that finance must not duplicate its model.
                      */}
                      <Link
                        href={`/cash-advances/${row.id}`}
                        className="tabular font-medium text-blue-600 underline underline-offset-2"
                      >
                        {row.number}
                      </Link>
                      <StatusBadge tone={URGENCY_TONE[row.urgency] ?? "draft"}>
                        {urgencyLabel(row.daysUntilNeeded)}
                      </StatusBadge>
                    </span>
                    <span className="tabular font-medium">
                      {formatMoney(row.amount, row.currency)}
                    </span>
                  </div>

                  <p className="mt-1 text-sm">{row.purpose}</p>

                  <p className="mt-0.5 text-xs text-text-muted">
                    Needed <DateCell value={row.neededBy} />
                    {row.ticket ? ` · ${row.ticket.number} — ${row.ticket.title}` : ""}
                    {row.project ? ` · ${row.project.code}` : ""}
                  </p>
                </li>
              ))}
            </ul>
          )}
        </>
      )}
    </div>
  );
}
