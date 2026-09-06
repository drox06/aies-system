"use client";

import { useState } from "react";
import { Button } from "@/components/ui/button";
import { DateCell } from "@/components/ui/cells";
import { Input, Label, Select, Textarea } from "@/components/ui/input";
import { Card, EmptyState, PageHeader } from "@/components/ui/layout";
import { StatusBadge } from "@/components/ui/status-badge";
import {
  COLLECTION_ACTIVITY_LABELS,
  COLLECTION_ACTIVITY_TYPES,
  COLLECTION_OUTCOMES,
  COLLECTION_OUTCOME_LABELS,
  type CollectionActivityType,
  type CollectionOutcome,
} from "@/server/core/finance/collection-rules";
import { trpc } from "@/lib/trpc/client";

/**
 * specs/05-finance-billing.md §5's collection worklist.
 *
 * ## Why this is a different screen from Receivables
 *
 * Receivables is a picture of the debt, read once a month by somebody deciding how the company is
 * doing. This is a queue of work, read every morning by whoever is making the calls. The same rows,
 * ordered by a different question — and merging them would produce a screen that answers neither.
 *
 * ## What each row has to carry
 *
 * §5 asks for the last contact and the promised date, and the reason is that a collections call is
 * mostly about what happened last time. Ringing somebody the day after they promised the 15th spends
 * a relationship for nothing; ringing somebody who broke that promise is a different conversation
 * entirely, and nothing on an ordinary ageing report tells you which you are about to have.
 */

const pesos = (centavos: number) =>
  `₱${(centavos / 100).toLocaleString("en-PH", { minimumFractionDigits: 2 })}`;

