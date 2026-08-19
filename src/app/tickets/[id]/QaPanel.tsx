"use client";

import { useState } from "react";
import { Attachments } from "@/components/ui/attachments";
import { Button } from "@/components/ui/button";
import { DateCell } from "@/components/ui/cells";
import { Input, Label, Select, Textarea } from "@/components/ui/input";
import { Card } from "@/components/ui/layout";
import { StatusBadge, type StatusTone } from "@/components/ui/status-badge";
import {
  DEFECT_SEVERITIES,
  DEFECT_SEVERITY_LABELS,
  EVIDENCE_TYPES,
  EVIDENCE_TYPE_LABELS,
  QA_ENTITY_TYPE,
  type DefectSeverity,
  type EvidenceType,
} from "@/server/core/operations/qa-rules";
import { trpc } from "@/lib/trpc/client";

/**
 * §9's QA gate, on the ticket.
 *
 * The screen has one job beyond capture: to make it obvious, **before** anybody sets the toggle, that
 * approving requires the client's own document. §9 makes that a hard block, and a hard block a person
 * only discovers on submit is one they route around by picking the other answer.
 *
 * Nothing here asks AIES's opinion of the work. §9: "QA is performed and approved by the client, not
 * by AIES" — every field is a record of what the customer said or produced.
 */

const TONE: Record<string, StatusTone> = {
  approved: "approved",
  rejected: "failed",
};

export function QaPanel({ ticketId }: { ticketId: string }) {
  const qa = trpc.operations.listQa.useQuery({ ticketId });
  const me = trpc.system.whoami.useQuery(undefined, { retry: false });
  const [open, setOpen] = useState(false);

  const canRecord = (me.data?.permissions ?? []).includes("qa.record");

  if (qa.isPending) return null;
  if (qa.error) {
    return (
      <Card className="p-4">
        <p className="text-sm">{qa.error.message}</p>
      </Card>
    );
  }

  const data = qa.data;

  return (
    <Card className="p-4">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <h2 className="text-sm font-semibold">Client QA</h2>
        {data.latest && (
          <StatusBadge tone={data.latest.approved ? TONE.approved! : TONE.rejected!}>
            {data.latest.approved ? "Client approved" : `Rejected — round ${data.reworkRounds}`}
          </StatusBadge>
        )}
      </div>

      {!data.latest && (
        <p className="mt-1 text-sm text-text-muted">
          Nothing recorded. The customer inspects the work and the Operations Manager records what
          they said — this is not AIES marking its own homework.
        </p>
      )}

      {data.rows.length > 0 && (
        <ul className="mt-3 space-y-2 text-sm">
          {data.rows.map((row) => (
            <li key={row.id} className="rounded-md border border-border p-2.5">
              <div className="flex flex-wrap items-baseline justify-between gap-2">
                <span className="tabular font-medium">{row.number}</span>
                <span className="text-xs text-text-muted">
                  {row.approved ? "approved" : "rejected"} ·{" "}
                  {row.inspectedAt ? <DateCell value={row.inspectedAt} /> : "no date"}
                  {row.reworkRound > 0 && ` · round ${row.reworkRound}`}
                </span>
              </div>
              {!row.clientInspected && (
                // §9: a waived gate must not look like one nobody opened.
                <p className="mt-0.5 text-xs text-amber-800">
                  The client did not inspect. Recorded deliberately, not skipped.
                </p>
              )}
              {row.clientInspectorName && (
                <p className="text-xs text-text-muted">
                  {row.clientInspectorName}
                  {row.clientInspectorPosition ? `, ${row.clientInspectorPosition}` : ""}
                </p>
              )}
              {row.defects.length > 0 && (
                <ul className="mt-1 space-y-0.5 text-xs">
                  {row.defects.map((defect, index) => (
                    <li key={index}>
                      <span
                        className={
                          defect.severity === "critical" || defect.severity === "major"
                            ? "font-medium text-danger"
                            : "text-text-muted"
                        }
                      >
                        {DEFECT_SEVERITY_LABELS[defect.severity] ?? defect.severity}
                      </span>{" "}
                      — {defect.description}
                    </li>
                  ))}
                </ul>
              )}
              {row.remarks && <p className="mt-1 text-xs text-text-muted">{row.remarks}</p>}
            </li>
          ))}
        </ul>
      )}

      {data.openDefects.length > 0 && (
        <p className="mt-2 rounded-md border border-amber-300 bg-amber-50 p-2.5 text-xs text-amber-900">
          {/* Approval is not closure — a client can accept work with a punch list. */}
          {data.openDefects.length} defect(s) still open across all rounds. Approval does not close
          them.
        </p>
      )}

      <Card className="mt-3 p-3">
        {/*
          Either party's paperwork, and the panel says so.

          QA has one flow rather than the two §6.2, §10 and §12 needed, because it was always
          document-first: nothing is recorded here until a file is attached. What was unclear was
          *whose* file. "The client's documentation" read as though only their form would do, and
          AIES has its own QA inspection sheet that customers sign just as often. Both satisfy §9 —
          what the gate wants is the customer's acceptance in writing, not a particular letterhead.
        */}
        <h3 className="text-sm font-semibold">The signed QA document</h3>
        <p className="mt-1 text-xs text-text-muted">
          Our own QA inspection form signed by them, or an externally written one filled in —
          whichever this site uses. Upload it here first: an approval cannot be recorded without at
          least one file.
        </p>
        <div className="mt-2">
          <Attachments entityType={QA_ENTITY_TYPE} entityId={ticketId} />
        </div>
      </Card>

      {canRecord && !open && (
        <Button variant="secondary" size="sm" className="mt-3" onClick={() => setOpen(true)}>
          Record the client&rsquo;s verdict
        </Button>
      )}

      {open && (
        <RecordForm
          ticketId={ticketId}
          onDone={() => {
            setOpen(false);
            void qa.refetch();
          }}
          onCancel={() => setOpen(false)}
        />
      )}
    </Card>
  );
}

