"use client";

import { useState } from "react";
import { Button } from "@/components/ui/button";
import { DateCell } from "@/components/ui/cells";
import { Input, Label } from "@/components/ui/input";
import { Card, PageHeader } from "@/components/ui/layout";
import { StatusBadge } from "@/components/ui/status-badge";
import { toastError, toastSuccess } from "@/lib/errors";
import { trpc } from "@/lib/trpc/client";

/**
 * §16's approval queue — the hours and field spend waiting on a decision.
 *
 * ## Why this is the most consequential screen in module 04
 *
 * Hours could be recorded and submitted from `/field` and **never approved**, because nothing called
 * `decideTimesheet`. §6 of module 05 counts only *approved* timesheets as labour cost, so on any real
 * job the largest cost line read **zero** and every project margin was flattering.
 *
 * The FIN5 walkthrough showed ₱10,335 of labour only because a seed wrote `status: "approved"`
 * directly — a line I wrote myself and did not stop to question. docs/DECISIONS.md #135 and the
 * triage that followed it.
 *
 * ## Hours and expenses together
 *
 * They share a permission, they are submitted together from the field, and they are the same
 * judgement: *was this really spent on this job?* Splitting them across two screens would mean a
 * manager approving Tuesday's hours in one place and Tuesday's fuel in another.
 *
 * ## What escalation does and does not mean
 *
 * The operations manager is the primary approver — they know whether the hours match the work. After
 * two working days a row is marked escalated and the admin manager is chased. But the admin manager,
 * VP and President hold the permission from the start and can act at any moment: escalation widens
 * who is **chased**, never who is **allowed**. Same distinction module 00's approval fallback draws.
 */

const pesos = (centavos: number) =>
  `₱${(centavos / 100).toLocaleString("en-PH", { minimumFractionDigits: 2 })}`;

/**
 * How long it has been waiting, in words.
 *
 * Working hours converted to working days, because "13 hours" reads as half a day to somebody who
 * thinks in shifts. Null stays "unknown" rather than becoming zero — a sheet submitted before the
 * clock existed has genuinely been waiting, and showing it as fresh would be the worse error.
 */
function waited(hours: number | null): string {
  if (hours === null) return "waiting — submitted before the clock was added";
  if (hours < 1) return "just now";
  if (hours < 8) return `${Math.floor(hours)} working hours`;
  const days = Math.floor(hours / 8);
  return `${days} working day${days === 1 ? "" : "s"}`;
}

export default function ApprovalQueuePage() {
  const hours = trpc.operations.timesheetsAwaiting.useQuery();
  const spend = trpc.operations.expensesAwaiting.useQuery();

  function refresh() {
    void hours.refetch();
    void spend.refetch();
  }

  const hourRows = hours.data ?? [];
  const spendRows = spend.data ?? [];
  const escalated =
    hourRows.filter((row) => row.escalated).length +
    spendRows.filter((row) => row.escalated).length;

  return (
    <div className="mx-auto max-w-5xl">
      <PageHeader
        title="Hours and expenses"
        description="What the crew has submitted and nobody has decided yet. Approved hours are what a project's labour cost is made of."
      />

      {/*
        The escalated count, shown even at zero.

        A figure that disappears when it is good is one nobody learns to read — the same reasoning as
        the release queue's late count and payables' disputed count. Zero here is a real answer:
        nothing has been sitting for two working days.
      */}
      <Card className="mt-4 p-3">
        <div className="flex flex-wrap items-baseline justify-between gap-2">
          <span className="text-sm">
            <span className="tabular font-semibold">{hourRows.length + spendRows.length}</span>{" "}
            waiting on a decision
          </span>
          <span className="text-sm">
            <span className="text-xs text-text-muted">Past two working days</span>{" "}
            <span className={`tabular font-semibold ${escalated > 0 ? "text-danger" : ""}`}>
              {escalated}
            </span>
          </span>
        </div>
        <p className="mt-1 text-xs text-text-muted">
          Yours to decide as operations manager. After two working days the admin manager is chased
          as well — they could always have acted, they simply were not being asked to.
        </p>
      </Card>

      <Card className="mt-4 p-4">
        <h2 className="text-sm font-semibold">Hours</h2>
        <p className="mt-0.5 text-xs text-text-muted">
          Until these are approved they are not on any project&rsquo;s cost, and the margin reads
          better than it is.
        </p>

        {hours.isPending && <p className="mt-2 text-sm text-text-muted">Loading…</p>}
        {hours.error && <p className="mt-2 text-sm text-danger">{hours.error.message}</p>}
        {hours.data && hourRows.length === 0 && (
          <p className="mt-2 text-sm">
            Nothing is waiting. Anything you submitted yourself is not here — somebody else has to
            decide it.
          </p>
        )}

        <ul className="mt-2 space-y-2">
          {hourRows.map((row) => (
            <li key={row.id} className="rounded-md border border-border p-3">
              <div className="flex flex-wrap items-baseline justify-between gap-2">
                <span className="flex flex-wrap items-baseline gap-2">
                  <span className="font-medium">{row.workerName}</span>
                  <span className="text-xs text-text-muted">
                    <DateCell value={row.date} />
                  </span>
                  {row.ticket && (
                    <span className="tabular text-xs text-text-muted">{row.ticket.number}</span>
                  )}
                </span>
                <span className="flex items-center gap-2">
                  {row.escalated && <StatusBadge tone="failed">Escalated</StatusBadge>}
                  <span className="tabular text-sm font-medium">
                    {Number(row.regularHours)}h
                    {Number(row.overtimeHours) > 0 && ` + ${Number(row.overtimeHours)}h OT`}
                  </span>
                </span>
              </div>

              <p className="mt-1 text-xs text-text-muted">
                {row.ticket?.title ?? "No ticket"}
                {Number(row.travelHours) > 0 && ` · ${Number(row.travelHours)}h travel`}
                {Number(row.standbyHours) > 0 && ` · ${Number(row.standbyHours)}h standby`}
                {` · ${waited(row.waitedWorkingHours)}`}
              </p>
              {row.activity && <p className="mt-1 text-sm">{row.activity}</p>}

              <Decide
                kind="hours"
                id={row.id}
                label={`${row.workerName}'s hours`}
                onDone={refresh}
              />
            </li>
          ))}
        </ul>
      </Card>

      <Card className="mt-4 p-4">
        <h2 className="text-sm font-semibold">Field expenses</h2>
        <p className="mt-0.5 text-xs text-text-muted">
          Money a technician spent on site. An invoice AIES received is an expense in Finance
          instead — recording it in both would count it twice.
        </p>

        {spend.data && spendRows.length === 0 && (
          <p className="mt-2 text-sm">Nothing is waiting.</p>
        )}

        <ul className="mt-2 space-y-2">
          {spendRows.map((row) => (
            <li key={row.id} className="rounded-md border border-border p-3">
              <div className="flex flex-wrap items-baseline justify-between gap-2">
                <span className="flex flex-wrap items-baseline gap-2">
                  <span className="font-medium">{row.workerName}</span>
                  <span className="text-xs text-text-muted">
                    <DateCell value={row.date} />
                  </span>
                  <span className="text-xs text-text-muted">{row.category}</span>
                </span>
                <span className="flex items-center gap-2">
                  {row.escalated && <StatusBadge tone="failed">Escalated</StatusBadge>}
                  <span className="tabular text-sm font-medium">{pesos(row.amount)}</span>
                </span>
              </div>

              <p className="mt-1 text-sm">{row.description}</p>
              <p className="mt-1 text-xs text-text-muted">
                {row.ticket ? `${row.ticket.number} · ` : ""}
                {row.receiptCount > 0
                  ? `${row.receiptCount} receipt${row.receiptCount === 1 ? "" : "s"}`
                  : "no receipt attached"}
                {/*
                  §16: an expense charged to an advance flows into that advance's liquidation. Saying
                  so here stops a reviewer approving it as though it were a fresh claim on the
                  company — the money has already left, and this is the accounting for it.
                */}
                {row.fromCashAdvance && " · paid from a cash advance"}
                {` · ${waited(row.waitedWorkingHours)}`}
              </p>

              <Decide
                kind="expense"
                id={row.id}
                label={`${row.workerName}'s ${row.category}`}
                onDone={refresh}
              />
            </li>
          ))}
        </ul>
      </Card>
    </div>
  );
}

