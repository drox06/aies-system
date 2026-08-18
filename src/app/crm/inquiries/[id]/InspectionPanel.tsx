"use client";

import { useState } from "react";
import { Attachments } from "@/components/ui/attachments";
import { SITE_INSPECTION_ENTITY_TYPE } from "@/server/core/operations/site-inspection-rules";
import { Button } from "@/components/ui/button";
import { DateCell } from "@/components/ui/cells";
import { Card } from "@/components/ui/layout";
import { Input, Label, Select, Textarea } from "@/components/ui/input";
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
  const [dueAt, setDueAt] = useState("");
  const [findings, setFindings] = useState("");
  /**
   * Which plant the technician is being sent to.
   *
   * Defaults to the plant the inquiry came from, which is the answer nine times out of ten — and is
   * why the company asked for the plant on intake as well: "so that the technician assigned will
   * know which plant to go to for the inspection." It stays changeable because the visit is not
   * always to the plant that raised the question.
   */
  const [inspectionSiteId, setInspectionSiteId] = useState(inquiry.siteId ?? "");

  const sites = trpc.crm.listSites.useQuery(
    { accountId: inquiry.accountId ?? "" },
    { enabled: Boolean(inquiry.accountId) },
  );

  // Not gated on `open`. That flag belongs to the raise-a-new-request form, so gating the query on
  // it meant the assignee list was never fetched for an *existing* request — the dropdown on the
  // assignment row showed nothing but "Choose…" no matter who was eligible.
  const assignees = trpc.crm.inspectionAssignees.useQuery();

  const invalidate = () => {
    void utils.crm.getInquiry.invalidate({ inquiryId: inquiry.id });
    void utils.comments.activityFeed.invalidate({ entityType: "Inquiry", entityId: inquiry.id });
  };

  const request = trpc.crm.requestInspection.useMutation({ onSuccess: invalidate });
  const assign = trpc.crm.assignInspection.useMutation({ onSuccess: invalidate });
  const complete = trpc.crm.completeInspection.useMutation({ onSuccess: invalidate });
  const cancel = trpc.crm.cancelInspection.useMutation({ onSuccess: invalidate });

  /**
   * The surveys these requests produced. Read so the panel can show the **site inspection's own**
   * attachments rather than a second bucket of its own.
   */
  const surveys = trpc.operations.listInspections.useQuery({ inquiryId: inquiry.id });

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
          <AssignmentRow
            request={item}
            assignees={assignees.data ?? []}
            busy={assign.isPending}
            onAssign={async (userId, due) => {
              try {
                await assign.mutateAsync({
                  inspectionRequestId: item.id,
                  assignedToId: userId,
                  dueAt: due,
                });
                toastSuccess("Assigned — they have been notified.");
              } catch (error) {
                toastError(error);
              }
            }}
          />
          {/* Where, on the request itself. The person who opens this is usually the person driving
              there, and a visit whose destination lives only in somebody's memory is the failure
              §5 is trying to remove. */}
          {(() => {
            const site = (sites.data ?? []).find((s) => s.id === item.siteId);
            if (!site) return null;
            return (
              <p className="mt-1 text-xs">
                <span className="font-medium">{site.name}</span>
                {site.accessNotes && (
                  <span className="mt-0.5 block rounded bg-surface-2 p-1.5 text-text-muted">
                    Getting in: {site.accessNotes}
                  </span>
                )}
              </p>
            );
          })()}

          {item.requiredOutputs.length > 0 && (
            <p className="mt-1 text-xs text-text-muted">
              Bring back: {item.requiredOutputs.join(", ").replace(/_/g, " ")}
            </p>
          )}

          {/* What the visit actually brought back. §5 lists "photos, tag list, measurements" as the
              required outputs and the panel has been asking for them since session 2 with nowhere
              to put them — a request that names its deliverables and cannot receive them is a form,
              not a record. Photographs show as thumbnails and open full-size in place: a site photo
              you have to download before you can see it is one nobody looks at. */}
          {/*
            The survey's own photographs, mirrored here rather than asked for twice. Until 2026-08-17
            this panel had its own `InspectionRequest` bucket and the surveyor's report had another,
            so a site photo had to be uploaded in both places to be visible in both — which meant one
            of the two was always the stale copy. Same entity, same files, two screens.
          */}
          {(surveys.data ?? [])
            .filter((survey) => survey.inspectionRequestId === item.id)
            .map((survey) => (
              <div key={survey.id} className="mt-2 border-t border-border pt-2">
                <Attachments
                  entityType={SITE_INSPECTION_ENTITY_TYPE}
                  entityId={survey.id}
                  label={`Photographs from ${survey.number}`}
                  hint="The surveyor's own upload — the same files the report shows. Nothing to re-upload."
                  emptyText="The surveyor has not attached anything yet."
                />
              </div>
            ))}

          <div className="mt-2 border-t border-border pt-2">
            <Attachments
              entityType="InspectionRequest"
              entityId={item.id}
              label="Photos and findings from the visit"
              hint={
                item.requiredOutputs.includes("photos")
                  ? "Photographs open full size here. Everything else downloads."
                  : undefined
              }
              emptyText="Nothing has come back from this visit yet."
              accept="image/*,video/*,.pdf,.xlsx,.csv,.docx"
              // §7.2's higher ceiling, for the case it names by hand: site video.
              category="operations"
              canUpload={item.status !== "cancelled"}
            />
          </div>
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
          {(sites.data ?? []).length > 0 && (
            <div>
              <Label htmlFor="insp-site">Which plant is the visit to?</Label>
              <Select
                id="insp-site"
                value={inspectionSiteId}
                onChange={(e) => setInspectionSiteId(e.target.value)}
              >
                <option value="">Not decided</option>
                {(sites.data ?? []).map((site) => (
                  <option key={site.id} value={site.id}>
                    {site.name}
                  </option>
                ))}
              </Select>
              {/* §2 puts gate pass, PPE and induction on the site for exactly this moment: the
                  person being sent needs to read them before they leave, not at the gate. */}
              {(() => {
                const chosen = (sites.data ?? []).find((s) => s.id === inspectionSiteId);
                return chosen?.accessNotes ? (
                  <p className="mt-1 rounded bg-surface-2 p-1.5 text-xs">
                    <span className="font-medium">Getting in:</span> {chosen.accessNotes}
                  </p>
                ) : null;
              })()}
            </div>
          )}

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
          {/* §5: "Until module 04 exists, the request is a task assigned to a user with a due
              date." Both halves are here — module 04 replaces them with a scheduled field task. */}
          <div className="grid gap-3 sm:grid-cols-2">
            <div>
              <Label htmlFor="insp-assignee">Assign to</Label>
              <Select
                id="insp-assignee"
                value={assignedToId}
                onChange={(e) => setAssignedToId(e.target.value)}
              >
                <option value="">Nobody yet</option>
                {(assignees.data ?? []).map((user) => (
                  <option key={user.id} value={user.id}>
                    {user.name}
                    {user.isTechnical ? " — field" : ""}
                  </option>
                ))}
              </Select>
              <p className="mt-0.5 text-xs text-text-muted">
                They are notified immediately, with the purpose and what to bring back.
              </p>
            </div>
            <div>
              <Label htmlFor="insp-due">Needed by</Label>
              <Input
                id="insp-due"
                type="date"
                value={dueAt}
                onChange={(e) => setDueAt(e.target.value)}
              />
            </div>
          </div>
          <Button
            size="sm"
            disabled={request.isPending || purpose.trim().length === 0}
            onClick={async () => {
              try {
                await request.mutateAsync({
                  inquiryId: inquiry.id,
                  siteId: inspectionSiteId || null,
                  purpose,
                  questions: questions || null,
                  requiredOutputs: outputs as (typeof INSPECTION_OUTPUTS)[number][],
                  windowStart: windowStart ? new Date(windowStart) : null,
                  windowEnd: windowEnd ? new Date(windowEnd) : null,
                  assignedToId: assignedToId || null,
                  dueAt: dueAt ? new Date(dueAt) : null,
                });
                toastSuccess("Inspection requested — the acknowledgement clock is paused.");
                setOpen(false);
                setPurpose("");
                setQuestions("");
                setDueAt("");
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

/**
 * Who is going, and by when — on every request, with a way to change it.
 *
 * An open inspection with nobody assigned is the state §5 is trying to prevent, so it says so
 * plainly rather than showing an empty field. Reassignment notifies the new person; the previous
 * holder is not told, deliberately.
 */
function AssignmentRow({
  request,
  assignees,
  busy,
  onAssign,
}: {
  request: {
    id: string;
    status: string;
    assignedToId: string | null;
    dueAt: string | Date | null;
  };
  assignees: { id: string; name: string; isTechnical: boolean }[];
  busy: boolean;
  onAssign: (userId: string, dueAt: Date | null) => Promise<void>;
}) {
  const [editing, setEditing] = useState(false);
  const [userId, setUserId] = useState(request.assignedToId ?? "");
  const [due, setDue] = useState(
    request.dueAt ? new Date(request.dueAt).toISOString().slice(0, 10) : "",
  );

  const assignedName = assignees.find((a) => a.id === request.assignedToId)?.name ?? null;
  const closed = request.status === "completed" || request.status === "cancelled";

  return (
    <div className="mt-1.5 text-xs">
      <span className={assignedName ? "text-text-muted" : "text-warning"}>
        {assignedName ? (
          <>
            Assigned to <span className="font-medium">{assignedName}</span>
            {request.dueAt && (
              <>
                {" "}
                · needed by <DateCell value={request.dueAt} />
              </>
            )}
          </>
        ) : (
          "Nobody is assigned to this visit yet."
        )}
      </span>
      {!closed && (
        <Button
          size="sm"
          // Blue while nobody is going, ghost once somebody is. Spec.md §6.3 makes blue the UI
          // primary for "every primary action", and on an unassigned request this *is* the action:
          // a raised inspection with no name against it means the visit is not happening, and the
          // inquiry's SLA clock is paused behind it. Reassigning is housekeeping, so it drops back
          // to ghost rather than competing for attention at the same weight.
          //
          // The orange stays on the sentence rather than moving onto the button — §6.3 reserves it
          // for "needs your attention" indicators, not for calls to action.
          variant={assignedName ? "ghost" : "primary"}
          className="ml-2"
          onClick={() => setEditing((v) => !v)}
        >
          {assignedName ? "Reassign" : "Assign"}
        </Button>
      )}

      {editing && !closed && (
        <div className="mt-2 grid gap-2 sm:grid-cols-[1fr_9rem_auto]">
          <Select aria-label="Assign to" value={userId} onChange={(e) => setUserId(e.target.value)}>
            <option value="">Choose…</option>
            {assignees.map((user) => (
              <option key={user.id} value={user.id}>
                {user.name}
                {user.isTechnical ? " — field" : ""}
              </option>
            ))}
          </Select>
          <Input
            aria-label="Needed by"
            type="date"
            value={due}
            onChange={(e) => setDue(e.target.value)}
          />
          <Button
            size="sm"
            disabled={busy || userId.length === 0}
            onClick={async () => {
              await onAssign(userId, due ? new Date(due) : null);
              setEditing(false);
            }}
          >
            Save
          </Button>
        </div>
      )}
    </div>
  );
}
