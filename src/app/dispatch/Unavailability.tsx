"use client";

import { useState } from "react";
import { Button } from "@/components/ui/button";
import { DateCell } from "@/components/ui/cells";
import { Input, Label, Select } from "@/components/ui/input";
import { Card } from "@/components/ui/layout";
import {
  UNAVAILABILITY_KINDS,
  UNAVAILABILITY_LABELS,
  type UnavailabilityKind,
} from "@/server/core/operations/dispatch-rules";
import { toastError, toastSuccess } from "@/lib/errors";
import { trpc } from "@/lib/trpc/client";

/**
 * §17's who-is-away, on the board that schedules them.
 *
 * ## What was wrong
 *
 * `recordUnavailability`, `listUnavailability` and `removeUnavailability` all existed and none had a
 * caller, so somebody on leave could not be recorded — and the board went on offering them work. The
 * dispatcher found out by ringing a technician who was at a wedding. docs/DECISIONS.md #135's triage.
 *
 * ## Why it belongs here rather than on a person's record
 *
 * Being away is not a fact about somebody, it is a fact about a **week**. The question it answers is
 * "who can I send on Thursday", which is the board's question, and putting the answer three clicks
 * away in an admin screen is how it stops being recorded at all.
 *
 * ## Removable, deliberately
 *
 * Leave gets cancelled. §17 has no concept of a corrected absence and inventing one — a status, a
 * supersede chain — would be ceremony around "they came in after all". A row that should not be
 * there is deleted, and the audit log carries who removed it.
 */
export function Unavailability({ from, to }: { from: Date; to: Date }) {
  const away = trpc.operations.listUnavailability.useQuery({ from, to });
  const people = trpc.admin.listUsers.useQuery(undefined, { retry: false });

  const [adding, setAdding] = useState(false);
  const [userId, setUserId] = useState("");
  const [kind, setKind] = useState<UnavailabilityKind>("leave");
  const [fromDate, setFromDate] = useState(() => from.toISOString().slice(0, 10));
  const [toDate, setToDate] = useState(() => from.toISOString().slice(0, 10));
  const [notes, setNotes] = useState("");

  const record = trpc.operations.recordUnavailability.useMutation({
    onSuccess: () => {
      toastSuccess("Recorded. The board will stop offering them work for those days.");
      setAdding(false);
      setNotes("");
      void away.refetch();
    },
    onError: toastError,
  });

  const remove = trpc.operations.removeUnavailability.useMutation({
    onSuccess: () => {
      toastSuccess("Removed — they are available again.");
      void away.refetch();
    },
    onError: toastError,
  });

  const rows = away.data ?? [];

  return (
    <Card className="mt-4 p-4">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <h2 className="text-sm font-semibold">Who is away</h2>
        {!adding && (
          <Button size="sm" onClick={() => setAdding(true)}>
            Record somebody away
          </Button>
        )}
      </div>
      <p className="mt-0.5 text-xs text-text-muted">
        Anybody here is not offered work for those days. Recording it is what stops a job being
        scheduled onto somebody who is not coming in.
      </p>

      {adding && (
        <div className="mt-3 rounded-md border border-border p-3">
          <div className="grid gap-3 sm:grid-cols-2">
            <div>
              <Label htmlFor="ua-who">Who</Label>
              <Select
                id="ua-who"
                value={userId}
                onChange={(event) => setUserId(event.target.value)}
              >
                <option value="">Choose somebody…</option>
                {people.data?.map((person) => (
                  <option key={person.id} value={person.id}>
                    {person.name}
                  </option>
                ))}
              </Select>
              {people.error && (
                <p className="mt-1 text-xs text-text-muted">
                  The list of people needs admin access. Ask an administrator to record this one.
                </p>
              )}
            </div>
            <div>
              <Label htmlFor="ua-kind">Why</Label>
              <Select
                id="ua-kind"
                value={kind}
                onChange={(event) => setKind(event.target.value as UnavailabilityKind)}
              >
                {UNAVAILABILITY_KINDS.map((value) => (
                  <option key={value} value={value}>
                    {UNAVAILABILITY_LABELS[value]}
                  </option>
                ))}
              </Select>
            </div>
            <div>
              <Label htmlFor="ua-from">From</Label>
              <Input
                id="ua-from"
                type="date"
                value={fromDate}
                onChange={(event) => setFromDate(event.target.value)}
              />
            </div>
            <div>
              <Label htmlFor="ua-to">To</Label>
              <Input
                id="ua-to"
                type="date"
                value={toDate}
                onChange={(event) => setToDate(event.target.value)}
              />
              <p className="mt-1 text-xs text-text-muted">
                Inclusive. One day off is the same date twice.
              </p>
            </div>
            <div className="sm:col-span-2">
              <Label htmlFor="ua-notes">Notes</Label>
              <Input
                id="ua-notes"
                value={notes}
                placeholder="Approved leave, back Monday."
                onChange={(event) => setNotes(event.target.value)}
              />
            </div>
          </div>

          <div className="mt-3 flex gap-2">
            <Button
              size="sm"
              disabled={record.isPending || userId === "" || fromDate === "" || toDate === ""}
              onClick={() =>
                record.mutate({
                  userId,
                  fromDate: new Date(fromDate),
                  toDate: new Date(toDate),
                  kind,
                  notes: notes.trim() === "" ? null : notes.trim(),
                })
              }
            >
              {record.isPending ? "Recording…" : "Record it"}
            </Button>
            <Button variant="ghost" size="sm" onClick={() => setAdding(false)}>
              Discard
            </Button>
          </div>
        </div>
      )}

      {away.isPending && <p className="mt-2 text-sm text-text-muted">Loading…</p>}
      {rows.length === 0 && away.data && (
        <p className="mt-2 text-sm">Everybody is available for these weeks.</p>
      )}

      <ul className="mt-2 space-y-1.5">
        {rows.map((row) => (
          <li
            key={row.id}
            className="flex flex-wrap items-baseline justify-between gap-2 rounded-md border border-border p-2.5 text-sm"
          >
            <span>
              <span className="font-medium">{row.userName ?? "Somebody"}</span>{" "}
              <span className="text-xs text-text-muted">
                {UNAVAILABILITY_LABELS[row.kind as UnavailabilityKind] ?? row.kind} ·{" "}
                <DateCell value={row.fromDate} /> to <DateCell value={row.toDate} />
                {row.notes ? ` · ${row.notes}` : ""}
              </span>
            </span>
            <Button
              variant="ghost"
              size="sm"
              disabled={remove.isPending}
              onClick={() => remove.mutate({ id: row.id })}
            >
              They are back
            </Button>
          </li>
        ))}
      </ul>
    </Card>
  );
}
