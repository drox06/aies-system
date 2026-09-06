"use client";

import { useState } from "react";
import { Button } from "@/components/ui/button";
import { DateCell } from "@/components/ui/cells";
import { Input, Label, Textarea } from "@/components/ui/input";
import { Card } from "@/components/ui/layout";
import { toastError, toastSuccess } from "@/lib/errors";
import { trpc } from "@/lib/trpc/client";

/**
 * docs/DECISIONS.md #185 — operations' side of "are we ready to bill this?", for terms 4 through 6.
 *
 * `BillingPanel` covers the same milestones from finance's side, but that panel sits entirely behind
 * `finance.view` and returns nothing to anyone without it — an operations manager opening this same
 * page sees no billing plan at all. This is a separate panel for exactly that reason: it renders only
 * what finance has actually asked about (`billingReadinessForOrder` is scoped to milestones with an
 * open ask), so an order nobody has asked about shows nothing here, the same restraint `BillingPanel`
 * takes with `NoSchedule`.
 */
export function BillingReadinessPanel({ salesOrderId }: { salesOrderId: string }) {
  const utils = trpc.useUtils();
  const readiness = trpc.finance.billingReadinessForOrder.useQuery(
    { salesOrderId },
    { retry: false },
  );

  const onDone = () => {
    void readiness.refetch();
    // Finance's own copy of the same milestone lives in `BillingPanel`, a sibling component with its
    // own query cache — without this, "we can bill this" would look like nothing happened until
    // finance reloads the page.
    void utils.finance.schedule.invalidate({ salesOrderId });
  };

  // Absent for anybody without `project.manage`, same reasoning `BillingPanel` uses for finance.view.
  if (readiness.error || readiness.isPending || readiness.data.length === 0) return null;

  return (
    <Card className="mt-4 p-4">
      <h2 className="text-sm font-semibold">Finance is asking</h2>
      <p className="mt-0.5 text-xs text-text-muted">
        Whether this work is done enough to bill for. Answer from here rather than making finance
        chase you for it.
      </p>

      <ul className="mt-2 space-y-2">
        {readiness.data.map((milestone) => (
          <li key={milestone.id} className="rounded-md border border-border p-2.5">
            <p className="text-sm font-medium">{milestone.label}</p>
            <p className="mt-0.5 text-xs text-text-muted">
              Asked <DateCell value={milestone.readinessAskedAt!} withTime />
              {milestone.readinessRepliedAt &&
                new Date(milestone.readinessRepliedAt) >= new Date(milestone.readinessAskedAt!) && (
                  <>
                    {" "}
                    — last said not ready: {milestone.readinessPercentComplete}% done, expected{" "}
                    <DateCell value={milestone.readinessEstimatedDate!} />.
                    {milestone.readinessNotes && <> {milestone.readinessNotes}</>}
                  </>
                )}
            </p>
            <ReplyReadiness milestoneId={milestone.id} label={milestone.label} onDone={onDone} />
          </li>
        ))}
      </ul>
    </Card>
  );
}

function ReplyReadiness({
  milestoneId,
  label,
  onDone,
}: {
  milestoneId: string;
  label: string;
  onDone: () => void;
}) {
  const [open, setOpen] = useState(false);
  const [percent, setPercent] = useState("");
  const [date, setDate] = useState("");
  const [notes, setNotes] = useState("");

  const reply = trpc.finance.replyMilestoneReadiness.useMutation({
    onSuccess: () => {
      toastSuccess(`Answered for ${label}.`);
      setOpen(false);
      setPercent("");
      setDate("");
      setNotes("");
      onDone();
    },
    onError: toastError,
  });

  if (!open) {
    return (
      <div className="mt-1.5 flex flex-wrap gap-2">
        <Button
          size="sm"
          disabled={reply.isPending}
          onClick={() => reply.mutate({ milestoneId, accomplished: true })}
        >
          {reply.isPending ? "Sending…" : "We can bill this"}
        </Button>
        <Button variant="secondary" size="sm" onClick={() => setOpen(true)}>
          Not yet…
        </Button>
      </div>
    );
  }

  return (
    <div className="mt-1.5 rounded-md border border-border p-2.5">
      <div className="flex gap-2">
        <div className="flex-1">
          <Label htmlFor={`pct-${milestoneId}`}>% done</Label>
          <Input
            id={`pct-${milestoneId}`}
            type="number"
            min={0}
            max={100}
            value={percent}
            onChange={(event) => setPercent(event.target.value)}
          />
        </div>
        <div className="flex-1">
          <Label htmlFor={`eta-${milestoneId}`}>Expected done by</Label>
          <Input
            id={`eta-${milestoneId}`}
            type="date"
            value={date}
            onChange={(event) => setDate(event.target.value)}
          />
        </div>
      </div>
      <Label htmlFor={`notes-${milestoneId}`} className="mt-2">
        Notes
      </Label>
      <Textarea
        id={`notes-${milestoneId}`}
        rows={2}
        value={notes}
        placeholder="What is holding it up."
        onChange={(event) => setNotes(event.target.value)}
      />
      <div className="mt-2 flex flex-wrap gap-2">
        <Button
          size="sm"
          disabled={reply.isPending || !percent || !date}
          onClick={() =>
            reply.mutate({
              milestoneId,
              accomplished: false,
              percentComplete: Number(percent),
              estimatedDate: new Date(date),
              notes: notes.trim() || null,
            })
          }
        >
          Send
        </Button>
        <Button variant="ghost" size="sm" onClick={() => setOpen(false)}>
          Cancel
        </Button>
      </div>
    </div>
  );
}