function RecordForm({
  ticketId,
  onDone,
  onCancel,
}: {
  ticketId: string;
  onDone: () => void;
  onCancel: () => void;
}) {
  const [approved, setApproved] = useState(true);
  const [clientInspected, setClientInspected] = useState(true);
  const [inspectorName, setInspectorName] = useState("");
  const [inspectorPosition, setInspectorPosition] = useState("");
  const [evidenceType, setEvidenceType] = useState<EvidenceType>("client_signed_form");
  const [evidenceIds, setEvidenceIds] = useState("");
  const [remarks, setRemarks] = useState("");
  const [defects, setDefects] = useState<{ description: string; severity: DefectSeverity }[]>([]);

  const record = trpc.operations.recordQa.useMutation({ onSuccess: onDone });

  const evidenceList = evidenceIds
    .split(",")
    .map((entry) => entry.trim())
    .filter(Boolean);

  return (
    <div className="mt-3 space-y-3 rounded-md border border-border p-3">
      <fieldset>
        <legend className="text-xs text-text-muted">What did the client say?</legend>
        <div className="mt-1 flex flex-wrap gap-4">
          <label className="flex items-center gap-1.5 text-sm">
            <input type="radio" checked={approved} onChange={() => setApproved(true)} />
            They approved it
          </label>
          <label className="flex items-center gap-1.5 text-sm">
            <input type="radio" checked={!approved} onChange={() => setApproved(false)} />
            They rejected it
          </label>
        </div>
      </fieldset>

      {/*
        Said before the toggle is set, not after. §9's block is hard, and a hard block somebody only
        meets on submit is one they route around by choosing the other answer.
      */}
      {approved && (
        <div className="rounded-md border-2 border-amber-400 bg-amber-50 p-3">
          <p className="text-sm font-semibold text-amber-900">
            An approval needs the client&rsquo;s own document.
          </p>
          <p className="mt-1 text-sm text-amber-900">
            Upload it above, then paste its id below. If they approved verbally, write the
            conversation up, upload that note and mark the evidence <strong>other</strong> — weak
            evidence honestly labelled is worth more than an assertion.
          </p>
        </div>
      )}

      <label className="flex items-start gap-2 text-sm">
        <input
          type="checkbox"
          className="mt-1"
          checked={!clientInspected}
          onChange={(e) => setClientInspected(!e.target.checked)}
        />
        <span>
          The client did not inspect at all
          <span className="mt-0.5 block text-xs text-text-muted">
            Recorded deliberately rather than left blank — a skipped gate and a waived one must not
            look the same. Say why in the remarks.
          </span>
        </span>
      </label>

      <div className="grid gap-3 sm:grid-cols-2">
        <div>
          <Label htmlFor="qa-name">Who inspected</Label>
          <Input
            id="qa-name"
            value={inspectorName}
            onChange={(e) => setInspectorName(e.target.value)}
          />
        </div>
        <div>
          <Label htmlFor="qa-position">Their position</Label>
          <Input
            id="qa-position"
            value={inspectorPosition}
            onChange={(e) => setInspectorPosition(e.target.value)}
          />
        </div>
        <div>
          <Label htmlFor="qa-evidence-type">Evidence type</Label>
          <Select
            id="qa-evidence-type"
            value={evidenceType}
            onChange={(e) => setEvidenceType(e.target.value as EvidenceType)}
          >
            {EVIDENCE_TYPES.map((type) => (
              <option key={type} value={type}>
                {EVIDENCE_TYPE_LABELS[type]}
              </option>
            ))}
          </Select>
        </div>
        <div>
          <Label htmlFor="qa-evidence">Evidence file ids</Label>
          <Input
            id="qa-evidence"
            placeholder="Paste from the attachments above"
            value={evidenceIds}
            onChange={(e) => setEvidenceIds(e.target.value)}
          />
        </div>
      </div>

      <div>
        <Label>Defects</Label>
        <p className="mt-0.5 text-xs text-text-muted">
          Required when they rejected it — &ldquo;they rejected it&rdquo; with nothing listed gives
          the crew nothing to put right. Major and critical raise an NCR when module 08 exists.
        </p>
        <div className="mt-2 space-y-2">
          {defects.map((defect, index) => (
            <div key={index} className="grid gap-2 sm:grid-cols-[1fr_8rem]">
              <Input
                aria-label="Defect"
                placeholder="Weld porosity on the north flange"
                value={defect.description}
                onChange={(e) =>
                  setDefects(
                    defects.map((d, i) =>
                      i === index ? { ...d, description: e.target.value } : d,
                    ),
                  )
                }
              />
              <Select
                aria-label="Severity"
                value={defect.severity}
                onChange={(e) =>
                  setDefects(
                    defects.map((d, i) =>
                      i === index ? { ...d, severity: e.target.value as DefectSeverity } : d,
                    ),
                  )
                }
              >
                {DEFECT_SEVERITIES.map((severity) => (
                  <option key={severity} value={severity}>
                    {DEFECT_SEVERITY_LABELS[severity]}
                  </option>
                ))}
              </Select>
            </div>
          ))}
        </div>
        <Button
          variant="ghost"
          size="sm"
          className="mt-2"
          onClick={() => setDefects([...defects, { description: "", severity: "minor" }])}
        >
          Add a defect
        </Button>
      </div>

      <div>
        <Label htmlFor="qa-remarks">Remarks</Label>
        <Textarea
          id="qa-remarks"
          rows={2}
          value={remarks}
          onChange={(e) => setRemarks(e.target.value)}
        />
      </div>

      {record.error && <p className="text-sm text-danger">{record.error.message}</p>}
      {record.data?.warnings && record.data.warnings.length > 0 && (
        <ul className="space-y-0.5 text-xs text-amber-800">
          {record.data.warnings.map((warning, index) => (
            <li key={index}>{warning}</li>
          ))}
        </ul>
      )}

      <div className="flex gap-2">
        <Button
          size="sm"
          disabled={
            record.isPending ||
            (approved && evidenceList.length === 0) ||
            (!approved && defects.filter((d) => d.description.trim()).length === 0)
          }
          onClick={() =>
            record.mutate({
              ticketId,
              approved,
              clientInspected,
              clientInspectorName: inspectorName || null,
              clientInspectorPosition: inspectorPosition || null,
              evidenceFileIds: evidenceList,
              evidenceType,
              remarks: remarks || null,
              defects: defects
                .filter((d) => d.description.trim())
                .map((d) => ({ description: d.description, severity: d.severity })),
            })
          }
        >
          Record it
        </Button>
        <Button variant="ghost" size="sm" onClick={onCancel}>
          Cancel
        </Button>
      </div>

      <p className="text-xs text-text-muted">
        {approved
          ? "Approving moves the ticket to testing and commissioning."
          : "Rejecting sends the ticket back to the crew and counts a rework round — §9's loop, drawn literally."}
      </p>
    </div>
  );
}
