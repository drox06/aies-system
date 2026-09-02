"use client";

import { use, useState } from "react";
import Link from "next/link";
import { AuditTrail } from "@/components/AuditTrail";
import { Attachments } from "@/components/ui/attachments";
import { Button } from "@/components/ui/button";
import { DateCell } from "@/components/ui/cells";
import { Input, Label, Select, Textarea } from "@/components/ui/input";
import { Card, PageHeader, RecordLayout } from "@/components/ui/layout";
import { StatusBadge, type StatusTone } from "@/components/ui/status-badge";
import { RequirementsPanel } from "./RequirementsPanel";
import {
  ATTENDEE_PARTIES,
  ATTENDEE_PARTY_LABELS,
  SITE_INSPECTION_ENTITY_TYPE,
  UTILITIES,
  UTILITY_LABELS,
  attendeesNeedingNames,
  type Attendee,
  type AttendeeParty,
  type Utility,
} from "@/server/core/operations/site-inspection-rules";
import { trpc } from "@/lib/trpc/client";

/**
 * One site inspection (specs/04-operations-projects.md §6.1).
 *
 * The scope-change block is deliberately the loudest thing on the page and sits above the findings
 * rather than below them. §6.1: "Discovering at inspection that the job is bigger than quoted is
 * normal; discovering it *after* mobilization is expensive." The surveyor is filling this in on a
 * phone, in a plant, in a hurry — the question that costs the most to miss goes where it cannot be
 * scrolled past.
 */

const STATUS_TONE: Record<string, StatusTone> = {
  scheduled: "pending",
  completed: "info",
  approved: "approved",
};

interface Measurement {
  label: string;
  value: string;
  unit: string;
}

