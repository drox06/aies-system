"use client";

import { useState } from "react";
import { Attachments } from "@/components/ui/attachments";
import { Button } from "@/components/ui/button";
import { DateCell } from "@/components/ui/cells";
import { Input, Label, Select, Textarea } from "@/components/ui/input";
import { Card } from "@/components/ui/layout";
import { StatusBadge } from "@/components/ui/status-badge";
import {
  SERVICE_REPORT_ENTITY_TYPE,
  SERVICE_REPORT_STATUSES,
  SERVICE_REPORT_STATUS_LABELS,
  type PartUsed,
  type ServiceReportStatus,
} from "@/server/core/operations/close-out-rules";
import { trpc } from "@/lib/trpc/client";

/**
 * §12's service report, on the ticket.
 *
 * The report and its approval are two acts on this screen as they are in the service: the customer
 * signs what the technician wrote, and somebody at AIES then stands behind it. An unapproved report
 * holds the project open — §12 makes that one of six close-out blockers — so the panel says so
 * rather than leaving a draft looking finished.
 */
export function ServiceReportPanel({ ticketId }: { ticketId: string }) {
  const reports = trpc.operations.listServiceReports.useQuery({ ticketId });
  const me = trpc.system.whoami.useQuery(undefined, { retry: false });
  const [drafting, setDrafting] = useState(false);

  const permissions = me.data?.permissions ?? [];
  const canWrite = permissions.includes("ticket.execute");
  const canApprove = permissions.includes("service_report.approve");

  if (reports.isPending) return null;
  if (reports.error) {
    return (
      <Card className="p-4">
        <p className="text-sm">{reports.error.message}</p>
      </Card>
    );
  }

  const unapproved = reports.data.filter((row) => row.status !== "approved").length;

  return (
    <Card className="p-4">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <h2 className="text-sm font-semibold">Service reports</h2>
        {unapproved > 0 && <StatusBadge tone="pending">{unapproved} not yet approved</StatusBadge>}
      </div>

      {reports.data.length === 0 && (
        <p className="mt-1 text-sm text-text-muted">
          None yet. The report is what the customer signs for the work, and an unapproved one holds
          the project open at close-out.
        </p>
      )}

      <ul className="mt-3 space-y-2 text-sm">
        {reports.data.map((row) => (
          <li key={row.id} className="rounded-md border border-border p-2.5">
            <div className="flex flex-wrap items-baseline justify-between gap-2">
              <span className="tabular font-medium">{row.number}</span>
              <span className="flex items-center gap-2 text-xs text-text-muted">
                <StatusBadge tone={row.status === "approved" ? "approved" : "pending"}>
                  {SERVICE_REPORT_STATUS_LABELS[row.status as ServiceReportStatus] ?? row.status}
                </StatusBadge>
                {row.finishedAt && <DateCell value={row.finishedAt} />}
              </span>
            </div>
            <p className="mt-1 whitespace-pre-wrap">{row.workPerformed}</p>
            {row.customerName && (
              <p className="mt-0.5 text-xs text-text-muted">
                Signed by {row.customerName}
                {row.customerPosition ? `, ${row.customerPosition}` : ""}
              </p>
            )}
            {!row.customerSignatureFileId && row.signatureWaiverReason && (
              <p className="mt-0.5 text-xs text-amber-800">
                Unsigned — {row.signatureWaiverReason}
              </p>
            )}
            {row.followUpRequired && (
              <p className="mt-0.5 text-xs text-amber-800">Follow-up: {row.followUpNotes}</p>
            )}
            {row.partsUsed.length > 0 && (
              <p className="mt-0.5 text-xs text-text-muted">
                Parts:{" "}
                {row.partsUsed.map((part) => `${part.quantity}× ${part.description}`).join(", ")}
              </p>
            )}

            {canApprove && row.status !== "approved" && (
              <AdvanceControls id={row.id} onDone={() => void reports.refetch()} />
            )}
          </li>
        ))}
      </ul>

      <Card className="mt-3 p-3">
        <h3 className="text-sm font-semibold">Signature and photographs</h3>
        <p className="mt-1 text-xs text-text-muted">
          Upload the customer&rsquo;s signature here, then paste its id when marking the report
          signed.
        </p>
        <div className="mt-2">
          <Attachments entityType={SERVICE_REPORT_ENTITY_TYPE} entityId={ticketId} />
        </div>
      </Card>

      {canWrite && !drafting && (
        <Button variant="secondary" size="sm" className="mt-3" onClick={() => setDrafting(true)}>
          Write a service report
        </Button>
      )}

      {drafting && (
        <DraftForm
          ticketId={ticketId}
          onDone={() => {
            setDrafting(false);
            void reports.refetch();
          }}
          onCancel={() => setDrafting(false)}
        />
      )}
    </Card>
  );
}

