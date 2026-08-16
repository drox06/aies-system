"use client";

import { use, useState } from "react";
import Link from "next/link";
import { AuditTrail } from "@/components/AuditTrail";
import { Attachments } from "@/components/ui/attachments";
import { Button } from "@/components/ui/button";
import { DateCell } from "@/components/ui/cells";
import { Input, Label, Textarea } from "@/components/ui/input";
import { Card, PageHeader, RecordLayout } from "@/components/ui/layout";
import { StatusBadge, type StatusTone } from "@/components/ui/status-badge";
import { METHODOLOGY_ENTITY_TYPE } from "@/server/core/operations/methodology-rules";
import { trpc } from "@/lib/trpc/client";

/**
 * One method statement (specs/04-operations-projects.md §6.2).
 *
 * Every field the server requires has an input on this page, and that sentence is doing real work:
 * the review of session 3 found a site inspection whose completion rule could never be satisfied
 * because the form had no attendee field (docs/DECISIONS.md #62). `methodologyCompleteness` asks for
 * a scope, a sequence, a manpower plan and a safety plan, and all four are editable below; the
 * client's approval demands a file, and there is an upload for it.
 */

const STATUS_TONE: Record<string, StatusTone> = {
  draft: "draft",
  internal_review: "pending",
  approved: "info",
  submitted_to_client: "pending",
  client_approved: "approved",
  client_rejected: "failed",
  superseded: "cancelled",
};

const human = (value: string) => value.replace(/_/g, " ");

interface Step {
  step: number;
  description: string;
  durationHours: number;
  crew: string;
}
interface Crew {
  role: string;
  count: number;
  notes?: string;
}
interface Material {
  description: string;
  quantity: string;
  unit: string;
}

