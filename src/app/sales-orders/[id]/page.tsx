"use client";

import { use, useState } from "react";
import Link from "next/link";
import { AuditTrail } from "@/components/AuditTrail";
import { Button } from "@/components/ui/button";
import { Input, Label } from "@/components/ui/input";
import { DateCell } from "@/components/ui/cells";
import { Card, PageHeader, RecordLayout } from "@/components/ui/layout";
import { StatusBadge, type StatusTone } from "@/components/ui/status-badge";
import { downpaymentGate } from "@/server/core/order/supplier-po-rules";
import { BillingPanel } from "./BillingPanel";
import { formatMoney } from "@/lib/format";
import { toastError, toastSuccess } from "@/lib/errors";
import { trpc } from "@/lib/trpc/client";
import { OrderFromSuppliers } from "./OrderFromSuppliers";
import { ProposeTickets } from "./ProposeTickets";

/**
 * One sales order (specs/03-order-procurement.md §1).
 *
 * The three workstream panels are §1's instruction made visible: procurement, finance and execution
 * move independently, so each gets its own block and none of them is presented as a step after
 * another. §4 asks specifically that "the sales order header shows a clear gate indicator so nobody
 * has to ask finance in a chat app" — that is the finance block, and the message comes from the same
 * pure function the supplier PO's send path enforces.
 */

const STATUS_TONE: Record<string, StatusTone> = {
  open: "active",
  in_progress: "active",
  partially_delivered: "pending",
  delivered: "approved",
  completed: "approved",
  closed: "draft",
  cancelled: "cancelled",
};

const PO_TONE: Record<string, StatusTone> = {
  draft: "draft",
  pending_approval: "pending",
  approved: "approved",
  sent: "active",
  acknowledged: "info",
  partially_received: "pending",
  received: "approved",
  cancelled: "cancelled",
};

const human = (value: string) => value.replace(/_/g, " ");

