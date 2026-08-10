"use client";

import { useState } from "react";
import { Button } from "@/components/ui/button";
import { DateCell } from "@/components/ui/cells";
import { Card } from "@/components/ui/layout";
import { Input, Label, Textarea } from "@/components/ui/input";
import { StatusBadge } from "@/components/ui/status-badge";
import { toastError, toastSuccess } from "@/lib/errors";
import { trpc } from "@/lib/trpc/client";

/**
 * §7's issuance, in the two steps the company asked for.
 *
 * The app cannot watch an outbound email (Spec.md §3.4 removed inbound ingest; module 10 owns
 * sending). So the honest sequence is:
 *
 *   1. **Download** — the PDF is produced and the record says who has it. Changes no status.
 *   2. **Confirm sent** — a person asserts it reached the customer, with the date it actually went.
 *      That is what moves the inquiry to `quoted`.
 *
 * The download log below is the audit trail, not a separate store — see the activity feed on this
 * page for the full history with timestamps.
 */
export function IssuancePanel({
  quotationId,
  status,
  canSeeCost,
  downloadedAt,
  downloadedByName,
  downloadCount,
  sentAt,
  onChanged,
}: {
  quotationId: string;
  status: string;
  canSeeCost: boolean;
  downloadedAt: string | null;
  downloadedByName: string | null;
  downloadCount: number;
  sentAt: string | null;
  onChanged: () => void;
}) {
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [sentOn, setSentOn] = useState(() => new Date().toISOString().slice(0, 10));
  const [note, setNote] = useState("");

  const confirmSent = trpc.quotation.confirmSent.useMutation();

  const isApproved = status === "approved";
  const isSent = status === "sent" || status === "under_negotiation";

  // A plain link, not fetch(): the browser's own download handling gives the file its name from
  // Content-Disposition and puts it where the user expects. The route records the download.
  const pdfHref = `/api/quotations/${quotationId}/pdf`;

  return (
    <Card className="p-4">
      <h2 className="text-sm font-semibold">Issuing</h2>

      {!isApproved && !isSent && (
        <p className="mt-1 text-sm text-text-muted">
          A quotation has to be approved before it can be issued. §6 allows no exceptions.
        </p>
      )}

      <div className="mt-2 flex flex-wrap gap-2">
        <Button asChild variant={isApproved && !downloadedAt ? "primary" : "secondary"} size="sm">
          {/* Opens in a new tab so the builder is not navigated away from mid-edit. */}
          <a
            href={pdfHref}
            target="_blank"
            rel="noreferrer"
            onClick={() => setTimeout(onChanged, 1500)}
          >
            Download PDF
          </a>
        </Button>
        {canSeeCost && (
          <Button asChild variant="ghost" size="sm">
            <a href={`${pdfHref}?variant=internal`} target="_blank" rel="noreferrer">
              Costing sheet
            </a>
          </Button>
        )}
      </div>

      {/* The state the company named: downloaded, by whom, ready to send. */}
      <div className="mt-3 text-sm">
        {isSent ? (
          <p className="text-text-muted">
            <StatusBadge tone="approved">Sent</StatusBadge>{" "}
            {sentAt && (
              <>
                on <DateCell value={sentAt} />
              </>
            )}
          </p>
        ) : downloadedAt ? (
          <p className="text-text-muted">
            <StatusBadge tone="pending">Ready for sending</StatusBadge> Downloaded by{" "}
            <span className="font-medium">{downloadedByName ?? "someone"}</span>{" "}
            <DateCell value={downloadedAt} withTime />
            {downloadCount > 1 && (
              // Downloaded repeatedly and still not sent is worth surfacing, not hiding.
              <span className="ml-1">· {downloadCount} downloads</span>
            )}
          </p>
        ) : (
          <p className="text-text-muted">Not downloaded yet.</p>
        )}
      </div>

      {isApproved && downloadedAt && !confirmOpen && (
        <Button size="sm" className="mt-3" onClick={() => setConfirmOpen(true)}>
          Confirm sent to customer
        </Button>
      )}

      {confirmOpen && (
        <div className="mt-3 rounded border border-border p-3">
          <Label htmlFor="sent-on">Date it was actually sent</Label>
          <Input
            id="sent-on"
            type="date"
            value={sentOn}
            max={new Date().toISOString().slice(0, 10)}
            onChange={(e) => setSentOn(e.target.value)}
          />
          {/* People send on Friday and confirm on Monday; the customer's validity clock runs from
              the former, so the date is asked for rather than assumed. */}
          <p className="mt-0.5 text-xs text-text-muted">
            Not necessarily today — the customer&apos;s validity period runs from this date.
          </p>

          <div className="mt-2">
            <Label htmlFor="sent-note">Note (optional)</Label>
            <Textarea
              id="sent-note"
              rows={2}
              value={note}
              onChange={(e) => setNote(e.target.value)}
              placeholder="Sent from EA's Outlook to procurement@…"
            />
          </div>

          <div className="mt-2 flex gap-2">
            <Button
              size="sm"
              disabled={confirmSent.isPending}
              onClick={async () => {
                try {
                  const result = await confirmSent.mutateAsync({
                    quotationId,
                    sentAt: new Date(sentOn),
                    note: note || null,
                  });
                  toastSuccess(
                    result.inquiryNumber
                      ? `Recorded as sent. ${result.inquiryNumber} moves to quoted.`
                      : "Recorded as sent.",
                  );
                  setConfirmOpen(false);
                  setNote("");
                  onChanged();
                } catch (error) {
                  toastError(error);
                }
              }}
            >
              {confirmSent.isPending ? "Recording…" : "Confirm sent"}
            </Button>
            <Button size="sm" variant="ghost" onClick={() => setConfirmOpen(false)}>
              Cancel
            </Button>
          </div>
        </div>
      )}

      <p className="mt-3 text-xs text-text-muted">
        The PDF is attached to your own email client. This app cannot see that it was sent, so the
        confirmation above is what moves the inquiry to quoted — and anything downloaded but never
        confirmed is chased after two days.
      </p>
    </Card>
  );
}
