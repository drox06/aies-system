"use client";

import { useState } from "react";
import Link from "next/link";
import { DateCell } from "@/components/ui/cells";
import { Card, EmptyState, PageHeader } from "@/components/ui/layout";
import { Input } from "@/components/ui/input";
import { StatusBadge, type StatusTone } from "@/components/ui/status-badge";
import { trpc } from "@/lib/trpc/client";

/**
 * Every ticket this person may see (specs/04-operations-projects.md §2, §19).
 *
 * §19: "Technicians are scoped to tickets where they are assigned." That is enforced on the server —
 * this screen shows whatever comes back, so a technician's list is their own work and nobody else's
 * without the screen having to know the rule.
 *
 * Sorted by `requiredByDate` from the server: the question a dispatcher asks this screen is "what is
 * due", and a list ordered by creation date answers a question nobody has.
 */

const TYPE_TONE: Record<string, StatusTone> = {
  new_project: "active",
  installation: "info",
  after_sales: "pending",
  delivery: "draft",
};

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

export default function TicketsPage() {
  const [search, setSearch] = useState("");
  const list = trpc.operations.listTickets.useQuery({ search: search || undefined });

  const rows = list.data ?? [];

  return (
    <div className="mx-auto max-w-7xl">
      <PageHeader
        title="Tickets"
        description="Operational work, by what is due first. A ticket is generated from a sales order, or raised on its own."
      />

      <div className="mb-3">
        <Input
          className="max-w-xs"
          placeholder="Ticket number, title, or customer"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
        />
      </div>

      {list.isPending && <p className="text-sm text-text-muted">Loading…</p>}

      {!list.isPending && rows.length === 0 && (
        <Card className="p-4">
          <EmptyState
            title={search ? "No ticket matches that." : "No tickets yet."}
            description={
              search
                ? "Search covers the number, the title and the customer's name."
                : "Open a sales order and review the proposed tickets — nothing is generated automatically, because one order can be one ticket or eight."
            }
          />
        </Card>
      )}

      {rows.length > 0 && (
        <Card className="overflow-x-auto p-0">
          <table className="w-full min-w-[52rem] text-sm">
            <thead>
              <tr className="border-b border-border text-left text-xs text-text-muted">
                <th className="px-3 py-2 font-medium">Ticket</th>
                <th className="px-3 py-2 font-medium">Type</th>
                <th className="px-3 py-2 font-medium">Customer</th>
                <th className="px-3 py-2 font-medium">Site</th>
                <th className="px-3 py-2 font-medium">Status</th>
                <th className="px-3 py-2 font-medium">Required by</th>
                <th className="px-3 py-2 font-medium">From</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((ticket) => (
                <tr key={ticket.id} className="border-b border-border/60">
                  <td className="px-3 py-2">
                    <Link
                      href={`/tickets/${ticket.id}`}
                      className="tabular font-medium text-blue-600 underline underline-offset-2"
                    >
                      {ticket.number}
                    </Link>
                    <span className="block max-w-xs truncate text-xs text-text-muted">
                      {ticket.title}
                    </span>
                  </td>
                  <td className="px-3 py-2">
                    <StatusBadge tone={TYPE_TONE[ticket.type] ?? "draft"}>
                      <span className="capitalize">{human(ticket.type)}</span>
                    </StatusBadge>
                    {ticket.subType && (
                      <span className="block text-xs text-text-muted capitalize">
                        {human(ticket.subType)}
                      </span>
                    )}
                  </td>
                  <td className="px-3 py-2">
                    <span className="truncate">{ticket.account.name}</span>
                    {!ticket.billable && (
                      // Worth its own badge: a non-billable ticket is a cost with no invoice behind
                      // it, and §4 requires a justification precisely because somebody will ask.
                      <span className="ml-2">
                        <StatusBadge tone="pending">Not billable</StatusBadge>
                      </span>
                    )}
                  </td>
                  <td className="px-3 py-2 text-xs text-text-muted">{ticket.site?.name ?? "—"}</td>
                  <td className="px-3 py-2">
                    <StatusBadge tone={STATUS_TONE[ticket.status] ?? "draft"}>
                      <span className="capitalize">{human(ticket.status)}</span>
                    </StatusBadge>
                  </td>
                  <td className="px-3 py-2">
                    {ticket.requiredByDate ? (
                      <DateCell value={ticket.requiredByDate} />
                    ) : (
                      <span className="text-text-muted">—</span>
                    )}
                  </td>
                  <td className="px-3 py-2 text-xs">
                    {ticket.salesOrder ? (
                      <Link
                        href={`/sales-orders/${ticket.salesOrder.id}`}
                        className="tabular text-blue-600 underline underline-offset-2"
                      >
                        {ticket.salesOrder.number}
                      </Link>
                    ) : (
                      <span className="text-text-muted">raised on its own</span>
                    )}
                    {ticket.project && (
                      <span className="tabular block text-text-muted">{ticket.project.code}</span>
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