export default function CollectionsPage() {
  const worklist = trpc.finance.collectionWorklist.useQuery();
  const utils = trpc.useUtils();

  const [openId, setOpenId] = useState<string | null>(null);
  const [type, setType] = useState<CollectionActivityType>("call");
  const [notes, setNotes] = useState("");
  const [outcome, setOutcome] = useState<CollectionOutcome | "">("");
  const [promisedDate, setPromisedDate] = useState("");

  const log = trpc.finance.logCollectionActivity.useMutation({
    onSuccess: () => {
      setOpenId(null);
      setNotes("");
      setOutcome("");
      setPromisedDate("");
      void utils.finance.collectionWorklist.invalidate();
    },
  });

  if (worklist.isPending) {
    return <p className="text-sm text-text-muted">Loading the worklist…</p>;
  }
  if (worklist.error) {
    return <p className="text-sm text-danger">{worklist.error.message}</p>;
  }

  const rows = worklist.data ?? [];
  const total = rows.reduce((sum, row) => sum + row.balance, 0);

  return (
    <div>
      <PageHeader
        title="Collections"
        description="Overdue statements, worst first — by how much is owed multiplied by how long it has been owed. What to chase, and what was said last time."
      />

      {rows.length === 0 ? (
        <Card className="mt-4 p-4">
          <EmptyState
            title="Nothing is overdue."
            description="A statement appears here the day after its due date, and leaves when it is paid."
          />
        </Card>
      ) : (
        <>
          <Card className="mt-4 p-3">
            <p className="text-sm">
              <span className="tabular font-semibold">{pesos(total)}</span>{" "}
              <span className="text-text-muted">
                overdue across {rows.length} statement{rows.length === 1 ? "" : "s"}
              </span>
            </p>
          </Card>

          <div className="mt-4 space-y-2">
            {rows.map((row) => (
              <Card key={row.id} className="p-3">
                <div className="flex flex-wrap items-baseline justify-between gap-2">
                  <div className="min-w-0">
                    <p className="font-medium">
                      {row.accountName}
                      <span className="ml-2 tabular text-sm text-text-muted">{row.number}</span>
                    </p>
                    <p className="mt-0.5 text-xs text-text-muted">
                      Due <DateCell value={row.dueDate} /> · {row.daysOverdue} days overdue
                    </p>
                  </div>
                  <div className="text-right">
                    <p className="tabular font-semibold">{pesos(row.balance)}</p>
                    {row.suggestion.urgent && <StatusBadge tone="failed">Chase now</StatusBadge>}
                  </div>
                </div>

                {/* The whole point: what to do, and why now. */}
                <div className="mt-2 rounded-md bg-surface-2 p-2">
                  <p className="text-sm font-medium">{row.suggestion.action}</p>
                  <p className="mt-0.5 text-xs text-text-muted">{row.suggestion.because}</p>
                </div>

                {(row.lastContactAt || row.promisedDate) && (
                  <div className="mt-2 text-xs text-text-muted">
                    {row.lastContactAt && (
                      <p>
                        Last contact <DateCell value={row.lastContactAt} /> —{" "}
                        {COLLECTION_ACTIVITY_LABELS[
                          row.lastContactType as CollectionActivityType
                        ] ?? row.lastContactType}
                        {row.lastOutcome && (
                          <>
                            {", "}
                            {COLLECTION_OUTCOME_LABELS[row.lastOutcome as CollectionOutcome] ??
                              row.lastOutcome}
                          </>
                        )}
                        {row.lastContactNotes && <>: &ldquo;{row.lastContactNotes}&rdquo;</>}
                      </p>
                    )}
                    {row.promisedDate && (
                      <p className="mt-0.5">
                        Promised <DateCell value={row.promisedDate} />
                      </p>
                    )}
                  </div>
                )}

                {/* docs/DECISIONS.md #188's automatic cycle, running alongside the human log below. */}
                {row.cycle && row.cycle.state !== "closed" && (
                  <CycleStatus
                    statementId={row.id}
                    cycle={row.cycle}
                    onDone={() => void utils.finance.collectionWorklist.invalidate()}
                  />
                )}

                {openId === row.id ? (
                  <div className="mt-3 rounded-md border border-border p-3">
                    <div className="grid gap-2 sm:grid-cols-2">
                      <div>
                        <Label htmlFor={`type-${row.id}`}>What did you do</Label>
                        <Select
                          id={`type-${row.id}`}
                          value={type}
                          onChange={(event) =>
                            setType(event.target.value as CollectionActivityType)
                          }
                        >
                          {COLLECTION_ACTIVITY_TYPES.map((option) => (
                            <option key={option} value={option}>
                              {COLLECTION_ACTIVITY_LABELS[option]}
                            </option>
                          ))}
                        </Select>
                      </div>
                      <div>
                        <Label htmlFor={`outcome-${row.id}`}>How did it go</Label>
                        <Select
                          id={`outcome-${row.id}`}
                          value={outcome}
                          onChange={(event) =>
                            setOutcome(event.target.value as CollectionOutcome | "")
                          }
                        >
                          <option value="">—</option>
                          {COLLECTION_OUTCOMES.map((option) => (
                            <option key={option} value={option}>
                              {COLLECTION_OUTCOME_LABELS[option]}
                            </option>
                          ))}
                        </Select>
                      </div>
                    </div>

                    <div className="mt-2">
                      <Label htmlFor={`notes-${row.id}`}>What was said</Label>
                      <Textarea
                        id={`notes-${row.id}`}
                        rows={2}
                        value={notes}
                        onChange={(event) => setNotes(event.target.value)}
                      />
                      <p className="mt-1 text-xs text-text-muted">
                        The next person to pick this up reads this and nothing else.
                      </p>
                    </div>

                    <div className="mt-2 w-48">
                      <Label htmlFor={`promised-${row.id}`}>Did they promise a date</Label>
                      <Input
                        id={`promised-${row.id}`}
                        type="date"
                        value={promisedDate}
                        onChange={(event) => setPromisedDate(event.target.value)}
                      />
                    </div>

                    {log.error && <p className="mt-2 text-sm text-danger">{log.error.message}</p>}

                    <div className="mt-3 flex flex-wrap gap-2">
                      <Button
                        size="sm"
                        disabled={log.isPending || notes.trim().length < 3}
                        onClick={() =>
                          log.mutate({
                            statementId: row.id,
                            type,
                            notes,
                            outcome: outcome === "" ? null : outcome,
                            promisedDate: promisedDate ? new Date(promisedDate) : null,
                          })
                        }
                      >
                        {log.isPending ? "Saving…" : "Log it"}
                      </Button>
                      <Button variant="ghost" size="sm" onClick={() => setOpenId(null)}>
                        Cancel
                      </Button>
                    </div>

                    {notes.trim().length < 3 && (
                      <p className="mt-1 text-xs text-text-muted">
                        Write what was said before this can be logged.
                      </p>
                    )}
                  </div>
                ) : (
                  <Button
                    variant="secondary"
                    size="sm"
                    className="mt-3"
                    onClick={() => {
                      setOpenId(row.id);
                      setNotes("");
                      setOutcome("");
                      setPromisedDate("");
                    }}
                  >
                    Log a follow-up
                  </Button>
                )}
              </Card>
            ))}
          </div>
        </>
      )}
    </div>
  );
}

