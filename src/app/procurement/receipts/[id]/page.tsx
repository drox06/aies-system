"use client";

import { use, useEffect, useState } from "react";
import Link from "next/link";
import { AuditTrail } from "@/components/AuditTrail";
import { Attachments } from "@/components/ui/attachments";
import { Button } from "@/components/ui/button";
import { DateCell } from "@/components/ui/cells";
import { Card, PageHeader, RecordLayout } from "@/components/ui/layout";
import { Input, Label, Textarea } from "@/components/ui/input";
import { StatusBadge, type StatusTone } from "@/components/ui/status-badge";
import { GOODS_RECEIPT_ENTITY_TYPE } from "@/server/core/order/goods-receipt-rules";
import { toastError, toastSuccess } from "@/lib/errors";
import { trpc } from "@/lib/trpc/client";

/**
 * One goods receipt, and its ISO 9001 clause 8.4.2 incoming inspection (§6).
 *
 * The inspection is the screen's whole reason to exist. §6: "**Incoming inspection is required**…
 * quantity check, damage check, documentation check (test certificates, calibration certificates,
 * datasheets, warranty), and photos." All four, no partial credit — so the four are shown as four
 * things with the outstanding ones named, rather than as one "inspected" tick.
 *
 * **Photographs are counted, not claimed.** There is no "did you take photos?" checkbox, because
 * that is a checkbox that always gets ticked. The attachment panel is the answer, and the server
 * reads the stored files.
 */

const RECEIPT_TONE: Record<string, StatusTone> = {
  draft: "draft",
  inspected: "pending",
  accepted: "approved",
  partially_rejected: "pending",
  rejected: "failed",
};

const human = (value: string) => value.replace(/_/g, " ");

