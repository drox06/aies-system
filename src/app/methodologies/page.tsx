"use client";

import { useState } from "react";
import Link from "next/link";
import { DateCell } from "@/components/ui/cells";
import { Card, EmptyState, PageHeader } from "@/components/ui/layout";
import { StatusBadge, type StatusTone } from "@/components/ui/status-badge";
import { trpc } from "@/lib/trpc/client";

/**
 * §6.2's method statements.
 *
 * The view that earns this screen is **With the client** — §6.2: "Client methodology approval is a
 * common and invisible source of schedule slip, and AIES is usually blamed for delays it did not
 * cause." A list of what is sitting unanswered, with the days on it, is that sentence made
 * actionable: it is what somebody reads before a progress meeting.
 */

const SCOPES = [
  { key: "submitted_to_client", label: "With the client", hint: "Sent and unanswered" },
  { key: "internal_review", label: "For internal review", hint: "Waiting on our own sign-off" },
  { key: "draft", label: "Drafts", hint: "Being written" },
  { key: "all", label: "All", hint: "Everything, including approved and superseded" },
] as const;

type Scope = (typeof SCOPES)[number]["key"];

const STATUS_TONE: Record<string, StatusTone> = {
  draft: "draft",
  internal_review: "pending",
  approved: "info",
  submitted_to_client: "pending",
  client_approved: "approved",
  client_rejected: "failed",
  superseded: "cancelled",
};

const human = (value: string) => value.replace(/_/g, " ");

const daysSince = (value: string | Date) =>
  Math.floor((Date.now() - new Date(value).getTime()) / 86_400_000);

export default function MethodologiesPage() {
  const [scope, setScope] = useState<Scope>("submitted_to_client");
  const query = trpc.operations.listMethodologies.useQuery(
    scope === "all" ? {} : { status: scope },
  );

  const rows = query.data ?? [];

  return (
    <div className="mx-auto max-w-7xl">
      <PageHeader
        title="Method statements"
        description="How the work will be done, and who is holding up the approval."
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

      {query.isPending && <p className="text-sm text-text-muted">Loading…</p>}

      {query.error && (
        <Card className="p-4">
          <p className="text-sm">{query.error.message}</p>
        </Card>
      )}

      {query.data && rows.length === 0 && (
        <EmptyState
          title={scope === "submitted_to_client" ? "Nothing with the client" : "Nothing here"}
          description={
            scope === "submitted_to_client"
              ? "No method statement is waiting on a customer's approval."
              : "Method statements are written from a ticket, where the work is already described."
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
                <Th>Status</Th>
                <Th>With the client</Th>
              </tr>
            </thead>
            <tbody>
              {rows.map((row) => (
                <tr key={row.id} className="border-b border-border last:border-0">
                  <td className="px-3 py-2">
                    <Link
                      href={`/methodologies/${row.id}`}
                      className="tabular text-blue-600 underline underline-offset-2"
                    >
                      {row.number} R{row.revision}
                    </Link>
                  </td>
                  <td className="px-3 py-2">
                    <p className="truncate">{row.title}</p>
                    <p className="tabular text-xs text-text-muted">
                      {row.ticket?.number ?? row.project?.code ?? ""}
                    </p>
                  </td>
                  <td className="px-3 py-2">
                    <StatusBadge tone={STATUS_TONE[row.status] ?? "draft"}>
                      <span className="capitalize">{human(row.status)}</span>
                    </StatusBadge>
                  </td>
                  <td className="px-3 py-2">
                    {row.submittedToClientAt ? (
                      row.clientApprovedAt ? (
                        <span className="text-xs text-text-muted">
                          answered in{" "}
                          {daysSince(row.submittedToClientAt) - daysSince(row.clientApprovedAt)}{" "}
                          days
                        </span>
                      ) : (
                        // The number that changes the conversation about whose delay it was.
                        <span className="text-xs font-medium text-amber-800">
                          {daysSince(row.submittedToClientAt)} days unanswered
                        </span>
                      )
                    ) : (
                      <span className="text-xs text-text-muted">not sent</span>
                    )}
                    {row.submittedToClientAt && (
                      <p className="text-xs text-text-muted">
                        sent <DateCell value={row.submittedToClientAt} />
                      </p>
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
