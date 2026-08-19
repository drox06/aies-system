"use client";

import { useState } from "react";
import { Button } from "@/components/ui/button";
import { DateCell } from "@/components/ui/cells";
import { Card } from "@/components/ui/layout";
import { Input, Label, Textarea } from "@/components/ui/input";
import { formatMoney } from "@/lib/format";
import { toastError, toastSuccess } from "@/lib/errors";
import { trpc } from "@/lib/trpc/client";
import { PoVerification } from "./PoVerification";

/**
 * The customer's purchase order, on the **quotation** record.
 *
 * The pipeline board already offers this, but the board is an *inquiry* board — and a quotation does
 * not always have an inquiry behind it. §9's duplicate produces one with none, and so does anything
 * raised straight from the Quotations screen. Those quotations had no card to drag and therefore no
 * way to record a PO at all, which is the gap this closes: a PO answers a *quotation*, and this is
 * where the person holding it is looking.
 *
 * When there is an inquiry, recording here still moves its card to Received PO — the service does
 * that, not this component.
 */
export function QuotationPoPanel({
  quotationId,
  quotationNumber,
  status,
  currency,
  quotationLines,
  onRecorded,
}: {
  quotationId: string;
  quotationNumber: string;
  status: string;
  currency: string;
  /** Non-optional lines, so §3's quantity check has something to compare the PO against. */
  quotationLines: { lineNo: number; description: string; quantity: string }[];
  onRecorded: () => void;
}) {
  const utils = trpc.useUtils();
  const [open, setOpen] = useState(false);
  const [poNumber, setPoNumber] = useState("");
  const [poDate, setPoDate] = useState(() => new Date().toISOString().slice(0, 10));
  const [amount, setAmount] = useState("");
  const [file, setFile] = useState<File | null>(null);
  const [busy, setBusy] = useState(false);

  // `customer_po.view` gates this; the panel disappears for anybody else rather than erroring.
  const pos = trpc.order.forQuotation.useQuery({ quotationId }, { retry: false });
  const record = trpc.order.recordCustomerPo.useMutation();

  if (pos.error) return null;

  const rows = pos.data ?? [];
  // A PO answers a document the customer has. Anything earlier has not reached them.
  const canRecord = ["sent", "under_negotiation", "accepted"].includes(status);
  if (!canRecord && rows.length === 0) return null;

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (!file) return;
    setBusy(true);
    try {
      const form = new FormData();
      form.append("file", file);
      form.append("entityType", "CustomerPO");
      // Against the quotation, which is what the service checks the upload belongs to.
      form.append("entityId", quotationId);

      const response = await fetch("/api/files", { method: "POST", body: form });
      if (!response.ok) {
        const body = (await response.json().catch(() => ({}))) as { error?: string };
        throw new Error(body.error ?? "That file could not be uploaded.");
      }
      const uploaded = (await response.json()) as { id: string };

      const result = await record.mutateAsync({
        quotationId,
        poNumber,
        poDate: new Date(poDate),
        amount,
        currency,
        fileId: uploaded.id,
      });

      toastSuccess(
        result.inquiryMoved
          ? `PO ${poNumber} recorded. The inquiry moved to Received PO.`
          : `PO ${poNumber} recorded against ${quotationNumber}.`,
      );
      setOpen(false);
      setPoNumber("");
      setAmount("");
      setFile(null);
      void utils.order.forQuotation.invalidate({ quotationId });
      onRecorded();
    } catch (error) {
      toastError(error);
    } finally {
      setBusy(false);
    }
  }

  return (
    <Card className="p-4">
      <h2 className="text-sm font-semibold">Customer PO</h2>

      {rows.length === 0 ? (
        <p className="mt-1 text-xs text-text-muted">
          Nothing recorded yet. Recording one here also moves the inquiry&rsquo;s card, when there
          is an inquiry behind this quotation.
        </p>
      ) : (
        <ul className="mt-2 space-y-2">
          {rows.map((po) => (
            <li key={po.id} className="text-sm">
              <div className="flex flex-wrap items-baseline justify-between gap-2">
                <span className="font-medium">{po.poNumber}</span>
                <span className="tabular">{formatMoney(po.amount, po.currency)}</span>
              </div>
              <p className="text-xs text-text-muted">
                Dated <DateCell value={po.poDate} /> · recorded{" "}
                <DateCell value={po.receivedAt} withTime />
              </p>
              <Button asChild size="sm" variant="ghost" className="mt-1 px-0">
                <a href={`/api/files/${po.fileId}`} target="_blank" rel="noreferrer">
                  Open the scanned PO
                </a>
              </Button>

              {/* §3's gate lives here, next to the document it compares — not on a screen somebody
                  has to remember to visit. */}
              <PoVerification
                customerPOId={po.id}
                poNumber={po.poNumber}
                quotationLines={quotationLines}
                status={po.status}
                salesOrder={po.salesOrder}
                onChanged={onRecorded}
              />

              {/*
                Correcting a PO recorded with the wrong number or the wrong file.

                Recording one is data entry from a document somebody else wrote, which is exactly the
                kind of act that gets a digit wrong — and until now there was no way back. The door
                closes once a sales order exists, because supplier orders, tickets and billing hang
                off it by then; the service says so rather than simply refusing.
              */}
              {!po.salesOrder && canRecord && (
                <PoWithdraw customerPOId={po.id} poNumber={po.poNumber} onDone={onRecorded} />
              )}
            </li>
          ))}
        </ul>
      )}

      {canRecord && !open && (
        <Button size="sm" className="mt-3" onClick={() => setOpen(true)}>
          Record customer PO
        </Button>
      )}

      {open && (
        <form onSubmit={submit} className="mt-3 space-y-3 border-t border-border pt-3">
          <div className="grid gap-3 sm:grid-cols-2">
            <div>
              <Label htmlFor="qpo-number">PO number *</Label>
              <Input
                id="qpo-number"
                value={poNumber}
                onChange={(e) => setPoNumber(e.target.value)}
                placeholder="As printed on their document"
                required
              />
            </div>
            <div>
              <Label htmlFor="qpo-date">PO date *</Label>
              <Input
                id="qpo-date"
                type="date"
                value={poDate}
                onChange={(e) => setPoDate(e.target.value)}
                required
              />
            </div>
          </div>

          <div>
            <Label htmlFor="qpo-amount">Amount *</Label>
            <Input
              id="qpo-amount"
              value={amount}
              onChange={(e) => setAmount(e.target.value)}
              inputMode="decimal"
              required
            />
            <p className="mt-1 text-xs text-text-muted">
              What the customer&rsquo;s PO says, even if it differs from the quotation.
            </p>
          </div>

          <div>
            <Label htmlFor="qpo-file">Scanned PO *</Label>
            <Input
              id="qpo-file"
              type="file"
              accept="application/pdf,image/*"
              required
              onChange={(e) => setFile(e.target.files?.[0] ?? null)}
            />
          </div>

          <div className="flex gap-2">
            <Button type="button" variant="ghost" size="sm" onClick={() => setOpen(false)}>
              Cancel
            </Button>
            <Button type="submit" size="sm" disabled={busy || !file || !poNumber.trim()}>
              {busy ? "Recording…" : "Record PO"}
            </Button>
          </div>
        </form>
      )}
    </Card>
  );
}

