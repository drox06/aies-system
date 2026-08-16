"use client";

import { use } from "react";
import Link from "next/link";
import { AuditTrail } from "@/components/AuditTrail";
import { DateCell } from "@/components/ui/cells";
import { Card, PageHeader, RecordLayout } from "@/components/ui/layout";
import { StatusBadge, type StatusTone } from "@/components/ui/status-badge";
import { TICKET_ENTITY_TYPE } from "@/server/core/operations/ticket-rules";
import { formatMoney } from "@/lib/format";
import { trpc } from "@/lib/trpc/client";

/**
 * One ticket (specs/04-operations-projects.md §3).
 *
 * Read-only in session 1, and honestly so: every action a ticket has — the cash advance, the
 * material request, mobilization, QA, the service report — is a gate that does not exist yet. A
 * screen with buttons that error is worse than one that says what is coming.
 *
 * The site block is here because §19 says a technician "sees scope, site data, and their own cash
 * advances" — access notes and an address are the two things somebody driving there actually needs.
 */

const STATUS_TONE: Record<string, StatusTone> = {
  generated: "draft",
  cash_advance_pending: "pending",
  material_pending: "pending",
  ready_to_mobilize: "info",
  mobilized: "active",
  in_progress: "active",
  qa: "pending",
  tc: "pending",
  for_closeout: "pending",
  completed: "approved",
  cancelled: "cancelled",
  on_hold: "failed",
};

const human = (value: string) => value.replace(/_/g, " ");

export default function TicketPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = use(params);
  const ticket = trpc.operations.getTicket.useQuery({ ticketId: id });

  if (ticket.isPending) return <p className="text-sm text-text-muted">Loading…</p>;
  if (ticket.error) {
    return (
      <Card className="p-4">
        <p className="text-sm">{ticket.error.message}</p>
      </Card>
    );
  }

  const data = ticket.data;
  // Null rather than absent when the reader lacks `project.view_cost` — §19: technicians see scope
  // and site data, "never contract value or margin".
  const canSeeCost = data.project?.contractValue != null;

  return (
    <div className="mx-auto max-w-7xl">
      <PageHeader
        title={data.number}
        description={data.title}
        actions={
          <div className="flex flex-wrap items-center gap-2">
            <StatusBadge tone={STATUS_TONE[data.status] ?? "draft"}>
              <span className="capitalize">{human(data.status)}</span>
            </StatusBadge>
            <StatusBadge tone="info">
              <span className="capitalize">{human(data.type)}</span>
            </StatusBadge>
            {!data.billable && <StatusBadge tone="pending">Not billable</StatusBadge>}
          </div>
        }
      />

      <RecordLayout
        aside={
          <div className="space-y-4">
            <Card className="p-4">
              <h2 className="text-sm font-semibold">Where</h2>
              <dl className="mt-2 space-y-1 text-sm">
                <Row label="Customer" value={data.account.name} />
                <Row label="Site" value={data.site?.name ?? "—"} />
                <Row
                  label="Required by"
                  value={data.requiredByDate ? <DateCell value={data.requiredByDate} /> : "—"}
                />
                <Row label="Priority" value={<span className="capitalize">{data.priority}</span>} />
              </dl>
              {data.site?.accessNotes && (
                <p className="mt-2 rounded-md border border-border bg-surface-muted p-2.5 text-xs whitespace-pre-wrap">
                  {data.site.accessNotes}
                </p>
              )}
            </Card>

            <Card className="p-4">
              <h2 className="text-sm font-semibold">Origin</h2>
              <dl className="mt-2 space-y-1 text-sm">
                <Row
                  label="Sales order"
                  value={
                    data.salesOrder ? (
                      <Link
                        href={`/sales-orders/${data.salesOrder.id}`}
                        className="tabular text-blue-600 underline underline-offset-2"
                      >
                        {data.salesOrder.number}
                      </Link>
                    ) : (
                      "raised on its own"
                    )
                  }
                />
                <Row label="Their PO" value={data.customerPO?.poNumber ?? "—"} />
                <Row label="Covers" value={`${data.lines.length} order line(s)`} />
                <Row label="Raised" value={<DateCell value={data.raisedAt} withTime />} />
              </dl>
              {data.justification && (
                <p className="mt-2 text-xs text-text-muted">{data.justification}</p>
              )}
            </Card>

            {data.project && (
              <Card className="p-4">
                <h2 className="text-sm font-semibold">Project</h2>
                <p className="tabular mt-1 text-sm">{data.project.code}</p>
                <p className="text-xs text-text-muted">{data.project.name}</p>
                <p className="mt-1">
                  <StatusBadge tone="pending">
                    <span className="capitalize">{human(data.project.status)}</span>
                  </StatusBadge>
                </p>
                {canSeeCost && (
                  <dl className="mt-2 space-y-1 text-sm">
                    <Row label="Contract value" value={formatMoney(data.project.contractValue!)} />
                    <Row label="Budget cost" value={formatMoney(data.project.budgetCost!)} />
                  </dl>
                )}
              </Card>
            )}
          </div>
        }
      >
        <div className="space-y-4">
          <Card className="p-4">
            <h2 className="text-sm font-semibold">Scope of work</h2>
            <p className="mt-2 text-sm whitespace-pre-wrap">{data.scopeOfWork}</p>
            {data.specialInstructions && (
              <>
                <h3 className="mt-3 text-sm font-semibold">Special instructions</h3>
                <p className="mt-1 text-sm whitespace-pre-wrap">{data.specialInstructions}</p>
              </>
            )}
          </Card>

          <Card className="p-4">
            <h2 className="text-sm font-semibold">What happens next</h2>
            {/*
              Honest rather than decorative. §1's four gates — cash advance, material request, QA,
              warranty — are whole sessions each and none exists yet. Buttons that error would teach
              people to distrust the ones that work, so this says what is coming instead.
            */}
            <ul className="mt-2 space-y-1.5 text-sm text-text-muted">
              <li>
                <span className="font-medium text-text">Cash advance</span> — §1&rsquo;s first gate,
                asked of every ticket type before anybody mobilises.{" "}
                {data.cashAdvanceRequired ? "Marked as required." : "Not yet decided."}
              </li>
              <li>
                <span className="font-medium text-text">Material request</span> — the second gate.
                Currently <span className="capitalize">{human(data.materialRequestStatus)}</span>.
              </li>
              <li>
                <span className="font-medium text-text">Mobilisation, QA and close-out</span> —
                after both gates clear.
              </li>
            </ul>
            <p className="mt-2 text-xs text-text-muted">
              None of these is built yet. A crew that mobilises without cash or materials is a
              wasted day, which is exactly why the gates come before the buttons.
            </p>
          </Card>

          <Card className="p-4">
            <h2 className="text-sm font-semibold">History</h2>
            <div className="mt-2">
              <AuditTrail entityType={TICKET_ENTITY_TYPE} entityId={data.id} />
            </div>
          </Card>
        </div>
      </RecordLayout>
    </div>
  );
}

function Row({ label, value }: { label: string; value: React.ReactNode }) {
  return (
    <div className="flex items-baseline justify-between gap-3">
      <dt className="text-xs text-text-muted">{label}</dt>
      <dd className="min-w-0 truncate text-right">{value}</dd>
    </div>
  );
}
