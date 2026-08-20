"use client";

import { useState } from "react";
import { Button } from "@/components/ui/button";
import { DateCell } from "@/components/ui/cells";
import { Input, Label } from "@/components/ui/input";
import { Card, PageHeader } from "@/components/ui/layout";
import { formatMoney } from "@/lib/format";
import { toastError, toastSuccess } from "@/lib/errors";
import { trpc } from "@/lib/trpc/client";

/**
 * §6's cost rates — the screen the P&L's caveat was pointing at, and which did not exist.
 *
 * ## What was wrong
 *
 * `CostRate` had no service, no router procedure and no screen. §6's P&L priced labour from it and
 * reported *"N days with no rate"* when it found none — a caveat whose only possible action was
 * impossible. The company walked the P&L, read it, and asked "where do I look for these?"
 *
 * So the screen leads with **the unanswered question** rather than with the register: whoever
 * arrives here almost certainly came from that caveat, and the first thing they should see is the
 * whole of what needs fixing, including how far back it runs.
 *
 * ## Why the history is on screen and not behind an edit button
 *
 * A rate is not a setting; it is a record of what was true. A job costed in March must keep March's
 * rate however many rises have happened since, or last year's margins move every time payroll does.
 * Showing the history makes that visible rather than surprising — and makes it obvious that setting
 * a new rate adds a row rather than overwriting one.
 */
