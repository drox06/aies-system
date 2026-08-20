"use client";

import { useState } from "react";
import Link from "next/link";
import { DateCell } from "@/components/ui/cells";
import { Card, EmptyState, PageHeader } from "@/components/ui/layout";
import { Button } from "@/components/ui/button";
import { StatusBadge, type StatusTone } from "@/components/ui/status-badge";
import { formatMoney } from "@/lib/format";
import { toastError, toastSuccess } from "@/lib/errors";
import { trpc } from "@/lib/trpc/client";

/**
 * §5's cash advance register.
 *
 * §5 asks for one thing from this screen above all others: "The register must always distinguish
 * *outstanding*, *formally extended and why*, and *simply late*." So the standing column is not a
 * date with conditional colouring — it is the three-state verdict computed by `liquidationStanding`
 * on the server, with the extension's reason shown next to it. A reader must be able to tell "we
 * agreed to this delay" from "nobody has chased this" at a glance, because the two call for
 * completely different actions.
 *
 * The default view is **outstanding**, not "all". The question this screen exists to answer is who
 * is holding company money right now.
 */

const SCOPES = [
  { key: "outstanding", label: "Outstanding", hint: "Money that is out and not yet accounted for" },
  { key: "late", label: "Late", hint: "Past the deadline in force, extensions taken into account" },
  { key: "mine", label: "Mine", hint: "Advances you asked for or are covered by" },
  { key: "all", label: "All", hint: "Everything, including settled and declined" },
] as const;

type Scope = (typeof SCOPES)[number]["key"];

const STANDING_TONE: Record<string, StatusTone> = {
  not_released: "draft",
  settled: "approved",
  outstanding: "info",
  extended: "pending",
  late: "failed",
};

const STATUS_TONE: Record<string, StatusTone> = {
  draft: "draft",
  pending_approval: "pending",
  approved: "info",
  rejected: "cancelled",
  released: "active",
  partially_liquidated: "pending",
  pending_settlement: "pending",
  liquidated: "approved",
  overdue_liquidation: "failed",
  extended: "pending",
};

const human = (value: string) =>
  value === "pending_settlement" ? "pending settlement" : value.replace(/_/g, " ");

export default function CashAdvanceRegisterPage() {
  const [scope, setScope] = useState<Scope>("outstanding");
  const advances = trpc.operations.listCashAdvances.useQuery({ scope });

  const rows = advances.data ?? [];
  const outstandingTotal = rows.reduce(
    (sum, row) => sum + Number(row.amountApproved ?? row.amountRequested),
    0,
  );

  return (
    <div className="mx-auto max-w-7xl">
      <PageHeader
        title="Cash advances"
        description="Who is holding company money, and what is owed back."
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

      {advances.isPending && <p className="text-sm text-text-muted">Loading…</p>}

      {advances.error && (
        <Card className="p-4">
          <p className="text-sm">{advances.error.message}</p>
        </Card>
      )}

      {advances.data && rows.length === 0 && (
        <EmptyState
          title={scope === "late" ? "Nothing is late" : "Nothing here"}
          description={
            scope === "late"
              ? "Every outstanding advance is either within its deadline or formally extended."
              : "Advances are raised from a ticket, where the crew and the job are already known."
          }
        />
      )}

      {rows.length > 0 && (
        <>
          {(scope === "outstanding" || scope === "late") && (
            <p className="mb-2 text-sm text-text-muted">
              {rows.length} advance{rows.length === 1 ? "" : "s"} ·{" "}
              <span className="tabular font-medium text-text">
                {formatMoney(outstandingTotal.toFixed(2))}
              </span>{" "}
              out
            </p>
          )}

          <Card className="overflow-x-auto p-0">
            <table className="w-full text-sm">
              <thead className="border-b border-border bg-surface-muted text-left">
                <tr>
                  <Th>Number</Th>
                  <Th>For</Th>
                  <Th className="text-right">Amount</Th>
                  <Th>Status</Th>
                  <Th>Liquidation</Th>
                </tr>
              </thead>
              <tbody>
                {rows.map((row) => (
                  <tr key={row.id} className="border-b border-border last:border-0">
                    <td className="px-3 py-2">
                      <Link
                        href={`/cash-advances/${row.id}`}
                        className="tabular text-blue-600 underline underline-offset-2"
                      >
                        {row.number}
                      </Link>
                      <p className="text-xs text-text-muted">
                        <DateCell value={row.createdAt} />
                      </p>
                    </td>
                    <td className="px-3 py-2">
                      <p className="truncate">{row.purpose}</p>
                      <p className="text-xs text-text-muted">
                        {row.ticket ? `${row.ticket.number} · ${row.ticket.title}` : null}
                        {row.project ? `${row.project.code} · ${row.project.name}` : null}
                      </p>
                    </td>
                    <td className="tabular px-3 py-2 text-right">
                      {formatMoney(row.amountApproved ?? row.amountRequested)}
                      {row.amountApproved === null && (
                        <p className="text-xs text-text-muted">requested</p>
                      )}
                    </td>
                    <td className="px-3 py-2">
                      <StatusBadge tone={STATUS_TONE[row.status] ?? "draft"}>
                        <span className="capitalize">{human(row.status)}</span>
                      </StatusBadge>
                    </td>
                    <td className="px-3 py-2">
                      <StatusBadge tone={STANDING_TONE[row.standing.state] ?? "draft"}>
                        <span className="capitalize">{human(row.standing.state)}</span>
                      </StatusBadge>
                      {/*
                        The reason travels with the badge. §5 asks the register to show *why* an
                        extension was granted, not merely that one was — an unexplained extension is
                        indistinguishable from nobody chasing, which is the exact confusion §5 is
                        trying to prevent.
                      */}
                      <p className="mt-0.5 max-w-xs text-xs text-text-muted">
                        {row.standing.message}
                      </p>
                      {/*
                        A draft advance could be created and never sent for approval.

                        `requestCashAdvance` was wired from the ticket and `submitCashAdvance` was
                        not, so §5's loop ran request → dead end: the money was never asked for and
                        the crew found out at the site. docs/DECISIONS.md #135's triage.
                      */}
                      {row.status === "draft" && (
                        <SendForApproval
                          id={row.id}
                          number={row.number}
                          onSent={() => void advances.refetch()}
                        />
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </Card>
        </>
      )}
    </div>
  );
}

function Th({ children, className = "" }: { children: React.ReactNode; className?: string }) {
  return (
    <th className={`px-3 py-2 text-xs font-medium text-text-muted ${className}`}>{children}</th>
  );
}

/**
 * Sending a draft advance for approval.
 *
 * The one press §5's loop was missing. `requestCashAdvance` creates the draft from the ticket;
 * without this the draft sits where nobody is looking, because a draft is not in anybody's queue —
 * that is what being a draft means.
 *
 * Only the person who raised it can send it, which the service enforces. Somebody else submitting
 * your request would put your name on numbers you had not finished checking.
 */
function SendForApproval({
  id,
  number,
  onSent,
}: {
  id: string;
  number: string;
  onSent: () => void;
}) {
  const submit = trpc.operations.submitCashAdvance.useMutation({
    onSuccess: () => {
      toastSuccess(`${number} sent for approval.`);
      onSent();
    },
    onError: toastError,
  });

  return (
    <Button
      size="sm"
      className="mt-1.5"
      disabled={submit.isPending}
      onClick={() => submit.mutate({ cashAdvanceId: id })}
    >
      {submit.isPending ? "Sending…" : "Send for approval"}
    </Button>
  );
}
