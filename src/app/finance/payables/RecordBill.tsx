"use client";

import { useMemo, useState } from "react";
import { Button } from "@/components/ui/button";
import { Input, Label, Select, Textarea } from "@/components/ui/input";
import { Card } from "@/components/ui/layout";
import { formatMoney } from "@/lib/format";
import { toastError, toastSuccess } from "@/lib/errors";
import { trpc } from "@/lib/trpc/client";

/**
 * Keying a supplier's bill — the entry half of §7, which did not exist until 2026-08-20.
 *
 * ## Why this was missing, and why that mattered
 *
 * `recordSupplierInvoiceService` was written with its three-way match, its duplicate refusal and
 * twenty tests, and **nothing ever called it**. The payables screen could approve a bill and had no
 * way to record one, so §7's entire purpose — catching a supplier billing for more than they sent —
 * was unreachable by a person. The company found it by trying to walk it.
 *
 * Third time in one module: docs/DECISIONS.md #128 named the shape after §11's warranty gate, and
 * #131 found it again in §6's P&L. The check is a question, asked of every figure and every rule:
 * **who types this, and where?**
 *
 * ## The shape of the form
 *
 * The purchase order is chosen first, because it is what decides everything else — the currency, the
 * expected amount, and whether a match can run at all. Picking it fills the amount in as a
 * **suggestion the person can overwrite**, which is the point: a bill that agrees with the order goes
 * through in one keystroke, and one that does not requires deliberately typing a different number.
 *
 * A bill with no order is allowed and says so plainly. §7 reports it rather than refusing — the goods
 * may genuinely have arrived — but never silently, because an invoice with no purchase order is how
 * clause 8.4 gets bypassed after the fact.
 */