function AdvanceControls({ id, onDone }: { id: string; onDone: () => void }) {
  const [target, setTarget] = useState<ServiceReportStatus>("pending_signature");
  const [signatureFileId, setSignatureFileId] = useState("");
  const [customerName, setCustomerName] = useState("");
  const [waiver, setWaiver] = useState("");

  const advance = trpc.operations.advanceServiceReport.useMutation({ onSuccess: onDone });

  const needsProof = target === "signed" || target === "submitted" || target === "approved";

  return (
    <div className="mt-2 space-y-2 rounded-md border border-border p-2.5">
      <div className="grid gap-2 sm:grid-cols-2">
        <div>
          <Label htmlFor={`sr-target-${id}`}>Move to</Label>
          <Select
            id={`sr-target-${id}`}
            value={target}
            onChange={(e) => setTarget(e.target.value as ServiceReportStatus)}
          >
            {SERVICE_REPORT_STATUSES.filter((status) => status !== "draft").map((status) => (
              <option key={status} value={status}>
                {SERVICE_REPORT_STATUS_LABELS[status]}
              </option>
            ))}
          </Select>
        </div>
        {needsProof && (
          <div>
            <Label htmlFor={`sr-sig-${id}`}>Signature file id</Label>
            <Input
              id={`sr-sig-${id}`}
              value={signatureFileId}
              onChange={(e) => setSignatureFileId(e.target.value)}
            />
          </div>
        )}
      </div>

      {needsProof && signatureFileId && (
        <div>
          <Label htmlFor={`sr-name-${id}`}>Who signed</Label>
          <Input
            id={`sr-name-${id}`}
            value={customerName}
            onChange={(e) => setCustomerName(e.target.value)}
          />
        </div>
      )}

      {needsProof && !signatureFileId && (
        <div className="rounded-md border-2 border-amber-400 bg-amber-50 p-2.5">
          <p className="text-sm text-amber-900">
            No customer signature. Without one this is AIES&rsquo;s account of its own work — say
            why there is none.
          </p>
          <div className="mt-2">
            <Label htmlFor={`sr-waiver-${id}`}>Why</Label>
            <Input
              id={`sr-waiver-${id}`}
              value={waiver}
              onChange={(e) => setWaiver(e.target.value)}
            />
          </div>
        </div>
      )}

      {advance.error && <p className="text-sm text-danger">{advance.error.message}</p>}

      <Button
        size="sm"
        disabled={
          advance.isPending ||
          (needsProof && !signatureFileId.trim() && !waiver.trim()) ||
          (needsProof && !!signatureFileId.trim() && !customerName.trim())
        }
        onClick={() =>
          advance.mutate({
            id,
            target,
            customerSignatureFileId: signatureFileId || null,
            customerName: customerName || null,
            signatureWaiverReason: waiver || null,
          })
        }
      >
        {target === "approved" ? "Approve it" : "Move it"}
      </Button>
    </div>
  );
}

