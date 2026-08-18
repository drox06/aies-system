"use client";

import { useState } from "react";
import { Button } from "@/components/ui/button";
import { DateCell } from "@/components/ui/cells";
import { Input, Label } from "@/components/ui/input";
import { Card } from "@/components/ui/layout";
import { trpc } from "@/lib/trpc/client";

/**
 * §17's scheduling, where the job is.
 *
 * ## Check, then confirm or cancel
 *
 * The company's instruction, 2026-08-18: "if one person is already assigned a field job and gets
 * assigned another, don't make the system refuse it — rather just remind whoever is booking that the
 * person is already assigned to a prior work", and then: "enable the person scheduling to either
 * confirm the booking or cancel the booking."
 *
 * So pressing the button **checks first**. If nothing clashes it books straight away — a
 * confirmation dialog for a booking with no problem is friction that teaches people to click through
 * dialogs without reading them, which is how the one that mattered gets clicked through too. If
 * something does clash, it names what and waits.
 *
 * Checked before writing rather than written and undone: an undo leaves a window where the board is
 * wrong, and somebody who closes the tab mid-decision leaves it wrong permanently.
 *
 * It is still never a refusal. Confirm is always available. Their own example is why — two jobs at
 * different sites that happen to be ten minutes apart. The dispatcher knows that; the system cannot.
 */

interface PendingBooking {
  start: string;
  end: string | null;
  conflicts: { who: string; day: string; reason: string; otherTickets: string[] }[];
}

export function SchedulePanel({ ticketId }: { ticketId: string }) {
  const ticket = trpc.operations.getTicket.useQuery({ ticketId });
  const me = trpc.system.whoami.useQuery(undefined, { retry: false });
  const utils = trpc.useUtils();

  const canDispatch = (me.data?.permissions ?? []).includes("ticket.dispatch");

  const [start, setStart] = useState("");
  const [end, setEnd] = useState("");
  const [pending, setPending] = useState<PendingBooking | null>(null);
  const [saved, setSaved] = useState<string | null>(null);
  const [checking, setChecking] = useState(false);

  const schedule = trpc.operations.scheduleTicket.useMutation({
    onSuccess: () => {
      void utils.operations.getTicket.invalidate({ ticketId });
      void utils.operations.dispatchBoard.invalidate();
    },
  });

  if (ticket.isPending || !ticket.data) return null;

  const data = ticket.data;
  const scheduled = data.scheduledStart;

  const book = async (startDate: string, endDate: string | null) => {
    setPending(null);
    setSaved(null);
    await schedule.mutateAsync({
      ticketId,
      scheduledStart: new Date(startDate),
      scheduledEnd: endDate ? new Date(endDate) : null,
    });
    setSaved(endDate ? `${startDate} to ${endDate}` : startDate);
  };

  const check = async () => {
    setChecking(true);
    setSaved(null);
    try {
      const preview = await utils.operations.previewSchedule.fetch({
        ticketId,
        scheduledStart: new Date(start),
        scheduledEnd: end ? new Date(end) : null,
      });

      // Nothing in the way: book it. A dialog here would be noise, and noise is what makes people
      // stop reading dialogs.
      if (preview.conflicts.length === 0) {
        await book(start, end || null);
        return;
      }

      setPending({ start, end: end || null, conflicts: preview.conflicts });
    } finally {
      setChecking(false);
    }
  };

  return (
    <Card className="p-4">
      <h2 className="text-sm font-semibold">Schedule</h2>
      <p className="mt-1 text-xs text-text-muted">
        When AIES will do it, which is not the same as when the customer needs it.
      </p>

      <dl className="mt-2 grid gap-x-6 gap-y-1 text-sm sm:grid-cols-2">
        <div className="flex justify-between gap-2">
          <dt className="text-text-muted">Customer needs it by</dt>
          <dd>{data.requiredByDate ? <DateCell value={data.requiredByDate} /> : "Not set"}</dd>
        </div>
        <div className="flex justify-between gap-2">
          <dt className="text-text-muted">Crew booked for</dt>
          <dd>{scheduled ? <DateCell value={scheduled} /> : "Not scheduled"}</dd>
        </div>
      </dl>

      {canDispatch && !pending && (
        <div className="mt-3 flex flex-wrap items-end gap-2 border-t border-border pt-3">
          <div className="w-40">
            <Label htmlFor="sched-start">Start</Label>
            <Input
              id="sched-start"
              type="date"
              value={start}
              onChange={(event) => setStart(event.target.value)}
            />
          </div>
          <div className="w-40">
            <Label htmlFor="sched-end">Finish (optional)</Label>
            <Input
              id="sched-end"
              type="date"
              value={end}
              onChange={(event) => setEnd(event.target.value)}
            />
          </div>
          <Button disabled={!start || checking || schedule.isPending} onClick={() => void check()}>
            {checking ? "Checking…" : scheduled ? "Move it" : "Put it on the board"}
          </Button>

          {scheduled && (
            <Button
              variant="ghost"
              disabled={schedule.isPending}
              onClick={() => {
                setSaved(null);
                schedule.mutate({ ticketId, scheduledStart: null });
              }}
            >
              Take it off
            </Button>
          )}
        </div>
      )}

      {/*
        Nothing has been written at this point. Confirm books it; Cancel walks away and the board is
        exactly as it was.
      */}
      {pending && (
        <div className="mt-3 rounded-md border-2 border-amber-400 bg-amber-50 p-3">
          <p className="text-sm font-semibold text-amber-900">
            Already booked that day — book anyway?
          </p>
          <ul className="mt-1 space-y-1 text-sm text-amber-900">
            {pending.conflicts.map((conflict, index) => (
              <li key={index}>
                <span className="font-medium">{conflict.who}</span> on {conflict.day} —{" "}
                {conflict.reason}
                {conflict.otherTickets.length > 0 &&
                  ` Already on ${conflict.otherTickets.join(", ")}.`}
              </li>
            ))}
          </ul>
          <p className="mt-2 text-xs text-amber-900">
            If the sites are close together this is fine — you know that and the system does not.
            Nothing has been saved yet.
          </p>

          <div className="mt-3 flex flex-wrap gap-2">
            <Button
              disabled={schedule.isPending}
              onClick={() => void book(pending.start, pending.end)}
            >
              Confirm the booking
            </Button>
            <Button variant="secondary" onClick={() => setPending(null)}>
              Cancel
            </Button>
          </div>
        </div>
      )}

      {saved && !pending && <p className="mt-2 text-sm text-text-muted">Booked for {saved}.</p>}

      {schedule.error && <p className="mt-2 text-sm text-danger">{schedule.error.message}</p>}
    </Card>
  );
}
