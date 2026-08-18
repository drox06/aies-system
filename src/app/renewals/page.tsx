"use client";

import Link from "next/link";
import { Card, PageHeader } from "@/components/ui/layout";
import { StatusBadge, type StatusTone } from "@/components/ui/status-badge";
import { DateCell } from "@/components/ui/cells";
import { RENEWAL_REASON_LABELS, type RenewalReason } from "@/server/core/operations/renewal-rules";
import { trpc } from "@/lib/trpc/client";

/**
 * §16's renewal loop, on a screen.
 *
 * "This is where the recurring revenue in this business lives." Every row is a sale the company has
 * already earned the right to make — the customer owns the equipment, AIES installed it, and somebody
 * has to service it.
 *
 * The page reads the **same function the nightly sweep acts on**, deliberately. A dashboard built
 * from its own query eventually disagrees with the job behind it, and then nobody trusts either.
 *
 * Each row carries the argument for the call, not just the date. A lead that says "AIESMC-260001
 * ends in 40 days" and nothing else gets closed as noise by whoever picks it up three weeks later.
 */

/**
 * Overdue reads differently from merely due, and the difference is the whole priority.
 *
 * Colour comes from *urgency* rather than from the kind of renewal: a calibration due tomorrow and a
 * contract ending tomorrow are equally urgent, and tinting them by reason would have said otherwise.
 * The reason is already the section heading.
 */
function urgency(days: number): { label: string; tone: StatusTone } {
  if (days < 0) return { label: `${-days} days overdue`, tone: "failed" };
  if (days <= 14) return { label: `${days} days`, tone: "failed" };
  if (days <= 45) return { label: `${days} days`, tone: "pending" };
  return { label: `${days} days`, tone: "info" };
}

export default function RenewalsPage() {
  const renewals = trpc.operations.dueRenewals.useQuery();

  const rows = renewals.data ?? [];
  const reasons = [...new Set(rows.map((row) => row.reason))] as RenewalReason[];

  return (
    <div>
      <PageHeader
        title="Renewals"
        description="Contracts ending, calibrations due, warranties running out, equipment past its service date. Work the company has already earned the right to quote for."
      />

      {renewals.isPending && <p className="text-sm text-text-muted">Loading…</p>}
      {renewals.error && <p className="text-sm text-danger">{renewals.error.message}</p>}

      {renewals.data?.length === 0 && (
        <Card className="p-4">
          <p className="text-sm">
            Nothing is due. Every contract and every item is inside its window.
          </p>
          <p className="mt-1 text-xs text-text-muted">
            The nightly job raises these as leads whether or not anybody opens this page — so an
            empty list means there is nothing to chase, not that nothing is being watched.
          </p>
        </Card>
      )}

      {reasons.map((reason) => {
        const group = rows.filter((row) => row.reason === reason);
        return (
          <section key={reason} className="mt-5">
            <div className="flex flex-wrap items-baseline gap-2">
              <h2 className="text-sm font-semibold">{RENEWAL_REASON_LABELS[reason]}</h2>
              <span className="text-xs text-text-muted">
                {group.length} item{group.length === 1 ? "" : "s"}
              </span>
            </div>

            <ul className="mt-2 space-y-2">
              {group.map((row) => {
                const state = urgency(row.daysUntilDue);
                return (
                  <li key={`${row.entityType}-${row.entityId}-${row.reason}`}>
                    <Card className="p-3">
                      <div className="flex flex-wrap items-baseline justify-between gap-2">
                        <p className="text-sm font-medium">{row.label}</p>
                        <StatusBadge tone={state.tone}>{state.label}</StatusBadge>
                      </div>

                      <p className="mt-1 text-xs text-text-muted">
                        Due <DateCell value={row.dueAt} />
                        {" · "}
                        <Link
                          href={
                            row.entityType === "MaintenanceContract"
                              ? `/contracts/${row.entityId}`
                              : `/warranty`
                          }
                          className="underline"
                        >
                          {row.entityType === "MaintenanceContract"
                            ? "Open contract"
                            : "Open equipment"}
                        </Link>
                      </p>

                      {/* The argument for the call. Without it the row is a date somebody ignores. */}
                      <p className="mt-2 text-sm">{row.pitch}</p>
                    </Card>
                  </li>
                );
              })}
            </ul>
          </section>
        );
      })}
    </div>
  );
}
