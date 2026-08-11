"use client";

import * as Dialog from "@radix-ui/react-dialog";
import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Input, Label } from "@/components/ui/input";
import { toastError, toastSuccess } from "@/lib/errors";
import { trpc } from "@/lib/trpc/client";

/**
 * Recording the customer's purchase order (specs/03-order-procurement.md §2).
 *
 * The company's rule: a card leaves "Sent" when the PO arrives, and "for this to move to the next
 * column a PO should be uploaded". So this is not an optional attachment panel — it is the only way
 * into the next column, and the scan is required rather than encouraged. §2 says the same thing:
 * "scanned PO is mandatory".
 *
 * **Two requests, not one.** The file goes to `POST /api/files` first, then the mutation records the
 * PO against the returned id. tRPC carries JSON, not multipart; and the server re-reads the stored
 * file to confirm it is the one being claimed, which an id in a request body cannot prove on its
 * own. The cost is that an abandoned dialog can leave an orphan upload — acceptable, because the
 * alternative loses the document.
 */
export function CustomerPoDialog({
  open,
  onOpenChange,
  inquiry,
  onRecorded,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  inquiry: {
    id: string;
    number: string;
    subject: string;
    liveQuotation: { id: string; number: string; total: string; currency: string } | null;
  } | null;
  onRecorded: () => void;
}) {
  const [poNumber, setPoNumber] = useState("");
  const [poDate, setPoDate] = useState(() => new Date().toISOString().slice(0, 10));
  const [amount, setAmount] = useState("");
  const [file, setFile] = useState<File | null>(null);
  const [busy, setBusy] = useState(false);

  const record = trpc.order.recordCustomerPo.useMutation();

  function reset() {
    setPoNumber("");
    setPoDate(new Date().toISOString().slice(0, 10));
    setAmount("");
    setFile(null);
  }

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (!inquiry || !file) return;
    setBusy(true);
    try {
      const form = new FormData();
      form.append("file", file);
      form.append("entityType", "CustomerPO");
      // Against the inquiry, so the scan is findable from the card even before the PO row exists —
      // and so the service can prove the upload belongs to the record it is being attached to.
      form.append("entityId", inquiry.id);

      const response = await fetch("/api/files", { method: "POST", body: form });
      if (!response.ok) {
        const body = (await response.json().catch(() => ({}))) as { error?: string };
        throw new Error(body.error ?? "That file could not be uploaded.");
      }
      const uploaded = (await response.json()) as { id: string };

      await record.mutateAsync({
        inquiryId: inquiry.id,
        quotationId: inquiry.liveQuotation?.id ?? null,
        poNumber,
        poDate: new Date(poDate),
        amount,
        currency: inquiry.liveQuotation?.currency ?? "PHP",
        fileId: uploaded.id,
      });

      toastSuccess(`PO ${poNumber} recorded. ${inquiry.number} moved to Received PO.`);
      reset();
      onOpenChange(false);
      onRecorded();
    } catch (error) {
      toastError(error);
    } finally {
      setBusy(false);
    }
  }

  return (
    <Dialog.Root
      open={open}
      onOpenChange={(next) => {
        if (!next) reset();
        onOpenChange(next);
      }}
    >
      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 z-50 bg-navy-900/40" />
        <Dialog.Content className="fixed top-1/2 left-1/2 z-50 max-h-[90dvh] w-[min(32rem,calc(100vw-2rem))] -translate-x-1/2 -translate-y-1/2 overflow-y-auto rounded-md border border-border bg-surface p-5 shadow-xl">
          <Dialog.Title className="text-base font-semibold">
            Record the customer&rsquo;s PO
          </Dialog.Title>
          <Dialog.Description className="mt-1 text-sm text-text-muted">
            {inquiry
              ? `${inquiry.number} — ${inquiry.subject}`
              : "Pick an inquiry in the Sent column."}
            {inquiry?.liveQuotation && (
              <span className="mt-1 block">Against quotation {inquiry.liveQuotation.number}.</span>
            )}
          </Dialog.Description>

          <form onSubmit={submit} className="mt-4 space-y-4">
            <div className="grid gap-3 sm:grid-cols-2">
              <div>
                <Label htmlFor="po-number">PO number *</Label>
                <Input
                  id="po-number"
                  value={poNumber}
                  onChange={(e) => setPoNumber(e.target.value)}
                  placeholder="As printed on their document"
                  required
                  autoFocus
                />
              </div>
              <div>
                <Label htmlFor="po-date">PO date *</Label>
                <Input
                  id="po-date"
                  type="date"
                  value={poDate}
                  onChange={(e) => setPoDate(e.target.value)}
                  required
                />
              </div>
            </div>

            <div>
              <Label htmlFor="po-amount">Amount *</Label>
              <Input
                id="po-amount"
                value={amount}
                onChange={(e) => setAmount(e.target.value)}
                inputMode="decimal"
                placeholder={inquiry?.liveQuotation?.total ?? "0.00"}
                required
              />
              <p className="mt-1 text-xs text-text-muted">
                {/* Not defaulted from the quotation on purpose: the number that matters is the one
                    on the customer's document, and pre-filling it invites nobody to read it. A
                    mismatch is a real thing — module 03 turns it into a discrepancy check. */}
                What the customer&rsquo;s PO says, even if it differs from the quotation.
              </p>
            </div>

            <div>
              <Label htmlFor="po-file">Scanned PO *</Label>
              <Input
                id="po-file"
                type="file"
                accept="application/pdf,image/*"
                required
                onChange={(e) => setFile(e.target.files?.[0] ?? null)}
              />
              <p className="mt-1 text-xs text-text-muted">
                Required. The column means their PO arrived — without the document it is only a
                claim that it did.
              </p>
            </div>

            <div className="flex justify-end gap-2 pt-1">
              <Dialog.Close asChild>
                <Button type="button" variant="ghost">
                  Cancel
                </Button>
              </Dialog.Close>
              <Button
                type="submit"
                disabled={busy || !file || poNumber.trim().length === 0 || !inquiry}
              >
                {busy ? "Recording…" : "Record PO"}
              </Button>
            </div>
          </form>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