interface CycleInfo {
  state: string;
  weeklyNotifiedCount: number;
  timelinePromptOpenedAt: string | Date | null;
  expectedPaymentDate: string | Date | null;
  missedDateCount: number;
  needsTimeline: boolean;
}

/**
 * docs/DECISIONS.md #188's cycle, read on the same row the human worklist already occupies. The
 * automatic notifications are the platform doing the part nobody should have to remember; this is
 * where the one manual step in the whole cycle — answering "when is payment expected?" — happens.
 */
function CycleStatus({
  statementId,
  cycle,
  onDone,
}: {
  statementId: string;
  cycle: CycleInfo;
  onDone: () => void;
}) {
  const [date, setDate] = useState("");
  const [notes, setNotes] = useState("");

  const setExpected = trpc.finance.setExpectedPaymentDate.useMutation({
    onSuccess: () => {
      setDate("");
      setNotes("");
      onDone();
    },
  });

  if (cycle.state === "matured") {
    return (
      <p className="mt-2 text-xs text-text-muted">
        Matured. Five days of grace before this enters the weekly collections cycle.
      </p>
    );
  }

  if (cycle.state === "dunning") {
    return (
      <p className="mt-2 text-xs text-text-muted">
        In the collections cycle — reminder {cycle.weeklyNotifiedCount} sent.
      </p>
    );
  }

  // awaiting_timeline
  if (cycle.expectedPaymentDate) {
    return (
      <p className="mt-2 text-xs text-text-muted">
        Expected <DateCell value={cycle.expectedPaymentDate} />
        {cycle.missedDateCount > 0 && (
          <span className="text-amber-900">
            {" "}
            — {cycle.missedDateCount} promised date{cycle.missedDateCount === 1 ? "" : "s"} missed
            before this one.
          </span>
        )}
      </p>
    );
  }

  return (
    <div className="mt-2 rounded-md border border-amber-300 bg-amber-50 p-2.5">
      <p className="text-xs text-amber-900">
        Two reminders sent, still unpaid — when is payment expected?
        {cycle.missedDateCount > 0 &&
          ` (${cycle.missedDateCount} date${cycle.missedDateCount === 1 ? "" : "s"} missed already.)`}
      </p>
      <div className="mt-2 flex flex-wrap items-end gap-2">
        <div>
          <Label htmlFor={`expected-${statementId}`}>Expected by</Label>
          <Input
            id={`expected-${statementId}`}
            type="date"
            value={date}
            onChange={(event) => setDate(event.target.value)}
          />
        </div>
        <div className="flex-1 basis-40">
          <Label htmlFor={`expected-notes-${statementId}`}>Notes</Label>
          <Input
            id={`expected-notes-${statementId}`}
            value={notes}
            placeholder="Who said so"
            onChange={(event) => setNotes(event.target.value)}
          />
        </div>
        <Button
          size="sm"
          disabled={setExpected.isPending || !date}
          onClick={() =>
            setExpected.mutate({ statementId, expectedDate: new Date(date), notes: notes || null })
          }
        >
          {setExpected.isPending ? "Saving…" : "Set date"}
        </Button>
      </div>
      {setExpected.error && <p className="mt-1 text-xs text-danger">{setExpected.error.message}</p>}
    </div>
  );
}
