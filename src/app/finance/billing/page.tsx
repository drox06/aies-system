"use client";

import { useState } from "react";
import Link from "next/link";
import { Button } from "@/components/ui/button";
import { DateCell } from "@/components/ui/cells";
import { Card, EmptyState, PageHeader } from "@/components/ui/layout";
import { StatusBadge } from "@/components/ui/status-badge";
import { trpc } from "@/lib/trpc/client";

/**
 * specs/05-finance-billing.md §2's work list.
 *
 * ## What this screen is claiming
 *
 * §2: "Finance never has to ask operations whether a project is done — this is the core coordination
 * failure the platform exists to fix."
 *
 * So every row carries **why it is here**. Not the trigger's name — the thing that happened. "The
 * project closed", "the customer signed for the goods". Without that, the list is a set of demands
 * from an unexplained source, and the first thing anybody does with an unexplained demand is go and
 * ask operations, which is the phone call this module exists to remove.
 *
 * ## Overdue is not a separate list
 *
 * Sorted by due date with the overdue ones marked, rather than split into two tables. A milestone
 * that went overdue is the same piece of work as one that has not; splitting them would mean reading
 * two lists to answer "what should I bill today", and the answer to that is always "the top of one
 * list".
 */

const pesos = (centavos: number) =>
  `₱${(centavos / 100).toLocaleString("en-PH", { minimumFractionDigits: 2 })}`;

function isOverdue(dueDate: Date | string | null): boolean {
  if (!dueDate) return false;
  return new Date(dueDate).getTime() < Date.now();
}

export default function BillingWorklistPage() {
  const billable = trpc.finance.billable.useQuery();
  const [showAll, setShowAll] = useState(false);

  if (billable.isPending) {
    return <p className="text-sm text-text-muted">Loading what is ready to bill…</p>;
  }
  if (billable.error) {
    return <p className="text-sm text-danger">{billable.error.message}</p>;
  }

  const rows = billable.data ?? [];
  const overdue = rows.filter((row) => isOverdue(row.dueDate));
  const total = rows.reduce((sum, row) => sum + row.amount, 0);
  const shown = showAll ? rows : rows.slice(0, 50);

  return (
    <div>
      <PageHeader
        title="Ready to bill"
        description="Milestones the work has already earned. Each one is here because something happened elsewhere in the platform — the reason is on the row."
      />

      {rows.length === 0 ? (
        <Card className="mt-4 p-4">
          <EmptyState
            title="Nothing is ready to bill."
            description="A milestone appears here when the event it bills on happens — an order raised, goods signed for, a project closed. If an order has no billing plan yet, plan it from the order itself."
          />
        </Card>
      ) : (
        <>
          <div className="mt-4 flex flex-wrap gap-3">
            <Card className="flex-1 p-3">
              <p className="text-xs text-text-muted">Ready to bill</p>
              <p className="mt-1 text-lg font-semibold tabular">{pesos(total)}</p>
              <p className="text-xs text-text-muted">
                {rows.length} milestone{rows.length === 1 ? "" : "s"}
              </p>
            </Card>
            {overdue.length > 0 && (
              <Card className="flex-1 border-2 border-amber-400 bg-amber-50 p-3">
                <p className="text-xs text-amber-900">Past its due date</p>
                <p className="mt-1 text-lg font-semibold tabular text-amber-900">
                  {pesos(overdue.reduce((sum, row) => sum + row.amount, 0))}
                </p>
                <p className="text-xs text-amber-900">
                  {overdue.length} milestone{overdue.length === 1 ? "" : "s"} — billable and not
                  billed
                </p>
              </Card>
            )}
          </div>

          <div className="mt-4 space-y-2">
            {shown.map((row) => (
              <Card key={row.id} className="p-3">
                <div className="flex flex-wrap items-baseline justify-between gap-2">
                  <div className="min-w-0">
                    <p className="font-medium">
                      {row.label}
                      <span className="ml-2 text-sm text-text-muted">{row.pct}%</span>
                    </p>
                    <p className="mt-0.5 text-sm text-text-muted">
                      {row.accountName ?? "Unknown customer"}
                      {row.salesOrderNumber && (
                        <>
                          {" · "}
                          <Link href={`/sales-orders/${row.salesOrderId}`} className="underline">
                            {row.salesOrderNumber}
                          </Link>
                        </>
                      )}
                    </p>
                  </div>
                  <div className="text-right">
                    <p className="tabular font-semibold">{pesos(row.amount)}</p>
                    {row.dueDate && (
                      <p className="text-xs">
                        {isOverdue(row.dueDate) ? (
                          <StatusBadge tone="failed">
                            Due <DateCell value={row.dueDate} />
                          </StatusBadge>
                        ) : (
                          <span className="text-text-muted">
                            Due <DateCell value={row.dueDate} />
                          </span>
                        )}
                      </p>
                    )}
                  </div>
                </div>

                {/* The whole point of the module, on every row. */}
                <p className="mt-2 border-t border-border pt-2 text-xs text-text-muted">
                  Billable because {row.readyReason ?? "its trigger fired"}
                  {row.readyAt && (
                    <>
                      {" — "}
                      <DateCell value={row.readyAt} withTime />
                    </>
                  )}
                  . {row.triggerLabel}.
                </p>
              </Card>
            ))}
          </div>

          {rows.length > shown.length && (
            <Button variant="secondary" className="mt-3" onClick={() => setShowAll(true)}>
              Show the other {rows.length - shown.length}
            </Button>
          )}
        </>
      )}
    </div>
  );
}
