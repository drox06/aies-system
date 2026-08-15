"use client";

import { useState } from "react";
import { Button } from "@/components/ui/button";
import { DateCell } from "@/components/ui/cells";
import { Card } from "@/components/ui/layout";
import { Input, Label, Select, Textarea } from "@/components/ui/input";
import { StatusBadge, type StatusTone } from "@/components/ui/status-badge";
import { toastError, toastSuccess } from "@/lib/errors";
import { trpc } from "@/lib/trpc/client";

/**
 * §3's supplier price requests, on the quotation record.
 *
 * The screen follows §3's own numbered sequence, because that is the order the work happens in:
 * raise it against chosen lines → mark it sent when PD emails it → record what came back → apply the
 * costs. Each step is only offered when the one before it is done, so the panel never shows a button
 * that the service is going to refuse.
 *
 * **Copy to clipboard is a first-class action, not a convenience.** §3.2 confirms PD sends these by
 * hand, so the request body is the actual deliverable of raising an RFQ — the app's job ends at
 * producing text good enough to paste into an email without editing.
 */

const RFQ_TONE: Record<string, StatusTone> = {
  draft: "draft",
  sent: "pending",
  responded: "approved",
  declined: "failed",
  expired: "cancelled",
};

export function RfqPanel({
  quotationId,
  quotationCurrency,
  editable,
  canSeeCost,
  lines,
  onApplied,
}: {
  quotationId: string;
  quotationCurrency: string;
  editable: boolean;
  canSeeCost: boolean;
  lines: { lineNo: number; description: string }[];
  onApplied: () => void;
}) {
  const utils = trpc.useUtils();
  const [open, setOpen] = useState(false);
  const [supplierId, setSupplierId] = useState("");
  const [dueBy, setDueBy] = useState("");
  const [notes, setNotes] = useState("");
  const [chosen, setChosen] = useState<number[]>([]);
  const [respondingTo, setRespondingTo] = useState<string | null>(null);
  const [costs, setCosts] = useState<Record<number, string>>({});
  const [leadTimes, setLeadTimes] = useState<Record<number, string>>({});
  const [currency, setCurrency] = useState("PHP");

  // Gated on `supplier_rfq.manage`, so this errors for anyone else. The panel disappears rather
  // than showing controls that will 403 — a salesperson does not raise supplier pricing (§3).
  const suppliers = trpc.quotation.rfqSuppliers.useQuery(undefined, { retry: false });
  const rfqs = trpc.quotation.rfqsForQuotation.useQuery({ quotationId });
  const comparison = trpc.quotation.rfqComparison.useQuery(
    { quotationId },
    // Carries supplier cost, so it is `finance.view_cost`-gated on the server too.
    { retry: false, enabled: canSeeCost },
  );

  const create = trpc.quotation.createRfq.useMutation();
  const markSent = trpc.quotation.markRfqSent.useMutation();
  const record = trpc.quotation.recordRfqResponse.useMutation();
  const apply = trpc.quotation.applyRfq.useMutation();

  const mayManage = !suppliers.error;
  const rows = rfqs.data ?? [];
  if (!mayManage && rows.length === 0) return null;

  const refresh = () => {
    void utils.quotation.rfqsForQuotation.invalidate({ quotationId });
    void utils.quotation.rfqComparison.invalidate({ quotationId });
  };

  const toggle = (lineNo: number) =>
    setChosen((current) =>
      current.includes(lineNo) ? current.filter((n) => n !== lineNo) : [...current, lineNo],
    );

  return (
    <Card className="p-4">
      <h2 className="text-sm font-semibold">Supplier pricing</h2>
      <p className="mt-0.5 text-xs text-text-muted">
        §3&rsquo;s price requests. The app writes the request; PD sends it and records what comes
        back.
      </p>

      {mayManage && editable && (
        <Button variant="ghost" size="sm" className="mt-2" onClick={() => setOpen((o) => !o)}>
          {open ? "Cancel" : "Request supplier pricing"}
        </Button>
      )}

      {open && (
        <div className="mt-3 space-y-3 rounded border border-border p-3">
          <div>
            <Label htmlFor="rfq-supplier">Principal *</Label>
            <Select
              id="rfq-supplier"
              value={supplierId}
              onChange={(e) => setSupplierId(e.target.value)}
            >
              <option value="">Choose…</option>
              {(suppliers.data ?? []).map((supplier) => (
                <option key={supplier.id} value={supplier.id}>
                  {supplier.name}
                  {supplier.productLines.length > 0 ? ` — ${supplier.productLines.join(", ")}` : ""}
                </option>
              ))}
            </Select>
            {(suppliers.data ?? []).length === 0 && (
              <p className="mt-1 text-xs text-text-muted">
                {/* Not an empty dropdown with no explanation: the reason is a business rule, and
                    the fix is somewhere else entirely. */}
                No appointed principals yet. A principal can be asked for pricing once its
                distributor agreement is signed (§5c).
              </p>
            )}
          </div>

          <fieldset>
            <legend className="text-xs font-medium">Lines to ask about</legend>
            <p className="mb-1 text-xs text-text-muted">
              Leave all unticked to ask about every line.
            </p>
            <div className="space-y-1">
              {lines.map((line) => (
                <label key={line.lineNo} className="flex items-start gap-2 text-xs">
                  <input
                    type="checkbox"
                    className="mt-0.5"
                    checked={chosen.includes(line.lineNo)}
                    onChange={() => toggle(line.lineNo)}
                  />
                  <span>
                    <span className="tabular text-text-muted">{line.lineNo}.</span>{" "}
                    {line.description}
                  </span>
                </label>
              ))}
            </div>
          </fieldset>

          <div>
            <Label htmlFor="rfq-due">Response wanted by</Label>
            <Input
              id="rfq-due"
              type="date"
              value={dueBy}
              onChange={(e) => setDueBy(e.target.value)}
            />
          </div>

          <div>
            <Label htmlFor="rfq-notes">Anything else to tell them</Label>
            <Textarea
              id="rfq-notes"
              rows={2}
              className="text-xs"
              value={notes}
              onChange={(e) => setNotes(e.target.value)}
              placeholder="Tolerances, connection type, a site constraint."
            />
          </div>

          <Button
            size="sm"
            disabled={create.isPending || !supplierId}
            onClick={async () => {
              try {
                const rfq = await create.mutateAsync({
                  quotationId,
                  supplierId,
                  sourceLineNos: chosen.length > 0 ? chosen : undefined,
                  dueBy: dueBy ? new Date(dueBy) : null,
                  notes: notes || null,
                });
                toastSuccess(`${rfq.number} drafted. Copy the text and send it.`);
                setOpen(false);
                setSupplierId("");
                setChosen([]);
                setDueBy("");
                setNotes("");
                refresh();
              } catch (error) {
                toastError(error);
              }
            }}
          >
            {create.isPending ? "Drafting…" : "Draft the request"}
          </Button>
        </div>
      )}

      {rows.length > 0 && (
        <ul className="mt-3 space-y-3">
          {rows.map((rfq) => (
            <li key={rfq.id} className="rounded border border-border p-3">
              <div className="flex flex-wrap items-baseline justify-between gap-2">
                <span className="text-sm font-medium">{rfq.number}</span>
                <StatusBadge tone={RFQ_TONE[rfq.status] ?? "draft"}>{rfq.status}</StatusBadge>
              </div>
              <p className="mt-0.5 text-xs text-text-muted">
                {rfq.supplierName} · {rfq.lines.length} line(s)
                {rfq.dueBy && (
                  <>
                    {" "}
                    · due <DateCell value={rfq.dueBy} />
                  </>
                )}
              </p>

              {mayManage && (
                <div className="mt-2 flex flex-wrap gap-2">
                  <Button
                    variant="ghost"
                    size="sm"
                    onClick={async () => {
                      try {
                        await navigator.clipboard.writeText(rfq.requestBody);
                        toastSuccess("Request copied. Paste it into an email.");
                      } catch {
                        toastError(new Error("Your browser would not let the page copy text."));
                      }
                    }}
                  >
                    Copy request
                  </Button>

                  {/* §3.2 asks for both: the body goes in the email, the PDF gets attached. A
                      plain link so the browser handles the download and its filename. */}
                  <Button asChild variant="ghost" size="sm">
                    <a href={`/api/rfqs/${rfq.id}/pdf`} target="_blank" rel="noreferrer">
                      Download PDF
                    </a>
                  </Button>

                  {rfq.status === "draft" && (
                    <Button
                      size="sm"
                      disabled={markSent.isPending}
                      onClick={async () => {
                        try {
                          await markSent.mutateAsync({ rfqId: rfq.id });
                          toastSuccess(`${rfq.number} marked sent. The response clock is running.`);
                          refresh();
                        } catch (error) {
                          toastError(error);
                        }
                      }}
                    >
                      Mark sent
                    </Button>
                  )}

                  {rfq.status === "sent" && (
                    <Button
                      size="sm"
                      onClick={() => {
                        setRespondingTo(respondingTo === rfq.id ? null : rfq.id);
                        setCosts({});
                        setLeadTimes({});
                      }}
                    >
                      {respondingTo === rfq.id ? "Close" : "Record their response"}
                    </Button>
                  )}

                  {rfq.status === "responded" && editable && (
                    <Button
                      size="sm"
                      disabled={apply.isPending}
                      onClick={async () => {
                        try {
                          const result = await apply.mutateAsync({ rfqId: rfq.id });
                          toastSuccess(`Costed ${result.applied} line(s) from ${rfq.number}.`);
                          refresh();
                          onApplied();
                        } catch (error) {
                          toastError(error);
                        }
                      }}
                    >
                      Apply to the quotation
                    </Button>
                  )}
                </div>
              )}

              {respondingTo === rfq.id && (
                <div className="mt-3 space-y-2 border-t border-border pt-3">
                  <div>
                    <Label htmlFor={`cur-${rfq.id}`}>Currency they quoted in</Label>
                    <Select
                      id={`cur-${rfq.id}`}
                      value={currency}
                      onChange={(e) => setCurrency(e.target.value)}
                    >
                      {["PHP", "USD", "EUR"].map((code) => (
                        <option key={code} value={code}>
                          {code}
                        </option>
                      ))}
                    </Select>
                    {currency !== quotationCurrency && (
                      <p className="mt-1 text-xs text-text-muted">
                        {/* Said here rather than sprung at the end. Recording what the supplier
                            quoted is always allowed — it is a fact about the outside world. The
                            exchange rate is only needed to turn it into *our* cost, which is what
                            Apply does. */}
                        Recorded as {currency}. This quotation is in {quotationCurrency}, so an
                        exchange rate is needed before these costs can be applied to it.
                      </p>
                    )}
                  </div>
                  {rfq.lines.map((line) => (
                    <div key={line.id} className="grid gap-2 sm:grid-cols-[1fr_7rem_6rem]">
                      <span className="self-center text-xs">
                        <span className="tabular text-text-muted">{line.lineNo}.</span>{" "}
                        {line.description}
                      </span>
                      <Input
                        aria-label={`Line ${line.lineNo} unit cost`}
                        inputMode="decimal"
                        placeholder="Unit cost"
                        value={costs[line.lineNo] ?? ""}
                        onChange={(e) => setCosts((c) => ({ ...c, [line.lineNo]: e.target.value }))}
                      />
                      <Input
                        aria-label={`Line ${line.lineNo} lead time in days`}
                        inputMode="numeric"
                        placeholder="Days"
                        value={leadTimes[line.lineNo] ?? ""}
                        onChange={(e) =>
                          setLeadTimes((c) => ({ ...c, [line.lineNo]: e.target.value }))
                        }
                      />
                    </div>
                  ))}
                  <Button
                    size="sm"
                    disabled={record.isPending}
                    onClick={async () => {
                      try {
                        const priced = rfq.lines
                          .filter((line) => (costs[line.lineNo] ?? "").trim().length > 0)
                          .map((line) => ({
                            lineNo: line.lineNo,
                            unitCost: costs[line.lineNo]!.trim(),
                            currency,
                            leadTimeDays: leadTimes[line.lineNo]
                              ? Number(leadTimes[line.lineNo])
                              : null,
                          }));
                        if (priced.length === 0) {
                          toastError(new Error("Nothing priced yet."));
                          return;
                        }
                        await record.mutateAsync({
                          rfqId: rfq.id,
                          currency,
                          lines: priced,
                        });
                        toastSuccess(`Recorded ${priced.length} price(s) for ${rfq.number}.`);
                        setRespondingTo(null);
                        refresh();
                      } catch (error) {
                        toastError(error);
                      }
                    }}
                  >
                    Save the response
                  </Button>
                </div>
              )}
            </li>
          ))}
        </ul>
      )}

      {canSeeCost && (comparison.data ?? []).length > 1 && (
        <div className="mt-4 border-t border-border pt-3">
          <h3 className="text-sm font-semibold">Comparison</h3>
          <p className="mt-0.5 text-xs text-text-muted">
            {/* §3.6 asks for cost, lead time and validity side by side. The cheapest is flagged and
                deliberately not chosen — the cheaper offer is often the slower one. */}
            Cheapest is marked, not selected. Lead time is usually the other half of the decision.
          </p>
          <div className="mt-2 overflow-x-auto">
            <table className="w-full text-xs">
              <tbody>
                {(comparison.data ?? []).map((row) => (
                  <tr key={row.sourceLineNo} className="border-t border-border align-top">
                    <td className="py-1.5 pr-3">
                      <span className="tabular text-text-muted">{row.sourceLineNo}.</span>{" "}
                      {row.description}
                    </td>
                    <td className="py-1.5">
                      {row.offers.map((offer) => (
                        <div key={offer.supplierQuoteLineId} className="flex flex-wrap gap-2">
                          <span className="tabular">
                            {offer.currency} {offer.unitCost}
                          </span>
                          <span className="text-text-muted">{offer.supplierName}</span>
                          {offer.leadTimeDays !== null && (
                            <span className="text-text-muted">{offer.leadTimeDays}d</span>
                          )}
                          {offer.isCheapest && <StatusBadge tone="approved">cheapest</StatusBadge>}
                          {offer.isApplied && <StatusBadge tone="active">costed</StatusBadge>}
                        </div>
                      ))}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}
    </Card>
  );
}
