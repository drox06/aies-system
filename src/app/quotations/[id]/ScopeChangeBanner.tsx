"use client";

import { useState } from "react";
import Link from "next/link";
import { Button } from "@/components/ui/button";
import { DateCell } from "@/components/ui/cells";
import { Textarea } from "@/components/ui/input";
import { Card } from "@/components/ui/layout";
import { toastError, toastSuccess } from "@/lib/errors";
import { trpc } from "@/lib/trpc/client";

/**
 * A site inspection found the job is bigger than this quotation (module 04 §6.1).
 *
 * This is the *record* half of §6.1's link. The notification that fires alongside it is a nudge,
 * and a nudge on the in-app bell — the only channel with a handler today — is easy to miss. Miss it
 * and, without this banner, nothing would ever surface the finding again: the crew mobilises three
 * weeks later against a quotation nobody revised, which is exactly what §6.1 exists to prevent.
 *
 * So it sits at the top of the record and does not go away until somebody either revises the
 * quotation or says, on the record, why no revision is needed. docs/DECISIONS.md #59.
 */
export function ScopeChangeBanner({
  quotationId,
  flaggedAt,
  notes,
  source,
  inspectionId,
  resolvedAt,
  resolution,
  resolutionNote,
  canAct,
  onResolved,
}: {
  quotationId: string;
  flaggedAt: string | Date | null;
  notes: string | null;
  source: string | null;
  inspectionId: string | null;
  resolvedAt: string | Date | null;
  resolution: string | null;
  resolutionNote: string | null;
  canAct: boolean;
  onResolved: () => void;
}) {
  const [open, setOpen] = useState(false);
  const [reason, setReason] = useState("");

  const dismiss = trpc.quotation.dismissScopeChange.useMutation({
    onSuccess: () => {
      toastSuccess("Recorded. The scope change is closed without a revision.");
      setOpen(false);
      setReason("");
      onResolved();
    },
    onError: toastError,
  });

  if (!flaggedAt) return null;

  /**
   * Resolved, and still shown — quietly.
   *
   * "A survey found extra scope and we absorbed it" is history worth keeping on the document,
   * particularly when the job overruns and somebody asks whether anybody knew. Hiding it the moment
   * it is dealt with would throw away the only record that the decision was ever made.
   */
  if (resolvedAt) {
    return (
      <Card className="p-3">
        <p className="text-xs text-text-muted">
          A site inspection{source ? ` (${source})` : ""} found extra scope on{" "}
          <DateCell value={flaggedAt} />.{" "}
          {resolution === "revised"
            ? "It was answered with a revision."
            : `Closed without a revision — ${resolutionNote ?? "no reason recorded"}.`}
        </p>
      </Card>
    );
  }

  return (
    <Card className="border-amber-400 bg-amber-50 p-4">
      <h2 className="text-sm font-semibold text-amber-900">
        A site inspection found work beyond this quotation
      </h2>

      <p className="mt-1 text-sm text-amber-900">{notes}</p>

      <p className="mt-1 text-xs text-amber-800">
        Flagged <DateCell value={flaggedAt} />
        {source && inspectionId ? (
          <>
            {" "}
            on{" "}
            <Link href={`/inspections/${inspectionId}`} className="underline underline-offset-2">
              {source}
            </Link>
          </>
        ) : source ? (
          <> on {source}</>
        ) : null}
        . This stays here until the quotation is revised, or somebody records why it need not be.
      </p>

      {canAct && !open && (
        <div className="mt-3 flex flex-wrap gap-2">
          {/* No "revise" button here on purpose — the revision control already exists on this page,
              and a second entry point to it is a second thing to keep in step. Revising clears this
              banner automatically. */}
          <Button variant="secondary" size="sm" onClick={() => setOpen(true)}>
            No revision needed
          </Button>
        </div>
      )}

      {open && (
        <div className="mt-3">
          <Textarea
            rows={2}
            placeholder="Why does this need no revision? Absorbed, already covered, surveyor mistaken…"
            value={reason}
            onChange={(e) => setReason(e.target.value)}
          />
          <div className="mt-2 flex gap-2">
            <Button
              size="sm"
              disabled={dismiss.isPending || reason.trim().length < 10}
              onClick={() => dismiss.mutate({ quotationId, reason })}
            >
              Record and close
            </Button>
            <Button variant="ghost" size="sm" onClick={() => setOpen(false)}>
              Cancel
            </Button>
          </div>
        </div>
      )}
    </Card>
  );
}