/**
 * Approve in one press; reject only with a reason.
 *
 * Approving is the ordinary outcome and asking a manager to justify the ordinary outcome is how a
 * queue stops being worked. A rejection is different: somebody's pay or reimbursement is being held,
 * and "rejected" alone tells them nothing about what to change.
 */
function Decide({
  kind,
  id,
  label,
  onDone,
}: {
  kind: "hours" | "expense";
  id: string;
  label: string;
  onDone: () => void;
}) {
  const [rejecting, setRejecting] = useState(false);
  const [reason, setReason] = useState("");

  const timesheet = trpc.operations.decideTimesheet.useMutation({
    onSuccess: (_result, variables) => {
      toastSuccess(variables.approve ? `${label} approved.` : `${label} rejected.`);
      setRejecting(false);
      setReason("");
      onDone();
    },
    onError: toastError,
  });

  const expense = trpc.operations.decideExpense.useMutation({
    onSuccess: (_result, variables) => {
      toastSuccess(variables.approve ? `${label} approved.` : `${label} rejected.`);
      setRejecting(false);
      setReason("");
      onDone();
    },
    onError: toastError,
  });

  const decide = kind === "hours" ? timesheet : expense;

  if (rejecting) {
    return (
      <div className="mt-2 rounded-md border border-border p-2.5">
        <Label htmlFor={`why-${id}`}>What needs to change</Label>
        <Input
          id={`why-${id}`}
          value={reason}
          placeholder="Eight hours logged against a ticket that was demobilised on the 14th."
          onChange={(event) => setReason(event.target.value)}
        />
        <p className="mt-1 text-xs text-text-muted">
          They see this. &ldquo;Rejected&rdquo; on its own leaves somebody guessing about their own
          pay.
        </p>
        <div className="mt-2 flex gap-2">
          <Button
            size="sm"
            disabled={decide.isPending || reason.trim().length < 5}
            onClick={() => decide.mutate({ id, approve: false, reason: reason.trim() })}
          >
            Reject it
          </Button>
          <Button variant="ghost" size="sm" onClick={() => setRejecting(false)}>
            Discard
          </Button>
        </div>
      </div>
    );
  }

  return (
    <div className="mt-2 flex gap-2">
      <Button
        variant="secondary"
        size="sm"
        disabled={decide.isPending}
        onClick={() => decide.mutate({ id, approve: true })}
      >
        Approve
      </Button>
      <Button variant="ghost" size="sm" onClick={() => setRejecting(true)}>
        Reject…
      </Button>
    </div>
  );
}