export default function InspectionPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = use(params);
  const inspection = trpc.operations.getInspection.useQuery({ inspectionId: id });

  // Only a pre-quotation survey — one raised from an inquiry — has requirements to answer. A
  // ticket- or project-side inspection has no inquiry behind it and nothing quoting is gated on.
  // Called unconditionally, ahead of the pending/error returns below, same as every other hook in
  // this component — the enabled flag is what makes it a no-op until there is an inquiry to ask for.
  const inquiry = trpc.crm.getInquiry.useQuery(
    { inquiryId: inspection.data?.inquiryId ?? "" },
    { enabled: !!inspection.data?.inquiryId },
  );

  if (inspection.isPending) return <p className="text-sm text-text-muted">Loading…</p>;
  if (inspection.error) {
    return (
      <Card className="p-4">
        <p className="text-sm">{inspection.error.message}</p>
      </Card>
    );
  }

  const data = inspection.data;

  return (
    <div className="mx-auto max-w-7xl">
      <PageHeader
        title={data.number}
        description={
          data.ticket?.title ?? data.project?.name ?? "Pre-quotation survey, raised from an inquiry"
        }
        actions={
          <div className="flex flex-wrap items-center gap-2">
            <StatusBadge tone={STATUS_TONE[data.status] ?? "draft"}>{data.status}</StatusBadge>
            {data.scopeChangeIdentified && <StatusBadge tone="failed">Scope change</StatusBadge>}
            {/* Only once the survey is genuinely finished — the route itself refuses while
                `status` is still "scheduled", so this stays hidden rather than offering a report
                that would come back empty. */}
            {data.status !== "scheduled" && (
              <Button variant="secondary" size="sm" asChild>
                <a href={`/api/inspections/${data.id}/pdf`} target="_blank" rel="noreferrer">
                  Download PDF
                </a>
              </Button>
            )}
          </div>
        }
      />

      <RecordLayout
        aside={
          <div className="space-y-4">
            <Card className="p-4">
              <h2 className="text-sm font-semibold">The visit</h2>
              <dl className="mt-2 space-y-1 text-sm">
                <Row
                  label="Booked for"
                  value={data.scheduledFor ? <DateCell value={data.scheduledFor} /> : "—"}
                />
                <Row
                  label="Visited"
                  value={data.inspectedAt ? <DateCell value={data.inspectedAt} /> : "not yet"}
                />
                <Row label="Attended by" value={`${data.inspectedByIds.length} person(s)`} />
              </dl>
              {data.ticket && (
                <Link
                  href={`/tickets/${data.ticket.id}`}
                  className="tabular mt-2 block text-sm text-blue-600 underline underline-offset-2"
                >
                  {data.ticket.number}
                </Link>
              )}
            </Card>

            <Card className="p-4">
              <h2 className="text-sm font-semibold">Utilities on site</h2>
              <ul className="mt-2 space-y-1 text-sm">
                {data.utilities.map((utility) => (
                  <li key={utility.key} className="flex items-baseline justify-between gap-3">
                    <span className="text-text-muted">{utility.label}</span>
                    <span>
                      {/* Absent is not the same as unavailable, and the screen says so — a planner
                          who reads "no crane" and brings one has lost a day either way, but a
                          planner who reads "nobody checked" knows to ask. */}
                      {utility.available === null
                        ? "not checked"
                        : utility.available
                          ? "available"
                          : "not available"}
                    </span>
                  </li>
                ))}
              </ul>
            </Card>

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
          {/* What the customer needs, asked while somebody is standing in front of them to answer
              it — moved here from the inquiry screen (2026-09-02). Only a survey raised from an
              inquiry has one of these to fill in. */}
          {inquiry.data && <RequirementsPanel inquiry={inquiry.data} />}

          {data.editable ? (
            <InspectionForm
              inspectionId={data.id}
              initial={data}
              onSaved={() => void inspection.refetch()}
            />
          ) : (
            <ReadOnlyFindings data={data} />
          )}

          <Card className="p-4">
            <h2 className="text-sm font-semibold">Photographs and sketches</h2>
            <p className="mt-1 text-xs text-text-muted">
              Visible to whoever attended and to management. Not required to complete the report — a
              refused-entry visit is still a real inspection.
            </p>
            <div className="mt-2">
              <Attachments entityType={SITE_INSPECTION_ENTITY_TYPE} entityId={data.id} />
            </div>
          </Card>

          <StatusActions
            inspectionId={data.id}
            status={data.status}
            canApprove={data.canApprove}
            missing={data.completeness.missing}
            onDone={() => void inspection.refetch()}
          />

          <Card className="p-4">
            <h2 className="text-sm font-semibold">History</h2>
            <div className="mt-2">
              <AuditTrail entityType={SITE_INSPECTION_ENTITY_TYPE} entityId={data.id} />
            </div>
          </Card>
        </div>
      </RecordLayout>
    </div>
  );
}

