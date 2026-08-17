"use client";

import { useState } from "react";
import { Button } from "@/components/ui/button";
import { DateCell } from "@/components/ui/cells";
import { Input, Label, Select, Textarea } from "@/components/ui/input";
import { Card } from "@/components/ui/layout";
import { StatusBadge } from "@/components/ui/status-badge";
import {
  STANDBY_CAUSES,
  STANDBY_CAUSE_LABELS,
  type StandbyCause,
} from "@/server/core/operations/daily-progress-rules";
import { trpc } from "@/lib/trpc/client";

/**
 * §8's daily log, on the ticket.
 *
 * Two things are deliberate about the layout.
 *
 * **The steps come from the method statement**, not a text box. §8 logs progress "against the
 * methodology's sequence of work", and a percentage nobody can trace to a step is a number somebody
 * made up.
 *
 * **Standby is asked about every day, not only on bad ones.** §8: "This is the evidence base for a
 * variation claim, and today it exists only in people's memory." A field somebody has to go looking
 * for is one they fill in after the argument has already started.
 */
export function ProgressPanel({ ticketId }: { ticketId: string }) {
  const progress = trpc.operations.listProgress.useQuery({ ticketId });
  const steps = trpc.operations.progressSteps.useQuery({ ticketId });
  const me = trpc.system.whoami.useQuery(undefined, { retry: false });
  const [open, setOpen] = useState(false);

  const canLog = (me.data?.permissions ?? []).includes("ticket.execute");

  if (progress.isPending) return null;
  if (progress.error) {
    return (
      <Card className="p-4">
        <p className="text-sm">{progress.error.message}</p>
      </Card>
    );
  }

  const data = progress.data;

  return (
    <Card className="p-4">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <h2 className="text-sm font-semibold">Daily progress</h2>
        {/* §8's report, "where the customer requires them" — generated on demand, not stored. */}
        <a
          href={`/api/tickets/${ticketId}/progress-pdf`}
          className="text-xs underline"
          target="_blank"
          rel="noreferrer"
        >
          Download the progress report
        </a>
        <StatusBadge tone={data.percentComplete >= 100 ? "approved" : "info"}>
          {data.percentComplete}% complete
        </StatusBadge>
      </div>

      {data.standby.totalStandbyHours > 0 && (
        <div className="mt-2 rounded-md border border-amber-300 bg-amber-50 p-3">
          <p className="text-sm text-amber-900">{data.standby.message}</p>
          <ul className="mt-1.5 space-y-0.5 text-xs text-amber-900">
            {data.standby.byCause.map((row) => (
              <li key={row.cause}>
                {row.label}: {row.hours}h{" "}
                <span className="text-amber-800">
                  (
                  {row.attribution === "customer"
                    ? "customer's"
                    : row.attribution === "aies"
                      ? "ours"
                      : "neither"}
                  )
                </span>
              </li>
            ))}
          </ul>
        </div>
      )}

      {data.rows.length === 0 && (
        <p className="mt-1 text-sm text-text-muted">
          Nothing logged yet. A day recorded at the time is worth more than a day remembered.
        </p>
      )}

      {data.rows.length > 0 && (
        <ul className="mt-3 space-y-2 text-sm">
          {data.rows.slice(0, 10).map((row) => (
            <li key={row.id} className="rounded-md border border-border p-2.5">
              <div className="flex flex-wrap items-baseline justify-between gap-2">
                <span className="font-medium">
                  <DateCell value={row.logDate} />
                </span>
                <span className="text-xs text-text-muted">
                  {row.percentComplete}% · {row.hoursWorked}h worked
                  {Number(row.standbyHours) > 0 && (
                    <span className="text-amber-800">
                      {" "}
                      · {row.standbyHours}h standby
                      {row.standbyCause
                        ? ` (${STANDBY_CAUSE_LABELS[row.standbyCause as StandbyCause] ?? row.standbyCause})`
                        : ""}
                    </span>
                  )}
                </span>
              </div>
              {row.stepsCompleted.length > 0 && (
                <p className="text-xs text-text-muted">
                  Steps done: {row.stepsCompleted.join(", ")}
                </p>
              )}
              {row.issuesRaised && <p className="mt-1 text-xs">{row.issuesRaised}</p>}
            </li>
          ))}
        </ul>
      )}

      {canLog && !open && (
        <Button variant="secondary" size="sm" className="mt-3" onClick={() => setOpen(true)}>
          Log a day
        </Button>
      )}

      {open && (
        <LogForm
          ticketId={ticketId}
          steps={steps.data?.steps ?? []}
          methodologyNumber={steps.data?.methodology?.number ?? null}
          onDone={() => {
            setOpen(false);
            void progress.refetch();
          }}
          onCancel={() => setOpen(false)}
        />
      )}
    </Card>
  );
}

