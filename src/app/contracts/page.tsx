"use client";

import Link from "next/link";
import { Card, PageHeader } from "@/components/ui/layout";
import { StatusBadge, type StatusTone } from "@/components/ui/status-badge";
import { DateCell } from "@/components/ui/cells";
import { daysUntil } from "@/server/core/operations/renewal-rules";
import { trpc } from "@/lib/trpc/client";

/**
 * §16's maintenance contracts.
 *
 * Sorted by end date rather than by name, because the question this list answers is "what is running
 * out?" — the same question the renewals screen answers, one step earlier and with the whole term in
 * view.
 */

const TONE: Record<string, StatusTone> = {
  active: "approved",
  draft: "pending",
  expired: "failed",
  cancelled: "draft",
  renewed: "info",
};

export default function ContractsPage() {
  const contracts = trpc.operations.listContracts.useQuery();
  const rows = contracts.data ?? [];

  return (
    <div>
      <PageHeader
        title="Maintenance contracts"
        description="What the company has committed to service, and when each commitment runs out."
      />

      {contracts.isPending && <p className="text-sm text-text-muted">Loading…</p>}
      {contracts.error && <p className="text-sm text-danger">{contracts.error.message}</p>}

      {contracts.data?.length === 0 && (
        <Card className="p-4">
          <p className="text-sm">No maintenance contracts yet.</p>
          <p className="mt-1 text-xs text-text-muted">
            A contract turns an installed base into scheduled work: visits become tickets ahead of
            time, and the last ninety days become a renewal conversation.
          </p>
        </Card>
      )}

      <ul className="mt-4 space-y-2">
        {rows.map((row) => {
          const remaining = daysUntil(row.endDate);
          return (
            <li key={row.id}>
              <Link href={`/contracts/${row.id}`} className="block">
                <Card className="p-3 transition-colors hover:border-brand">
                  <div className="flex flex-wrap items-baseline justify-between gap-2">
                    <p className="text-sm font-medium">
                      {row.number} · {row.account.name}
                    </p>
                    <StatusBadge tone={TONE[row.status] ?? "draft"}>{row.status}</StatusBadge>
                  </div>

                  <p className="mt-1 text-xs text-text-muted">
                    <DateCell value={row.startDate} /> to <DateCell value={row.endDate} />
                    {row.status === "active" && (
                      <>
                        {" · "}
                        {remaining < 0 ? `${-remaining} days past` : `${remaining} days left`}
                      </>
                    )}
                    {" · "}
                    {row.visitsPerYear} visit{row.visitsPerYear === 1 ? "" : "s"} a year
                    {" · "}
                    {row.equipmentIds.length} item{row.equipmentIds.length === 1 ? "" : "s"} covered
                  </p>

                  {row.renewalFlaggedAt && (
                    <p className="mt-1 text-xs">Renewal already raised as a lead.</p>
                  )}
                </Card>
              </Link>
            </li>
          );
        })}
      </ul>
    </div>
  );
}