function InspectionForm({
  inspectionId,
  initial,
  onSaved,
}: {
  inspectionId: string;
  initial: {
    findings: string | null;
    inspectedAt: Date | string | null;
    inspectedByIds: string[];
    attendees: Attendee[];
    accessConstraints: string | null;
    tagNumbers: string[];
    hazards: string[];
    permitsRequired: string[];
    scopeChangeIdentified: boolean;
    scopeChangeNotes: string | null;
    measurements: unknown;
    utilities: { key: string; available: boolean | null }[];
  };
  onSaved: () => void;
}) {
  const [findings, setFindings] = useState(initial.findings ?? "");
  const [attendees, setAttendees] = useState<Attendee[]>(initial.attendees);
  const [inspectedAt, setInspectedAt] = useState(
    initial.inspectedAt ? new Date(initial.inspectedAt).toISOString().slice(0, 10) : "",
  );
  const [accessConstraints, setAccessConstraints] = useState(initial.accessConstraints ?? "");
  const [tagNumbers, setTagNumbers] = useState(initial.tagNumbers.join(", "));
  const [hazards, setHazards] = useState(initial.hazards.join(", "));
  const [permits, setPermits] = useState(initial.permitsRequired.join(", "));
  const [scopeChange, setScopeChange] = useState(initial.scopeChangeIdentified);
  const [scopeNotes, setScopeNotes] = useState(initial.scopeChangeNotes ?? "");
  const [measurements, setMeasurements] = useState<Measurement[]>(
    Array.isArray(initial.measurements) ? (initial.measurements as Measurement[]) : [],
  );
  const [utilities, setUtilities] = useState<Record<string, boolean>>(
    Object.fromEntries(
      initial.utilities.filter((u) => u.available !== null).map((u) => [u.key, !!u.available]),
    ),
  );

  const save = trpc.operations.saveInspection.useMutation({ onSuccess: onSaved });

  const list = (value: string) =>
    value
      .split(",")
      .map((entry) => entry.trim())
      .filter(Boolean);

  return (
    <>
      {/*
        §6.1's highest-value question, placed first. A surveyor standing in a plant answers what is
        in front of them; whatever is at the bottom of a long form gets answered on the drive back,
        or not at all.
      */}
      <Card className={scopeChange ? "border-amber-300 bg-amber-50/50 p-4" : "border-border p-4"}>
        <label className="flex items-start gap-2">
          <input
            type="checkbox"
            className="mt-1"
            checked={scopeChange}
            onChange={(e) => setScopeChange(e.target.checked)}
          />
          <span>
            <span className="text-sm font-semibold">Is the job bigger than what was quoted?</span>
            <span className="mt-0.5 block text-xs text-text-muted">
              Saying yes tells sales today. Discovering it after the crew mobilises is what this
              question exists to prevent.
            </span>
          </span>
        </label>

        {scopeChange && (
          <div className="mt-3">
            <Label htmlFor="scope-notes">What changed</Label>
            <Textarea
              id="scope-notes"
              rows={3}
              value={scopeNotes}
              onChange={(e) => setScopeNotes(e.target.value)}
            />
            <p className="mt-1 text-xs text-text-muted">
              Required. Sales cannot revise a quotation against a tick box.
            </p>
          </div>
        )}
      </Card>

      <Card className="p-4">
        <h2 className="text-sm font-semibold">What was found</h2>

        {/*
          Who went. Required to complete the report — and missing entirely until 2026-08-16, which
          made completion impossible through the UI: the server asked for attendees and no screen
          could supply them. The server rule was right; the form was the half that was never built.
        */}
        {/*
          Departments for AIES's own people, names for everybody else. Asked for on 2026-08-17,
          replacing a checkbox list of every internal user: on a survey what matters is that sales and
          technical were both there, and the people who are not AIES are exactly the ones whose names
          nobody can look up later.
        */}
        <fieldset className="mt-3">
          <legend className="text-xs text-text-muted">Who attended</legend>
          <div className="mt-2 space-y-2">
            {attendees.map((attendee, index) => (
              <div key={index} className="flex flex-wrap items-end gap-2">
                <div className="w-44">
                  <Label htmlFor={`att-party-${index}`}>Who</Label>
                  <Select
                    id={`att-party-${index}`}
                    value={attendee.party}
                    onChange={(e) =>
                      setAttendees(
                        attendees.map((a, i) =>
                          i === index ? { ...a, party: e.target.value as AttendeeParty } : a,
                        ),
                      )
                    }
                  >
                    {ATTENDEE_PARTIES.map((party) => (
                      <option key={party} value={party}>
                        {ATTENDEE_PARTY_LABELS[party]}
                      </option>
                    ))}
                  </Select>
                </div>
                <div className="grow">
                  <Label htmlFor={`att-name-${index}`}>
                    {attendee.party === "other" ? "Name (required)" : "Name (optional)"}
                  </Label>
                  <Input
                    id={`att-name-${index}`}
                    placeholder={
                      attendee.party === "other"
                        ? "Plant engineer, principal's representative"
                        : "Who from that department"
                    }
                    value={attendee.name ?? ""}
                    onChange={(e) =>
                      setAttendees(
                        attendees.map((a, i) => (i === index ? { ...a, name: e.target.value } : a)),
                      )
                    }
                  />
                </div>
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={() => setAttendees(attendees.filter((_, i) => i !== index))}
                >
                  Remove
                </Button>
              </div>
            ))}
          </div>

          <Button
            variant="ghost"
            size="sm"
            className="mt-2"
            onClick={() => setAttendees([...attendees, { party: "technical", name: "" }])}
          >
            Add an attendee
          </Button>

          {attendees.length === 0 && (
            <p className="mt-1 text-xs text-amber-800">
              At least one, or the report cannot be completed.
            </p>
          )}
          {attendeesNeedingNames(attendees).length > 0 && (
            <p className="mt-1 text-xs text-amber-800">
              Name everybody recorded as &ldquo;others&rdquo; — the label on its own records
              nothing.
            </p>
          )}
        </fieldset>

        <div className="mt-3 grid gap-3 sm:grid-cols-2">
          <div>
            <Label htmlFor="visited">Date visited</Label>
            <Input
              id="visited"
              type="date"
              value={inspectedAt}
              onChange={(e) => setInspectedAt(e.target.value)}
            />
          </div>
          <div>
            <Label htmlFor="tags">Tag numbers</Label>
            <Input
              id="tags"
              placeholder="FT-101, PT-204"
              value={tagNumbers}
              onChange={(e) => setTagNumbers(e.target.value)}
            />
          </div>
        </div>

        <div className="mt-3">
          <Label htmlFor="findings">Findings</Label>
          <Textarea
            id="findings"
            rows={6}
            value={findings}
            onChange={(e) => setFindings(e.target.value)}
          />
        </div>

        <div className="mt-3 grid gap-3 sm:grid-cols-2">
          <div>
            <Label htmlFor="hazards">Hazards</Label>
            <Input
              id="hazards"
              placeholder="Confined space, live 480V"
              value={hazards}
              onChange={(e) => setHazards(e.target.value)}
            />
          </div>
          <div>
            <Label htmlFor="permits">Permits required</Label>
            <Input
              id="permits"
              placeholder="Hot work, entry permit"
              value={permits}
              onChange={(e) => setPermits(e.target.value)}
            />
          </div>
        </div>

        <div className="mt-3">
          <Label htmlFor="access">Access constraints</Label>
          <Textarea
            id="access"
            rows={2}
            value={accessConstraints}
            onChange={(e) => setAccessConstraints(e.target.value)}
          />
        </div>

        <fieldset className="mt-3">
          <legend className="text-xs text-text-muted">Utilities available on site</legend>
          <div className="mt-1 flex flex-wrap gap-3">
            {UTILITIES.map((key) => (
              <label key={key} className="flex items-center gap-1.5 text-sm">
                <input
                  type="checkbox"
                  checked={!!utilities[key]}
                  onChange={(e) => setUtilities({ ...utilities, [key]: e.target.checked })}
                />
                {UTILITY_LABELS[key as Utility]}
              </label>
            ))}
          </div>
        </fieldset>

        <div className="mt-3">
          <Label>Measurements</Label>
          <div className="mt-1 space-y-2">
            {measurements.map((row, index) => (
              <div key={index} className="grid gap-2 sm:grid-cols-3">
                <Input
                  aria-label="What was measured"
                  placeholder="Pipe bore"
                  value={row.label}
                  onChange={(e) => updateMeasurement(index, { label: e.target.value })}
                />
                <Input
                  aria-label="Value"
                  placeholder="150"
                  value={row.value}
                  onChange={(e) => updateMeasurement(index, { value: e.target.value })}
                />
                <Input
                  aria-label="Unit"
                  placeholder="mm"
                  value={row.unit}
                  onChange={(e) => updateMeasurement(index, { unit: e.target.value })}
                />
              </div>
            ))}
          </div>
          <Button
            variant="ghost"
            size="sm"
            className="mt-2"
            onClick={() => setMeasurements([...measurements, { label: "", value: "", unit: "" }])}
          >
            Add a measurement
          </Button>
        </div>

        {save.error && <p className="mt-2 text-sm text-danger">{save.error.message}</p>}
        {save.data?.scopeChangeReported && (
          <p className="mt-2 text-sm text-amber-800">
            Sales has been told. They will not be told again if you save this a second time.
          </p>
        )}

        <Button
          className="mt-3"
          disabled={save.isPending}
          onClick={() =>
            save.mutate({
              inspectionId,
              inspectedAt: inspectedAt ? new Date(inspectedAt) : null,
              attendees,
              findings,
              accessConstraints,
              tagNumbers: list(tagNumbers),
              hazards: list(hazards),
              permitsRequired: list(permits),
              measurements: measurements.filter((row) => row.label.trim()),
              utilitiesAvailable: Object.fromEntries(
                Object.entries(utilities).map(([key, available]) => [key, { available }]),
              ),
              scopeChangeIdentified: scopeChange,
              scopeChangeNotes: scopeNotes,
            })
          }
        >
          Save findings
        </Button>
      </Card>
    </>
  );

  function updateMeasurement(index: number, patch: Partial<Measurement>) {
    setMeasurements(measurements.map((row, i) => (i === index ? { ...row, ...patch } : row)));
  }
}