function LogForm({
  ticketId,
  steps,
  methodologyNumber,
  onDone,
  onCancel,
}: {
  ticketId: string;
  steps: { step: number; description: string }[];
  methodologyNumber: string | null;
  onDone: () => void;
  onCancel: () => void;
}) {
  const [logDate, setLogDate] = useState(new Date().toISOString().slice(0, 10));
  const [percent, setPercent] = useState("0");
  const [manpower, setManpower] = useState("0");
  const [hours, setHours] = useState("0");
  const [weather, setWeather] = useState("");
  const [standbyHours, setStandbyHours] = useState("0");
  const [standbyCause, setStandbyCause] = useState<StandbyCause | "">("");
  const [standbyNotes, setStandbyNotes] = useState("");
  const [issues, setIssues] = useState("");
  const [done, setDone] = useState<number[]>([]);

  const log = trpc.operations.logDay.useMutation({ onSuccess: onDone });
  const hasStandby = Number(standbyHours) > 0;

  return (
    <div className="mt-3 space-y-3 rounded-md border border-border p-3">
      <div className="grid gap-3 sm:grid-cols-4">
        <div>
          <Label htmlFor="p-date">Day</Label>
          <Input
            id="p-date"
            type="date"
            value={logDate}
            onChange={(e) => setLogDate(e.target.value)}
          />
        </div>
        <div>
          <Label htmlFor="p-percent">Percent complete</Label>
          <Input
            id="p-percent"
            type="number"
            min={0}
            max={100}
            value={percent}
            onChange={(e) => setPercent(e.target.value)}
          />
        </div>
        <div>
          <Label htmlFor="p-crew">Crew on site</Label>
          <Input
            id="p-crew"
            type="number"
            min={0}
            value={manpower}
            onChange={(e) => setManpower(e.target.value)}
          />
        </div>
        <div>
          <Label htmlFor="p-hours">Hours worked</Label>
          <Input
            id="p-hours"
            type="number"
            min={0}
            step="any"
            value={hours}
            onChange={(e) => setHours(e.target.value)}
          />
        </div>
      </div>

      {steps.length > 0 ? (
        <fieldset>
          <legend className="text-xs text-text-muted">
            Steps finished today — from {methodologyNumber}
          </legend>
          <div className="mt-1 space-y-1">
            {steps.map((step) => (
              <label key={step.step} className="flex items-start gap-2 text-sm">
                <input
                  type="checkbox"
                  className="mt-1"
                  checked={done.includes(step.step)}
                  onChange={(e) =>
                    setDone(
                      e.target.checked ? [...done, step.step] : done.filter((n) => n !== step.step),
                    )
                  }
                />
                <span>
                  <span className="tabular text-text-muted">{step.step}.</span> {step.description}
                </span>
              </label>
            ))}
          </div>
        </fieldset>
      ) : (
        <p className="text-xs text-text-muted">
          {/* Honest rather than an empty box: an after-sales callout usually has no method statement. */}
          No method statement on this ticket, so there is no sequence of work to tick against. The
          percentage and the notes are what this day leaves behind.
        </p>
      )}

      {/*
        Asked every day, not only when something went wrong. §8's claim is built from days recorded
        at the time; a field somebody goes looking for is filled in after the argument starts.
      */}
      <div className="rounded-md border border-border p-2.5">
        <div className="grid gap-3 sm:grid-cols-2">
          <div>
            <Label htmlFor="p-standby">Standby hours</Label>
            <Input
              id="p-standby"
              type="number"
              min={0}
              step="any"
              value={standbyHours}
              onChange={(e) => setStandbyHours(e.target.value)}
            />
          </div>
          <div>
            <Label htmlFor="p-cause">Cause</Label>
            <Select
              id="p-cause"
              value={standbyCause}
              disabled={!hasStandby}
              onChange={(e) => setStandbyCause(e.target.value as StandbyCause | "")}
            >
              <option value="">—</option>
              {STANDBY_CAUSES.map((cause) => (
                <option key={cause} value={cause}>
                  {STANDBY_CAUSE_LABELS[cause]}
                </option>
              ))}
            </Select>
          </div>
        </div>
        {hasStandby && (
          <div className="mt-2">
            <Label htmlFor="p-standby-notes">What happened</Label>
            <Input
              id="p-standby-notes"
              value={standbyNotes}
              onChange={(e) => setStandbyNotes(e.target.value)}
            />
            <p className="mt-1 text-xs text-text-muted">
              Standby caused by the customer is what a variation claim rests on. Recording it today
              is the difference between a claim and a memory.
            </p>
          </div>
        )}
      </div>

      <div className="grid gap-3 sm:grid-cols-2">
        <div>
          <Label htmlFor="p-weather">Weather</Label>
          <Input id="p-weather" value={weather} onChange={(e) => setWeather(e.target.value)} />
        </div>
        <div>
          <Label htmlFor="p-issues">Issues raised</Label>
          <Textarea
            id="p-issues"
            rows={2}
            value={issues}
            onChange={(e) => setIssues(e.target.value)}
          />
        </div>
      </div>

      {log.error && <p className="text-sm text-danger">{log.error.message}</p>}
      {log.data?.warnings && log.data.warnings.length > 0 && (
        <ul className="space-y-0.5 text-xs text-amber-800">
          {log.data.warnings.map((warning, index) => (
            <li key={index}>{warning}</li>
          ))}
        </ul>
      )}

      <div className="flex gap-2">
        <Button
          size="sm"
          disabled={log.isPending || (hasStandby && !standbyCause)}
          onClick={() =>
            log.mutate({
              ticketId,
              logDate: new Date(logDate),
              stepsCompleted: done,
              percentComplete: Number(percent) || 0,
              manpowerOnSite: Number(manpower) || 0,
              hoursWorked: Number(hours) || 0,
              weather: weather || null,
              standbyHours: Number(standbyHours) || 0,
              standbyCause: standbyCause || null,
              standbyNotes: standbyNotes || null,
              issuesRaised: issues || null,
            })
          }
        >
          Save the day
        </Button>
        <Button variant="ghost" size="sm" onClick={onCancel}>
          Cancel
        </Button>
      </div>
      <p className="text-xs text-text-muted">
        Saving the same day again corrects it. There is only ever one log per day.
      </p>
    </div>
  );
}