export function RecordBill({ onRecorded }: { onRecorded: () => void }) {
  const [open, setOpen] = useState(false);
  const suppliers = trpc.finance.billableSuppliers.useQuery(undefined, { enabled: open });

  const [supplierId, setSupplierId] = useState("");
  const [supplierPOId, setSupplierPOId] = useState("");
  const [supplierRef, setSupplierRef] = useState("");
  const [invoiceDate, setInvoiceDate] = useState(() => new Date().toISOString().slice(0, 10));
  const [dueDate, setDueDate] = useState("");
  const [amount, setAmount] = useState("");
  const [vatAmount, setVatAmount] = useState("");
  const [notes, setNotes] = useState("");

  const supplier = useMemo(
    () => suppliers.data?.find((row) => row.id === supplierId) ?? null,
    [suppliers.data, supplierId],
  );
  const order = useMemo(
    () => supplier?.orders.find((row) => row.id === supplierPOId) ?? null,
    [supplier, supplierPOId],
  );

  const record = trpc.finance.recordSupplierInvoice.useMutation({
    onSuccess: (result) => {
      /*
        The match result, said out loud at the moment of recording.

        A toast saying only "recorded" would make somebody go and find the row to learn whether it
        matched — and the whole reason the check runs here rather than on read is that its answer
        belongs to this moment.
      */
      if (result.match.matched) {
        toastSuccess(`${result.number} recorded and matched against the order and receipts.`);
      } else {
        toastError(
          new Error(
            `${result.number} recorded, but it does not match: ` +
              result.match.findings.map((finding) => finding.note).join(" "),
          ),
        );
      }
      reset();
      onRecorded();
    },
    onError: toastError,
  });

  function reset() {
    setOpen(false);
    setSupplierId("");
    setSupplierPOId("");
    setSupplierRef("");
    setInvoiceDate(new Date().toISOString().slice(0, 10));
    setDueDate("");
    setAmount("");
    setVatAmount("");
    setNotes("");
  }

  /** Picking the order fills the amount in, because agreeing with it is the common case. */
  function chooseOrder(id: string) {
    setSupplierPOId(id);
    const picked = supplier?.orders.find((row) => row.id === id);
    if (picked && amount.trim() === "") setAmount(Number(picked.total).toFixed(2));
  }

  if (!open) {
    return (
      <Button className="mt-4" size="sm" onClick={() => setOpen(true)}>
        Record a supplier bill
      </Button>
    );
  }

  const parsedAmount = Number(amount);
  const canSubmit =
    supplierId !== "" &&
    supplierRef.trim().length > 0 &&
    invoiceDate !== "" &&
    Number.isFinite(parsedAmount) &&
    parsedAmount > 0;

  return (
    <Card className="mt-4 p-4">
      <h2 className="text-sm font-semibold">Record a supplier bill</h2>
      <p className="mt-0.5 text-xs text-text-muted">
        It is checked against the order and what was received as soon as it is recorded.
      </p>

      <div className="mt-3 grid gap-3 sm:grid-cols-2">
        <div className="sm:col-span-2">
          <Label htmlFor="sb-supplier">Supplier</Label>
          <Select
            id="sb-supplier"
            value={supplierId}
            onChange={(event) => {
              setSupplierId(event.target.value);
              setSupplierPOId("");
            }}
          >
            <option value="">Choose a supplier…</option>
            {suppliers.data?.map((row) => (
              <option key={row.id} value={row.id}>
                {row.name}
                {row.paymentTerms ? ` · ${row.paymentTerms}` : ""}
              </option>
            ))}
          </Select>
          {suppliers.isPending && (
            <p className="mt-1 text-xs text-text-muted">Loading suppliers…</p>
          )}
          {suppliers.data?.length === 0 && (
            <p className="mt-1 text-xs text-text-muted">
              No supplier has an order that has been sent, so there is nothing a bill could answer
              yet.
            </p>
          )}
        </div>

        {supplier && (
          <div className="sm:col-span-2">
            <Label htmlFor="sb-po">Against which order</Label>
            <Select
              id="sb-po"
              value={supplierPOId}
              onChange={(event) => chooseOrder(event.target.value)}
            >
              <option value="">No purchase order — recorded and flagged</option>
              {supplier.orders.map((row) => (
                <option key={row.id} value={row.id}>
                  {row.number} · {formatMoney(row.total, row.currency)} · {row.status}
                  {Number(row.alreadyBilled) > 0
                    ? ` · ${formatMoney(row.alreadyBilled, row.currency)} already billed`
                    : ""}
                </option>
              ))}
            </Select>
            {supplierPOId === "" && (
              <p className="mt-1 text-xs text-amber-700">
                A bill with no purchase order is recorded, not refused — the goods may have arrived.
                It is flagged, because this is how an unapproved purchase gets in after the fact.
              </p>
            )}
            {order && Number(order.alreadyBilled) > 0 && (
              <p className="mt-1 text-xs text-amber-700">
                {formatMoney(order.alreadyBilled, order.currency)} has already been billed against{" "}
                {order.number}. The same goods under a second reference will not be caught as a
                duplicate.
              </p>
            )}
          </div>
        )}

        <div>
          <Label htmlFor="sb-ref">Their invoice number</Label>
          <Input
            id="sb-ref"
            value={supplierRef}
            placeholder="LVS-INV-88221"
            onChange={(event) => setSupplierRef(event.target.value)}
          />
          <p className="mt-1 text-xs text-text-muted">
            Theirs, as printed. Every follow-up call quotes it rather than ours.
          </p>
        </div>

        <div>
          <Label htmlFor="sb-amount">Amount</Label>
          <Input
            id="sb-amount"
            type="number"
            step="0.01"
            min="0"
            value={amount}
            onChange={(event) => setAmount(event.target.value)}
          />
          {order && amount !== "" && Number(amount) !== Number(order.total) && (
            <p className="mt-1 text-xs text-amber-700">
              {order.number} was {formatMoney(order.total, order.currency)}. This will be recorded
              as disputed, with the difference written down.
            </p>
          )}
        </div>

        <div>
          <Label htmlFor="sb-invoiced">Invoice date</Label>
          <Input
            id="sb-invoiced"
            type="date"
            value={invoiceDate}
            onChange={(event) => setInvoiceDate(event.target.value)}
          />
        </div>

        <div>
          <Label htmlFor="sb-due">Due date</Label>
          <Input
            id="sb-due"
            type="date"
            value={dueDate}
            onChange={(event) => setDueDate(event.target.value)}
          />
          <p className="mt-1 text-xs text-text-muted">
            Left blank if their invoice does not state one — the list says so rather than inventing
            a date.
          </p>
        </div>

        <div>
          <Label htmlFor="sb-vat">Input VAT</Label>
          <Input
            id="sb-vat"
            type="number"
            step="0.01"
            min="0"
            value={vatAmount}
            onChange={(event) => setVatAmount(event.target.value)}
          />
          <p className="mt-1 text-xs text-text-muted">
            Blank means nobody has recorded it, which is not the same as an invoice with no VAT on
            it.
          </p>
        </div>

        <div className="sm:col-span-2">
          <Label htmlFor="sb-notes">Notes</Label>
          <Textarea
            id="sb-notes"
            rows={2}
            value={notes}
            onChange={(event) => setNotes(event.target.value)}
          />
        </div>
      </div>

      <div className="mt-3 flex gap-2">
        <Button
          size="sm"
          disabled={!canSubmit || record.isPending}
          onClick={() =>
            record.mutate({
              supplierId,
              supplierPOId: supplierPOId === "" ? null : supplierPOId,
              supplierRef: supplierRef.trim(),
              invoiceDate: new Date(invoiceDate),
              dueDate: dueDate === "" ? null : new Date(dueDate),
              amount: parsedAmount,
              vatAmount: vatAmount.trim() === "" ? null : Number(vatAmount),
              currency: order?.currency ?? supplier?.currency ?? "PHP",
              notes: notes.trim() === "" ? null : notes.trim(),
            })
          }
        >
          {record.isPending ? "Recording…" : "Record it"}
        </Button>
        <Button variant="ghost" size="sm" onClick={reset}>
          Discard
        </Button>
      </div>
    </Card>
  );
}
