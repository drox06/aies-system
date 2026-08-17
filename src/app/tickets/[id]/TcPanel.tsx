"use client";

import { useState } from "react";
import { Attachments } from "@/components/ui/attachments";
import { Button } from "@/components/ui/button";
import { DateCell } from "@/components/ui/cells";
import { Input, Label, Select, Textarea } from "@/components/ui/input";
import { Card } from "@/components/ui/layout";
import { StatusBadge, type StatusTone } from "@/components/ui/status-badge";
import {
  PUNCH_SEVERITIES,
  PUNCH_SEVERITY_LABELS,
  TC_ENTITY_TYPE,
  TC_RESULTS,
  TC_RESULT_LABELS,
  describeCriterion,
  evaluateMeasurement,
  parseCriterion,
  suggestedResult,
  type Criterion,
  type FunctionalTest,
  type PunchItem,
  type PunchSeverity,
  type TcResult,
} from "@/server/core/operations/tc-rules";
import { trpc } from "@/lib/trpc/client";

/**
 * §10's testing and commissioning, on the ticket.
 *
 * The screen's one job beyond capture is to make provenance visible while it is still cheap to fix.
 * A criterion typed in on the same visit as the reading it judges is legal and sometimes
 * unavoidable, but the person doing it should see that the record will say so — afterwards, the
 * only options are to leave it or to lie about it.
 */

const VERDICT_TONE: Record<string, StatusTone> = {
  pass: "approved",
  fail: "failed",
  indeterminate: "pending",
};

const VERDICT_LABEL: Record<string, string> = {
  pass: "In spec",
  fail: "Out of spec",
  indeterminate: "Unresolved",
};

interface DraftTest extends FunctionalTest {
  criterionText: string;
}

export function TcPanel({ ticketId }: { ticketId: string }) {
  const tc = trpc.operations.listTc.useQuery({ ticketId });
  const promised = trpc.operations.promisedLines.useQuery({ ticketId });
  const me = trpc.system.whoami.useQuery(undefined, { retry: false });

  const permissions = me.data?.permissions ?? [];
  const canExecute = permissions.includes("ticket.execute");
  const canSignOff = permissions.includes("tc.signoff");

  const begin = trpc.operations.beginTc.useMutation({ onSuccess: () => void tc.refetch() });

  if (tc.isPending) return null;
  if (tc.error) {
    return (
      <Card className="p-4">
        <p className="text-sm">{tc.error.message}</p>
      </Card>
    );
  }

  const data = tc.data;
  const open = data.rows.find((row) => !row.completedAt) ?? null;

  return (
    <Card className="p-4">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <h2 className="text-sm font-semibold">Testing &amp; commissioning</h2>
        {data.latest?.result && (
          <StatusBadge tone={data.latest.result === "rejected" ? "failed" : "approved"}>
            {TC_RESULT_LABELS[data.latest.result as TcResult] ?? data.latest.result}
          </StatusBadge>
        )}
      </div>

      {data.rows.length === 0 && (
        <p className="mt-1 text-sm text-text-muted">
          Nothing recorded. Commissioning proves the work meets what was quoted — the certificate it
          produces is what the final bill rests on.
        </p>
      )}

      {data.closeoutBlockers.length > 0 && (
        <div className="mt-3 rounded-md border-2 border-danger/40 bg-danger/5 p-3">
          <p className="text-sm font-semibold text-danger">
            {data.closeoutBlockers.length} critical punch item(s) block project close-out.
          </p>
          <ul className="mt-1 space-y-0.5 text-xs">
            {data.closeoutBlockers.map((item, index) => (
              <li key={index}>
                {item.description}
                {item.ownerId ? "" : " — nobody owns this one"}
              </li>
            ))}
          </ul>
        </div>
      )}

      {data.rows.length > 0 && (
        <ul className="mt-3 space-y-2 text-sm">
          {data.rows.map((row) => (
            <li key={row.id} className="rounded-md border border-border p-2.5">
              <div className="flex flex-wrap items-baseline justify-between gap-2">
                <span className="tabular font-medium">{row.number}</span>
                <span className="text-xs text-text-muted">
                  {row.completedAt ? (
                    <>
                      {row.result} · <DateCell value={row.completedAt} />
                    </>
                  ) : (
                    "in progress"
                  )}
                </span>
              </div>
              {!row.witnessedByCustomer && (
                <p className="mt-0.5 text-xs text-amber-800">
                  The customer did not witness this. Recorded deliberately, not skipped.
                </p>
              )}
              {row.customerWitnessName && (
                <p className="text-xs text-text-muted">
                  Witnessed by {row.customerWitnessName}
                  {row.customerWitnessPosition ? `, ${row.customerWitnessPosition}` : ""}
                </p>
              )}
              {row.completedAt && !row.customerSignatureFileId && (
                <p className="mt-0.5 text-xs text-amber-800">
                  Signed off without the customer&rsquo;s signature. {row.signOffRemarks}
                </p>
              )}
              {/* §10's certificate. A draft prints with its own banner rather than being withheld. */}
              <a
                href={`/api/tc/${row.id}/pdf`}
                className="mt-1 inline-block text-xs underline"
                target="_blank"
                rel="noreferrer"
              >
                Download the certificate
              </a>
            </li>
          ))}
        </ul>
      )}

      <Card className="mt-3 p-3">
        <h3 className="text-sm font-semibold">Certificate and signature</h3>
        <p className="mt-1 text-xs text-text-muted">
          Upload the signed certificate here, then paste its id when signing off. §10 makes this a
          billing trigger — an unsigned one is AIES&rsquo;s word for it.
        </p>
        <div className="mt-2">
          <Attachments entityType={TC_ENTITY_TYPE} entityId={ticketId} />
        </div>
      </Card>

      {canExecute && !open && (
        <Button
          variant="secondary"
          size="sm"
          className="mt-3"
          disabled={begin.isPending}
          onClick={() => begin.mutate({ ticketId })}
        >
          Start commissioning
        </Button>
      )}
      {begin.error && <p className="mt-2 text-sm text-danger">{begin.error.message}</p>}

      {open && (
        <TcWorksheet
          record={open}
          promisedLines={promised.data?.lines ?? []}
          promisedNote={promised.data?.note ?? null}
          canSignOff={canSignOff}
          onSaved={() => void tc.refetch()}
        />
      )}
    </Card>
  );
}

