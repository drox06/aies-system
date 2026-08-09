"use client";

import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Input, Label, Select } from "@/components/ui/input";
import { Menu, MenuItem } from "@/components/ui/menu";
import {
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

  const transition = trpc.crm.transitionInquiry.useMutation({
    onSuccess: () => {
      void utils.crm.getInquiry.invalidate({ inquiryId: inquiry.id });
      void utils.crm.listInquiries.invalidate();
      void utils.comments.activityFeed.invalidate({
        entityType: "Inquiry",
        entityId: inquiry.id,
      });
    },
  });

  const options = userTransitionsFrom(inquiry.status);

  async function move(to: string) {
    try {
      await transition.mutateAsync({ inquiryId: inquiry.id, to: to as "acknowledged" });
      toastSuccess(`Moved to ${humanStatus(to)}.`);
    } catch (error) {
      // The server's message is the useful one — it names the missing requirement, or the reason
      // the move is not allowed from here.
      toastError(error);
    }
  }

  if (options.length === 0) {
    return <span className="text-xs text-text-muted">No further moves from here.</span>;
  }

  // One move available is a button, not a menu. Acknowledging is the commonest action in the
  // module and burying it behind a dropdown would add a click to the thing the SLA measures.
  if (options.length === 1) {
    return (
      <Button size="sm" disabled={transition.isPending} onClick={() => void move(options[0]!)}>
        {labelFor(options[0]!)}
      </Button>
    );
  }

  return (
    <>
      <Menu label="Change this inquiry's status" trigger={<Button size="sm">Move to…</Button>}>
        {options.map((option) => (
          <MenuItem
            key={option}
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
