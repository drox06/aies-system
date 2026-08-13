"use client";

import { useState } from "react";
import { Button } from "@/components/ui/button";
import { DateCell } from "@/components/ui/cells";
import { Card } from "@/components/ui/layout";
import { Input, Label, Select, Textarea } from "@/components/ui/input";
import { StatusBadge } from "@/components/ui/status-badge";
import { LOST_REASONS } from "@/server/core/crm/inquiry-lifecycle";
import { formatMoney } from "@/lib/format";
import { toastError, toastSuccess } from "@/lib/errors";
import { trpc } from "@/lib/trpc/client";

/**
 * §8's negotiation, on the quotation record.
 *
 * §8 quotes the company: *"if not we leave room for negotiations."* AIES quotes expecting to be
 * pushed, so this is not an exception panel — it is where a live quotation spends its most important
 * week.
 *
 * The what-if calculator sits **above** the round log on purpose. The question a salesperson has
 * while the customer is still on the phone is "what does 700k do to us?", and the answer has to be
 * one keystroke away; writing the round up is what happens afterwards.
 */
export function NegotiationPanel({
  quotationId,
  status,
  currency,
  canSeeCost,
  onChanged,
}: {
  quotationId: string;
  status: string;
  currency: string;
  canSeeCost: boolean;
  onChanged: () => void;
}) {
  const utils = trpc.useUtils();
  const [target, setTarget] = useState("");
  const [mode, setMode] = useState<"total" | "discount">("total");
  const [position, setPosition] = useState("");
  const [response, setResponse] = useState("");
  const [agreedTotal, setAgreedTotal] = useState("");
  const [declining, setDeclining] = useState(false);
  const [lostReason, setLostReason] = useState<string>(LOST_REASONS[0]);
  const [competitor, setCompetitor] = useState("");

  const rounds = trpc.quotation.negotiationRounds.useQuery({ quotationId });
  const whatIf = trpc.quotation.whatIf.useQuery(
    {
      quotationId,
      ...(mode === "total" ? { targetTotal: target } : { targetDiscountPct: target }),
    },
    // Only once there is a number to price, and only for somebody who may see margin — the answer
    // *is* a margin figure.
    { enabled: canSeeCost && target.trim().length > 0, retry: false },
  );

  const start = trpc.quotation.startNegotiation.useMutation();
  const logRound = trpc.quotation.logNegotiationRound.useMutation();
  const reject = trpc.quotation.recordRejection.useMutation();

  const isLive = status === "sent" || status === "under_negotiation";
  const negotiating = status === "under_negotiation";
  const list = rounds.data ?? [];

  if (!isLive && list.length === 0) return null;

  const refresh = () => {
    void utils.quotation.negotiationRounds.invalidate({ quotationId });
    onChanged();
  };

  return (
    <Card className="p-4">
      <h2 className="text-sm font-semibold">Negotiation</h2>

      {status === "sent" && (
        <>
          <p className="mt-0.5 text-xs text-text-muted">
            With the customer. Open a negotiation when they come back on the price.
          </p>
          <Button
            size="sm"
            className="mt-2"
            disabled={start.isPending}
            onClick={async () => {
              try {
                await start.mutateAsync({ quotationId });
                toastSuccess("Under negotiation.");
                refresh();
              } catch (error) {
                toastError(error);
              }
            }}
          >
            Open a negotiation
          </Button>
        </>
      )}

      {canSeeCost && negotiating && (
        <div className="mt-3 rounded border border-border p-3">
          <h3 className="text-xs font-semibold">What if we sold it for…</h3>
          <div className="mt-2 grid gap-2 sm:grid-cols-[8rem_1fr]">
            <Select
              aria-label="What-if mode"
              value={mode}
              onChange={(e) => setMode(e.target.value as "total" | "discount")}
            >
              <option value="total">Target total</option>
              <option value="discount">Discount %</option>
            </Select>
            <Input
              aria-label="Target"
              inputMode="decimal"
              value={target}
              onChange={(e) => setTarget(e.target.value)}
              placeholder={mode === "total" ? "700000" : "7.5"}
            />
          </div>

          {whatIf.data && (
            <dl className="mt-3 grid grid-cols-2 gap-x-4 gap-y-1 text-xs sm:grid-cols-4">
              <Figure label="Total">{formatMoney(whatIf.data.targetTotal, currency)}</Figure>
              <Figure label="Discount">
                {formatMoney(whatIf.data.discountAmount, currency)} ({whatIf.data.discountPct}%)
              </Figure>
              <Figure label="Margin">{formatMoney(whatIf.data.marginAmount, currency)}</Figure>
              <Figure label="Margin %">{whatIf.data.marginPct ?? "—"}%</Figure>
            </dl>
          )}

          {whatIf.data?.belowFloor && (
            <p className="mt-2 rounded border border-danger/40 bg-danger/5 p-2 text-xs">
              Below the {whatIf.data.marginFloorPct}% floor
              {whatIf.data.linesBelowFloor.length > 0 && (
                <>
                  {" "}
                  — line{whatIf.data.linesBelowFloor.length > 1 ? "s" : ""}{" "}
                  {whatIf.data.linesBelowFloor.join(", ")}
                </>
              )}
              .
            </p>
          )}

          {whatIf.data?.needsReapproval && (
            <p className="mt-2 text-xs text-text-muted">
              {/* §8: "If it does, the UI offers to raise the approval request in place." The offer
                  is a revision rather than a button that edits a sent document — §5 makes that
                  immutable, and the revision is what carries the new price back through §6. */}
              Taking this price means revising the quotation: a sent one is immutable (§5), and the
              revision goes back to the Vice President for approval (§6). Use{" "}
              <strong>Create a revision</strong> below, with the reason <em>price negotiation</em>.
            </p>
          )}

          {whatIf.error && <p className="mt-2 text-xs text-text-muted">{whatIf.error.message}</p>}
        </div>
      )}

      {negotiating && (
        <div className="mt-3 space-y-2 rounded border border-border p-3">
          <h3 className="text-xs font-semibold">Log a round</h3>
          <div>
            <Label htmlFor="neg-position">What they asked for</Label>
            <Textarea
              id="neg-position"
              rows={2}
              className="text-xs"
              value={position}
              onChange={(e) => setPosition(e.target.value)}
              placeholder="In their words where you can — it is what the next round argues against."
            />
          </div>
          <div>
            <Label htmlFor="neg-response">What we said back</Label>
            <Textarea
              id="neg-response"
              rows={2}
              className="text-xs"
              value={response}
              onChange={(e) => setResponse(e.target.value)}
            />
          </div>
          <div>
            <Label htmlFor="neg-total">Where the price landed (optional)</Label>
            <Input
              id="neg-total"
              inputMode="decimal"
              value={agreedTotal}
              onChange={(e) => setAgreedTotal(e.target.value)}
            />
          </div>
          <Button
            size="sm"
            disabled={logRound.isPending || !position.trim() || !response.trim()}
            onClick={async () => {
              try {
                await logRound.mutateAsync({
                  quotationId,
                  customerPosition: position,
                  aiesResponse: response,
                  agreedTotal: agreedTotal.trim() || null,
                });
                toastSuccess("Round logged.");
                setPosition("");
                setResponse("");
                setAgreedTotal("");
                refresh();
              } catch (error) {
                toastError(error);
              }
            }}
          >
            Log it
          </Button>
        </div>
      )}

      {list.length > 0 && (
        <ol className="mt-3 space-y-2 border-t border-border pt-3">
          {list.map((round) => (
            <li key={round.id} className="text-xs">
              <p className="font-medium">
                Round {round.roundNo}
                {round.agreedTotal && (
                  <span className="tabular ml-2 font-normal">
                    {formatMoney(round.agreedTotal, currency)}
                  </span>
                )}
              </p>
              <p className="text-text-muted">
                <DateCell value={round.occurredAt} /> · {round.authorisedByLabel}
              </p>
              <p className="mt-0.5">
                <span className="text-text-muted">They:</span> {round.customerPosition}
              </p>
              <p>
                <span className="text-text-muted">Us:</span> {round.aiesResponse}
              </p>
            </li>
          ))}
        </ol>
      )}

      {isLive && (
        <div className="mt-3 border-t border-border pt-3">
          {!declining ? (
            <Button variant="ghost" size="sm" onClick={() => setDeclining(true)}>
              The customer declined…
            </Button>
          ) : (
            <div className="space-y-2">
              <div>
                <Label htmlFor="neg-reason">Why did we lose it?</Label>
                <Select
                  id="neg-reason"
                  value={lostReason}
                  onChange={(e) => setLostReason(e.target.value)}
                >
                  {LOST_REASONS.map((reason) => (
                    <option key={reason} value={reason}>
                      {reason.replace(/_/g, " ")}
                    </option>
                  ))}
                </Select>
                <p className="mt-1 text-xs text-text-muted">
                  {/* The same picklist module 01 uses for a lost inquiry — one vocabulary, so the
                      win/loss report can be trusted. */}
                  The same list a lost inquiry uses, so both aggregate into one report.
                </p>
              </div>
              <div>
                <Label htmlFor="neg-competitor">Lost to (optional)</Label>
                <Input
                  id="neg-competitor"
                  value={competitor}
                  onChange={(e) => setCompetitor(e.target.value)}
                />
              </div>
              <div className="flex gap-2">
                <Button variant="ghost" size="sm" onClick={() => setDeclining(false)}>
                  Cancel
                </Button>
                <Button
                  size="sm"
                  disabled={reject.isPending}
                  onClick={async () => {
                    try {
                      await reject.mutateAsync({
                        quotationId,
                        lostReason: lostReason as (typeof LOST_REASONS)[number],
                        competitor: competitor || null,
                      });
                      toastSuccess("Recorded as declined.");
                      setDeclining(false);
                      refresh();
                    } catch (error) {
                      toastError(error);
                    }
                  }}
                >
                  Record it
                </Button>
              </div>
            </div>
          )}
        </div>
      )}

      {status === "rejected" && (
        <div className="mt-2">
          <StatusBadge tone="failed">Declined by the customer</StatusBadge>
        </div>
      )}
    </Card>
  );
}

function Figure({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div>
      <dt className="text-text-muted">{label}</dt>
      <dd className="tabular mt-0.5">{children}</dd>
    </div>
  );
}
