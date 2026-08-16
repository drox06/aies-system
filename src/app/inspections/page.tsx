"use client";

import { useState } from "react";
import Link from "next/link";
import { DateCell } from "@/components/ui/cells";
import { Card, EmptyState, PageHeader } from "@/components/ui/layout";
import { StatusBadge, type StatusTone } from "@/components/ui/status-badge";
import { trpc } from "@/lib/trpc/client";

/**
 * §6.1's site inspections.
 *
 * Two audiences on one screen. A surveyor opens it to find the visit they are booked on; a planner
 * opens it to see which surveys came back with more work than was quoted. So the scope-change filter
 * is a first-class view rather than a column somebody has to scan for — §6.1 calls that link "one of
 * the highest-value things the platform does", and a finding nobody can list is not a link.
 */

const SCOPES = [
  { key: "scheduled", label: "Scheduled", hint: "Visits booked but not yet carried out" },
  { key: "completed", label: "Completed", hint: "Reports filed, awaiting sign-off" },
  { key: "scope", label: "Found extra scope", hint: "Surveys where the job is bigger than quoted" },
  { key: "all", label: "All", hint: "Everything, including approved" },
] as const;

type Scope = (typeof SCOPES)[number]["key"];

const STATUS_TONE: Record<string, StatusTone> = {
  scheduled: "pending",
  completed: "info",
  approved: "approved",
};

export default function InspectionsPage() {
  const [scope, setScope] = useState<Scope>("scheduled");

  const inspections = trpc.operations.listInspections.useQuery(
    scope === "scope" ? { scopeChangeOnly: true } : scope === "all" ? {} : { status: scope },
  );

  const rows = inspections.data ?? [];

  return (
    <div className="mx-auto max-w-7xl">
      <PageHeader
        title="Site inspections"
        description="What the survey found, and whether the job is bigger than it was quoted."
      />

      <div className="mb-4 flex flex-wrap gap-2">
        {SCOPES.map((entry) => (
          <button
            key={entry.key}
            type="button"
            title={entry.hint}
            onClick={() => setScope(entry.key)}
            className={
              scope === entry.key
                ? "rounded-md border border-blue-600 bg-blue-600 px-3 py-1.5 text-sm font-medium text-text-invert"
                : "rounded-md border border-border bg-surface px-3 py-1.5 text-sm hover:bg-surface-2"
            }
          >
            {entry.label}
          </button>
        ))}
      </div>

      {inspections.isPending && <p className="text-sm text-text-muted">Loading…</p>}

      {inspections.error && (
        <Card className="p-4">
          <p className="text-sm">{inspections.error.message}</p>
        </Card>
      )}

      {inspections.data && rows.length === 0 && (
        <EmptyState
          title={scope === "scope" ? "No scope changes found" : "Nothing here"}
          description={
            scope === "scope"
              ? "No survey has come back saying the job is bigger than what was quoted."
              : "Inspections are raised from a ticket, or arrive from a sales request for a pre-quotation survey."
          }
        />
      )}

      {rows.length > 0 && (
        <Card className="overflow-x-auto p-0">
          <table className="w-full text-sm">
            <thead className="border-b border-border bg-surface-muted text-left">
              <tr>
                <Th>Number</Th>
                <Th>For</Th>
                <Th>When</Th>
                <Th>Status</Th>
              </tr>
            </thead>
            <tbody>
              {rows.map((row) => (
                <tr key={row.id} className="border-b border-border last:border-0">
                  <td className="px-3 py-2">
                    <Link
                      href={`/inspections/${row.id}`}
                      className="tabular text-blue-600 underline underline-offset-2"
                    >
                      {row.number}
                    </Link>
                  </td>
                  <td className="px-3 py-2">
                    {row.ticket ? (
                      <>
                        <p className="truncate">{row.ticket.title}</p>
                        <p className="tabular text-xs text-text-muted">{row.ticket.number}</p>
                      </>
                    ) : row.project ? (
                      <p className="tabular">{row.project.code}</p>
                    ) : (
                      // The module 01 route: sales asked for a look before pricing.
                      <p className="text-xs text-text-muted">
                        Pre-quotation survey, raised from an inquiry
                      </p>
                    )}
                  </td>
                  <td className="px-3 py-2">
                    {row.inspectedAt ? (
                      <DateCell value={row.inspectedAt} />
                    ) : row.scheduledFor ? (
                      <span className="text-text-muted">
                        booked <DateCell value={row.scheduledFor} />
                      </span>
                    ) : (
                      <span className="text-text-muted">no date yet</span>
                    )}
                  </td>
                  <td className="px-3 py-2">
                    <StatusBadge tone={STATUS_TONE[row.status] ?? "draft"}>
                      {row.status}
                    </StatusBadge>
                    {row.scopeChangeIdentified && (
                      <span className="ml-1.5">
                        <StatusBadge tone="failed">Scope change</StatusBadge>
                      </span>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </Card>
      )}
    </div>
  );
}

function Th({ children }: { children: React.ReactNode }) {
  return <th className="px-3 py-2 text-xs font-medium text-text-muted">{children}</th>;
}
