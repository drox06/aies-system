"use client";

import { useSession } from "next-auth/react";
import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Input, Label, Select } from "@/components/ui/input";
import { Menu, MenuItem } from "@/components/ui/menu";
import {
  canAcknowledge,
  humanStatus,
  LOST_REASONS,
  userTransitionsFrom,
} from "@/server/core/crm/inquiry-lifecycle";
import { toastError, toastSuccess } from "@/lib/errors";
import { trpc } from "@/lib/trpc/client";
import type { InquiryDetail } from "./types";

/**
 * The moves §3 allows from here, and nothing else.
 *
 * The list comes from `userTransitionsFrom`, the same map the server enforces, so the buttons and
 * the rules cannot drift apart. `won`, `lost` and `quoted` never appear: §3 says they follow the
 * quotation's outcome, and module 02 sets them through the system-only path.
 */
export function InquiryStatusActions({ inquiry }: { inquiry: InquiryDetail }) {
  const utils = trpc.useUtils();
  const [lostOpen, setLostOpen] = useState(false);
  const [lostReason, setLostReason] = useState<string>(LOST_REASONS[0]);
  const [lostToCompetitor, setLostToCompetitor] = useState("");
  /**
   * "if the inquiry did not call a request for site inspection, the 9 gates should not hold it...
   * pop a prompt that asks if logging the requirements are really not necessary" (2026-09-04). Only
   * reachable when both are true — an inspection was never requested for this inquiry, and the
   * requirements gate is not already satisfied — so a normal, complete inquiry never sees this.
   */
  const [waiverConfirmOpen, setWaiverConfirmOpen] = useState(false);

  const invalidateInquiry = () => {
    void utils.crm.getInquiry.invalidate({ inquiryId: inquiry.id });
    void utils.crm.listInquiries.invalidate();
    void utils.comments.activityFeed.invalidate({
      entityType: "Inquiry",
      entityId: inquiry.id,
    });
  };

  const transition = trpc.crm.transitionInquiry.useMutation({ onSuccess: invalidateInquiry });
  const requestWaiver = trpc.crm.requestQuotingWaiver.useMutation({ onSuccess: invalidateInquiry });

  const needsWaiver = !inquiry.completeness.satisfied && inquiry.inspections.length === 0;

  const options = userTransitionsFrom(inquiry.status);

  // §3's acknowledgement belongs to the person the inquiry was logged for. The server refuses it
  // either way; this only spares them clicking a button that was never going to work, and names the
  // person they should chase instead. `canAcknowledge` is the same function the service calls.
  const { data: session } = useSession();
  const mayAcknowledge =
    !session?.user ||
    canAcknowledge(
      { id: session.user.id, permissions: session.user.permissions },
      { ownerId: inquiry.ownerId },
    );
  const ownerName = inquiry.owner?.name ?? "the assigned salesperson";
  const blockedReason = `${ownerName} is assigned to this inquiry — theirs is the acknowledgement that starts the work.`;

  async function move(to: string) {
    if (to === "quoting" && needsWaiver) {
      setWaiverConfirmOpen(true);
      return;
    }
    try {
      await transition.mutateAsync({ inquiryId: inquiry.id, to: to as "acknowledged" });
      toastSuccess(`Moved to ${humanStatus(to)}.`);
    } catch (error) {
      // The server's message is the useful one — it names the missing requirement, or the reason
      // the move is not allowed from here.
      toastError(error);
    }
  }

  // Reachable from either layout below — "Hand to quotation" can be the sole move (a button) or one
  // of several (in the menu), and this prompt has to appear either way.
  const waiverDialog = waiverConfirmOpen && (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-navy-900/40 p-4">
      <div className="w-full max-w-sm rounded-md border border-border bg-surface p-4 shadow-xl">
        <h2 className="text-sm font-semibold">Skip the requirements?</h2>
        <p className="mt-1 text-xs text-text-muted">
          {inquiry.number} has {inquiry.completeness.missing.length} requirement(s) unanswered
          {inquiry.completeness.missing.length > 0 &&
            ` (${inquiry.completeness.missing.map((m) => m.label).join(", ")})`}
          , and no site inspection was ever requested for it — this looks like a simple purchase and
          delivery. Are you sure logging the requirements really isn&rsquo;t necessary?
        </p>
        {requestWaiver.error && (
          <p className="mt-2 text-sm text-danger">{requestWaiver.error.message}</p>
        )}
        <div className="mt-4 flex justify-end gap-2">
          <Button variant="ghost" size="sm" onClick={() => setWaiverConfirmOpen(false)}>
            No, go back
          </Button>
          <Button
            size="sm"
            disabled={requestWaiver.isPending}
            onClick={async () => {
              try {
                await requestWaiver.mutateAsync({ inquiryId: inquiry.id });
                toastSuccess("Sent to the Vice President and the President for approval.");
                setWaiverConfirmOpen(false);
              } catch (error) {
                toastError(error);
              }
            }}
          >
            Yes, ask for approval
          </Button>
        </div>
      </div>
    </div>
  );

  if (options.length === 0) {
    return <span className="text-xs text-text-muted">No further moves from here.</span>;
  }

  // One move available is a button, not a menu. Acknowledging is the commonest action in the
  // module and burying it behind a dropdown would add a click to the thing the SLA measures.
  if (options.length === 1) {
    const blocked = options[0] === "acknowledged" && !mayAcknowledge;
    return (
      <div className="flex items-center gap-2">
        {blocked && <span className="text-xs text-text-muted">{blockedReason}</span>}
        <Button
          size="sm"
          disabled={transition.isPending || blocked}
          title={blocked ? blockedReason : undefined}
          onClick={() => void move(options[0]!)}
        >
          {labelFor(options[0]!)}
        </Button>
        {waiverDialog}
      </div>
    );
  }

  return (
    <>
      <Menu label="Change this inquiry's status" trigger={<Button size="sm">Move to…</Button>}>
        {options.map((option) => (
          <MenuItem
            key={option}
            disabled={option === "acknowledged" && !mayAcknowledge}
            title={option === "acknowledged" && !mayAcknowledge ? blockedReason : undefined}
            onClick={() => {
              if (option === "lost") setLostOpen(true);
              else void move(option);
            }}
          >
            {labelFor(option)}
          </MenuItem>
        ))}
      </Menu>

      {lostOpen && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-navy-900/40 p-4">
          <div className="w-full max-w-sm rounded-md border border-border bg-surface p-4 shadow-xl">
            <h2 className="text-sm font-semibold">Why was this lost?</h2>
            <p className="mt-1 text-xs text-text-muted">
              Required. Without enforced loss reasons the pipeline report says nothing.
            </p>
            <div className="mt-3">
              <Label htmlFor="lost-reason">Reason</Label>
              <Select
                id="lost-reason"
                value={lostReason}
                onChange={(e) => setLostReason(e.target.value)}
              >
                {LOST_REASONS.map((reason) => (
                  <option key={reason} value={reason}>
                    {reason.replace(/_/g, " ")}
                  </option>
                ))}
              </Select>
            </div>
            <div className="mt-3">
              <Label htmlFor="lost-competitor">Lost to (optional)</Label>
              <Input
                id="lost-competitor"
                value={lostToCompetitor}
                onChange={(e) => setLostToCompetitor(e.target.value)}
              />
            </div>
            <div className="mt-4 flex justify-end gap-2">
              <Button variant="ghost" size="sm" onClick={() => setLostOpen(false)}>
                Cancel
              </Button>
              <Button
                size="sm"
                disabled={transition.isPending}
                onClick={async () => {
                  try {
                    await transition.mutateAsync({
                      inquiryId: inquiry.id,
                      to: "lost",
                      lostReason: lostReason as "price",
                      lostToCompetitor: lostToCompetitor || null,
                    });
                    toastSuccess("Marked lost.");
                    setLostOpen(false);
                  } catch (error) {
                    toastError(error);
                  }
                }}
              >
                Mark lost
              </Button>
            </div>
          </div>
        </div>
      )}

      {waiverDialog}
    </>
  );
}

function labelFor(status: string): string {
  switch (status) {
    case "acknowledged":
      return "Acknowledge";
    case "evaluating":
      return "Start evaluating";
    case "inspection_required":
      return "Needs a site inspection";
    case "quoting":
      return "Hand to quotation";
    case "disqualified":
      return "Disqualify";
    default:
      return humanStatus(status);
  }
}