export default function MethodologyPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = use(params);
  const query = trpc.operations.getMethodology.useQuery({ methodologyId: id });

  if (query.isPending) return <p className="text-sm text-text-muted">Loading…</p>;
  if (query.error) {
    return (
      <Card className="p-4">
        <p className="text-sm">{query.error.message}</p>
      </Card>
    );
  }

  const data = query.data;
  const refresh = () => void query.refetch();

  return (
    <div className="mx-auto max-w-7xl">
      <PageHeader
        title={`${data.number} R${data.revision}`}
        description={data.title}
        actions={
          <div className="flex flex-wrap items-center gap-2">
            <StatusBadge tone={STATUS_TONE[data.status] ?? "draft"}>
              <span className="capitalize">{human(data.status)}</span>
            </StatusBadge>
            {!data.clientApprovalRequired && (
              <StatusBadge tone="draft">Client approval waived</StatusBadge>
            )}
          </div>
        }
      />

      <RecordLayout
        aside={
          <div className="space-y-4">
            <Card className="p-4">
              <h2 className="text-sm font-semibold">With the client</h2>
              <p className="mt-1 text-sm">{data.turnaround.message}</p>
              <dl className="mt-2 space-y-1 text-sm">
                <Row
                  label="Sent"
                  value={
                    data.submittedToClientAt ? <DateCell value={data.submittedToClientAt} /> : "—"
                  }
                />
                <Row
                  label="Approved"
                  value={data.clientApprovedAt ? <DateCell value={data.clientApprovedAt} /> : "—"}
                />
              </dl>
              <p className="mt-2 text-xs text-text-muted">
                {/* §6.2's reason for dating this at all. */}
                The gap between these two dates is the customer&rsquo;s. Recorded so a delay that
                was theirs is not remembered as ours.
              </p>
            </Card>

            {data.ticket && (
              <Card className="p-4">
                <h2 className="text-sm font-semibold">For</h2>
                <Link
                  href={`/tickets/${data.ticket.id}`}
                  className="tabular mt-1 block text-sm text-blue-600 underline underline-offset-2"
                >
                  {data.ticket.number}
                </Link>
                <p className="text-xs text-text-muted">{data.ticket.title}</p>
              </Card>
            )}

            {data.chain.length > 1 && (
              <Card className="p-4">
                <h2 className="text-sm font-semibold">Revisions</h2>
                <p className="mt-0.5 text-xs text-text-muted">
                  The evidence of what was agreed, and of what was turned down.
                </p>
                <ul className="mt-2 space-y-1.5 text-sm">
                  {data.chain.map((rev) => (
                    <li key={rev.id}>
                      <Link
                        href={`/methodologies/${rev.id}`}
                        className={
                          rev.id === data.id
                            ? "font-medium"
                            : "text-blue-600 underline underline-offset-2"
                        }
                      >
                        R{rev.revision}
                      </Link>{" "}
                      <span className="text-xs text-text-muted capitalize">
                        {human(rev.status)}
                      </span>
                      {rev.clientRejectionNotes && (
                        <p className="text-xs text-text-muted">{rev.clientRejectionNotes}</p>
                      )}
                    </li>
                  ))}
                </ul>
              </Card>
            )}

            {data.completeness.warnings.length > 0 && (
              <Card className="p-4">
                <h2 className="text-sm font-semibold">Worth noting</h2>
                <ul className="mt-2 space-y-1.5 text-xs text-text-muted">
                  {data.completeness.warnings.map((warning, index) => (
                    <li key={index}>{warning}</li>
                  ))}
                </ul>
              </Card>
            )}
          </div>
        }
      >
        <div className="space-y-4">
          {data.clientRejectionNotes && data.status === "client_rejected" && (
            <Card className="border-amber-400 bg-amber-50 p-4">
              <h2 className="text-sm font-semibold text-amber-900">The client rejected this</h2>
              <p className="mt-1 text-sm text-amber-900">{data.clientRejectionNotes}</p>
              <p className="mt-1 text-xs text-amber-800">
                A revision was raised from it. This one stays as it is — that is what makes the
                chain evidence.
              </p>
            </Card>
          )}

          {data.editable ? (
            <MethodologyForm methodologyId={data.id} initial={data} onSaved={refresh} />
          ) : (
            <ReadOnlyMethod data={data} />
          )}

          <Card className="p-4">
            <h2 className="text-sm font-semibold">Attachments</h2>
            <p className="mt-1 text-xs text-text-muted">
              The job safety analysis, and the client&rsquo;s signed approval when it arrives.
            </p>
            <div className="mt-2">
              <Attachments entityType={METHODOLOGY_ENTITY_TYPE} entityId={data.id} />
            </div>
          </Card>

          <Lifecycle data={data} onDone={refresh} />

          <Card className="p-4">
            <h2 className="text-sm font-semibold">History</h2>
            <div className="mt-2">
              <AuditTrail entityType={METHODOLOGY_ENTITY_TYPE} entityId={data.id} />
            </div>
          </Card>
        </div>
      </RecordLayout>
    </div>
  );
}

