"use client";

import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Input, Label, Textarea } from "@/components/ui/input";
import { StatusBadge } from "@/components/ui/status-badge";
import { toastError, toastSuccess } from "@/lib/errors";
import { trpc } from "@/lib/trpc/client";

/**
 * specs/03-order-procurement.md §3's three-way check, where the person holding the PO is looking.
 *
 * The spec puts unusual weight on this screen: "Discrepancies are surfaced on screen and must be
 * resolved (accept, or raise a quotation revision) before the sales order is created. **This single
 * check prevents the most expensive category of error in this business.**"
 *
 * So the findings are shown *before* anything is written, the note is demanded when there are any,
 * and the button that raises the sales order does not appear until the PO is verified. The check
 * itself lives in po-verification.ts and runs on the server — this component asks for it and shows
 * what came back, so the screen can never disagree with the gate.
 *
 * ## The line quantities
 *
 * `CustomerPO` has no line model — §2 does not give it one — so the only way quantities get compared
 * is somebody reading them off the customer's PDF and typing them in. That is optional, and its
 * absence is stated rather than hidden: a check that quietly passed when nobody typed them would say
 * "verified" about something it never looked at.
 */
export function PoVerification({
  customerPOId,
  poNumber,
  quotationLines,
  status,
  salesOrder,
  onChanged,
}: {
  customerPOId: string;
  poNumber: string;
  /** The quotation's own lines, so the quantity boxes start pre-filled with what was quoted. */
  quotationLines: { lineNo: number; description: string; quantity: string }[];
  status: string;
  salesOrder: { id: string; number: string } | null;
  onChanged: () => void;
}) {
  const utils = trpc.useUtils();
  const [open, setOpen] = useState(false);
  const [note, setNote] = useState("");
  const [quantities, setQuantities] = useState<Record<number, string>>({});

  // Only the lines somebody actually typed a number for. Sending the rest as zero would invent a
  // finding on every line the person had not got to yet.
  const typedLines = quotationLines
    .filter((line) => (quantities[line.lineNo] ?? "").trim() !== "")
    .map((line) => ({
      lineNo: line.lineNo,
      description: line.description,
      quantity: Number(quantities[line.lineNo]),
    }));
  const poLines = typedLines.length > 0 ? typedLines : undefined;

  const check = trpc.order.checkCustomerPo.useQuery(
    { customerPOId, poLines },
    // `customer_po.view` gates it; the whole block disappears for anybody else rather than erroring.
    { retry: false, enabled: open },
  );

  const verify = trpc.order.verifyCustomerPo.useMutation();
  const raise = trpc.order.createSalesOrder.useMutation();

  const refresh = () => {
    void utils.order.forQuotation.invalidate();
    void utils.order.checkCustomerPo.invalidate({ customerPOId });
    onChanged();
  };

  async function handleVerify() {
    try {
      await verify.mutateAsync({ customerPOId, poLines, acceptanceNote: note || null });
      toastSuccess(`PO ${poNumber} verified against the quotation.`);
      setNote("");
      refresh();
    } catch (error) {
      toastError(error);
    }
  }

  async function handleRaise() {
    try {
      const order = await raise.mutateAsync({ customerPOId });
      toastSuccess(`${order.number} raised. The deal is now an obligation.`);
      refresh();
    } catch (error) {
      toastError(error);
    }
  }

  if (salesOrder) {
    // The number and not a link: the sales order screen is session 2's, and a link to a route that
    // does not exist is the dead end this build has now hit six times.
    return (
      <p className="mt-1 flex flex-wrap items-center gap-2 text-xs">
        <StatusBadge tone="approved">Sales order raised</StatusBadge>
        <span className="tabular">{salesOrder.number}</span>
      </p>
    );
  }

  if (!open) {
    return (
      <div className="mt-1 flex flex-wrap items-center gap-2">
        {status === "verified" ? (
          <StatusBadge tone="approved">Verified</StatusBadge>
        ) : (
          <StatusBadge tone="pending">Not verified yet</StatusBadge>
        )}
        <Button size="sm" variant="secondary" onClick={() => setOpen(true)}>
          {status === "verified" ? "Raise sales order" : "Check against the quotation"}
        </Button>
      </div>
    );
  }

  const result = check.data;
  const blocking = result?.discrepancies.filter((d) => d.severity === "blocking") ?? [];
  const advisory = result?.discrepancies.filter((d) => d.severity === "advisory") ?? [];

  return (
    <div className="mt-2 rounded-md border border-border p-3">
      <div className="flex items-start justify-between gap-2">
        <h3 className="text-xs font-semibold">Three-way check</h3>
        <Button size="sm" variant="ghost" onClick={() => setOpen(false)}>
          Close
        </Button>
      </div>

      {check.isPending && <p className="mt-1 text-xs text-text-muted">Comparing…</p>}
      {check.error && (
        <p className="mt-1 text-xs text-text-muted">
          You do not have permission to run this check.
        </p>
      )}

      {result && (
        <>
          <p className="mt-1 text-xs text-text-muted">{result.summary}</p>

          {blocking.length > 0 && (
            <ul className="mt-2 space-y-1">
              {blocking.map((d, index) => (
                <li
                  key={`${d.kind}-${index}`}
                  className="rounded border border-red-300 bg-red-50 p-2 text-xs text-red-900"
                >
                  {d.message}
                </li>
              ))}
            </ul>
          )}

          {advisory.length > 0 && (
            <ul className="mt-2 space-y-1">
              {advisory.map((d, index) => (
                <li
                  key={`${d.kind}-${index}`}
                  className="rounded border border-amber-300 bg-amber-50 p-2 text-xs text-amber-900"
                >
                  {d.message}
                </li>
              ))}
            </ul>
          )}

          {!result.quantitiesChecked && (
            <p className="mt-2 text-xs text-text-muted">
              Line quantities were not compared — the customer&rsquo;s PO is a scan, so they have to
              be read off it. Fill in what their document says and the check reruns.
            </p>
          )}

          {quotationLines.length > 0 && status !== "verified" && (
            <div className="mt-2 space-y-1">
              {quotationLines.map((line) => (
                <div key={line.lineNo} className="flex items-center gap-2">
                  <span className="w-6 text-right text-xs text-text-muted tabular">
                    {line.lineNo}
                  </span>
                  <span className="min-w-0 flex-1 truncate text-xs">{line.description}</span>
                  <span className="text-xs text-text-muted">quoted {line.quantity}</span>
                  <Input
                    aria-label={`Quantity on the PO for line ${line.lineNo}`}
                    className="w-24"
                    inputMode="decimal"
                    placeholder="on the PO"
                    value={quantities[line.lineNo] ?? ""}
                    onChange={(e) =>
                      setQuantities((current) => ({ ...current, [line.lineNo]: e.target.value }))
                    }
                  />
                </div>
              ))}
            </div>
          )}

          {status !== "verified" && (
            <div className="mt-3 space-y-2 border-t border-border pt-3">
              {result.discrepancies.length > 0 && (
                <div>
                  <Label htmlFor={`po-note-${customerPOId}`}>
                    What did the customer actually order, and why is it alright?
                  </Label>
                  <Textarea
                    id={`po-note-${customerPOId}`}
                    rows={2}
                    value={note}
                    onChange={(e) => setNote(e.target.value)}
                    placeholder="They split the award; the balance follows on a second PO."
                  />
                  <p className="mt-0.5 text-xs text-text-muted">
                    Required, and it stays on the record. Six months from now the question is not
                    &ldquo;did somebody check&rdquo; but &ldquo;what did they see&rdquo;.
                  </p>
                </div>
              )}
              <Button
                size="sm"
                onClick={() => void handleVerify()}
                disabled={
                  verify.isPending ||
                  blocking.length > 0 ||
                  (result.discrepancies.length > 0 && note.trim().length < 3)
                }
              >
                {verify.isPending ? "Recording…" : "Verify this PO"}
              </Button>
              {blocking.length > 0 && (
                <p className="text-xs text-text-muted">
                  Raise a quotation revision that covers this, then check again.
                </p>
              )}
            </div>
          )}

          {status === "verified" && (
            <div className="mt-3 border-t border-border pt-3">
              <Button size="sm" onClick={() => void handleRaise()} disabled={raise.isPending}>
                {raise.isPending ? "Raising…" : "Raise the sales order"}
              </Button>
              <p className="mt-1 text-xs text-text-muted">
                This copies the quotation&rsquo;s lines onto an order AIES is committed to deliver.
              </p>
            </div>
          )}
        </>
      )}
    </div>
  );
}