function TcWorksheet({
  record,
  promisedLines,
  promisedNote,
  canSignOff,
  onSaved,
}: {
  record: {
    id: string;
    number: string;
    functionalTests: FunctionalTest[];
    punchItems: PunchItem[];
    calibrationAssetsUsed: string[];
    witnessedByCustomer: boolean;
    customerWitnessName: string | null;
    customerWitnessPosition: string | null;
  };
  promisedLines: { quotationLineId: string | null; description: string; promiseText: string }[];
  promisedNote: string | null;
  canSignOff: boolean;
  onSaved: () => void;
}) {
  const [tests, setTests] = useState<DraftTest[]>(() =>
    record.functionalTests.map((test) => ({
      ...test,
      criterionText: test.criterion ? describeCriterion(test.criterion) : "",
    })),
  );
  const [punchItems, setPunchItems] = useState<PunchItem[]>(record.punchItems);
  const [instruments, setInstruments] = useState(record.calibrationAssetsUsed.join(", "));
  const [witnessed, setWitnessed] = useState(record.witnessedByCustomer);
  const [witnessName, setWitnessName] = useState(record.customerWitnessName ?? "");
  const [witnessPosition, setWitnessPosition] = useState(record.customerWitnessPosition ?? "");

  const [result, setResult] = useState<TcResult>("accepted");
  const [signatureFileId, setSignatureFileId] = useState("");
  const [signOffRemarks, setSignOffRemarks] = useState("");
  const [remarks, setRemarks] = useState("");

  const save = trpc.operations.saveTc.useMutation({ onSuccess: onSaved });
  const complete = trpc.operations.completeTc.useMutation({ onSuccess: onSaved });

  const parsedFor = (draft: DraftTest) =>
    draft.criterionText.trim() ? parseCriterion(draft.criterionText) : { criterion: null };

  const evaluated = tests.map((draft) => {
    const parsed = parsedFor(draft);
    return { draft, parsed, evaluation: evaluateMeasurement(parsed.criterion, draft.measured) };
  });

  const suggestion = suggestedResult(
    tests.map((draft) => ({ ...draft, criterion: parsedFor(draft).criterion })),
    punchItems,
  );

  const setTest = (index: number, patch: Partial<DraftTest>) =>
    setTests(tests.map((test, i) => (i === index ? { ...test, ...patch } : test)));

  const payloadTests = tests.map((draft) => {
    const { criterionText, ...rest } = draft;
    void criterionText;
    return { ...rest, criterion: parsedFor(draft).criterion as Criterion | null };
  });

  return (
    <div className="mt-3 space-y-4 rounded-md border border-border p-3">
      <div className="flex items-baseline justify-between">
        <span className="tabular text-sm font-medium">{record.number}</span>
        <span className="text-xs text-text-muted">in progress</span>
      </div>

      <div>
        <Label>Tests</Label>
        <p className="mt-0.5 text-xs text-text-muted">
          Write the criterion before taking the reading where you can. The record keeps both
          timestamps, and one written afterwards proves less — §10 asks for results judged against
          the quoted specification, not against a number chosen once the answer was known.
        </p>

        {promisedNote && <p className="mt-1 text-xs text-amber-800">{promisedNote}</p>}

        <div className="mt-2 space-y-3">
          {evaluated.map(({ draft, parsed, evaluation }, index) => (
            <div key={index} className="rounded-md border border-border p-2.5">
              <div className="grid gap-2 sm:grid-cols-2">
                <div>
                  <Label htmlFor={`tc-test-${index}`}>Test</Label>
                  <Input
                    id={`tc-test-${index}`}
                    placeholder="Loop 4-20mA output"
                    value={draft.test}
                    onChange={(e) => setTest(index, { test: e.target.value })}
                  />
                </div>
                <div>
                  <Label htmlFor={`tc-criterion-${index}`}>Criterion</Label>
                  <Input
                    id={`tc-criterion-${index}`}
                    placeholder="4-20, >= 5, 230 ± 2%, no leaks"
                    value={draft.criterionText}
                    onChange={(e) => setTest(index, { criterionText: e.target.value })}
                  />
                </div>
                <div>
                  <Label htmlFor={`tc-measured-${index}`}>Measured</Label>
                  <Input
                    id={`tc-measured-${index}`}
                    value={draft.measured == null ? "" : String(draft.measured)}
                    onChange={(e) => setTest(index, { measured: e.target.value })}
                  />
                </div>
                <div>
                  <Label htmlFor={`tc-line-${index}`}>Read from</Label>
                  <Select
                    id={`tc-line-${index}`}
                    value={draft.quotationLineId ?? ""}
                    onChange={(e) =>
                      setTest(index, {
                        quotationLineId: e.target.value || null,
                        criterionSource: e.target.value ? "quotation" : "stated",
                        promiseText:
                          promisedLines.find((line) => line.quotationLineId === e.target.value)
                            ?.promiseText ?? null,
                      })
                    }
                  >
                    <option value="">Stated here — no quoted line</option>
                    {promisedLines
                      .filter((line) => line.quotationLineId)
                      .map((line) => (
                        <option key={line.quotationLineId} value={line.quotationLineId!}>
                          {line.description}
                        </option>
                      ))}
                  </Select>
                </div>
              </div>

              {parsed.error && <p className="mt-1 text-xs text-danger">{parsed.error}</p>}

              <div className="mt-1.5 flex flex-wrap items-center gap-2">
                <StatusBadge tone={VERDICT_TONE[evaluation.verdict]!}>
                  {VERDICT_LABEL[evaluation.verdict]}
                </StatusBadge>
                <span className="text-xs text-text-muted">{evaluation.reason}</span>
              </div>

              {draft.criterionSource !== "quotation" && (
                <p className="mt-1 text-xs text-amber-800">
                  No quoted line behind this criterion. Allowed, and recorded as such.
                </p>
              )}
            </div>
          ))}
        </div>

        <Button
          variant="ghost"
          size="sm"
          className="mt-2"
          onClick={() =>
            setTests([
              ...tests,
              { test: "", criterionText: "", criterionSource: "stated", measured: null },
            ])
          }
        >
          Add a test
        </Button>
      </div>

      <div>
        <Label htmlFor="tc-instruments">Instruments used</Label>
        <Input
          id="tc-instruments"
          placeholder="FLUKE-744, MEG-5000"
          value={instruments}
          onChange={(e) => setInstruments(e.target.value)}
        />
        <p className="mt-0.5 text-xs text-text-muted">
          §10 wants these for traceability. A reading whose instrument nobody can name is hard to
          defend later.
        </p>
      </div>

      <div>
        <Label>Punch list</Label>
        <p className="mt-0.5 text-xs text-text-muted">
          Critical items block project close-out, so give them an owner.
        </p>
        <div className="mt-2 space-y-2">
          {punchItems.map((item, index) => (
            <div key={index} className="grid gap-2 sm:grid-cols-[1fr_10rem]">
              <Input
                aria-label="Punch item"
                placeholder="Earth bond missing on panel 2"
                value={item.description}
                onChange={(e) =>
                  setPunchItems(
                    punchItems.map((p, i) =>
                      i === index ? { ...p, description: e.target.value } : p,
                    ),
                  )
                }
              />
              <Select
                aria-label="Severity"
                value={item.severity}
                onChange={(e) =>
                  setPunchItems(
                    punchItems.map((p, i) =>
                      i === index ? { ...p, severity: e.target.value as PunchSeverity } : p,
                    ),
                  )
                }
              >
                {PUNCH_SEVERITIES.map((severity) => (
                  <option key={severity} value={severity}>
                    {PUNCH_SEVERITY_LABELS[severity]}
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
          onClick={() => setPunchItems([...punchItems, { description: "", severity: "minor" }])}
        >
          Add a punch item
        </Button>
      </div>

      <label className="flex items-start gap-2 text-sm">
        <input
          type="checkbox"
          className="mt-1"
          checked={!witnessed}
          onChange={(e) => setWitnessed(!e.target.checked)}
        />
        <span>
          The customer did not witness commissioning
          <span className="mt-0.5 block text-xs text-text-muted">
            Recorded deliberately rather than left blank. Say why in the remarks.
          </span>
        </span>
      </label>

      {witnessed && (
        <div className="grid gap-3 sm:grid-cols-2">
          <div>
            <Label htmlFor="tc-witness">Who witnessed</Label>
            <Input
              id="tc-witness"
              value={witnessName}
              onChange={(e) => setWitnessName(e.target.value)}
            />
          </div>
          <div>
            <Label htmlFor="tc-witness-position">Their position</Label>
            <Input
              id="tc-witness-position"
              value={witnessPosition}
              onChange={(e) => setWitnessPosition(e.target.value)}
            />
          </div>
        </div>
      )}

      {save.error && <p className="text-sm text-danger">{save.error.message}</p>}

      <Button
        size="sm"
        variant="secondary"
        disabled={save.isPending}
        onClick={() =>
          save.mutate({
            id: record.id,
            functionalTests: payloadTests,
            punchItems: punchItems.filter((item) => item.description.trim()),
            calibrationAssetsUsed: instruments
              .split(",")
              .map((entry) => entry.trim())
              .filter(Boolean),
            witnessedByCustomer: witnessed,
            customerWitnessName: witnessName || null,
            customerWitnessPosition: witnessPosition || null,
          })
        }
      >
        Save the worksheet
      </Button>

      {canSignOff && (
        <div className="space-y-3 rounded-md border border-border p-3">
          <h3 className="text-sm font-semibold">Sign off</h3>
          <p className="text-xs text-text-muted">
            Save the worksheet first — sign-off reads what is stored, not what is on screen.
          </p>

          <div className="rounded-md border border-border bg-surface-muted p-2.5 text-xs">
            From the readings: <strong>{TC_RESULT_LABELS[suggestion.result]}</strong> —{" "}
            {suggestion.because} You choose the word; this is only what the numbers say.
          </div>

          <div className="grid gap-3 sm:grid-cols-2">
            <div>
              <Label htmlFor="tc-result">Result</Label>
              <Select
                id="tc-result"
                value={result}
                onChange={(e) => setResult(e.target.value as TcResult)}
              >
                {TC_RESULTS.map((value) => (
                  <option key={value} value={value}>
                    {TC_RESULT_LABELS[value]}
                  </option>
                ))}
              </Select>
            </div>
            <div>
              <Label htmlFor="tc-signature">Customer signature file id</Label>
              <Input
                id="tc-signature"
                placeholder="Paste from the attachments above"
                value={signatureFileId}
                onChange={(e) => setSignatureFileId(e.target.value)}
              />
            </div>
          </div>

          {!signatureFileId && (
            <div className="rounded-md border-2 border-amber-400 bg-amber-50 p-3">
              <p className="text-sm font-semibold text-amber-900">
                No customer signature attached.
              </p>
              <p className="mt-1 text-sm text-amber-900">
                §10 makes this certificate a billing trigger. Sign off without one only if there
                genuinely is none, and say why below — it goes on the record.
              </p>
              <div className="mt-2">
                <Label htmlFor="tc-signoff-remarks">Why there is no signature</Label>
                <Textarea
                  id="tc-signoff-remarks"
                  rows={2}
                  value={signOffRemarks}
                  onChange={(e) => setSignOffRemarks(e.target.value)}
                />
              </div>
            </div>
          )}

          <div>
            <Label htmlFor="tc-remarks">Remarks</Label>
            <Textarea
              id="tc-remarks"
              rows={2}
              value={remarks}
              onChange={(e) => setRemarks(e.target.value)}
            />
          </div>

          {complete.error && <p className="text-sm text-danger">{complete.error.message}</p>}
          {complete.data?.warnings && complete.data.warnings.length > 0 && (
            <ul className="space-y-0.5 text-xs text-amber-800">
              {complete.data.warnings.map((warning, index) => (
                <li key={index}>{warning}</li>
              ))}
            </ul>
          )}

          <Button
            size="sm"
            disabled={complete.isPending || (!signatureFileId && !signOffRemarks.trim())}
            onClick={() =>
              complete.mutate({
                id: record.id,
                result,
                remarks: remarks || null,
                customerSignatureFileId: signatureFileId || null,
                signOffRemarks: signOffRemarks || null,
              })
            }
          >
            Complete commissioning
          </Button>

          <p className="text-xs text-text-muted">
            {result === "rejected"
              ? "Rejecting sends the ticket back to the crew — §10's loop, as the flowchart draws it."
              : "Accepting moves the ticket to close-out. Critical punch items keep it blocked there."}
          </p>
        </div>
      )}
    </div>
  );
}