function MethodologyForm({
  methodologyId,
  initial,
  onSaved,
}: {
  methodologyId: string;
  initial: {
    scopeSummary: string;
    safetyPlan: string | null;
    sequenceOfWork: unknown;
    manpowerPlan: unknown;
    materialsRequired: unknown;
    toolsRequired: string[];
    permitsRequired: string[];
    durationDays: number | null;
    mobilizationPlan: string | null;
    demobilizationPlan: string | null;
    contingencyPlan: string | null;
    environmentalConsiderations: string | null;
  };
  onSaved: () => void;
}) {
  const [scope, setScope] = useState(initial.scopeSummary ?? "");
  const [safety, setSafety] = useState(initial.safetyPlan ?? "");
  const [steps, setSteps] = useState<Step[]>(
    Array.isArray(initial.sequenceOfWork) ? (initial.sequenceOfWork as Step[]) : [],
  );
  const [crew, setCrew] = useState<Crew[]>(
    Array.isArray(initial.manpowerPlan) ? (initial.manpowerPlan as Crew[]) : [],
  );
  const [materials, setMaterials] = useState<Material[]>(
    Array.isArray(initial.materialsRequired) ? (initial.materialsRequired as Material[]) : [],
  );
  const [tools, setTools] = useState(initial.toolsRequired.join(", "));
  const [permits, setPermits] = useState(initial.permitsRequired.join(", "));
  const [duration, setDuration] = useState(initial.durationDays?.toString() ?? "");
  const [mobilization, setMobilization] = useState(initial.mobilizationPlan ?? "");
  const [demobilization, setDemobilization] = useState(initial.demobilizationPlan ?? "");
  const [contingency, setContingency] = useState(initial.contingencyPlan ?? "");
  const [environmental, setEnvironmental] = useState(initial.environmentalConsiderations ?? "");

  const save = trpc.operations.saveMethodology.useMutation({ onSuccess: onSaved });
  const list = (value: string) =>
    value
      .split(",")
      .map((entry) => entry.trim())
      .filter(Boolean);

  return (
    <Card className="p-4">
      <h2 className="text-sm font-semibold">The method</h2>

      <div className="mt-3">
        <Label htmlFor="m-scope">Scope summary</Label>
        <Textarea id="m-scope" rows={3} value={scope} onChange={(e) => setScope(e.target.value)} />
      </div>

      <div className="mt-4">
        <Label>Sequence of work</Label>
        <p className="mt-0.5 text-xs text-text-muted">
          The order it happens in, with how long each step takes and who does it.
        </p>
        <div className="mt-2 space-y-2">
          {steps.map((step, index) => (
            <div key={index} className="grid gap-2 sm:grid-cols-[1fr_6rem_9rem]">
              <Input
                aria-label="Step"
                placeholder="Isolate and drain the line"
                value={step.description}
                onChange={(e) =>
                  setSteps(
                    steps.map((s, i) => (i === index ? { ...s, description: e.target.value } : s)),
                  )
                }
              />
              <Input
                aria-label="Hours"
                type="number"
                min={0}
                value={step.durationHours}
                onChange={(e) =>
                  setSteps(
                    steps.map((s, i) =>
                      i === index ? { ...s, durationHours: Number(e.target.value) } : s,
                    ),
                  )
                }
              />
              <Input
                aria-label="Crew"
                placeholder="2 technicians"
                value={step.crew}
                onChange={(e) =>
                  setSteps(steps.map((s, i) => (i === index ? { ...s, crew: e.target.value } : s)))
                }
              />
            </div>
          ))}
        </div>
        <Button
          variant="ghost"
          size="sm"
          className="mt-2"
          onClick={() =>
            setSteps([
              ...steps,
              { step: steps.length + 1, description: "", durationHours: 0, crew: "" },
            ])
          }
        >
          Add a step
        </Button>
      </div>

      <div className="mt-4">
        <Label>Manpower plan</Label>
        <div className="mt-2 space-y-2">
          {crew.map((row, index) => (
            <div key={index} className="grid gap-2 sm:grid-cols-[1fr_6rem_1fr]">
              <Input
                aria-label="Role"
                placeholder="Instrument technician"
                value={row.role}
                onChange={(e) =>
                  setCrew(crew.map((c, i) => (i === index ? { ...c, role: e.target.value } : c)))
                }
              />
              <Input
                aria-label="How many"
                type="number"
                min={0}
                value={row.count}
                onChange={(e) =>
                  setCrew(
                    crew.map((c, i) => (i === index ? { ...c, count: Number(e.target.value) } : c)),
                  )
                }
              />
              <Input
                aria-label="Notes"
                placeholder="Certified for confined space"
                value={row.notes ?? ""}
                onChange={(e) =>
                  setCrew(crew.map((c, i) => (i === index ? { ...c, notes: e.target.value } : c)))
                }
              />
            </div>
          ))}
        </div>
        <Button
          variant="ghost"
          size="sm"
          className="mt-2"
          onClick={() => setCrew([...crew, { role: "", count: 1, notes: "" }])}
        >
          Add a role
        </Button>
      </div>

      <div className="mt-4">
        <Label htmlFor="m-safety">Safety plan</Label>
        <Textarea
          id="m-safety"
          rows={4}
          value={safety}
          onChange={(e) => setSafety(e.target.value)}
        />
        <p className="mt-1 text-xs text-text-muted">
          Attach the job safety analysis above once it is written.
        </p>
      </div>

      <div className="mt-4">
        <Label>Materials</Label>
        <p className="mt-0.5 text-xs text-text-muted">
          These pre-populate the material request, so what goes here is not typed again later.
        </p>
        <div className="mt-2 space-y-2">
          {materials.map((row, index) => (
            <div key={index} className="grid gap-2 sm:grid-cols-[1fr_6rem_6rem]">
              <Input
                aria-label="Material"
                placeholder="DN100 gasket set"
                value={row.description}
                onChange={(e) =>
                  setMaterials(
                    materials.map((m, i) =>
                      i === index ? { ...m, description: e.target.value } : m,
                    ),
                  )
                }
              />
              <Input
                aria-label="Quantity"
                value={row.quantity}
                onChange={(e) =>
                  setMaterials(
                    materials.map((m, i) => (i === index ? { ...m, quantity: e.target.value } : m)),
                  )
                }
              />
              <Input
                aria-label="Unit"
                value={row.unit}
                onChange={(e) =>
                  setMaterials(
                    materials.map((m, i) => (i === index ? { ...m, unit: e.target.value } : m)),
                  )
                }
              />
            </div>
          ))}
        </div>
        <Button
          variant="ghost"
          size="sm"
          className="mt-2"
          onClick={() =>
            setMaterials([...materials, { description: "", quantity: "1", unit: "pc" }])
          }
        >
          Add a material
        </Button>
      </div>

      <div className="mt-4 grid gap-3 sm:grid-cols-2">
        <div>
          <Label htmlFor="m-tools">Tools required</Label>
          <Input
            id="m-tools"
            placeholder="Torque wrench, gas detector"
            value={tools}
            onChange={(e) => setTools(e.target.value)}
          />
        </div>
        <div>
          <Label htmlFor="m-permits">Permits required</Label>
          <Input
            id="m-permits"
            placeholder="Hot work, confined space entry"
            value={permits}
            onChange={(e) => setPermits(e.target.value)}
          />
        </div>
        <div>
          <Label htmlFor="m-duration">Duration (days)</Label>
          <Input
            id="m-duration"
            type="number"
            min={1}
            value={duration}
            onChange={(e) => setDuration(e.target.value)}
          />
        </div>
        <div>
          <Label htmlFor="m-env">Environmental considerations</Label>
          <Input
            id="m-env"
            value={environmental}
            onChange={(e) => setEnvironmental(e.target.value)}
          />
        </div>
      </div>

      <div className="mt-4 grid gap-3 sm:grid-cols-3">
        <div>
          <Label htmlFor="m-mob">Mobilisation plan</Label>
          <Textarea
            id="m-mob"
            rows={2}
            value={mobilization}
            onChange={(e) => setMobilization(e.target.value)}
          />
        </div>
        <div>
          <Label htmlFor="m-demob">Demobilisation plan</Label>
          <Textarea
            id="m-demob"
            rows={2}
            value={demobilization}
            onChange={(e) => setDemobilization(e.target.value)}
          />
        </div>
        <div>
          <Label htmlFor="m-cont">Contingency plan</Label>
          <Textarea
            id="m-cont"
            rows={2}
            value={contingency}
            onChange={(e) => setContingency(e.target.value)}
          />
        </div>
      </div>

      {save.error && <p className="mt-2 text-sm text-danger">{save.error.message}</p>}

      <Button
        className="mt-4"
        disabled={save.isPending}
        onClick={() =>
          save.mutate({
            methodologyId,
            scopeSummary: scope,
            safetyPlan: safety || null,
            sequenceOfWork: steps.map((step, index) => ({ ...step, step: index + 1 })),
            manpowerPlan: crew,
            materialsRequired: materials.filter((m) => m.description.trim()),
            toolsRequired: list(tools),
            permitsRequired: list(permits),
            durationDays: duration ? Number(duration) : null,
            mobilizationPlan: mobilization || null,
            demobilizationPlan: demobilization || null,
            contingencyPlan: contingency || null,
            environmentalConsiderations: environmental || null,
          })
        }
      >
        Save
      </Button>
    </Card>
  );
}

