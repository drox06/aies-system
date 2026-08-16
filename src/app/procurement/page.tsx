"use client";

import { useState } from "react";
import Link from "next/link";
import { Button } from "@/components/ui/button";
import { DateCell } from "@/components/ui/cells";
import { Card, EmptyState, PageHeader } from "@/components/ui/layout";
import { Input } from "@/components/ui/input";
import { StatusBadge, type StatusTone } from "@/components/ui/status-badge";
import { formatMoney } from "@/lib/format";
import { trpc } from "@/lib/trpc/client";

/**
 * §5's expediting view.
 *
 * §5 names exactly what it must show: "all open supplier POs with **expected arrival, days late, and
 * the customer commitment they support**. Overdue POs notify the sales order owner, because the
 * customer will ask them, not procurement."
 *
 * That last clause is why the customer and the sales order are columns rather than a detail on the
 * record. The question this screen answers is not "what have we bought" but "what is late, and whose
 * delivery does it delay" — and answering the second half requires the join to be on the row.
 *
 * Sorted by expected arrival ascending from the server, so the most overdue is first without anybody
 * choosing a sort.
 */

const PO_TONE: Record<string, StatusTone> = {
  approved: "approved",
  sent: "active",
  acknowledged: "info",
  partially_received: "pending",
};

const human = (value: string) => value.replace(/_/g, " ");

export default function ProcurementPage() {
  const [search, setSearch] = useState("");
  const [openOnly, setOpenOnly] = useState(true);

  const list = trpc.order.listSupplierPos.useQuery({
    openOnly: openOnly || undefined,
    search: search || undefined,
  });

  const rows = list.data ?? [];
  const late = rows.filter((po) => (po.daysLate ?? 0) > 0);
  const undated = rows.filter((po) => po.daysLate === null);

  return (
    <div className="mx-auto max-w-7xl">
      <PageHeader
        title="Procurement"
        description="Every open supplier order, when it is due, and whose delivery it holds up."
        actions={
          <Button variant="secondary" size="sm" onClick={() => setOpenOnly((value) => !value)}>
            {openOnly ? "Show every PO" : "Show open only"}
          </Button>
        }
      />

      <div className="mb-3 flex flex-wrap items-center gap-3">
        <Input
          className="max-w-xs"
          placeholder="PO number, supplier, or their reference"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
        />
        {late.length > 0 && <StatusBadge tone="failed">{late.length} late</StatusBadge>}
        {undated.length > 0 && (
          // Not an error, but the ones nobody is chasing — which is what this screen is for.
          <StatusBadge tone="pending">{undated.length} with no arrival date</StatusBadge>
        )}
      </div>

      {list.isPending && <p className="text-sm text-text-muted">Loading…</p>}

      {!list.isPending && rows.length === 0 && (
        <Card className="p-4">
          <EmptyState
            title={openOnly ? "Nothing is on order." : "No supplier POs yet."}
            description="A PO appears here once it has been approved. Raise one from a sales order."
          />
        </Card>
      )}

      {rows.length > 0 && (
        <Card className="overflow-x-auto p-0">
          <table className="w-full min-w-[52rem] text-sm">
            <thead>
              <tr className="border-b border-border text-left text-xs text-text-muted">
                <th className="px-3 py-2 font-medium">PO</th>
                <th className="px-3 py-2 font-medium">Supplier</th>
                <th className="px-3 py-2 text-right font-medium">Value</th>
                <th className="px-3 py-2 font-medium">Status</th>
                <th className="px-3 py-2 font-medium">Expected</th>
                <th className="px-3 py-2 text-right font-medium">Late</th>
                <th className="px-3 py-2 font-medium">Supports</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((po) => (
                <tr key={po.id} className="border-b border-border/60">
                  <td className="px-3 py-2">
                    <Link
                      href={`/procurement/${po.id}`}
                      className="tabular font-medium text-blue-600 underline underline-offset-2"
                    >
                      {po.number}
                    </Link>
                    {po.supplierRef && (
                      <span className="block text-xs text-text-muted">
                        their ref {po.supplierRef}
                      </span>
                    )}
                  </td>
                  <td className="px-3 py-2">
                    <span className="truncate">{po.supplier.name}</span>
                    {!po.supplier.isApproved && (
                      <span className="ml-2">
                        <StatusBadge tone="failed">Not approved</StatusBadge>
                      </span>
                    )}
                  </td>
                  <td className="tabular px-3 py-2 text-right">
                    {formatMoney(po.total, po.currency)}
                  </td>
                  <td className="px-3 py-2">
                    <StatusBadge tone={PO_TONE[po.status] ?? "draft"}>
                      <span className="capitalize">{human(po.status)}</span>
                    </StatusBadge>
                  </td>
                  <td className="px-3 py-2">
                    {po.expectedArrivalDate ? (
                      <DateCell value={po.expectedArrivalDate} />
                    ) : (
                      <span className="text-text-muted">not given</span>
                    )}
                  </td>
                  <td className="tabular px-3 py-2 text-right">
                    {po.daysLate === null ? (
                      <span className="text-text-muted">—</span>
                    ) : po.daysLate > 0 ? (
                      <StatusBadge tone="failed">{po.daysLate}d</StatusBadge>
                    ) : (
                      <span className="text-text-muted">{-po.daysLate}d to go</span>
                    )}
                  </td>
                  <td className="px-3 py-2">
                    {po.salesOrder ? (
                      <>
                        <Link
                          href={`/sales-orders/${po.salesOrder.id}`}
                          className="tabular text-blue-600 underline underline-offset-2"
                        >
                          {po.salesOrder.number}
                        </Link>
                        <span className="block truncate text-xs text-text-muted">
                          {po.salesOrder.account.name}
                        </span>
                      </>
                    ) : (
                      <span className="text-xs text-text-muted">stock</span>
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