export default function CostRatesPage() {
  const rates = trpc.finance.costRates.useQuery();
  const uncosted = trpc.finance.uncostedDays.useQuery();
  const [editing, setEditing] = useState<string | null>(null);

  function refresh() {
    void rates.refetch();
    void uncosted.refetch();
  }

  return (
    <div className="mx-auto max-w-5xl">
      <PageHeader
        title="Cost rates"
        description="What an hour of somebody's time costs, and what it cost on the day a job was worked."
      />

      {/*
        The gap, first.

        Shown even when empty, and saying so: "nothing is unpriced" is an answer, and a panel that
        only appears when there is a problem is one nobody learns to trust the absence of.
      */}
      <Card className="mt-4 p-4">
        <h2 className="text-sm font-semibold">Days that cannot be priced</h2>
        {uncosted.isPending && <p className="mt-2 text-sm text-text-muted">Checking…</p>}

        {uncosted.data && uncosted.data.length === 0 && (
          <p className="mt-2 text-sm">
            Every approved timesheet has a rate in force on the day it was worked. Nothing is
            missing.
          </p>
        )}

        {uncosted.data && uncosted.data.length > 0 && (
          <>
            <p className="mt-1 text-xs text-text-muted">
              These days are counted as <strong>uncosted</strong> on every project P&amp;L they
              touch — not as free. Each is labour the margin does not know about.
            </p>
            <ul className="mt-2 space-y-1.5">
              {uncosted.data.map((row) => (
                <li
                  key={row.userId}
                  className="flex flex-wrap items-baseline justify-between gap-2 rounded-md border-2 border-amber-400 bg-amber-50 p-2.5 text-sm text-amber-900"
                >
                  <span>
                    <strong>{row.name}</strong> — {row.days} {row.days === 1 ? "day" : "days"} with
                    no rate
                  </span>
                  <span className="text-xs">
                    {/*
                      The earliest day decides the start date of the fix. A rate entered from today
                      leaves everything before it still uncosted, and somebody who cannot see how far
                      back the gap runs will do exactly that and wonder why nothing changed.
                    */}
                    earliest <DateCell value={row.earliestDay} /> — a rate must start on or before
                    this to cover them all
                  </span>
                </li>
              ))}
            </ul>
          </>
        )}
      </Card>

      {rates.error && (
        <Card className="mt-4 p-4">
          <p className="text-sm">{rates.error.message}</p>
        </Card>
      )}

      {rates.data && (
        <ul className="mt-4 space-y-2">
          {rates.data.map((person) => (
            <li key={person.userId} className="rounded-md border border-border p-3">
              <div className="flex flex-wrap items-baseline justify-between gap-2">
                <span className="flex flex-wrap items-baseline gap-2">
                  <span className="font-medium">{person.name}</span>
                  {!person.isActive && (
                    <span className="text-xs text-text-muted">no longer active</span>
                  )}
                </span>
                <span className="text-sm">
                  {person.current ? (
                    <>
                      <span className="tabular font-medium">
                        {formatMoney(person.current.hourlyCost, "PHP")}
                      </span>
                      <span className="text-xs text-text-muted"> / hour</span>
                      <span className="text-xs text-text-muted">
                        {" · overtime ×"}
                        {Number(person.current.overtimeMultiplier)}
                        {" · travel ×"}
                        {Number(person.current.travelMultiplier)}
                      </span>
                    </>
                  ) : (
                    /*
                      Not "PHP 0.00". A rate of zero is a real statement — an unpaid director — and
                      it is not the same as nobody having decided. Showing a zero here would make the
                      P&L's uncosted caveat look like a contradiction.
                    */
                    <span className="text-sm text-text-muted">No rate set</span>
                  )}
                </span>
              </div>

              {person.current && (
                <p className="mt-0.5 text-xs text-text-muted">
                  In force since <DateCell value={person.current.effectiveFrom} />
                </p>
              )}

              {person.history.length > 1 && (
                <details className="mt-2">
                  <summary className="cursor-pointer text-xs text-text-muted">
                    {person.history.length} rates on record
                  </summary>
                  <table className="mt-1.5 w-full text-xs">
                    <tbody>
                      {person.history.map((rate) => (
                        <tr key={rate.id} className="border-b border-border last:border-0">
                          <td className="py-1">
                            from <DateCell value={rate.effectiveFrom} />
                          </td>
                          <td className="tabular py-1 text-right">
                            {formatMoney(rate.hourlyCost, "PHP")}
                          </td>
                          <td className="py-1 pl-3 text-text-muted">
                            ×{Number(rate.overtimeMultiplier)} overtime
                          </td>
                          <td className="py-1 pl-3 text-text-muted">{rate.notes}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </details>
              )}

              {editing === person.userId ? (
                <SetRate
                  userId={person.userId}
                  name={person.name}
                  onDone={() => {
                    setEditing(null);
                    refresh();
                  }}
                  onCancel={() => setEditing(null)}
                />
              ) : (
                <Button
                  variant="secondary"
                  size="sm"
                  className="mt-2"
                  onClick={() => setEditing(person.userId)}
                >
                  {person.current ? "Set a new rate" : "Set a rate"}
                </Button>
              )}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

/**
 * Setting a rate, which adds a row rather than replacing one.
 *
 * The start date is asked for rather than assumed to be today, because the commonest reason anybody
 * opens this screen is to cover days already worked — and a rate that starts today leaves every one
 * of those still uncosted.
 */
function SetRate({
  userId,
  name,
  onDone,
  onCancel,
}: {
  userId: string;
  name: string;
  onDone: () => void;
  onCancel: () => void;
}) {
  const [hourlyCost, setHourlyCost] = useState("");
  const [effectiveFrom, setEffectiveFrom] = useState(() => new Date().toISOString().slice(0, 10));
  const [overtime, setOvertime] = useState("1.25");
  const [travel, setTravel] = useState("1");
  const [standby, setStandby] = useState("1");
  const [notes, setNotes] = useState("");

  const save = trpc.finance.setCostRate.useMutation({
    onSuccess: (result) => {
      toastSuccess(
        result.replaced
          ? `${name}'s rate for that date corrected.`
          : `${name}'s rate set. Days on or after that date can now be priced.`,
      );
      onDone();
    },
    onError: toastError,
  });

  const parsed = Number(hourlyCost);
  const canSave = Number.isFinite(parsed) && parsed >= 0 && hourlyCost.trim() !== "";

  return (
    <div className="mt-2 rounded-md border border-border p-3">
      <div className="grid gap-3 sm:grid-cols-2">
        <div>
          <Label htmlFor={`cr-cost-${userId}`}>Cost per hour</Label>
          <Input
            id={`cr-cost-${userId}`}
            type="number"
            step="0.01"
            min="0"
            value={hourlyCost}
            onChange={(event) => setHourlyCost(event.target.value)}
          />
          <p className="mt-1 text-xs text-text-muted">
            What the hour costs AIES, not what it is billed at.
          </p>
        </div>
        <div>
          <Label htmlFor={`cr-from-${userId}`}>In force from</Label>
          <Input
            id={`cr-from-${userId}`}
            type="date"
            value={effectiveFrom}
            onChange={(event) => setEffectiveFrom(event.target.value)}
          />
          <p className="mt-1 text-xs text-text-muted">
            Backdate it to cover days already worked. Earlier rates are kept, so past jobs keep the
            figures they were costed at.
          </p>
        </div>
        <div>
          <Label htmlFor={`cr-ot-${userId}`}>Overtime multiplier</Label>
          <Input
            id={`cr-ot-${userId}`}
            type="number"
            step="0.05"
            min="1"
            value={overtime}
            onChange={(event) => setOvertime(event.target.value)}
          />
          <p className="mt-1 text-xs text-text-muted">
            1.25 for ordinary overtime; higher on rest days and holidays.
          </p>
        </div>
        <div>
          <Label htmlFor={`cr-travel-${userId}`}>Travel multiplier</Label>
          <Input
            id={`cr-travel-${userId}`}
            type="number"
            step="0.05"
            min="1"
            value={travel}
            onChange={(event) => setTravel(event.target.value)}
          />
        </div>
        <div>
          <Label htmlFor={`cr-standby-${userId}`}>Standby multiplier</Label>
          <Input
            id={`cr-standby-${userId}`}
            type="number"
            step="0.05"
            min="1"
            value={standby}
            onChange={(event) => setStandby(event.target.value)}
          />
        </div>
        <div>
          <Label htmlFor={`cr-notes-${userId}`}>Why</Label>
          <Input
            id={`cr-notes-${userId}`}
            value={notes}
            placeholder="Annual review, effective January."
            onChange={(event) => setNotes(event.target.value)}
          />
        </div>
      </div>

      <div className="mt-3 flex gap-2">
        <Button
          size="sm"
          disabled={!canSave || save.isPending}
          onClick={() =>
            save.mutate({
              userId,
              effectiveFrom: new Date(effectiveFrom),
              hourlyCost: parsed,
              overtimeMultiplier: Number(overtime),
              travelMultiplier: Number(travel),
              standbyMultiplier: Number(standby),
              notes: notes.trim() === "" ? null : notes.trim(),
            })
          }
        >
          {save.isPending ? "Saving…" : "Save the rate"}
        </Button>
        <Button variant="ghost" size="sm" onClick={onCancel}>
          Discard
        </Button>
      </div>
    </div>
  );
}