function ReadOnlyMethod({
  data,
}: {
  data: {
    scopeSummary: string;
    safetyPlan: string | null;
    sequenceOfWork: unknown;
    toolsRequired: string[];
    permitsRequired: string[];
    durationDays: number | null;
  };
}) {
  const steps = Array.isArray(data.sequenceOfWork) ? (data.sequenceOfWork as Step[]) : [];

  return (
    <Card className="p-4">
      <h2 className="text-sm font-semibold">The method</h2>
      <p className="mt-2 text-sm whitespace-pre-wrap">{data.scopeSummary}</p>

      {steps.length > 0 && (
        <ol className="mt-3 space-y-1 text-sm">
          {steps.map((step, index) => (
            <li key={index}>
              <span className="tabular text-text-muted">{index + 1}.</span> {step.description}
              {step.durationHours ? (
                <span className="text-xs text-text-muted"> — {step.durationHours}h</span>
              ) : null}
              {step.crew ? <span className="text-xs text-text-muted"> · {step.crew}</span> : null}
            </li>
          ))}
        </ol>
      )}

      {data.safetyPlan && (
        <>
          <h3 className="mt-4 text-sm font-semibold">Safety plan</h3>
          <p className="mt-1 text-sm whitespace-pre-wrap">{data.safetyPlan}</p>
        </>
      )}

      <dl className="mt-3 space-y-1 text-sm">
        <Row label="Tools" value={data.toolsRequired.join(", ") || "—"} />
        <Row label="Permits" value={data.permitsRequired.join(", ") || "—"} />
        <Row label="Duration" value={data.durationDays ? `${data.durationDays} days` : "—"} />
      </dl>

      <p className="mt-3 text-xs text-text-muted">
        This has left AIES, so it is no longer editable. A change to an issued method statement is a
        revision.
      </p>
    </Card>
  );
}

