"use client";

import { useState } from "react";
import { Button } from "@/components/ui/button";
import { DateCell } from "@/components/ui/cells";
import { Card } from "@/components/ui/layout";
import { Textarea } from "@/components/ui/input";
import { StatusBadge } from "@/components/ui/status-badge";
import { toastError, toastSuccess } from "@/lib/errors";
import { trpc } from "@/lib/trpc/client";

/**
 * §6's approval, on the record.
 *
 * Three audiences share this panel and each needs a different thing from it:
 *
 *   - the **preparer** needs one button ("Submit for approval") and, after a rejection, the comment
 *     that says what to change — which is why the rejection reason is shown here rather than only
 *     in the activity feed;
 *   - the **approver** needs to decide without leaving the record they are reading;
 *   - **everybody** needs to see who decided, when, and whether it was Spec.md §4.4's fallback. A
 *     fallback approval that reads like an ordinary one is precisely what §4.4 forbids.
 *
 * Whether the current viewer may decide is answered by the server (`approvalState.canDecide`), not
 * guessed from a role here. The rule lives in an `ApprovalRule` row and can be retuned without a
 * deploy; a permission check hard-coded in this component would not follow it.
 */
export function ApprovalPanel({
  quotationId,
  status,
  rejectionReason,
  onChanged,
}: {
  quotationId: string;
  status: string;
  rejectionReason: string | null;
  onChanged: () => void;
}) {
  const [comment, setComment] = useState("");
  const [rejecting, setRejecting] = useState(false);

  const state = trpc.quotation.approvalState.useQuery({ quotationId });
  const submit = trpc.quotation.submitForApproval.useMutation();
  const decide = trpc.quotation.decideApproval.useMutation();
  const utils = trpc.useUtils();

  const refresh = () => {
    void utils.quotation.approvalState.invalidate({ quotationId });
    void utils.quotation.approvalQueue.invalidate();
    onChanged();
  };

  const isDraft = status === "draft";
  const isPending = status === "pending_approval";
  const canDecide = isPending && (state.data?.canDecide ?? false);
  const history = state.data?.history ?? [];

  return (
    <Card className="p-4">
      <h2 className="text-sm font-semibold">Approval</h2>
      <p className="mt-0.5 text-xs text-text-muted">
        The Vice President approves every quotation, whatever its value. Nothing can be issued
        without it.
      </p>

      {isDraft && (
        <>
          {rejectionReason && (
            <p className="mt-3 rounded border border-warn/40 bg-warn/5 p-2 text-xs">
              <span className="font-medium">Sent back:</span> {rejectionReason}
            </p>
          )}
          <Button
            size="sm"
            className="mt-3"
            disabled={submit.isPending}
            onClick={async () => {
              try {
                await submit.mutateAsync({ quotationId });
                toastSuccess("Sent to the Vice President for approval.");
                refresh();
              } catch (error) {
                toastError(error);
              }
            }}
          >
            {submit.isPending ? "Submitting…" : "Submit for approval"}
          </Button>
        </>
      )}

      {isPending && (
        <div className="mt-3">
          <StatusBadge tone="pending">Waiting on the Vice President</StatusBadge>
          {state.data?.fallbackAvailableAt && (
            <p className="mt-2 text-xs text-text-muted">
              {/* Working-calendar arithmetic, done on the server. A reader should not have to
                  work out which day 24 working hours from Friday afternoon lands on. */}
              If still undecided by <DateCell value={state.data.fallbackAvailableAt} withTime />, it
              also appears in the President&rsquo;s queue and either may decide it.
            </p>
          )}

          {canDecide && (
            <div className="mt-3 space-y-2">
              {state.data?.wouldBeFallback && (
                <p className="text-xs text-text-muted">
                  You would be deciding as the fallback approver. It is recorded as such.
                </p>
              )}
              {rejecting && (
                <Textarea
                  aria-label="Why is this being sent back?"
                  rows={3}
                  className="text-xs"
                  value={comment}
                  onChange={(e) => setComment(e.target.value)}
                  placeholder="What needs to change? The preparer sees this."
                />
              )}
              <div className="flex flex-wrap gap-2">
                <Button
                  size="sm"
                  disabled={decide.isPending}
                  onClick={async () => {
                    try {
                      const result = await decide.mutateAsync({
                        quotationId,
                        decision: "approved",
                      });
                      toastSuccess(
                        result.isFallback
                          ? "Approved, recorded as a fallback approval."
                          : "Approved.",
                      );
                      setRejecting(false);
                      refresh();
                    } catch (error) {
                      toastError(error);
                    }
                  }}
                >
                  Approve
                </Button>
                <Button
                  size="sm"
                  variant="ghost"
                  disabled={decide.isPending}
                  onClick={async () => {
                    // Two clicks, because the comment is mandatory and a disabled button with no
                    // explanation is worse than asking for the reason first.
                    if (!rejecting) {
                      setRejecting(true);
                      return;
                    }
                    try {
                      await decide.mutateAsync({
                        quotationId,
                        decision: "rejected",
                        comment,
                      });
                      toastSuccess("Sent back to draft.");
                      setComment("");
                      setRejecting(false);
                      refresh();
                    } catch (error) {
                      toastError(error);
                    }
                  }}
                >
                  {rejecting ? "Send back" : "Send back…"}
                </Button>
              </div>
            </div>
          )}
        </div>
      )}

      {history.length > 0 && (
        <ol className="mt-4 space-y-2 border-t border-border pt-3">
          {history.map((request) => (
            <li key={request.id} className="text-xs">
              <p className="text-text-muted">
                Submitted by {request.requestedByLabel},{" "}
                <DateCell value={request.requestedAt} withTime />
              </p>
              {request.actions.map((action) => (
                <p key={action.id} className="mt-0.5">
                  <span className="font-medium">
                    {action.decision === "approved" ? "Approved" : "Sent back"}
                  </span>{" "}
                  by {action.approverLabel}
                  {action.isFallback && (
                    <span className="ml-1 text-text-muted">(fallback approver)</span>
                  )}
                  , <DateCell value={action.at} withTime />
                  {action.comment && (
                    <span className="block text-text-muted">{action.comment}</span>
                  )}
                </p>
              ))}
            </li>
          ))}
        </ol>
      )}
    </Card>
  );
}
