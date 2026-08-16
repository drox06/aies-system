"use client";

import { useState } from "react";
import Link from "next/link";
import { Button } from "@/components/ui/button";
import { DateCell } from "@/components/ui/cells";
import { Input, Label } from "@/components/ui/input";
import { Card } from "@/components/ui/layout";
import { StatusBadge, type StatusTone } from "@/components/ui/status-badge";
import { inspectionRequiredForTicket } from "@/server/core/operations/site-inspection-rules";
import { trpc } from "@/lib/trpc/client";

/**
 * §6.1 on the ticket.
 *
 * §6 opens with "Only `new_project` tickets take this branch", so a new-project ticket with no
 * survey gets a prompt saying so. Every other type still gets the panel — see
 * `inspectionRequiredForTicket` for why that sentence is read as *which tickets require* a survey
 * rather than *which tickets may have one*. Sending somebody to look at a site before an after-sales
 * callout is ordinary good practice, and a system that refused to file the report would just mean
 * the report lives in somebody's phone.
 */

const STATUS_TONE: Record<string, StatusTone> = {
  scheduled: "pending",
  completed: "info",
  approved: "approved",
};

export function InspectionPanel({
  ticketId,
  ticketType,
  projectId,
  siteId,
}: {
  ticketId: string;
  ticketType: string;
  projectId: string | null;
  siteId: string | null;
}) {
  const inspections = trpc.operations.listInspections.useQuery({ ticketId });
  const me = trpc.system.whoami.useQuery(undefined, { retry: false });
  const [showForm, setShowForm] = useState(false);
  const [scheduledFor, setScheduledFor] = useState("");

  const schedule = trpc.operations.scheduleInspection.useMutation({
    onSuccess: () => {
      setShowForm(false);
      setScheduledFor("");
      void inspections.refetch();
    },
  });

  const canRecord = (me.data?.permissions ?? []).includes("ticket.execute");
  const rows = inspections.data ?? [];
  const required = inspectionRequiredForTicket({ type: ticketType });

  return (
    <Card className="p-4">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <h2 className="text-sm font-semibold">Site inspection</h2>
        {required && rows.length === 0 && <StatusBadge tone="pending">§6 wants one</StatusBadge>}
      </div>

      {rows.length === 0 && (
        <p className="mt-1 text-sm text-text-muted">
          {required
            ? "This is a new project, and §6 puts a site survey before the work is planned — it is where a job turns out to be bigger than it was quoted."
            : "No survey booked. Not required for this ticket type, but the report has somewhere to live if somebody goes."}
        </p>
      )}

      {rows.length > 0 && (
        <ul className="mt-2 space-y-1.5 text-sm">
          {rows.map((row) => (
            <li key={row.id} className="flex flex-wrap items-baseline justify-between gap-2">
              <Link
                href={`/inspections/${row.id}`}
                className="tabular text-blue-600 underline underline-offset-2"
              >
                {row.number}
              </Link>
              <span className="flex items-center gap-1.5">
                {row.scopeChangeIdentified && <StatusBadge tone="failed">Scope change</StatusBadge>}
                <StatusBadge tone={STATUS_TONE[row.status] ?? "draft"}>{row.status}</StatusBadge>
                <span className="text-xs text-text-muted">
                  {row.inspectedAt ? (
                    <DateCell value={row.inspectedAt} />
                  ) : row.scheduledFor ? (
                    <DateCell value={row.scheduledFor} />
                  ) : (
                    "no date"
                  )}
                </span>
              </span>
            </li>
          ))}
        </ul>
      )}

      {canRecord && !showForm && (
        <Button variant="secondary" size="sm" className="mt-3" onClick={() => setShowForm(true)}>
          Book a site inspection
        </Button>
      )}

      {showForm && (
        <div className="mt-3 rounded-md border border-border p-3">
          <Label htmlFor="insp-date">When</Label>
          <Input
            id="insp-date"
            type="date"
            value={scheduledFor}
            onChange={(e) => setScheduledFor(e.target.value)}
          />
          <p className="mt-1 text-xs text-text-muted">
            Optional — sites grant access when they grant it. The report can be filled in
            afterwards.
          </p>
          {schedule.error && <p className="mt-2 text-sm text-danger">{schedule.error.message}</p>}
          <div className="mt-3 flex gap-2">
            <Button
              size="sm"
              disabled={schedule.isPending}
              onClick={() =>
                schedule.mutate({
                  ticketId,
                  projectId,
                  siteId,
                  scheduledFor: scheduledFor ? new Date(scheduledFor) : null,
                  inspectedByIds: [],
                })
              }
            >
              Book it
            </Button>
            <Button variant="ghost" size="sm" onClick={() => setShowForm(false)}>
              Cancel
            </Button>
          </div>
        </div>
      )}
    </Card>
  );
}