/** The whole §6.2 cycle, offered one step at a time so the next action is never ambiguous. */
function Lifecycle({
  data,
  onDone,
}: {
  data: {
    id: string;
    status: string;
    canApprove: boolean;
    clientApprovalRequired: boolean;
    completeness: { complete: boolean; missing: string[] };
  };
  onDone: () => void;
}) {
  const [comment, setComment] = useState("");
  const [approvalFileId, setApprovalFileId] = useState("");
  const [waiverReason, setWaiverReason] = useState("");
  const [showWaiver, setShowWaiver] = useState(false);

  const submitReview = trpc.operations.submitMethodologyForReview.useMutation({
    onSuccess: onDone,
  });
  const approve = trpc.operations.approveMethodology.useMutation({ onSuccess: onDone });
  const toClient = trpc.operations.submitMethodologyToClient.useMutation({ onSuccess: onDone });
  const clientDecision = trpc.operations.recordClientDecision.useMutation({ onSuccess: onDone });
  const waive = trpc.operations.waiveClientApproval.useMutation({ onSuccess: onDone });

  const error =
    submitReview.error ?? approve.error ?? toClient.error ?? clientDecision.error ?? waive.error;

  if (data.status === "superseded") return null;

  return (
    <Card className="p-4">
      <h2 className="text-sm font-semibold">What happens next</h2>

      {error && <p className="mt-2 text-sm text-danger">{error.message}</p>}

      {data.status === "draft" && (
        <>
          {!data.completeness.complete && (
            <p className="mt-1 text-xs text-text-muted">
              Still needs: {data.completeness.missing.join("; ")}.
            </p>
          )}
          <Button
            className="mt-3"
            disabled={submitReview.isPending || !data.completeness.complete}
            onClick={() => submitReview.mutate({ methodologyId: data.id })}
          >
            Send for internal review
          </Button>
        </>
      )}

      {data.status === "internal_review" &&
        (data.canApprove ? (
          <>
            <div className="mt-2">
              <Label htmlFor="m-comment">Comment (required to send back)</Label>
              <Textarea
                id="m-comment"
                rows={2}
                value={comment}
                onChange={(e) => setComment(e.target.value)}
              />
            </div>
            <div className="mt-3 flex gap-2">
              <Button
                disabled={approve.isPending}
                onClick={() =>
                  approve.mutate({ methodologyId: data.id, decision: "approved", comment })
                }
              >
                Approve it internally
              </Button>
              <Button
                variant="secondary"
                disabled={approve.isPending || comment.trim().length === 0}
                onClick={() =>
                  approve.mutate({ methodologyId: data.id, decision: "rejected", comment })
                }
              >
                Send it back
              </Button>
            </div>
          </>
        ) : (
          <p className="mt-2 text-sm text-text-muted">
            Waiting on the operations manager or an officer to review it.
          </p>
        ))}

      {data.status === "approved" && (
        <>
          <p className="mt-1 text-sm text-text-muted">
            Approved internally. Sending it starts the clock that shows whose delay any wait was.
          </p>
          <div className="mt-3 flex flex-wrap gap-2">
            <Button
              disabled={toClient.isPending}
              onClick={() => toClient.mutate({ methodologyId: data.id })}
            >
              Send it to the client
            </Button>
            {data.clientApprovalRequired && data.canApprove && !showWaiver && (
              <Button variant="ghost" onClick={() => setShowWaiver(true)}>
                This client does not require approval
              </Button>
            )}
          </div>

          {showWaiver && (
            <div className="mt-3 rounded-md border border-border p-3">
              <Label htmlFor="m-waiver">Why not?</Label>
              <Textarea
                id="m-waiver"
                rows={2}
                value={waiverReason}
                onChange={(e) => setWaiverReason(e.target.value)}
              />
              <p className="mt-1 text-xs text-text-muted">
                §6.2 treats this as a rare exception, not a setting. The reason is the record of it.
              </p>
              <div className="mt-2 flex gap-2">
                <Button
                  size="sm"
                  disabled={waive.isPending || waiverReason.trim().length < 10}
                  onClick={() => waive.mutate({ methodologyId: data.id, reason: waiverReason })}
                >
                  Record the exception
                </Button>
                <Button variant="ghost" size="sm" onClick={() => setShowWaiver(false)}>
                  Cancel
                </Button>
              </div>
            </div>
          )}
        </>
      )}

      {data.status === "submitted_to_client" && (
        <>
          <p className="mt-1 text-sm text-text-muted">
            With the client. Record their answer when it comes.
          </p>
          <div className="mt-3">
            <Label htmlFor="m-approval-file">
              Their approval — paste the attachment id from above
            </Label>
            <Input
              id="m-approval-file"
              value={approvalFileId}
              onChange={(e) => setApprovalFileId(e.target.value)}
              placeholder="Upload it in Attachments first, then paste its id"
            />
            <p className="mt-1 text-xs text-text-muted">
              {/* §6.2 gates mobilisation on the document as well as the status. */}
              Required to record an approval: a status is something we set, the document is
              something they signed.
            </p>
          </div>
          <div className="mt-3">
            <Label htmlFor="m-notes">Their comments (required to record a rejection)</Label>
            <Textarea
              id="m-notes"
              rows={2}
              value={comment}
              onChange={(e) => setComment(e.target.value)}
            />
          </div>
          <div className="mt-3 flex gap-2">
            <Button
              disabled={clientDecision.isPending || !approvalFileId.trim()}
              onClick={() =>
                clientDecision.mutate({
                  methodologyId: data.id,
                  decision: "approved",
                  approvalFileId: approvalFileId.trim(),
                })
              }
            >
              They approved it
            </Button>
            <Button
              variant="secondary"
              disabled={clientDecision.isPending || comment.trim().length === 0}
              onClick={() =>
                clientDecision.mutate({
                  methodologyId: data.id,
                  decision: "rejected",
                  notes: comment,
                })
              }
            >
              They rejected it
            </Button>
          </div>
        </>
      )}

      {data.status === "client_approved" && (
        <p className="mt-1 text-sm text-text-muted">
          Approved by the client, with their document on file. Nothing here is blocking the crew.
        </p>
      )}
    </Card>
  );
}

function Row({ label, value }: { label: string; value: React.ReactNode }) {
  return (
    <div className="flex items-baseline justify-between gap-3">
      <dt className="text-xs text-text-muted">{label}</dt>
      <dd className="min-w-0 text-right">{value}</dd>
    </div>
  );
}
