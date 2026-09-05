"use client";

import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/layout";
import { Input, Label, Select } from "@/components/ui/input";
import { LOST_REASONS } from "@/server/core/crm/inquiry-lifecycle";
import { toastError, toastSuccess } from "@/lib/errors";
import { trpc } from "@/lib/trpc/client";
import { NegotiationPanel } from "./NegotiationPanel";
import { QuotationPoPanel } from "./QuotationPoPanel";

/**
 * §8's single decision point once a quotation reaches the customer: what did they say?
 *
 * Customer PO and Negotiation used to sit on the screen as two permanently-visible blocks the
 * moment a quotation was sent — before anyone had actually said what the customer did with it. This
 * routes through the reply first (approved / rejected, and if rejected, declined outright or still
 * negotiable), and only then surfaces the block that answer calls for. Neither existing block lost
 * anything: recording a PO and running a negotiation still work exactly as before once routed to —
 * `hideEntryUntilApproved`/`hideEntryUntilRouted` only withhold their very first entry point, and
 * only while the quotation is freshly `sent` with no reply recorded yet. The moment either panel has
 * real history of its own (a PO, a round logged, a negotiation under way), it shows regardless.
 *
 * The choice itself is not stored anywhere — there is no status between "sent" and an actual PO or
 * an actual rejection, because none is needed. "Approved" only means "go open the PO form"; the
 * decision that counts is the PO landing, which is what really moves the record on.
 */
export function CustomerReplyPanel({
  quotationId,
  quotationNumber,
  status,
  currency,
  canSeeCost,
  quotationLines,
  onChanged,
}: {
  quotationId: string;
  quotationNumber: string;
  status: string;
  currency: string;
  canSeeCost: boolean;
  quotationLines: { lineNo: number; description: string; quantity: string }[];
  onChanged: () => void;
}) {
  const [choice, setChoice] = useState<"approved" | "rejected" | null>(null);
  const [rejectedChoice, setRejectedChoice] = useState<"declined" | "negotiation" | null>(null);
  const [lostReason, setLostReason] = useState<string>(LOST_REASONS[0]);
  const [competitor, setCompetitor] = useState("");

  const reject = trpc.quotation.recordRejection.useMutation();

  // Once the status moves on its own — negotiating, accepted, rejected, anything else — the reply
  // is a known fact, and the two panels below take over on their own existing terms.
  const awaitingReply = status === "sent";

  return (
    <>
      {awaitingReply && choice === null && (
        <Card className="p-4">
          <h2 className="text-sm font-semibold">Record customer reply</h2>
          <p className="mt-0.5 text-xs text-text-muted">With the customer. What did they say?</p>
          <div className="mt-2 flex flex-wrap gap-2">
            <Button size="sm" onClick={() => setChoice("approved")}>
              Quotation approved
            </Button>
            <Button variant="secondary" size="sm" onClick={() => setChoice("rejected")}>
              Quotation rejected
            </Button>
          </div>
        </Card>
      )}

      {awaitingReply && choice === "rejected" && rejectedChoice === null && (
        <Card className="p-4">
          <h2 className="text-sm font-semibold">Record customer reply</h2>
          <p className="mt-0.5 text-xs text-text-muted">
            Rejected outright, or is there still room to negotiate?
          </p>
          <div className="mt-2 flex flex-wrap gap-2">
            <Button variant="destructive" size="sm" onClick={() => setRejectedChoice("declined")}>
              Declined
            </Button>
            <Button size="sm" onClick={() => setRejectedChoice("negotiation")}>
              Negotiation
            </Button>
          </div>
          <Button variant="ghost" size="sm" className="mt-1" onClick={() => setChoice(null)}>
            Back
          </Button>
        </Card>
      )}

      {awaitingReply && rejectedChoice === "declined" && (
        <Card className="p-4">
          <h2 className="text-sm font-semibold">Why was it declined?</h2>
          <div className="mt-2 space-y-2">
            <div>
              <Label htmlFor="reply-reason">Reason</Label>
              <Select
                id="reply-reason"
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
              <Label htmlFor="reply-competitor">Lost to (optional)</Label>
              <Input
                id="reply-competitor"
                value={competitor}
                onChange={(e) => setCompetitor(e.target.value)}
              />
            </div>
            <div className="flex gap-2">
              <Button variant="ghost" size="sm" onClick={() => setRejectedChoice(null)}>
                Back
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
                    onChanged();
                  } catch (error) {
                    toastError(error);
                  }
                }}
              >
                Record it
              </Button>
            </div>
          </div>
        </Card>
      )}

      <QuotationPoPanel
        quotationId={quotationId}
        quotationNumber={quotationNumber}
        status={status}
        currency={currency}
        quotationLines={quotationLines}
        onRecorded={onChanged}
        hideEntryUntilApproved={awaitingReply && choice !== "approved"}
      />

      <NegotiationPanel
        quotationId={quotationId}
        status={status}
        currency={currency}
        canSeeCost={canSeeCost}
        onChanged={onChanged}
        hideEntryUntilRouted={awaitingReply && rejectedChoice !== "negotiation"}
      />
    </>
  );
}