export default function GoodsReceiptPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = use(params);
  const utils = trpc.useUtils();

  const receipt = trpc.order.getGoodsReceipt.useQuery({ goodsReceiptId: id });

  const [quantityChecked, setQuantityChecked] = useState(false);
  const [damageChecked, setDamageChecked] = useState(false);
  const [documentationChecked, setDocumentationChecked] = useState(false);
  const [notes, setNotes] = useState("");
  const [rejections, setRejections] = useState<
    Record<string, { qtyRejected: string; reason: string; serials: string }>
  >({});

  useEffect(() => {
    const data = receipt.data;
    if (!data) return;
    setQuantityChecked(data.quantityChecked);
    setDamageChecked(data.damageChecked);
    setDocumentationChecked(data.documentationChecked);
    setNotes(data.inspectionNotes ?? "");
    setRejections(
      Object.fromEntries(
        data.lines.map((line) => [
          line.id,
          {
            qtyRejected: line.qtyRejected,
            reason: line.rejectionReason ?? "",
            serials: line.serialNumbers.join(", "),
          },
        ]),
      ),
    );
  }, [receipt.data]);

  const refresh = () => {
    void utils.order.getGoodsReceipt.invalidate({ goodsReceiptId: id });
    void utils.order.listGoodsReceipts.invalidate();
    void utils.order.outstandingForSupplierPo.invalidate();
  };

  const inspect = trpc.order.inspectGoodsReceipt.useMutation({ onSuccess: refresh });
  const accept = trpc.order.acceptGoodsReceipt.useMutation({ onSuccess: refresh });

  if (receipt.isPending) return <p className="text-sm text-text-muted">Loading…</p>;
  if (receipt.error) {
    return (
      <Card className="p-4">
        <p className="text-sm">{receipt.error.message}</p>
      </Card>
    );
  }

  const data = receipt.data;
  const settled = data.status === "accepted" || data.status === "partially_rejected";

  async function saveInspection() {
    try {
      const result = await inspect.mutateAsync({
        goodsReceiptId: id,
        version: data.version,
        quantityChecked,
        damageChecked,
        documentationChecked,
        inspectionNotes: notes || null,
        lines: data.lines.map((line) => {
          const entry = rejections[line.id];
          const rejected = entry?.qtyRejected?.trim() || "0";
          return {
            goodsReceiptLineId: line.id,
            // Accepted is derived from what arrived minus what was rejected, so the two can never
            // be typed inconsistently — the server refuses that anyway, but a form that lets you
            // enter it wrong is a form that wastes a round trip.
            qtyAccepted: (Number(line.qtyReceived) - Number(rejected)).toString(),
            qtyRejected: rejected,
            rejectionReason: entry?.reason || null,
            serialNumbers: (entry?.serials ?? "")
              .split(",")
              .map((serial) => serial.trim())
              .filter(Boolean),
          };
        }),
      });
      toastSuccess(
        result.gate.complete
          ? "Inspection recorded. The goods can now be accepted."
          : `Recorded. Still outstanding: ${result.gate.missing.join(", ")}.`,
      );
    } catch (error) {
      toastError(error);
    }
  }

  return (
    <div className="mx-auto max-w-7xl">
      <PageHeader
        title={data.number}
        description={`${data.supplierPO.supplier.name} · against ${data.supplierPO.number}`}
        actions={
          <StatusBadge tone={RECEIPT_TONE[data.status] ?? "draft"}>
            <span className="capitalize">{human(data.status)}</span>
          </StatusBadge>
        }
      />

      <RecordLayout
        aside={
          <div className="space-y-4">
            <Card className="p-4">
              <h2 className="text-sm font-semibold">Delivery</h2>
              <dl className="mt-2 space-y-1 text-sm">
                <Row label="Received" value={<DateCell value={data.receivedAt} withTime />} />
                <Row label="Packing list" value={data.packingListRef ?? "—"} />
                <Row label="Waybill" value={data.waybillRef ?? "—"} />
                <Row label="Invoice" value={data.invoiceRef ?? "—"} />
                <Row
                  label="Order"
                  value={
                    <Link
                      href={`/procurement/${data.supplierPO.id}`}
                      className="text-blue-600 underline underline-offset-2"
                    >
                      {data.supplierPO.number}
                    </Link>
                  }
                />
                {data.supplierPO.salesOrder && (
                  <Row
                    label="Supports"
                    value={
                      <Link
                        href={`/sales-orders/${data.supplierPO.salesOrder.id}`}
                        className="text-blue-600 underline underline-offset-2"
                      >
                        {data.supplierPO.salesOrder.number}
                      </Link>
                    }
                  />
                )}
              </dl>
            </Card>

            <Card className="p-4">
              <h2 className="text-sm font-semibold">Photographs</h2>
              <p className="mt-1 text-xs text-text-muted">
                Required by clause 8.4.2, and the only part of the inspection that survives the
                person who did it.
              </p>
              <div className="mt-2">
                <Attachments
                  entityType={GOODS_RECEIPT_ENTITY_TYPE}
                  entityId={data.id}
                  accept="image/*"
                  emptyText="No photographs yet — the inspection cannot pass without one."
                  canUpload={!settled}
                  // Re-read after an upload so the gate below reflects it without a page reload.
                  onChanged={refresh}
                />
              </div>
            </Card>
          </div>
        }
      >
        <div className="space-y-4">
          <Card className="p-4">
            <h2 className="text-sm font-semibold">What arrived</h2>
            <div className="mt-2 overflow-x-auto">
              <table className="w-full min-w-[40rem] text-sm">
                <thead>
                  <tr className="border-b border-border text-left text-xs text-text-muted">
                    <th className="py-1.5 pr-2 font-medium">Item</th>
                    <th className="py-1.5 pr-2 text-right font-medium">Ordered</th>
                    <th className="py-1.5 pr-2 text-right font-medium">Arrived</th>
                    <th className="py-1.5 pr-2 text-right font-medium">Rejected</th>
                    <th className="py-1.5 pr-2 font-medium">Serial numbers</th>
                  </tr>
                </thead>
                <tbody>
                  {data.lines.map((line) => (
                    <tr key={line.id} className="border-b border-border/60 align-top">
                      <td className="py-1.5 pr-2">{line.description}</td>
                      <td className="tabular py-1.5 pr-2 text-right text-text-muted">
                        {line.qtyOrdered}
                      </td>
                      <td className="tabular py-1.5 pr-2 text-right">
                        {line.qtyReceived} {line.unit}
                      </td>
                      <td className="py-1.5 pr-2 text-right">
                        {settled ? (
                          <span className="tabular">{line.qtyRejected}</span>
                        ) : (
                          <Input
                            aria-label={`Quantity rejected for ${line.description}`}
                            className="w-20 text-right"
                            inputMode="decimal"
                            value={rejections[line.id]?.qtyRejected ?? "0"}
                            onChange={(e) =>
                              setRejections((current) => ({
                                ...current,
                                [line.id]: {
                                  qtyRejected: e.target.value,
                                  reason: current[line.id]?.reason ?? "",
                                  serials: current[line.id]?.serials ?? "",
                                },
                              }))
                            }
                          />
                        )}
                      </td>
                      <td className="py-1.5 pr-2">
                        {settled ? (
                          <span className="text-xs text-text-muted">
                            {line.serialNumbers.join(", ") || "—"}
                          </span>
                        ) : (
                          <Input
                            aria-label={`Serial numbers for ${line.description}`}
                            className="w-48"
                            placeholder="Comma-separated"
                            value={rejections[line.id]?.serials ?? ""}
                            onChange={(e) =>
                              setRejections((current) => ({
                                ...current,
                                [line.id]: {
                                  qtyRejected: current[line.id]?.qtyRejected ?? "0",
                                  reason: current[line.id]?.reason ?? "",
                                  serials: e.target.value,
                                },
                              }))
                            }
                          />
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>

            {!settled &&
              data.lines
                .filter((line) => Number(rejections[line.id]?.qtyRejected ?? 0) > 0)
                .map((line) => (
                  <div key={`reason-${line.id}`} className="mt-2">
                    <Label htmlFor={`reject-${line.id}`}>
                      Why was {line.description} rejected?
                    </Label>
                    <Input
                      id={`reject-${line.id}`}
                      value={rejections[line.id]?.reason ?? ""}
                      onChange={(e) =>
                        setRejections((current) => ({
                          ...current,
                          [line.id]: {
                            qtyRejected: current[line.id]?.qtyRejected ?? "0",
                            reason: e.target.value,
                            serials: current[line.id]?.serials ?? "",
                          },
                        }))
                      }
                      placeholder="One unit arrived with a cracked housing."
                    />
                    <p className="mt-0.5 text-xs text-text-muted">
                      This is what goes to the supplier, and what the non-conformance report is
                      raised from.
                    </p>
                  </div>
                ))}

            {settled &&
              data.lines
                .filter((line) => line.rejectionReason)
                .map((line) => (
                  <p key={`why-${line.id}`} className="mt-2 text-xs text-text-muted">
                    <span className="font-medium">{line.description}</span> — {line.rejectionReason}
                  </p>
                ))}
          </Card>

          <Card className="p-4">
            <h2 className="text-sm font-semibold">Incoming inspection — ISO 9001 clause 8.4.2</h2>
            <p className="mt-1 text-xs text-text-muted">{data.gate.message}</p>

            <div className="mt-3 space-y-2">
              <Check
                id="grn-qty"
                label="Quantity checked against the packing list"
                checked={quantityChecked}
                disabled={settled}
                onChange={setQuantityChecked}
              />
              <Check
                id="grn-damage"
                label="Checked for damage in transit"
                checked={damageChecked}
                disabled={settled}
                onChange={setDamageChecked}
              />
              <Check
                id="grn-docs"
                label="Documentation checked — test and calibration certificates, datasheets, warranty"
                checked={documentationChecked}
                disabled={settled}
                onChange={setDocumentationChecked}
              />
              <div className="flex items-start gap-2 text-sm">
                <StatusBadge tone={data.photosAttached ? "approved" : "failed"}>
                  {data.photosAttached ? "Done" : "Outstanding"}
                </StatusBadge>
                <span>
                  Photographs
                  <span className="block text-xs text-text-muted">
                    Counted from what is attached, not ticked on a form.
                  </span>
                </span>
              </div>
            </div>

            {!settled && (
              <div className="mt-3">
                <Label htmlFor="grn-notes">Notes</Label>
                <Textarea
                  id="grn-notes"
                  rows={2}
                  value={notes}
                  onChange={(e) => setNotes(e.target.value)}
                />
              </div>
            )}
            {settled && data.inspectionNotes && (
              <p className="mt-2 text-sm">{data.inspectionNotes}</p>
            )}

            {!settled && (
              <div className="mt-3 flex flex-wrap gap-2">
                <Button
                  size="sm"
                  disabled={inspect.isPending}
                  onClick={() => void saveInspection()}
                >
                  {inspect.isPending ? "Recording…" : "Record inspection"}
                </Button>
                <Button
                  size="sm"
                  variant="secondary"
                  disabled={accept.isPending || data.status !== "inspected"}
                  onClick={() =>
                    void (async () => {
                      try {
                        await accept.mutateAsync({ goodsReceiptId: id });
                        toastSuccess("Accepted. The order has been credited with these goods.");
                      } catch (error) {
                        toastError(error);
                      }
                    })()
                  }
                >
                  Accept the goods
                </Button>
              </div>
            )}
            {!settled && data.status !== "inspected" && (
              <p className="mt-1.5 text-xs text-text-muted">
                Acceptance is what credits the customer&rsquo;s order. It stays closed until all
                four checks are done.
              </p>
            )}
          </Card>

          <Card className="p-4">
            <h2 className="text-sm font-semibold">History</h2>
            <div className="mt-2">
              <AuditTrail entityType={GOODS_RECEIPT_ENTITY_TYPE} entityId={data.id} />
            </div>
          </Card>
        </div>
      </RecordLayout>
    </div>
  );
}

function Check({
  id,
  label,
  checked,
  disabled,
  onChange,
}: {
  id: string;
  label: string;
  checked: boolean;
  disabled: boolean;
  onChange: (value: boolean) => void;
}) {
  return (
    <label htmlFor={id} className="flex items-start gap-2 text-sm">
      <input
        id={id}
        type="checkbox"
        className="mt-0.5 size-4 rounded border-border"
        checked={checked}
        disabled={disabled}
        onChange={(e) => onChange(e.target.checked)}
      />
      <span>{label}</span>
    </label>
  );
}

function Row({ label, value }: { label: string; value: React.ReactNode }) {
  return (
    <div className="flex items-baseline justify-between gap-3">
      <dt className="text-xs text-text-muted">{label}</dt>
      <dd className="tabular">{value}</dd>
    </div>
  );
}
