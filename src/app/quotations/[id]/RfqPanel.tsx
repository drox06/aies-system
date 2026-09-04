"use client";

import { useEffect, useState } from "react";
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
  version,
  quotationCurrency,
  quotationFxRate,
  editable,
  canSeeCost,
  lines,
  onApplied,
}: {
  quotationId: string;
  version: number;
  quotationCurrency: string;
  quotationFxRate: string;
  editable: boolean;
  canSeeCost: boolean;
  lines: { lineNo: number; description: string }[];
  onApplied: () => void;
}) {
  const utils = trpc.useUtils();
  const [open, setOpen] = useState(false);
  /**
   * Which lines each principal is being asked about.
   *
   * A map rather than one shared list, because that is the company's actual purchasing pattern:
   * "make it so, that a line item is requested to a selected supplier." Sending every line to every
   * supplier produced exactly the mess they hit — each came back having priced its own item and
   * written a zero against the other, on a document that showed a manufacturer an item they do not
   * sell.
   *
   * An empty array against a supplier means "ask about everything", which is the right default for
   * the common single-supplier job.
   */
  const [asks, setAsks] = useState<Record<string, number[]>>({});
  const [dueBy, setDueBy] = useState("");
  const [notes, setNotes] = useState("");
  const [respondingTo, setRespondingTo] = useState<string | null>(null);
  const [costs, setCosts] = useState<Record<number, string>>({});
  const [leadTimes, setLeadTimes] = useState<Record<number, string>>({});
  const [currency, setCurrency] = useState("PHP");
  const [fxRateDraft, setFxRateDraft] = useState(quotationFxRate);
  // Re-seeds after a save, so the field shows what was stored — same reasoning as TermsPanel's
  // `clauses` effect, and for the same practical reason: it must reflect a save made moments ago,
  // not the value the panel was born with.
  useEffect(() => setFxRateDraft(quotationFxRate), [quotationFxRate]);

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
  const setFxRate = trpc.quotation.updateHeader.useMutation();

  const mayManage = !suppliers.error;
  const rows = rfqs.data ?? [];
  if (!mayManage && rows.length === 0) return null;

  const refresh = () => {
    void utils.quotation.rfqsForQuotation.invalidate({ quotationId });
    void utils.quotation.rfqComparison.invalidate({ quotationId });
  };

  const supplierIds = Object.keys(asks);

  const toggleSupplier = (supplierId: string) =>
    setAsks((current) => {
      if (!(supplierId in current)) return { ...current, [supplierId]: [] };
      const next = { ...current };
      delete next[supplierId];
      return next;
    });

  const toggleLine = (supplierId: string, lineNo: number) =>
    setAsks((current) => {
      const chosen = current[supplierId] ?? [];
      return {
        ...current,
        [supplierId]: chosen.includes(lineNo)
          ? chosen.filter((n) => n !== lineNo)
          : [...chosen, lineNo],
      };
    });

  return (
    <Card className="p-4">
      <h2 className="text-sm font-semibold">Supplier pricing</h2>
      <p className="mt-0.5 text-xs text-text-muted">
        §3&rsquo;s price requests. The app writes the request; PD sends it and records what comes
        back.
      </p>

      {/* A supplier's price is only ever recorded in the currency they quoted in — converting it
          into this quotation's currency needs a rate, and until now there was nowhere in the app to
          set one. `applyRfqToQuotationService` refused rather than guess, correctly, but the
          refusal pointed at a field with no screen — the company hit exactly that wall: "it says
          apply FX rate, but it is already applied and entered in the line," which was the *line's*
          own `costFxRate` (a different, output field this action overwrites) being mistaken for the
          quotation's own rate, because the real one had never been visible anywhere. */}
      {editable && rows.some((rfq) => rfq.currency && rfq.currency !== quotationCurrency) && (
        <div className="mt-2 rounded border border-warning/40 bg-warning/10 p-2.5">
          <p className="text-xs text-warning">
            A supplier quoted in a different currency than {quotationCurrency}. Set the exchange
            rate here before applying their price — this is what every apply and comparison action
            on this quotation uses to convert it.
          </p>
          <div className="mt-1.5 flex flex-wrap items-center gap-2">
            <Label htmlFor="rfq-fx-rate" className="text-xs">
              1 foreign unit = this many {quotationCurrency}
            </Label>
            <Input
              id="rfq-fx-rate"
              inputMode="decimal"
              className="w-24"
              value={fxRateDraft}
              onChange={(e) => setFxRateDraft(e.target.value)}
            />
            <Button
              size="sm"
              variant="secondary"
              disabled={setFxRate.isPending || fxRateDraft.trim().length === 0}
              onClick={async () => {
                try {
                  await setFxRate.mutateAsync({
                    quotationId,
                    version,
                    fxRate: fxRateDraft.trim(),
                  });
                  toastSuccess(`Exchange rate set to ${fxRateDraft.trim()}.`);
                  onApplied();
                } catch (error) {
                  toastError(error);
                }
              }}
            >
              Save rate
            </Button>
          </div>
        </div>
      )}

      {mayManage && editable && (
        // Primary, not ghost, at the company's request — and it is right on the merits. Spec.md
        // §6.3 makes blue the weight for "every primary action", and on a quotation with no
        // supplier pricing yet this is *the* action: nothing can be costed until somebody asks.
        // It drops back to ghost once requests exist, so it stops competing with them.
        <Button
          variant={rows.length === 0 ? "primary" : "ghost"}
          size="sm"
          className="mt-2"
          onClick={() => setOpen((o) => !o)}
        >
          {open ? "Cancel" : "Request supplier pricing"}
        </Button>
      )}

      {open && (
        <div className="mt-3 space-y-3 rounded border border-border p-3">
          <fieldset>
            {/* Supplier and lines together, one block each, rather than two independent lists.
                Two lists could only express "these lines to all of these suppliers", which is what
                sent a valve manufacturer a request for a flowmeter and came back with a zero. */}
            <legend className="text-xs font-medium">Who to ask, and about what *</legend>
            <p className="mb-2 text-xs text-text-muted">
              Tick a principal, then tick the lines that principal actually supplies. Each gets its
              own request and none of them is told about the others.
            </p>

            <div className="space-y-2">
              {(suppliers.data ?? []).map((supplier) => {
                const selected = supplier.id in asks;
                const chosen = asks[supplier.id] ?? [];
                return (
                  <div
                    key={supplier.id}
                    className={
                      selected
                        ? "rounded border border-blue-400 bg-surface-2 p-2"
                        : "rounded border border-border p-2"
                    }
                  >
                    <label className="flex items-start gap-2 text-xs">
                      <input
                        type="checkbox"
                        className="mt-0.5"
                        checked={selected}
                        onChange={() => toggleSupplier(supplier.id)}
                      />
                      <span>
                        <span className="font-medium">{supplier.name}</span>
                        {supplier.productLines.length > 0 && (
                          <span className="text-text-muted">
                            {" "}
                            — {supplier.productLines.join(", ")}
                          </span>
                        )}
                      </span>
                    </label>

                    {selected && (
                      <div className="mt-1.5 ml-5 space-y-1 border-l border-border pl-2">
                        <p className="text-xs text-text-muted">
                          {chosen.length === 0
                            ? "Asking about every line. Tick some to narrow it."
                            : `Asking about ${chosen.length} of ${lines.length} lines.`}
                        </p>
                        {lines.map((line) => (
                          <label key={line.lineNo} className="flex items-start gap-2 text-xs">
                            <input
                              type="checkbox"
                              className="mt-0.5"
                              checked={chosen.includes(line.lineNo)}
                              onChange={() => toggleLine(supplier.id, line.lineNo)}
                            />
                            <span>
                              <span className="tabular text-text-muted">{line.lineNo}.</span>{" "}
                              {line.description}
                            </span>
                          </label>
                        ))}
                      </div>
                    )}
                  </div>
                );
              })}
            </div>

            {(suppliers.data ?? []).length === 0 && (
              <p className="mt-1 text-xs text-text-muted">
                {/* Not an empty list with no explanation: the reason is a business rule, and
                    the fix is somewhere else entirely. */}
                No appointed principals yet. A principal can be asked for pricing once its
                distributor agreement is signed (§5c).
              </p>
            )}
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
            disabled={create.isPending || supplierIds.length === 0}
            onClick={async () => {
              try {
                const result = await create.mutateAsync({
                  quotationId,
                  asks: supplierIds.map((supplierId) => ({
                    supplierId,
                    // Empty means every line, which the service reads the same way.
                    sourceLineNos:
                      (asks[supplierId] ?? []).length > 0 ? asks[supplierId] : undefined,
                  })),
                  dueBy: dueBy ? new Date(dueBy) : null,
                  notes: notes || null,
                });
                toastSuccess(
                  result.created.length === 1
                    ? `${result.created[0]!.number} drafted. Copy the text and send it.`
                    : `${result.created.length} requests drafted: ${result.created
                        .map((r) => r.number)
                        .join(", ")}.`,
                );
                // Partial success is reported rather than hidden: the drafted ones are real
                // documents and the failed ones need a different fix.
                for (const failure of result.failed) {
                  toastError(new Error(failure.reason));
                }
                setOpen(false);
                setAsks({});
                setDueBy("");
                setNotes("");
                refresh();
              } catch (error) {
                toastError(error);
              }
            }}
          >
            {create.isPending
              ? "Drafting…"
              : supplierIds.length > 1
                ? `Draft ${supplierIds.length} requests`
                : "Draft the request"}
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

              {/* The state the company got stuck in: a response recorded, prices sitting on the
                  request, and the quotation lines still uncosted with nothing on screen saying so.
                  Uncontested prices now carry across on save, so this only appears when there is a
                  genuine choice to make — and then it says which line and where to make it. */}
              {rfq.status === "responded" && !rfq.appliedToQuotation && (
                <p className="mt-1 rounded bg-warning/10 px-2 py-1 text-xs text-warning">
                  Priced, but not yet on the quotation
                  {rfq.pricedLineNos.length > 0 && ` (line ${rfq.pricedLineNos.join(", ")})`}.
                  Another supplier has also priced it — choose one in the comparison below, or apply
                  this whole request.
                </p>
              )}

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
                        const result = await record.mutateAsync({
                          rfqId: rfq.id,
                          currency,
                          lines: priced,
                        });

                        // Recording and costing used to be two buttons, and the second one gave no
                        // sign it was waiting — so a recorded price sat on the request and never
                        // reached the quotation. Uncontested prices are now carried straight to the
                        // lines, and the toast says exactly what happened to each.
                        if (result.autoApplied.length > 0) {
                          toastSuccess(
                            `Recorded, and line ${result.autoApplied.join(", ")} costed from this ` +
                              `supplier. Check the margin panel.`,
                          );
                          onApplied();
                        } else {
                          toastSuccess(`Recorded ${priced.length} price(s) for ${rfq.number}.`);
                        }
                        if (result.awaitingChoice.length > 0) {
                          toastSuccess(
                            `Line ${result.awaitingChoice.join(", ")} has more than one offer — ` +
                              `pick one in the comparison below.`,
                          );
                        }
                        if (result.notCarriedReason) {
                          toastError(new Error(result.notCarriedReason));
                        }
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

      {/**
       * Shown as soon as *anything* has been priced.
       *
       * This used to read `.length > 1`, which looks like "more than one supplier" and is not:
       * `comparison.data` holds **one row per quotation line**, so the panel only appeared once two
       * different lines had offers. A one-line job with three manufacturers competing — the exact
       * case §3.6 exists for — never showed it, and the company reported the panel as appearing
       * "sometimes". It was deterministic; the condition was just measuring the wrong thing.
       */}
      {canSeeCost && (comparison.data ?? []).length > 0 && (
        <div className="mt-4 border-t border-border pt-3">
          <h3 className="text-sm font-semibold">Comparison</h3>
          <p className="mt-0.5 text-xs text-text-muted">
            {/* §3.6 asks for cost, lead time and validity side by side. The cheapest is flagged and
                deliberately not chosen — the cheaper offer is often the slower one. */}
            Cheapest is marked, not selected. Lead time is usually the other half of the decision.
            {editable && " Cost each line from whichever supplier suits it."}
          </p>
          <div className="mt-2 overflow-x-auto">
            {/* One table row per *offer*, not a nested stack inside a cell.

                The old shape put every offer for a line into one cell as free-flowing flex rows, so
                each offer's "Use this" landed wherever that offer's text happened to end — after a
                lead time on one, after a "cheapest" badge on another. The company saw exactly that:
                two suppliers on one line, one button apparently aligned and the other missing until
                something below it moved. Real columns cannot do that: every offer gets the same
                slots, and the action column is always there even when it holds a badge instead. */}
            <table className="w-full text-xs">
              <thead>
                <tr className="text-left text-text-muted">
                  <th className="py-1 pr-3 font-medium">Line</th>
                  <th className="py-1 pr-3 font-medium">Supplier</th>
                  <th className="py-1 pr-3 text-right font-medium">Unit cost</th>
                  <th className="py-1 pr-3 text-right font-medium">Lead time</th>
                  <th className="py-1 pr-3 font-medium"> </th>
                  <th className="py-1 font-medium"> </th>
                </tr>
              </thead>
              <tbody>
                {(comparison.data ?? []).flatMap((row) =>
                  row.offers.map((offer, index) => (
                    <tr
                      key={offer.supplierQuoteLineId}
                      // Only the first offer of a line draws the divider, so the offers for one
                      // line read as a group rather than as unrelated rows.
                      className={index === 0 ? "border-t border-border" : undefined}
                    >
                      <td className="py-1.5 pr-3 align-top">
                        {/* The line is named once and then left blank, so the eye groups the
                            competing offers instead of re-reading the description each time. */}
                        {index === 0 && (
                          <>
                            <span className="tabular text-text-muted">{row.sourceLineNo}.</span>{" "}
                            {row.description}
                          </>
                        )}
                      </td>
                      <td className="py-1.5 pr-3 align-top">{offer.supplierName}</td>
                      <td className="tabular py-1.5 pr-3 text-right align-top">
                        {offer.currency} {offer.unitCost}
                      </td>
                      <td className="tabular py-1.5 pr-3 text-right align-top text-text-muted">
                        {offer.leadTimeDays !== null ? `${offer.leadTimeDays}d` : "—"}
                      </td>
                      <td className="py-1.5 pr-3 align-top">
                        {offer.isCheapest && row.offers.length > 1 && (
                          <StatusBadge tone="approved">cheapest</StatusBadge>
                        )}
                      </td>
                      <td className="py-1.5 text-right align-top whitespace-nowrap">
                        {offer.isApplied ? (
                          <StatusBadge tone="active">costed</StatusBadge>
                        ) : (
                          editable && (
                            // One line, one supplier. The whole-RFQ Apply above is still the
                            // right action when a single manufacturer supplies the job; this is
                            // for the job that is three manufacturers, where applying an RFQ
                            // wholesale would overwrite a line another supplier already won.
                            <Button
                              variant="ghost"
                              size="sm"
                              className="h-6 px-1.5"
                              disabled={apply.isPending}
                              onClick={async () => {
                                try {
                                  await apply.mutateAsync({
                                    rfqId: offer.rfqId,
                                    lineNos: [offer.rfqLineNo],
                                  });
                                  toastSuccess(
                                    `Line ${row.sourceLineNo} costed from ${offer.supplierName}.`,
                                  );
                                  refresh();
                                  onApplied();
                                } catch (error) {
                                  toastError(error);
                                }
                              }}
                            >
                              Use this
                            </Button>
                          )
                        )}
                      </td>
                    </tr>
                  )),
                )}
              </tbody>
            </table>
          </div>
        </div>
      )}
    </Card>
  );
}
