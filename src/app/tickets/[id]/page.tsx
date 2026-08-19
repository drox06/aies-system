"use client";

import { use } from "react";
import Link from "next/link";
import { AuditTrail } from "@/components/AuditTrail";
import { CashAdvancePanel } from "./CashAdvancePanel";
import { InspectionPanel } from "./InspectionPanel";
import { MaterialPanel } from "./MaterialPanel";
import { MethodologyPanel } from "./MethodologyPanel";
import { MobilizationPanel } from "./MobilizationPanel";
import { ProgressPanel } from "./ProgressPanel";
import { QaPanel } from "./QaPanel";
import { TcPanel } from "./TcPanel";
import { ServiceReportPanel } from "./ServiceReportPanel";
import { DeliveryPanel } from "./DeliveryPanel";
import { ChecklistPanel } from "./ChecklistPanel";
import { HoursPanel } from "./HoursPanel";
import { SchedulePanel } from "./SchedulePanel";
import { DateCell } from "@/components/ui/cells";
import { CollapsiblePanel } from "@/components/ui/collapsible-panel";
import { Card, PageHeader, RecordLayout } from "@/components/ui/layout";
import { StatusBadge, type StatusTone } from "@/components/ui/status-badge";
import { TICKET_ENTITY_TYPE } from "@/server/core/operations/ticket-rules";
import { formatMoney } from "@/lib/format";
import { trpc } from "@/lib/trpc/client";

/**
 * One ticket (specs/04-operations-projects.md §3).
 *
 * Session 1 was read-only, and said so. Session 2 adds §1's first gate — the cash advance — so the
 * panel below is real: it requests, it shows the verdict, and it overrides with a reason. The
 * remaining gates are still described rather than offered, for the same reason as before: a button
 * that errors teaches people to distrust the ones that work.
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

          {/*
            The panels, in the order the job happens.
            ============================================================================

            Set by the company 2026-08-19, and the order is theirs rather than mine. Two things in it
            are worth understanding, because both look like sequencing and are actually about who
            says the work is done.

            **QA is last.** It used to sit before commissioning and the service report, on the
            reading that QA is a quality step somewhere in the middle. It is not: a QA approval is
            where the *customer's* inspector signs, and it is now what starts the billing — see
            BILLING_TRIGGERS.on_installation in billing-rules.ts. Everything above it is AIES doing
            and recording work; QA is the customer accepting it. Putting it last says so.

            **Daily progress sits near the end**, below hours and spend, because it is a log kept
            while the work runs rather than a gate anybody waits on. It was higher up when the order
            was mine, and it pushed the things people actually chase further down the page.

            **Delivery is second**, right under the scope, for every ticket type rather than only
            delivery tickets — an installation that needs its equipment on site cares about the
            delivery too, and hiding it on the wrong ticket type is how somebody ends up asking
            operations where the meter is.
          */}

          <CollapsiblePanel
            title="Delivery"
            storageKey={`${data.id}:delivery`}
            defaultOpen={data.type === "delivery"}
          >
            <DeliveryPanel ticketId={data.id} ticketType={data.type} />
          </CollapsiblePanel>

          <CollapsiblePanel title="Schedule" storageKey={`${data.id}:schedule`}>
            <SchedulePanel ticketId={data.id} />
          </CollapsiblePanel>

          <CollapsiblePanel title="Cash advance" storageKey={`${data.id}:cash-advance`}>
            <CashAdvancePanel ticketId={data.id} />
          </CollapsiblePanel>

          <CollapsiblePanel title="Site inspection" storageKey={`${data.id}:inspection`}>
            <InspectionPanel
              ticketId={data.id}
              ticketType={data.type}
              projectId={data.project?.id ?? null}
              siteId={data.site?.id ?? null}
            />
          </CollapsiblePanel>

          <CollapsiblePanel title="Method statement" storageKey={`${data.id}:methodology`}>
            <MethodologyPanel
              ticketId={data.id}
              ticketTitle={data.title}
              projectId={data.project?.id ?? null}
            />
          </CollapsiblePanel>

          <CollapsiblePanel title="Materials" storageKey={`${data.id}:materials`}>
            <MaterialPanel
              ticketId={data.id}
              projectId={data.project?.id ?? null}
              methodologyId={null}
            />
          </CollapsiblePanel>

          <CollapsiblePanel title="Mobilisation readiness" storageKey={`${data.id}:mobilisation`}>
            <MobilizationPanel ticketId={data.id} />
          </CollapsiblePanel>

          <CollapsiblePanel
            title="Checklists filled in on site"
            storageKey={`${data.id}:checklists`}
          >
            <ChecklistPanel ticketId={data.id} />
          </CollapsiblePanel>

          <CollapsiblePanel title="Testing and commissioning" storageKey={`${data.id}:tc`}>
            <TcPanel ticketId={data.id} />
          </CollapsiblePanel>

          <CollapsiblePanel title="Service report" storageKey={`${data.id}:service-report`}>
            <ServiceReportPanel ticketId={data.id} />
          </CollapsiblePanel>

          <CollapsiblePanel title="Hours and spend" storageKey={`${data.id}:hours`}>
            <HoursPanel ticketId={data.id} />
          </CollapsiblePanel>

          <CollapsiblePanel title="Daily progress" storageKey={`${data.id}:progress`}>
            <ProgressPanel ticketId={data.id} />
          </CollapsiblePanel>

          {/* Last, and the only panel where somebody outside AIES signs. */}
          <CollapsiblePanel title="QA — the customer's acceptance" storageKey={`${data.id}:qa`}>
            <QaPanel ticketId={data.id} />
          </CollapsiblePanel>

          <Card className="p-4">
            <h2 className="text-sm font-semibold">What happens next</h2>
            {/*
              Honest rather than decorative, and kept in step as sessions land: everything above this
              card is built and offered, everything in this list is described because it is not.
            */}
            <ul className="mt-2 space-y-1.5 text-sm text-text-muted">
              <li>
                <span className="font-medium text-text">QA</span> — §9&rsquo;s gate, which the
                client performs rather than AIES, with a rework loop.
              </li>
              <li>
                <span className="font-medium text-text">Testing, warranty and close-out</span> — §10
                to §12.
              </li>
            </ul>
            <p className="mt-2 text-xs text-text-muted">
              Not built yet. Everything from generating the ticket to the crew coming home is.
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
