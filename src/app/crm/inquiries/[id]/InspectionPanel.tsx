"use client";

import { useState } from "react";
import { Button } from "@/components/ui/button";
import { DateCell } from "@/components/ui/cells";
import { Card } from "@/components/ui/layout";
import { Input, Label, Textarea } from "@/components/ui/input";
import { StatusBadge } from "@/components/ui/status-badge";
import { INSPECTION_OUTPUTS } from "@/server/core/crm/inquiry-lifecycle";
import { toastError, toastSuccess } from "@/lib/errors";
import { trpc } from "@/lib/trpc/client";
import type { InquiryDetail } from "./types";

/**
 * §5's inspection request.
 *
 * "Specific questions to answer" and "required outputs" are the two fields that decide whether the
 * visit was worth making, so they are on the form rather than buried in a notes box. A site visit
 * that comes back with photographs when what was needed was a tag list costs another visit, and in
 * a plant that can mean another month.
 */
export function InspectionPanel({ inquiry }: { inquiry: InquiryDetail }) {
  const utils = trpc.useUtils();
  const [open, setOpen] = useState(false);
  const [purpose, setPurpose] = useState("");
  const [questions, setQuestions] = useState("");
  const [outputs, setOutputs] = useState<string[]>(["photos"]);
  const [windowStart, setWindowStart] = useState("");
  const [windowEnd, setWindowEnd] = useState("");
  const [assignedToId, setAssignedToId] = useState("");
  const [findings, setFindings] = useState("");

  const users = trpc.admin.listUsers.useQuery(undefined, { enabled: open });

  const invalidate = () => {
    void utils.crm.getInquiry.invalidate({ inquiryId: inquiry.id });
    void utils.comments.activityFeed.invalidate({ entityType: "Inquiry", entityId: inquiry.id });
  };

  const request = trpc.crm.requestInspection.useMutation({ onSuccess: invalidate });
  const complete = trpc.crm.completeInspection.useMutation({ onSuccess: invalidate });
  const cancel = trpc.crm.cancelInspection.useMutation({ onSuccess: invalidate });

  const openRequest = inquiry.inspections.find(
    (item) => item.status === "requested" || item.status === "scheduled",
  );

  return (
    <Card className="p-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h2 className="text-sm font-semibold">Site inspection</h2>
        {!openRequest && inquiry.status === "evaluating" && (
          <Button size="sm" variant="ghost" onClick={() => setOpen((v) => !v)}>
            Request an inspection
          </Button>
        )}
      </div>

      {inquiry.inspections.length === 0 && !open && (
        <p className="mt-1 text-sm text-text-muted">
          None requested.{" "}
          {inquiry.status !== "evaluating" &&
            "An inquiry has to be under evaluation before one can be raised."}
        </p>
      )}

      {inquiry.inspections.map((item) => (
        <div key={item.id} className="mt-2 rounded border border-border p-3 text-sm">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <span className="font-medium">{item.purpose}</span>
            <StatusBadge
              tone={
                item.status === "completed"
                  ? "approved"
                  : item.status === "cancelled"
                    ? "cancelled"
                    : "pending"
              }
            >
              {item.status}
            </StatusBadge>
          </div>
          {item.questions && <p className="mt-1 text-xs whitespace-pre-wrap">{item.questions}</p>}
          {item.requiredOutputs.length > 0 && (
            <p className="mt-1 text-xs text-text-muted">
              Bring back: {item.requiredOutputs.join(", ").replace(/_/g, " ")}
            </p>
          )}
          {(item.windowStart || item.windowEnd) && (
            <p className="mt-1 text-xs text-text-muted">
              Window: <DateCell value={item.windowStart} /> – <DateCell value={item.windowEnd} />
            </p>
          )}
          {item.findings && (
            <p className="mt-2 border-t border-border pt-2 text-xs whitespace-pre-wrap">
              <span className="font-medium">Findings:</span> {item.findings}
            </p>
          )}

          {(item.status === "requested" || item.status === "scheduled") && (
            <div className="mt-3 border-t border-border pt-3">
              <Label htmlFor={`findings-${item.id}`}>Findings</Label>
              <Textarea
                id={`findings-${item.id}`}
                rows={2}
                value={findings}
                onChange={(e) => setFindings(e.target.value)}
                placeholder="What the visit established. Module 02 pulls this into the scope of work."
              />
              <div className="mt-2 flex gap-2">
                <Button
                  size="sm"
                  disabled={complete.isPending}
                  onClick={async () => {
                    try {
                      await complete.mutateAsync({
                        inspectionRequestId: item.id,
                        findings: findings || null,
                      });
                      setFindings("");
                      toastSuccess("Inspection completed — the inquiry is back under evaluation.");
                    } catch (error) {
                      toastError(error);
                    }
                  }}
                >
                  Mark completed
                </Button>
                <Button
                  size="sm"
                  variant="ghost"
                  disabled={cancel.isPending}
                  onClick={async () => {
                    try {
                      await cancel.mutateAsync({ inspectionRequestId: item.id });
                      toastSuccess("Inspection cancelled.");
                    } catch (error) {
                      toastError(error);
                    }
                  }}
                >
                  Cancel
                </Button>
              </div>
            </div>
          )}
        </div>
      ))}

      {open && !openRequest && (
        <div className="mt-3 space-y-3 rounded border border-border p-3">
          <div>
            <Label htmlFor="insp-purpose">Purpose *</Label>
            <Input
              id="insp-purpose"
              value={purpose}
              onChange={(e) => setPurpose(e.target.value)}
              placeholder="Confirm line size and tie-in points before quoting"
            />
          </div>
          <div>
            <Label htmlFor="insp-questions">Questions the visit must answer</Label>
            <Textarea
              id="insp-questions"
              rows={2}
              value={questions}
              onChange={(e) => setQuestions(e.target.value)}
            />
          </div>
          <fieldset>
            <legend className="text-sm font-medium">Required outputs</legend>
            <div className="mt-1 flex flex-wrap gap-3">
              {INSPECTION_OUTPUTS.map((output) => (
                <label key={output} className="flex items-center gap-1.5 text-sm">
                  <input
                    type="checkbox"
                    checked={outputs.includes(output)}
                    onChange={(e) =>
                      setOutputs((current) =>
                        e.target.checked
                          ? [...current, output]
                          : current.filter((value) => value !== output),
                      )
                    }
                  />
                  {output.replace(/_/g, " ")}
                </label>
              ))}
            </div>
          </fieldset>
          <div className="grid gap-3 sm:grid-cols-2">
            <div>
              <Label htmlFor="insp-start">Window from</Label>
              <Input
                id="insp-start"
                type="date"
                value={windowStart}
                onChange={(e) => setWindowStart(e.target.value)}
              />
            </div>
            <div>
              <Label htmlFor="insp-end">Window to</Label>
              <Input
                id="insp-end"
                type="date"
                value={windowEnd}
                onChange={(e) => setWindowEnd(e.target.value)}
              />
            </div>
          </div>
          <div>
            <Label htmlFor="insp-assignee">Assign to</Label>
            {/* §5: "Until module 04 exists, the request is a task assigned to a user with a due
                date." Module 04 replaces this with a real scheduled field task. */}
            <select
              id="insp-assignee"
              className="h-9 w-full rounded border border-border bg-surface px-2 text-sm"
              value={assignedToId}
              onChange={(e) => setAssignedToId(e.target.value)}
            >
              <option value="">Nobody yet</option>
              {(users.data ?? []).map((user) => (
                <option key={user.id} value={user.id}>
                  {user.name}
                </option>
              ))}
            </select>
          </div>
          <Button
            size="sm"
            disabled={request.isPending || purpose.trim().length === 0}
            onClick={async () => {
              try {
                await request.mutateAsync({
                  inquiryId: inquiry.id,
                  purpose,
                  questions: questions || null,
                  requiredOutputs: outputs as (typeof INSPECTION_OUTPUTS)[number][],
                  windowStart: windowStart ? new Date(windowStart) : null,
                  windowEnd: windowEnd ? new Date(windowEnd) : null,
                  assignedToId: assignedToId || null,
                });
                toastSuccess("Inspection requested — the acknowledgement clock is paused.");
                setOpen(false);
                setPurpose("");
                setQuestions("");
              } catch (error) {
                toastError(error);
              }
            }}
          >
            Raise request
          </Button>
        </div>
      )}
    </Card>
  );
}
