"use client";

import { useState } from "react";
import Link from "next/link";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/layout";
import { DateCell } from "@/components/ui/cells";
import { Input, Label } from "@/components/ui/input";
import { StatusBadge, type StatusTone } from "@/components/ui/status-badge";
import { toastError, toastSuccess } from "@/lib/errors";
import { trpc } from "@/lib/trpc/client";

/**
 * Booking a delivery in against a supplier PO (specs/03-order-procurement.md §6).
 *
 * Deliberately the shortest form in the build: the person filling it in is standing next to a
 * pallet, often on a phone. So the only required input is a quantity per line, every box is
 * pre-filled with **what is still outstanding**, and everything else — serial numbers, batch, the
 * paperwork references — is optional and follows.
 *
 * What it does *not* do is inspect. §6 requires an ISO 9001 clause 8.4.2 inspection before goods
 * can be accepted, and that happens on the receipt afterwards, by somebody with
 * `goods_receipt.inspect`. Folding the two together would make whoever signs for the delivery also
 * certify paperwork they have not seen, and the reliable result of that is a tick box that always
 * gets ticked.
 */

const RECEIPT_TONE: Record<string, StatusTone> = {
  draft: "draft",
  inspected: "pending",
  accepted: "approved",
  partially_rejected: "pending",
  rejected: "failed",
};

const human = (value: string) => value.replace(/_/g, " ");

export function ReceiveGoods({
  supplierPOId,
  poStatus,
  onReceived,
}: {
  supplierPOId: string;
  poStatus: string;
  onReceived: () => void;
}) {
  const utils = trpc.useUtils();
  const [open, setOpen] = useState(false);
  const [quantities, setQuantities] = useState<Record<string, string>>({});
  const [packingListRef, setPackingListRef] = useState("");
  const [waybillRef, setWaybillRef] = useState("");

  const outstanding = trpc.order.outstandingForSupplierPo.useQuery(
    { supplierPOId },
    { retry: false },
  );
  const receipts = trpc.order.listGoodsReceipts.useQuery({ supplierPOId }, { retry: false });
  const create = trpc.order.createGoodsReceipt.useMutation();

  // `goods_receipt.create` gates both queries; the panel disappears rather than erroring.
  if (outstanding.error || receipts.error) return null;

  const lines = outstanding.data ?? [];
  const anyOutstanding = lines.some((line) => Number(line.qtyOutstanding) > 0);
  // Nothing can have arrived against an order nobody has placed.
  const canReceive = !["draft", "pending_approval", "cancelled"].includes(poStatus);

  const typed = lines
    .filter((line) => (quantities[line.supplierPOLineId] ?? "").trim() !== "")
    .map((line) => ({
      supplierPOLineId: line.supplierPOLineId,
      qtyReceived: quantities[line.supplierPOLineId]!,
    }));

  async function submit() {
    try {
      const receipt = await create.mutateAsync({
        supplierPOId,
        lines: typed,
        packingListRef: packingListRef || null,
        waybillRef: waybillRef || null,
      });
      toastSuccess(
        `${receipt.number} booked in. It needs an incoming inspection before acceptance.`,
      );
      setQuantities({});
      setPackingListRef("");
      setWaybillRef("");
      setOpen(false);
      void utils.order.outstandingForSupplierPo.invalidate({ supplierPOId });
      void utils.order.listGoodsReceipts.invalidate({ supplierPOId });
      onReceived();
    } catch (error) {
      toastError(error);
    }
  }

  return (
    <Card className="p-4">
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div>
          <h2 className="text-sm font-semibold">Goods received</h2>
          <p className="mt-1 text-xs text-text-muted">
            Partial deliveries are normal — book in what actually arrived.
          </p>
        </div>
        {canReceive && anyOutstanding && !open && (
          <Button size="sm" onClick={() => setOpen(true)}>
            Book in a delivery
          </Button>
        )}
      </div>

      {(receipts.data ?? []).length > 0 && (
        <ul className="mt-3 divide-y divide-border">
          {(receipts.data ?? []).map((receipt) => (
            <li key={receipt.id} className="flex flex-wrap items-center gap-2 py-2 text-sm">
              <Link
                href={`/procurement/receipts/${receipt.id}`}
                className="tabular font-medium text-blue-600 underline underline-offset-2"
              >
                {receipt.number}
              </Link>
              <span className="text-xs text-text-muted">
                <DateCell value={receipt.receivedAt} />
              </span>
              <span className="min-w-0 flex-1 truncate text-xs text-text-muted">
                {receipt._count.lines} line(s)
              </span>
              <StatusBadge tone={RECEIPT_TONE[receipt.status] ?? "draft"}>
                <span className="capitalize">{human(receipt.status)}</span>
              </StatusBadge>
              {receipt.status === "draft" && (
                // The state that matters: goods are in the building and have not been verified.
                <StatusBadge tone="failed">Inspection outstanding</StatusBadge>
              )}
            </li>
          ))}
        </ul>
      )}

      {!anyOutstanding && lines.length > 0 && (
        <p className="mt-3 text-xs text-text-muted">Everything on this order has arrived.</p>
      )}

      {open && (
        <div className="mt-3 space-y-3 border-t border-border pt-3">
          <div className="space-y-1.5">
            {lines.map((line) => {
              const remaining = Number(line.qtyOutstanding);
              return (
                <div key={line.supplierPOLineId} className="flex flex-wrap items-center gap-2">
                  <span className="tabular w-6 text-right text-xs text-text-muted">
                    {line.lineNo}
                  </span>
                  <span className="min-w-0 flex-1 truncate text-sm">{line.description}</span>
                  <span className="text-xs text-text-muted">
                    {remaining > 0 ? `${line.qtyOutstanding} still due` : "complete"}
                  </span>
                  <Input
                    aria-label={`Quantity received for line ${line.lineNo}`}
                    className="w-24"
                    inputMode="decimal"
                    disabled={remaining <= 0}
                    placeholder={remaining > 0 ? line.qtyOutstanding : "—"}
                    value={quantities[line.supplierPOLineId] ?? ""}
                    onChange={(e) =>
                      setQuantities((current) => ({
                        ...current,
                        [line.supplierPOLineId]: e.target.value,
                      }))
                    }
                  />
                </div>
              );
            })}
          </div>

          <div className="grid gap-3 sm:grid-cols-2">
            <div>
              <Label htmlFor="grn-packing">Packing list ref</Label>
              <Input
                id="grn-packing"
                value={packingListRef}
                onChange={(e) => setPackingListRef(e.target.value)}
              />
            </div>
            <div>
              <Label htmlFor="grn-waybill">Waybill ref</Label>
              <Input
                id="grn-waybill"
                value={waybillRef}
                onChange={(e) => setWaybillRef(e.target.value)}
              />
            </div>
          </div>

          <div className="flex flex-wrap gap-2">
            <Button size="sm" variant="ghost" onClick={() => setOpen(false)}>
              Cancel
            </Button>
            <Button
              size="sm"
              onClick={() => void submit()}
              disabled={create.isPending || typed.length === 0}
            >
              {create.isPending ? "Booking in…" : "Book in"}
            </Button>
          </div>
          <p className="text-xs text-text-muted">
            Nothing moves on the customer&rsquo;s order until the incoming inspection is done and
            the receipt is accepted — ISO 9001 clause 8.4.2.
          </p>
        </div>
      )}
    </Card>
  );
}
