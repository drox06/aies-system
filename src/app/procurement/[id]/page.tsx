"use client";

import { use, useState } from "react";
import Link from "next/link";
import { AuditTrail } from "@/components/AuditTrail";
import { Button } from "@/components/ui/button";
import { DateCell } from "@/components/ui/cells";
import { Card, PageHeader, RecordLayout } from "@/components/ui/layout";
import { Input, Label, Textarea } from "@/components/ui/input";
import { StatusBadge, type StatusTone } from "@/components/ui/status-badge";
import { SUPPLIER_PO_ENTITY_TYPE } from "@/server/core/order/supplier-po-rules";
import { formatMoney } from "@/lib/format";
import { toastError, toastSuccess } from "@/lib/errors";
import { trpc } from "@/lib/trpc/client";
import { ReceiveGoods } from "./ReceiveGoods";

/**
 * One supplier purchase order (specs/03-order-procurement.md §4 and §5).
 *
 * The gate block is the reason this screen is not just a document viewer. §4 and §5 both put a
 * refusal in front of sending, and both allow an officer to step past it with a reason — so the
 * screen has to show *what is in the way*, *who may clear it*, and *where the reason goes*, before
 * anybody presses anything. A button that simply errors teaches people to distrust the buttons that
 * work.
 *
 * The gates come from `order.supplierPoGates`, which runs the same pure functions the send path
 * enforces. The screen cannot disagree with the server about whether a PO may go out.
 */

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