export default function SalesOrderPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = use(params);
  const utils = trpc.useUtils();

  const order = trpc.order.getSalesOrder.useQuery({ salesOrderId: id });
  const me = trpc.system.whoami.useQuery(undefined, { retry: false });
  // §4's gate is finance's to open — the same permission that records any other payment.
  const canRecordPayment = (me.data?.permissions ?? []).includes("payment.record");
  const supplierPos = trpc.order.listSupplierPos.useQuery({ salesOrderId: id }, { retry: false });

  const refresh = () => {
    void utils.order.getSalesOrder.invalidate({ salesOrderId: id });
    void utils.order.listSupplierPos.invalidate({ salesOrderId: id });
  };

  if (order.isPending) return <p className="text-sm text-text-muted">Loading…</p>;
  if (order.error) {
    return (
      <Card className="p-4">
        <p className="text-sm">{order.error.message}</p>
      </Card>
    );
  }

  const data = order.data;
  const canSeeCost = data.totalCost !== null;

  // The same function the send path enforces, so the header and the gate can never disagree.
  const gate = downpaymentGate({
    financeStatus: data.financeStatus,
    downpaymentPct: Number(data.downpaymentPct),
    currency: data.currency,
    downpaymentAmount: Number(data.downpaymentAmount),
  });

  return (
    <div className="mx-auto max-w-7xl">
      <PageHeader
        title={data.number}
        description={
          [data.account?.name, data.quotation ? `from ${data.quotation.number}` : null]
            .filter(Boolean)
            .join(" · ") || "Sales order"
        }
        actions={
          <StatusBadge tone={STATUS_TONE[data.status] ?? "draft"}>
            <span className="capitalize">{human(data.status)}</span>
          </StatusBadge>
        }
      />

      <BillingPanel salesOrderId={data.id} />

      <RecordLayout
        aside={
          <div className="space-y-4">
            <Card className="p-4">
              <h2 className="text-sm font-semibold">Value</h2>
              <dl className="mt-2 space-y-1 text-sm">
                <Row label="Subtotal" value={formatMoney(data.subtotal, data.currency)} />
                <Row label="VAT" value={formatMoney(data.vatAmount, data.currency)} />
                <Row label="Total" value={formatMoney(data.total, data.currency)} strong />
                {canSeeCost && (
                  <>
                    <Row label="Cost" value={formatMoney(data.totalCost!, data.currency)} />
                    <Row label="Margin" value={formatMoney(data.marginAmount!, data.currency)} />
                  </>
                )}
              </dl>
            </Card>

            {/* §1's three independent workstreams, as three blocks rather than one chain. */}
            <Card className="p-4">
              <h2 className="text-sm font-semibold">Procurement</h2>
              <p className="mt-1">
                <StatusBadge tone={data.procurementStatus === "received" ? "approved" : "pending"}>
                  <span className="capitalize">{human(data.procurementStatus)}</span>
                </StatusBadge>
              </p>
            </Card>

            <Card className="p-4">
              <h2 className="text-sm font-semibold">Finance</h2>
              <p className="mt-1">
                <StatusBadge tone={gate.blocks ? "failed" : "approved"}>
                  <span className="capitalize">{human(data.financeStatus)}</span>
                </StatusBadge>
              </p>
              {/* §4: "a clear gate indicator so nobody has to ask finance in a chat app". */}
              <p className="mt-1.5 text-xs text-text-muted">{gate.message}</p>

              {/*
                And the control that clears it, beside the indicator that shows it.

                §4's gate has been readable since module 03 session 2 and openable by nobody: no order
                ever left `not_required`, and even if one had, there was no way to record the money
                arriving. Putting the control anywhere else would have repeated the fault it fixes —
                a status somebody has to ask about in a chat app.
              */}
              {data.financeStatus === "awaiting_downpayment" && canRecordPayment && (
                <RecordDownpayment
                  salesOrderId={data.id}
                  number={data.number}
                  currency={data.currency}
                  amount={data.downpaymentAmount}
                  onDone={() => void order.refetch()}
                />
              )}
            </Card>

            <Card className="p-4">
              <h2 className="text-sm font-semibold">Execution</h2>
              <p className="mt-1">
                <StatusBadge tone={data.executionStatus === "not_required" ? "draft" : "pending"}>
                  <span className="capitalize">{human(data.executionStatus)}</span>
                </StatusBadge>
              </p>
              <p className="mt-1.5 text-xs text-text-muted">
                {data.executionStatus === "not_required"
                  ? "Goods only — nobody has to go anywhere."
                  : "This order includes field work. Module 04 turns it into tickets."}
              </p>
            </Card>

            <Card className="p-4">
              <h2 className="text-sm font-semibold">Origin</h2>
              <dl className="mt-2 space-y-1 text-sm">
                <Row label="Ordered" value={<DateCell value={data.orderDate} />} />
                <Row
                  label="Required by"
                  value={data.requiredByDate ? <DateCell value={data.requiredByDate} /> : "—"}
                />
                <Row label="Their PO" value={data.customerPO?.poNumber ?? "—"} />
                <Row
                  label="Quotation"
                  value={
                    data.quotation ? (
                      <Link
                        href={`/quotations/${data.quotation.id}`}
                        className="text-blue-600 underline underline-offset-2"
                      >
                        {data.quotation.number}
                      </Link>
                    ) : (
                      "—"
                    )
                  }
                />
              </dl>
            </Card>
          </div>
        }
      >
        <div className="space-y-4">
          <Card className="p-4">
            <h2 className="text-sm font-semibold">Lines</h2>
            <div className="mt-2 overflow-x-auto">
              <table className="w-full min-w-[40rem] text-sm">
                <thead>
                  <tr className="border-b border-border text-left text-xs text-text-muted">
                    <th className="py-1.5 pr-2 font-medium">#</th>
                    <th className="py-1.5 pr-2 font-medium">Description</th>
                    <th className="py-1.5 pr-2 text-right font-medium">Ordered</th>
                    <th className="py-1.5 pr-2 text-right font-medium">Received</th>
                    <th className="py-1.5 pr-2 text-right font-medium">Delivered</th>
                    <th className="py-1.5 pr-2 text-right font-medium">Value</th>
                  </tr>
                </thead>
                <tbody>
                  {data.lines.map((line) => (
                    <tr key={line.id} className="border-b border-border/60">
                      <td className="tabular py-1.5 pr-2 text-text-muted">{line.lineNo}</td>
                      <td className="py-1.5 pr-2">
                        {line.description}
                        {line.requiresExecution && (
                          <span className="ml-2">
                            <StatusBadge tone="info">Field work</StatusBadge>
                          </span>
                        )}
                      </td>
                      <td className="tabular py-1.5 pr-2 text-right">{line.qtyOrdered}</td>
                      <td className="tabular py-1.5 pr-2 text-right">{line.qtyReceived}</td>
                      <td className="tabular py-1.5 pr-2 text-right">{line.qtyDelivered}</td>
                      <td className="tabular py-1.5 pr-2 text-right">
                        {formatMoney(line.lineTotal, data.currency)}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </Card>

          <OrderFromSuppliers
            salesOrderId={data.id}
            lines={data.lines.map((line) => ({
              id: line.id,
              lineNo: line.lineNo,
              description: line.description,
              quantity: line.qtyOrdered,
              unitCost: line.unitCost,
            }))}
            onOrdered={refresh}
          />

          {/* §4's proposal, on the order it reads — and never generating from the event that
              created that order, which is the one thing §4 rules out. */}
          <ProposeTickets salesOrderId={data.id} onGenerated={refresh} />

          {!supplierPos.error && (supplierPos.data ?? []).length > 0 && (
            <Card className="p-4">
              <h2 className="text-sm font-semibold">Supplier orders</h2>
              <ul className="mt-2 divide-y divide-border">
                {(supplierPos.data ?? []).map((po) => (
                  <li key={po.id} className="flex flex-wrap items-center gap-2 py-2 text-sm">
                    <Link
                      href={`/procurement/${po.id}`}
                      className="tabular font-medium text-blue-600 underline underline-offset-2"
                    >
                      {po.number}
                    </Link>
                    <span className="min-w-0 flex-1 truncate text-text-muted">
                      {po.supplier.name}
                    </span>
                    <span className="tabular">{formatMoney(po.total, po.currency)}</span>
                    <StatusBadge tone={PO_TONE[po.status] ?? "draft"}>
                      <span className="capitalize">{human(po.status)}</span>
                    </StatusBadge>
                    {po.daysLate !== null && po.daysLate > 0 && (
                      <StatusBadge tone="failed">{po.daysLate}d late</StatusBadge>
                    )}
                  </li>
                ))}
              </ul>
            </Card>
          )}

          <Card className="p-4">
            <h2 className="text-sm font-semibold">History</h2>
            <div className="mt-2">
              <AuditTrail entityType="SalesOrder" entityId={data.id} />
            </div>
          </Card>
        </div>
      </RecordLayout>
    </div>
  );
}

function Row({
  label,
  value,
  strong,
}: {
  label: string;
  value: React.ReactNode;
  strong?: boolean;
}) {
  return (
    <div className="flex items-baseline justify-between gap-3">
      <dt className="text-xs text-text-muted">{label}</dt>
      <dd className={strong ? "tabular font-semibold" : "tabular"}>{value}</dd>
    </div>
  );
}

/**
 * Finance recording that the customer's downpayment arrived.
 *
 * Asks for a reference rather than only a confirmation, because the next thing that happens is AIES
 * committing money to a supplier on the strength of it. "Somebody said it came in" is not what
 * procurement should be relying on; a deposit slip number is.
 *
 * The date defaults to today and can be moved back — payments are usually recorded the morning after
 * they land — but not forward, which the service refuses.
 */
function RecordDownpayment({
  salesOrderId,
  number,
  currency,
  amount,
  onDone,
}: {
  salesOrderId: string;
  number: string;
  currency: string;
  amount: string;
  onDone: () => void;
}) {
  const [open, setOpen] = useState(false);
  const [reference, setReference] = useState("");
  const [receivedAt, setReceivedAt] = useState(new Date().toISOString().slice(0, 10));

  const record = trpc.order.recordDownpayment.useMutation({
    onSuccess: () => {
      toastSuccess(`Downpayment recorded on ${number}.`);
      setOpen(false);
      setReference("");
      onDone();
    },
    onError: toastError,
  });

  if (!open) {
    return (
      <Button variant="secondary" size="sm" className="mt-2" onClick={() => setOpen(true)}>
        Record the downpayment
      </Button>
    );
  }

  return (
    <div className="mt-2 rounded-md border border-border p-2.5">
      <p className="text-xs">
        Expecting{" "}
        <span className="tabular font-medium">
          {currency} {amount}
        </span>
        . Recording it clears procurement to order.
      </p>
      <div className="mt-2 space-y-2">
        <div>
          <Label htmlFor="dp-ref">How it arrived</Label>
          <Input
            id="dp-ref"
            value={reference}
            placeholder="BDO deposit slip 4471902"
            onChange={(e) => setReference(e.target.value)}
          />
        </div>
        <div>
          <Label htmlFor="dp-date">When</Label>
          <Input
            id="dp-date"
            type="date"
            value={receivedAt}
            onChange={(e) => setReceivedAt(e.target.value)}
          />
        </div>
      </div>
      <div className="mt-2 flex gap-2">
        <Button
          size="sm"
          disabled={record.isPending || reference.trim().length === 0}
          onClick={() =>
            record.mutate({
              salesOrderId,
              reference: reference.trim(),
              receivedAt: receivedAt ? new Date(receivedAt) : null,
            })
          }
        >
          {record.isPending ? "Recording…" : "Record it"}
        </Button>
        <Button variant="ghost" size="sm" onClick={() => setOpen(false)}>
          Cancel
        </Button>
      </div>
    </div>
  );
}