function ReadOnlyFindings({
  data,
}: {
  data: {
    findings: string | null;
    scopeChangeIdentified: boolean;
    scopeChangeNotes: string | null;
    hazards: string[];
    permitsRequired: string[];
    tagNumbers: string[];
    accessConstraints: string | null;
  };
}) {
  return (
    <Card className="p-4">
      <h2 className="text-sm font-semibold">What was found</h2>
      {data.scopeChangeIdentified && (
        <div className="mt-2 rounded-md border border-amber-300 bg-amber-50 p-2.5 text-sm text-amber-900">
          <strong>Scope change.</strong> {data.scopeChangeNotes}
        </div>
      )}
      <p className="mt-2 text-sm whitespace-pre-wrap">{data.findings ?? "—"}</p>
      <dl className="mt-3 space-y-1 text-sm">
        <Row label="Tag numbers" value={data.tagNumbers.join(", ") || "—"} />
        <Row label="Hazards" value={data.hazards.join(", ") || "—"} />
        <Row label="Permits" value={data.permitsRequired.join(", ") || "—"} />
        <Row label="Access" value={data.accessConstraints || "—"} />
      </dl>
      <p className="mt-3 text-xs text-text-muted">
        This report has been approved, so it is no longer editable. An approved report is a
        signature — raise a new inspection rather than rewriting it.
      </p>
    </Card>
  );
}

