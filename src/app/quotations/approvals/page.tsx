"use client";

import { useState } from "react";
import Link from "next/link";
import { Button } from "@/components/ui/button";
import { DateCell } from "@/components/ui/cells";
import { Card, EmptyState, PageHeader } from "@/components/ui/layout";
import { Textarea } from "@/components/ui/input";
import { StatusBadge } from "@/components/ui/status-badge";
import { formatMoney } from "@/lib/format";
import { toastError, toastSuccess } from "@/lib/errors";
import { trpc } from "@/lib/trpc/client";

/**
 * §6: "The approval queue is a first-class screen for the VP: every quote awaiting them, with
 * total, margin, customer, and age, **approvable in sequence without opening each one**."
 *
 * That last clause is the whole design. It is a stack of decidable cards rather than a table with a
 * link per row, because the VP's actual task is a sitting: work down the list, approve most, send
 * one back. A table that makes you open each record turns a ten-minute sitting into an afternoon,
 * and the number that decides most of these — the margin — is right here on the card.
 *
 * Deliberately not a `DataTable`. Sorting and paging a queue you are about to empty is furniture;
 * the useful order is oldest-first, which the server already returns, and the useful emphasis is on
 * the ones that have escalated.
 */
export default function ApprovalQueuePage() {
  const utils = trpc.useUtils();
  const queue = trpc.quotation.approvalQueue.useQuery();
  const decide = trpc.quotation.decideApproval.useMutation();

  const [rejectingId, setRejectingId] = useState<string | null>(null);
  const [comment, setComment] = useState("");

  const refresh = () => {
    void utils.quotation.approvalQueue.invalidate();
    void utils.quotation.list.invalidate();
  };

  const rows = queue.data ?? [];

  return (
    <div className="mx-auto max-w-4xl">
      <PageHeader
        title="Awaiting approval"
        description="Every quotation waiting on you. Nothing here can be issued to a customer until it is approved."
      />

      {queue.isPending && <p className="p-6 text-sm text-text-muted">Loading…</p>}

      {!queue.isPending && rows.length === 0 && (
        <EmptyState
          title="Nothing is waiting on you"
          description="Quotations appear here the moment they are submitted for approval."
        />
      )}

      <div className="space-y-3">
        {rows.map((row) => (
          <Card key={row.approvalRequestId} className="p-4">
            <div className="flex flex-wrap items-start justify-between gap-3">
              <div className="min-w-0">
                <Link
                  href={`/quotations/${row.quotationId}`}
                  className="text-sm font-semibold hover:underline"
                >
                  {row.displayNumber}
                </Link>
                <p className="mt-0.5 text-sm">{row.title}</p>
                <p className="mt-0.5 text-xs text-text-muted">{row.customer}</p>
              </div>
              <div className="text-right">
                <p className="tabular text-sm font-semibold">
                  {formatMoney(row.total, row.currency)}
                </p>
                {/* Absent, not zero, for a caller without `finance.view_cost` — Spec.md §4.3
                    strips the field server-side rather than hiding it here. */}
                {row.marginPct !== undefined && (
                  <p className="tabular mt-0.5 text-xs text-text-muted">
                    {Number(row.marginPct).toFixed(1)}% margin
                    {row.marginAmount !== undefined &&
                      ` · ${formatMoney(row.marginAmount, row.currency)}`}
                  </p>
                )}
              </div>
            </div>

            <div className="mt-3 flex flex-wrap items-center gap-2 text-xs text-text-muted">
              <span>
                Submitted <DateCell value={row.requestedAt} withTime /> ·{" "}
                <span className="tabular">{row.ageWorkingHours.toFixed(1)}</span> working hours ago
              </span>
              {row.isEscalated ? (
                <StatusBadge tone="failed">
                  Escalated — the President may also decide this
                </StatusBadge>
              ) : (
                <span>
                  Escalates <DateCell value={row.fallbackAvailableAt} withTime />
                </span>
              )}
              {row.wouldBeFallback && (
                <StatusBadge tone="pending">You would decide as fallback approver</StatusBadge>
              )}
            </div>

            {rejectingId === row.quotationId && (
              <Textarea
                aria-label={`Why is ${row.displayNumber} being sent back?`}
                rows={2}
                className="mt-3 text-xs"
                value={comment}
                onChange={(e) => setComment(e.target.value)}
                placeholder="What needs to change? The preparer sees this."
              />
            )}

            <div className="mt-3 flex flex-wrap gap-2">
              <Button
                size="sm"
                disabled={decide.isPending}
                onClick={async () => {
                  try {
                    const result = await decide.mutateAsync({
                      quotationId: row.quotationId,
                      decision: "approved",
                    });
                    toastSuccess(
                      result.isFallback
                        ? `${row.displayNumber} approved, recorded as a fallback approval.`
                        : `${row.displayNumber} approved.`,
                    );
                    setRejectingId(null);
                    refresh();
                  } catch (error) {
                    toastError(error);
                  }
                }}
              >
                Approve
              </Button>
              <Button
                size="sm"
                variant="ghost"
                disabled={decide.isPending}
                onClick={async () => {
                  if (rejectingId !== row.quotationId) {
                    setRejectingId(row.quotationId);
                    setComment("");
                    return;
                  }
                  try {
                    await decide.mutateAsync({
                      quotationId: row.quotationId,
                      decision: "rejected",
                      comment,
                    });
                    toastSuccess(`${row.displayNumber} sent back to draft.`);
                    setRejectingId(null);
                    setComment("");
                    refresh();
                  } catch (error) {
                    toastError(error);
                  }
                }}
              >
                {rejectingId === row.quotationId ? "Send back" : "Send back…"}
              </Button>
              <Button asChild size="sm" variant="ghost">
                <Link href={`/quotations/${row.quotationId}`}>Open</Link>
              </Button>
            </div>
          </Card>
        ))}
      </div>
    </div>
  );
}