export default function SupplierPoPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = use(params);
  const utils = trpc.useUtils();

  const po = trpc.order.getSupplierPo.useQuery({ supplierPOId: id });
  const gates = trpc.order.supplierPoGates.useQuery({ supplierPOId: id });
  const approval = trpc.order.supplierPoApprovalState.useQuery({ supplierPOId: id });
  const emailText = trpc.order.supplierPoEmailText.useQuery({ supplierPOId: id });

  const [downpaymentReason, setDownpaymentReason] = useState("");
  const [supplierReason, setSupplierReason] = useState("");
  const [rejectComment, setRejectComment] = useState("");
  const [supplierRef, setSupplierRef] = useState("");
  const [arrival, setArrival] = useState("");
  const [showEmail, setShowEmail] = useState(false);

  const refresh = () => {
    void utils.order.getSupplierPo.invalidate({ supplierPOId: id });
    void utils.order.supplierPoGates.invalidate({ supplierPOId: id });
    void utils.order.supplierPoApprovalState.invalidate({ supplierPOId: id });
    void utils.order.listSupplierPos.invalidate();
  };

  const submit = trpc.order.submitSupplierPoForApproval.useMutation({ onSuccess: refresh });
  const decide = trpc.order.decideSupplierPoApproval.useMutation({ onSuccess: refresh });
  const send = trpc.order.sendSupplierPo.useMutation({ onSuccess: refresh });
  const acknowledge = trpc.order.acknowledgeSupplierPo.useMutation({ onSuccess: refresh });

  if (po.isPending) return <p className="text-sm text-text-muted">Loading…</p>;
  if (po.error) {
    return (
      <Card className="p-4">
        <p className="text-sm">{po.error.message}</p>
      </Card>
    );
  }

  const data = po.data;
  const gate = gates.data;
  const charges = Number(data.freight) + Number(data.duties) + Number(data.otherCharges);
  /** Once an order is out with a supplier, receiving is the only thing left to do on this screen. */
  const receiving = ["sent", "acknowledged", "partially_received", "received"].includes(
    data.status,
  );

  async function run(action: () => Promise<unknown>, message: string) {
    try {
      await action();
      toastSuccess(message);
    } catch (error) {
      toastError(error);
    }
  }

  return (
    <div className="mx-auto max-w-7xl">
      <PageHeader
        title={data.number}
        description={`${data.supplier.name}${data.supplierRef ? ` · their ref ${data.supplierRef}` : ""}`}
        actions={
          <div className="flex flex-wrap items-center gap-2">
            <StatusBadge tone={PO_TONE[data.status] ?? "draft"}>
              <span className="capitalize">{human(data.status)}</span>
            </StatusBadge>
            <Button asChild variant="secondary" size="sm">
              <a href={`/api/supplier-pos/${data.id}/pdf`} target="_blank" rel="noreferrer">
                Download PDF
              </a>
            </Button>
          </div>
        }
      />

      <RecordLayout
        aside={
          <div className="space-y-4">
            <Card className="p-4">
              <h2 className="text-sm font-semibold">Value</h2>
              <dl className="mt-2 space-y-1 text-sm">
                <Row label="Goods" value={formatMoney(data.subtotal, data.currency)} />
                {Number(data.freight) > 0 && (
                  <Row label="Freight" value={formatMoney(data.freight, data.currency)} />
                )}
                {Number(data.duties) > 0 && (
                  <Row label="Duties" value={formatMoney(data.duties, data.currency)} />
                )}
                {Number(data.otherCharges) > 0 && (
                  <Row label="Other" value={formatMoney(data.otherCharges, data.currency)} />
                )}
                <Row label="Landed" value={formatMoney(data.total, data.currency)} strong />
              </dl>
              {charges > 0 && (
                <p className="mt-2 text-xs text-text-muted">
                  Charges are spread across the lines by value. The supplier&rsquo;s own document
                  shows the goods total only — freight and duties are AIES&rsquo;s cost of landing
                  them, not what this supplier is owed.
                </p>
              )}
            </Card>

            <Card className="p-4">
              <h2 className="text-sm font-semibold">Shipment</h2>
              <dl className="mt-2 space-y-1 text-sm">
                <Row label="Incoterm" value={data.incoterm ?? "—"} />
                <Row label="Mode" value={data.shipmentMode ?? "—"} />
                <Row
                  label="Ships"
                  value={data.expectedShipDate ? <DateCell value={data.expectedShipDate} /> : "—"}
                />
                <Row
                  label="Arrives"
                  value={
                    data.expectedArrivalDate ? <DateCell value={data.expectedArrivalDate} /> : "—"
                  }
                />
                <Row label="Tracking" value={data.trackingRef ?? "—"} />
              </dl>
              {data.daysLate !== null && data.daysLate > 0 && (
                <p className="mt-2">
                  <StatusBadge tone="failed">{data.daysLate} days late</StatusBadge>
                </p>
              )}
            </Card>

            {data.salesOrder && (
              <Card className="p-4">
                <h2 className="text-sm font-semibold">Supports</h2>
                <p className="mt-1 text-sm">
                  <Link
                    href={`/sales-orders/${data.salesOrder.id}`}
                    className="tabular text-blue-600 underline underline-offset-2"
                  >
                    {data.salesOrder.number}
                  </Link>
                </p>
                <p className="text-xs text-text-muted">{data.salesOrder.account.name}</p>
              </Card>
            )}
          </div>
        }
      >
        <div className="space-y-4">
          <Card className="p-4">
            <h2 className="text-sm font-semibold">Lines</h2>
            <div className="mt-2 overflow-x-auto">
              <table className="w-full min-w-[42rem] text-sm">
                <thead>
                  <tr className="border-b border-border text-left text-xs text-text-muted">
                    <th className="py-1.5 pr-2 font-medium">#</th>
                    <th className="py-1.5 pr-2 font-medium">Item</th>
                    <th className="py-1.5 pr-2 text-right font-medium">Qty</th>
                    <th className="py-1.5 pr-2 text-right font-medium">Unit cost</th>
                    <th className="py-1.5 pr-2 text-right font-medium">Goods</th>
                    {charges > 0 && <th className="py-1.5 pr-2 text-right font-medium">Landed</th>}
                  </tr>
                </thead>
                <tbody>
                  {data.lines.map((line) => (
                    <tr key={line.id} className="border-b border-border/60">
                      <td className="tabular py-1.5 pr-2 text-text-muted">{line.lineNo}</td>
                      <td className="py-1.5 pr-2">
                        {line.description}
                        {(line.manufacturer ?? line.modelNumber) && (
                          <span className="block text-xs text-text-muted">
                            {[line.manufacturer, line.modelNumber].filter(Boolean).join(" · ")}
                          </span>
                        )}
                      </td>
                      <td className="tabular py-1.5 pr-2 text-right">
                        {line.quantity} {line.unit}
                      </td>
                      <td className="tabular py-1.5 pr-2 text-right">
                        {formatMoney(line.unitCost, data.currency)}
                      </td>
                      <td className="tabular py-1.5 pr-2 text-right">
                        {formatMoney(line.lineTotal, data.currency)}
                      </td>
                      {charges > 0 && (
                        <td className="tabular py-1.5 pr-2 text-right font-medium">
                          {formatMoney(line.landedTotal, data.currency)}
                        </td>
                      )}
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </Card>

          {/*
            §6, directly under the lines it is about — and above the gate and approval blocks,
            because by the time an order is out with a supplier those two are history and receiving
            is the only thing anybody still does on this screen. It sat below them at first and was
            missed by the first person to look for it.
          */}
          {receiving && (
            <ReceiveGoods supplierPOId={data.id} poStatus={data.status} onReceived={refresh} />
          )}

          {/* ---- the gates ---------------------------------------------------------------- */}
          {gate && data.status !== "cancelled" && (
            <Card className="p-4">
              <h2 className="text-sm font-semibold">Before this can be sent</h2>

              <ul className="mt-2 space-y-2">
                <GateRow
                  label="Customer downpayment"
                  blocks={gate.downpayment.blocks}
                  message={gate.downpayment.message}
                />
                <GateRow
                  label="Supplier approved — ISO 9001 clause 8.4"
                  blocks={gate.supplierApproval.blocks}
                  message={
                    gate.supplierApproval.blocks
                      ? gate.supplierApproval.message
                      : `${data.supplier.name} is an approved supplier.`
                  }
                />
              </ul>

              {gate.downpayment.blocks && (
                <div className="mt-3">
                  <Label htmlFor="spo-dp-reason">Why order before the downpayment arrives?</Label>
                  <Textarea
                    id="spo-dp-reason"
                    rows={2}
                    value={downpaymentReason}
                    onChange={(e) => setDownpaymentReason(e.target.value)}
                    placeholder="EA authorised: the customer's cheque cleared this morning, proof on file."
                  />
                </div>
              )}

              {gate.supplierApproval.blocks && (
                <div className="mt-3">
                  <Label htmlFor="spo-sup-reason">Why buy from an unapproved supplier?</Label>
                  <Textarea
                    id="spo-sup-reason"
                    rows={2}
                    value={supplierReason}
                    onChange={(e) => setSupplierReason(e.target.value)}
                    placeholder="Single source for this obsolete part; approval paperwork is in progress."
                  />
                </div>
              )}

              {(gate.downpayment.blocks || gate.supplierApproval.blocks) && (
                <p className="mt-2 text-xs text-text-muted">
                  Only the President or Vice President may override. What you write here is what an
                  auditor reads when they ask why the rule was set aside.
                </p>
              )}
            </Card>
          )}

          {/* ---- what to do next ---------------------------------------------------------- */}
          <Card className="p-4">
            <h2 className="text-sm font-semibold">Next step</h2>

            {data.status === "draft" && (
              <div className="mt-2">
                <p className="text-xs text-text-muted">
                  The Vice President approves supplier orders. Nothing is committed until then.
                </p>
                <Button
                  className="mt-2"
                  size="sm"
                  disabled={submit.isPending || data.lines.length === 0}
                  onClick={() =>
                    void run(() => submit.mutateAsync({ supplierPOId: id }), "Sent for approval.")
                  }
                >
                  {submit.isPending ? "Submitting…" : "Submit for approval"}
                </Button>
              </div>
            )}

            {data.status === "pending_approval" && (
              <div className="mt-2 space-y-2">
                <p className="text-xs text-text-muted">
                  {approval.data?.canDecide
                    ? "This is with you."
                    : "Waiting on the Vice President."}
                </p>
                {approval.data?.canDecide && (
                  <>
                    <div>
                      <Label htmlFor="spo-reject">Comment (required to send back)</Label>
                      <Textarea
                        id="spo-reject"
                        rows={2}
                        value={rejectComment}
                        onChange={(e) => setRejectComment(e.target.value)}
                      />
                    </div>
                    <div className="flex flex-wrap gap-2">
                      <Button
                        size="sm"
                        disabled={decide.isPending}
                        onClick={() =>
                          void run(
                            () => decide.mutateAsync({ supplierPOId: id, decision: "approved" }),
                            "Approved.",
                          )
                        }
                      >
                        Approve
                      </Button>
                      <Button
                        size="sm"
                        variant="secondary"
                        disabled={decide.isPending || rejectComment.trim().length === 0}
                        onClick={() =>
                          void run(
                            () =>
                              decide.mutateAsync({
                                supplierPOId: id,
                                decision: "rejected",
                                comment: rejectComment,
                              }),
                            "Sent back to draft.",
                          )
                        }
                      >
                        Send back
                      </Button>
                    </div>
                  </>
                )}
              </div>
            )}

            {data.status === "approved" && (
              <div className="mt-2 space-y-2">
                <p className="text-xs text-text-muted">
                  Approved. Download the PDF, email it to {data.supplier.name}, then mark it sent —
                  the system does not email suppliers.
                </p>
                <div className="flex flex-wrap gap-2">
                  <Button
                    size="sm"
                    disabled={send.isPending}
                    onClick={() =>
                      void run(
                        () =>
                          send.mutateAsync({
                            supplierPOId: id,
                            downpaymentOverrideReason: downpaymentReason || null,
                            unapprovedSupplierOverrideReason: supplierReason || null,
                          }),
                        "Marked as sent.",
                      )
                    }
                  >
                    {send.isPending ? "Recording…" : "Mark as sent"}
                  </Button>
                  <Button size="sm" variant="ghost" onClick={() => setShowEmail((v) => !v)}>
                    {showEmail ? "Hide draft email" : "Draft email"}
                  </Button>
                </div>
                {showEmail && (
                  <Textarea
                    readOnly
                    rows={12}
                    className="mt-2 font-mono text-xs"
                    value={emailText.data ?? "Loading…"}
                  />
                )}
              </div>
            )}

            {data.status === "sent" && (
              <div className="mt-2 space-y-2">
                <p className="text-xs text-text-muted">
                  Sent {data.sentAt ? <DateCell value={data.sentAt} /> : null}. Record their
                  acknowledgement when it comes back.
                </p>
                <div className="grid gap-2 sm:grid-cols-2">
                  <div>
                    <Label htmlFor="spo-ref">Their order number</Label>
                    <Input
                      id="spo-ref"
                      value={supplierRef}
                      onChange={(e) => setSupplierRef(e.target.value)}
                      placeholder="Every follow-up call quotes theirs, not ours"
                    />
                  </div>
                  <div>
                    <Label htmlFor="spo-arrival">Arrival they confirmed</Label>
                    <Input
                      id="spo-arrival"
                      type="date"
                      value={arrival}
                      onChange={(e) => setArrival(e.target.value)}
                    />
                  </div>
                </div>
                <Button
                  size="sm"
                  disabled={acknowledge.isPending}
                  onClick={() =>
                    void run(
                      () =>
                        acknowledge.mutateAsync({
                          supplierPOId: id,
                          supplierRef: supplierRef || null,
                          expectedArrivalDate: arrival ? new Date(arrival) : null,
                        }),
                      "Acknowledgement recorded.",
                    )
                  }
                >
                  Record acknowledgement
                </Button>
              </div>
            )}

            {receiving && (
              <p className="mt-2 text-xs text-text-muted">
                {data.status === "received"
                  ? "Everything on this order has arrived and been accepted."
                  : "Waiting on the supplier. Book each delivery in as it arrives — the panel above."}
              </p>
            )}
          </Card>

          {(data.downpaymentOverrideReason ?? data.unapprovedSupplierOverrideReason) && (
            <Card className="p-4">
              <h2 className="text-sm font-semibold">Overrides on this order</h2>
              {data.downpaymentOverrideReason && (
                <p className="mt-1.5 text-sm">
                  <span className="text-xs text-text-muted">Downpayment gate — </span>
                  {data.downpaymentOverrideReason}
                </p>
              )}
              {data.unapprovedSupplierOverrideReason && (
                <p className="mt-1.5 text-sm">
                  <span className="text-xs text-text-muted">Clause 8.4 — </span>
                  {data.unapprovedSupplierOverrideReason}
                </p>
              )}
            </Card>
          )}

          <Card className="p-4">
            <h2 className="text-sm font-semibold">History</h2>
            <div className="mt-2">
              <AuditTrail entityType={SUPPLIER_PO_ENTITY_TYPE} entityId={data.id} />
            </div>
          </Card>
        </div>
      </RecordLayout>
    </div>
  );
}

function GateRow({ label, blocks, message }: { label: string; blocks: boolean; message: string }) {
  return (
    <li className="flex items-start gap-2">
      <StatusBadge tone={blocks ? "failed" : "approved"}>
        {blocks ? "Blocked" : "Clear"}
      </StatusBadge>
      <span className="min-w-0">
        <span className="text-sm font-medium">{label}</span>
        <span className="block text-xs text-text-muted">{message}</span>
      </span>
    </li>
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