function StatusActions({
  inspectionId,
  status,
  canApprove,
  missing,
  onDone,
}: {
  inspectionId: string;
  status: string;
  canApprove: boolean;
  missing: string[];
  onDone: () => void;
}) {
  const complete = trpc.operations.completeInspection.useMutation({ onSuccess: onDone });
  const approve = trpc.operations.approveInspection.useMutation({ onSuccess: onDone });

  if (status === "approved") return null;

  return (
    <Card className="p-4">
      <h2 className="text-sm font-semibold">
        {status === "scheduled" ? "Finish the report" : "Sign it off"}
      </h2>

      {status === "scheduled" && missing.length > 0 && (
        <p className="mt-1 text-xs text-text-muted">Still needs: {missing.join("; ")}.</p>
      )}

      {complete.error && <p className="mt-2 text-sm text-danger">{complete.error.message}</p>}
      {approve.error && <p className="mt-2 text-sm text-danger">{approve.error.message}</p>}

      <div className="mt-3 flex gap-2">
        {status === "scheduled" && (
          <Button
            disabled={complete.isPending || missing.length > 0}
            onClick={() => complete.mutate({ inspectionId })}
          >
            Mark complete
          </Button>
        )}
        {status === "completed" &&
          (canApprove ? (
            <Button disabled={approve.isPending} onClick={() => approve.mutate({ inspectionId })}>
              Approve the report
            </Button>
          ) : (
            <p className="text-xs text-text-muted">
              Waiting on the operations manager to sign this off.
            </p>
          ))}
      </div>
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
