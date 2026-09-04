"use client";

import { use, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { AuditTrail } from "@/components/AuditTrail";
import { Button } from "@/components/ui/button";
import { DateCell } from "@/components/ui/cells";
import { Card, PageHeader, RecordLayout } from "@/components/ui/layout";
import { Input, Label, Textarea } from "@/components/ui/input";
import { StatusBadge, type StatusTone } from "@/components/ui/status-badge";
import { getCompanyDetails } from "@/server/core/company";
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
  // PD's endorsement (docs/DECISIONS.md #175) — still awaiting the Vice President's or President's
  // own decision, same as `pending_approval`.
  endorsed: "pending",
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
  const endorse = trpc.order.endorseSupplierPo.useMutation({ onSuccess: refresh });
  const send = trpc.order.sendSupplierPo.useMutation({ onSuccess: refresh });
  const acknowledge = trpc.order.acknowledgeSupplierPo.useMutation({ onSuccess: refresh });
  const router = useRouter();
  const me = trpc.system.whoami.useQuery(undefined, { retry: false });
  const remove = trpc.order.deleteSupplierPo.useMutation({
    onSuccess: () => {
      refresh();
      router.push("/procurement");
    },
  });
  const [deleteReason, setDeleteReason] = useState("");

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
                <DeliverToRow
                  supplierPOId={id}
                  version={data.version}
                  editable={data.editable}
                  deliverTo={data.deliverTo}
                  onSaved={() => void po.refetch()}
                />
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
                    {/*
                      What is still coming. The company asked for it here rather than inside each
                      goods receipt: counting a part-delivered order by opening three GRNs and adding
                      up is exactly the arithmetic a system should have done already, and it is the
                      question somebody asks before phoning the supplier.
                    */}
                    <th className="py-1.5 pr-2 text-right font-medium">Outstanding</th>
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
                        {(() => {
                          /*
                            A service has nothing to count. §6's three-way match compares what was
                            ordered, what arrived and what was billed — and where nothing arrives,
                            "3 pc outstanding" is a lie about a calibration nobody was ever going to
                            unload from a truck.
                          */
                          if (line.isService) {
                            return line.performedAt ? (
                              <span className="text-text-muted">performed</span>
                            ) : (
                              <span className="font-medium">not yet done</span>
                            );
                          }
                          const outstanding = Number(line.quantity) - Number(line.qtyReceived ?? 0);
                          if (!Number.isFinite(outstanding)) return "—";
                          if (outstanding <= 0) {
                            return <span className="text-text-muted">all in</span>;
                          }
                          return (
                            <span className="font-medium">
                              {outstanding} {line.unit}
                            </span>
                          );
                        })()}
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
          {/*
            Services are confirmed, goods are received.

            Kept beside the goods receipt rather than on a screen of its own: a purchase order that
            mixes a meter and its calibration is one order, and settling it should not mean two
            different journeys.
          */}
          {receiving && (
            <ServiceLines
              lines={data.lines
                .filter((line) => line.isService)
                .map((line) => ({
                  id: line.id,
                  description: line.description,
                  performedAt: line.performedAt,
                }))}
              onChanged={refresh}
            />
          )}

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

            {data.status === "pending_approval" &&
              (me.data?.permissions ?? []).includes("supplier_po.endorse") && (
                <div className="mt-2 space-y-2">
                  <p className="text-xs text-text-muted">
                    Endorsing does not approve this PO — it still needs the Vice President&rsquo;s
                    or President&rsquo;s own decision before it can be sent.
                  </p>
                  <Button
                    size="sm"
                    disabled={endorse.isPending}
                    onClick={() =>
                      void run(() => endorse.mutateAsync({ supplierPOId: id }), "Endorsed.")
                    }
                  >
                    Endorse
                  </Button>
                </div>
              )}

            {(data.status === "pending_approval" || data.status === "endorsed") && (
              <div className="mt-2 space-y-2">
                <p className="text-xs text-text-muted">
                  {approval.data?.canDecide
                    ? "This is with you."
                    : data.status === "endorsed"
                      ? `Endorsed. Waiting on the Vice President.`
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
      {/*
        Deleting is for a duplicate that should never have existed — asked for on 2026-08-17. It is
        deliberately not the same act as cancelling: a cancellation is a commitment the company
        withdrew and stays visible; a double entry was never a commitment. The service refuses
        anything already sent or received.
      */}
      {(me.data?.permissions ?? []).includes("supplier_po.delete") && !data.sentAt && (
        <Card className="border-danger/30 p-4">
          <h2 className="text-sm font-semibold text-danger">Delete this order</h2>
          <p className="mt-1 text-xs text-text-muted">
            For a duplicate or an order raised in error. Refused once it has been sent to the
            supplier or goods have arrived — cancel it instead, so they see the withdrawal. The
            number is never reused, so the gap stays as a trace.
          </p>
          <div className="mt-2 flex flex-wrap items-end gap-2">
            <div className="grow">
              <Label htmlFor="po-delete-reason">Why</Label>
              <Input
                id="po-delete-reason"
                placeholder="Duplicate of AIESPO-260012"
                value={deleteReason}
                onChange={(e) => setDeleteReason(e.target.value)}
              />
            </div>
            <Button
              variant="destructive"
              size="sm"
              disabled={remove.isPending || deleteReason.trim().length < 3}
              onClick={() => remove.mutate({ supplierPOId: id, reason: deleteReason })}
            >
              Delete
            </Button>
          </div>
          {remove.error && <p className="mt-2 text-sm text-danger">{remove.error.message}</p>}
        </Card>
      )}
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

/**
 * Confirming that a bought-in service was actually performed.
 *
 * There is nothing to count, so there is nothing to type: a person says it happened and is recorded
 * as having said so. That is the whole content of the control, and it is deliberately the whole
 * content — inventing a quantity for a calibration would produce a number that means nothing and a
 * three-way match that compares it to nothing.
 */
function ServiceLines({
  lines,
  onChanged,
}: {
  lines: { id: string; description: string; performedAt: Date | string | null }[];
  onChanged: () => void;
}) {
  const confirm = trpc.order.confirmServicePerformed.useMutation({ onSuccess: onChanged });

  if (lines.length === 0) return null;

  return (
    <Card className="mt-4 p-4">
      <h2 className="text-sm font-semibold">Services on this order</h2>
      <p className="mt-1 text-xs text-text-muted">
        Nothing arrives for these, so there is no goods receipt. Confirm each one when it has been
        done — the order cannot close until they are all accounted for.
      </p>

      {confirm.error && <p className="mt-2 text-sm text-danger">{confirm.error.message}</p>}

      <ul className="mt-3 space-y-2">
        {lines.map((line) => (
          <li key={line.id} className="flex flex-wrap items-center justify-between gap-2 text-sm">
            <span className="min-w-0">
              {line.description}
              {line.performedAt && (
                <span className="ml-2 text-xs text-text-muted">
                  confirmed <DateCell value={line.performedAt} />
                </span>
              )}
            </span>
            <Button
              size="sm"
              variant={line.performedAt ? "ghost" : "secondary"}
              disabled={confirm.isPending}
              onClick={() =>
                confirm.mutate({ supplierPOLineId: line.id, performed: !line.performedAt })
              }
            >
              {line.performedAt ? "Not done after all" : "Confirm it was done"}
            </Button>
          </li>
        ))}
      </ul>
    </Card>
  );
}

/**
 * Where the supplier is to deliver — shown on every PO, editable while the PO still is.
 *
 * ## Why it is here at all
 *
 * The PO printed a delivery address derived from the sales order's site, or AIES's own when there
 * was none, and neither the buyer nor anybody else could see or change it. The company reported the
 * consequence on 2026-08-19: suppliers ringing to ask where the goods go. Derivation is right most
 * of the time and there was no way to be right the rest of the time.
 *
 * ## Why it shows the default rather than an empty box
 *
 * An empty field beside "Deliver to" reads as *unanswered*, and this question has always had an
 * answer. So the company address is rendered as the current value in grey with "the default" beside
 * it, and typing replaces it. Absent is not the same as empty — the same distinction that separates
 * a recorded N/A from an unasked question everywhere else in this platform.
 *
 * ## Why editing stops when the PO does
 *
 * `editable` is the service's own `isSupplierPoEditable`. Once a PO is sent, the supplier is holding
 * a piece of paper with an address on it, and quietly changing our copy would make the two disagree
 * with nothing to show for it. A sent PO that must go elsewhere is a conversation, not a text field.
 */
function DeliverToRow({
  supplierPOId,
  version,
  editable,
  deliverTo,
  onSaved,
}: {
  supplierPOId: string;
  version: number;
  editable: boolean;
  deliverTo: string | null;
  onSaved: () => void;
}) {
  const [open, setOpen] = useState(false);
  const [draft, setDraft] = useState(deliverTo ?? "");
  const company = getCompanyDetails();
  const fallback = [company.name, ...company.addressLines];

  const update = trpc.order.updateSupplierPo.useMutation({
    onSuccess: () => {
      toastSuccess("Delivery address saved.");
      setOpen(false);
      onSaved();
    },
    onError: toastError,
  });

  if (open) {
    return (
      <div className="py-1">
        <Label htmlFor="spo-deliver-to">Deliver to</Label>
        <Textarea
          id="spo-deliver-to"
          rows={3}
          value={draft}
          placeholder={fallback.join("\n")}
          onChange={(event) => setDraft(event.target.value)}
        />
        <p className="mt-0.5 text-xs text-text-muted">
          One line each, as it should print. Leave it empty for the company address.
        </p>
        <div className="mt-2 flex gap-2">
          <Button
            size="sm"
            disabled={update.isPending}
            onClick={() =>
              update.mutate({ supplierPOId, version, deliverTo: draft.trim() || null })
            }
          >
            {update.isPending ? "Saving…" : "Save"}
          </Button>
          <Button
            variant="ghost"
            size="sm"
            onClick={() => {
              setDraft(deliverTo ?? "");
              setOpen(false);
            }}
          >
            Cancel
          </Button>
        </div>
      </div>
    );
  }

  const lines = deliverTo?.trim() ? deliverTo.split("\n").filter(Boolean) : fallback;

  return (
    <div className="flex items-start justify-between gap-2 py-0.5">
      <dt className="text-text-muted">Deliver to</dt>
      <dd className="text-right">
        {lines.map((line) => (
          <span key={line} className={deliverTo ? "block" : "block text-text-muted"}>
            {line}
          </span>
        ))}
        {!deliverTo && <span className="block text-xs text-text-muted">the company address</span>}
        {editable && (
          <Button variant="ghost" size="sm" className="mt-0.5" onClick={() => setOpen(true)}>
            Change
          </Button>
        )}
      </dd>
    </div>
  );
}