function DraftForm({
  ticketId,
  onDone,
  onCancel,
}: {
  ticketId: string;
  onDone: () => void;
  onCancel: () => void;
}) {
  const [workPerformed, setWorkPerformed] = useState("");
  const [findings, setFindings] = useState("");
  const [recommendations, setRecommendations] = useState("");
  const [finishedAt, setFinishedAt] = useState("");
  const [followUpRequired, setFollowUpRequired] = useState(false);
  const [followUpNotes, setFollowUpNotes] = useState("");
  const [parts, setParts] = useState<PartUsed[]>([]);

  const save = trpc.operations.saveServiceReport.useMutation({ onSuccess: onDone });

  return (
    <div className="mt-3 space-y-3 rounded-md border border-border p-3">
      <div>
        <Label htmlFor="sr-work">What was done</Label>
        <Textarea
          id="sr-work"
          rows={3}
          value={workPerformed}
          onChange={(e) => setWorkPerformed(e.target.value)}
        />
      </div>

      <div className="grid gap-3 sm:grid-cols-2">
        <div>
          <Label htmlFor="sr-findings">Findings</Label>
          <Textarea
            id="sr-findings"
            rows={2}
            value={findings}
            onChange={(e) => setFindings(e.target.value)}
          />
        </div>
        <div>
          <Label htmlFor="sr-recommendations">Recommendations</Label>
          <Textarea
            id="sr-recommendations"
            rows={2}
            value={recommendations}
            onChange={(e) => setRecommendations(e.target.value)}
          />
        </div>
      </div>

      <div>
        <Label htmlFor="sr-finished">Finished at</Label>
        <Input
          id="sr-finished"
          type="datetime-local"
          value={finishedAt}
          onChange={(e) => setFinishedAt(e.target.value)}
        />
      </div>

      <div>
        <Label>Parts used</Label>
        <div className="mt-2 space-y-2">
          {parts.map((part, index) => (
            <div key={index} className="grid gap-2 sm:grid-cols-[1fr_6rem]">
              <Input
                aria-label="Part"
                placeholder="Mechanical seal"
                value={part.description}
                onChange={(e) =>
                  setParts(
                    parts.map((p, i) => (i === index ? { ...p, description: e.target.value } : p)),
                  )
                }
              />
              <Input
                aria-label="Quantity"
                type="number"
                min={0}
                value={part.quantity}
                onChange={(e) =>
                  setParts(
                    parts.map((p, i) =>
                      i === index ? { ...p, quantity: Number(e.target.value) } : p,
                    ),
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
          onClick={() => setParts([...parts, { description: "", quantity: 1 }])}
        >
          Add a part
        </Button>
      </div>

      <label className="flex items-start gap-2 text-sm">
        <input
          type="checkbox"
          className="mt-1"
          checked={followUpRequired}
          onChange={(e) => setFollowUpRequired(e.target.checked)}
        />
        <span>
          Something needs following up
          <span className="mt-0.5 block text-xs text-text-muted">
            Say what — a flag with no description is not a handover.
          </span>
        </span>
      </label>

      {followUpRequired && (
        <div>
          <Label htmlFor="sr-followup">What needs doing</Label>
          <Input
            id="sr-followup"
            value={followUpNotes}
            onChange={(e) => setFollowUpNotes(e.target.value)}
          />
        </div>
      )}

      {save.error && <p className="text-sm text-danger">{save.error.message}</p>}

      <div className="flex gap-2">
        <Button
          size="sm"
          disabled={
            save.isPending || !workPerformed.trim() || (followUpRequired && !followUpNotes.trim())
          }
          onClick={() =>
            save.mutate({
              ticketId,
              workPerformed,
              findings: findings || null,
              recommendations: recommendations || null,
              finishedAt: finishedAt ? new Date(finishedAt) : null,
              followUpRequired,
              followUpNotes: followUpNotes || null,
              partsUsed: parts.filter((part) => part.description.trim()),
            })
          }
        >
          Save the draft
        </Button>
        <Button variant="ghost" size="sm" onClick={onCancel}>
          Cancel
        </Button>
      </div>
    </div>
  );
}