/** Withdrawing a PO recorded wrongly, so the right one can be recorded. */
function PoWithdraw({
  customerPOId,
  poNumber,
  onDone,
}: {
  customerPOId: string;
  poNumber: string;
  onDone: () => void;
}) {
  const [open, setOpen] = useState(false);
  const [reason, setReason] = useState("");

  const withdraw = trpc.order.withdrawCustomerPo.useMutation({
    onSuccess: () => {
      setOpen(false);
      setReason("");
      onDone();
    },
  });

  if (!open) {
    return (
      <Button variant="ghost" size="sm" className="mt-1 px-0" onClick={() => setOpen(true)}>
        Recorded wrongly? Withdraw it
      </Button>
    );
  }

  return (
    <div className="mt-2 rounded-md border-2 border-amber-400 bg-amber-50 p-3">
      <p className="text-sm font-semibold text-amber-900">Withdraw PO {poNumber}?</p>
      <p className="mt-1 text-sm text-amber-900">
        It comes off this quotation and you can record the right one. The withdrawal is kept in the
        history — the wrong number was recorded and somebody noticed, which is part of the story.
      </p>
      <Textarea
        className="mt-2"
        rows={2}
        placeholder="What was wrong with it?"
        value={reason}
        onChange={(event) => setReason(event.target.value)}
      />
      {withdraw.error && <p className="mt-2 text-sm text-danger">{withdraw.error.message}</p>}
      {reason.trim().length < 5 && (
        <p className="mt-1 text-xs text-amber-900">
          Say what was wrong before it can be withdrawn.
        </p>
      )}
      <div className="mt-2 flex flex-wrap gap-2">
        <Button
          size="sm"
          variant="destructive"
          disabled={withdraw.isPending || reason.trim().length < 5}
          onClick={() => withdraw.mutate({ customerPOId, reason })}
        >
          {withdraw.isPending ? "Withdrawing…" : "Yes, withdraw it"}
        </Button>
        <Button size="sm" variant="ghost" onClick={() => setOpen(false)}>
          Keep it
        </Button>
      </div>
    </div>
  );
}
