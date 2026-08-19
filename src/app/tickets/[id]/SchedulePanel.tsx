"use client";

import { useState } from "react";
import { Button } from "@/components/ui/button";
import { DateCell } from "@/components/ui/cells";
import { Input, Label, Select } from "@/components/ui/input";
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
  // Reuses the list §6.1 already built for inspections rather than adding a parallel query.
  const people = trpc.operations.inspectionAttendees.useQuery(undefined, { retry: false });
  const utils = trpc.useUtils();

  const canDispatch = (me.data?.permissions ?? []).includes("ticket.dispatch");

  const [start, setStart] = useState("");
  const [end, setEnd] = useState("");
  const [pending, setPending] = useState<PendingBooking | null>(null);
  const [saved, setSaved] = useState<string | null>(null);
  const [checking, setChecking] = useState(false);
  const [leadId, setLeadId] = useState("");
  /**
   * The rest of the crew, beyond the lead.
   *
   * `Ticket.assignedUserIds` and both dispatch procedures have taken a list since §17 was built; the
   * form only ever offered one picker, so a two-person job could not be recorded as one. The
   * company found it the first time they tried to book a real crew: "there are times multiple
   * personnel need to be booked".
   *
   * It matters beyond data entry. The clash check reads *everybody* on the ticket, so a second
   * technician who was never recorded cannot be double-booked — the warning that exists to catch
   * exactly that stays silent, and the dispatcher is told nothing is wrong.
   *
   * `null` means "not touched yet", so an existing crew is preserved rather than wiped by anybody
   * who opens the panel to change a date.
   */
  const [crew, setCrew] = useState<string[] | null>(null);
  /** A subcontractor doing the work instead of, or alongside, AIES staff. Free text by design. */
  const [subcontractor, setSubcontractor] = useState("");

  const schedule = trpc.operations.scheduleTicket.useMutation({
    onSuccess: () => {
      void utils.operations.getTicket.invalidate({ ticketId });
      void utils.operations.dispatchBoard.invalidate();
    },
  });

  if (ticket.isPending || !ticket.data) return null;

  const data = ticket.data;
  const scheduled = data.scheduledStart;
  const currentLead = leadId || data.assignedLeadId || "";
  const currentCrew = crew ?? data.assignedUserIds ?? [];
  const toggleCrew = (id: string) =>
    setCrew(currentCrew.includes(id) ? currentCrew.filter((x) => x !== id) : [...currentCrew, id]);

  const book = async (startDate: string, endDate: string | null) => {
    setPending(null);
    setSaved(null);
    await schedule.mutateAsync({
      ticketId,
      scheduledStart: new Date(startDate),
      scheduledEnd: endDate ? new Date(endDate) : null,
      ...(currentLead ? { assignedLeadId: currentLead } : {}),
      assignedUserIds: currentCrew,
      crewNote: subcontractor.trim() || null,
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
        ...(currentLead ? { assignedLeadId: currentLead } : {}),
        assignedUserIds: currentCrew,
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
        <div className="mt-3 border-t border-border pt-3">
          {/*
            The company read the two dates above as editable and looked for a field to set "crew
            booked for". These inputs are that field — the heading now says so, because a form whose
            purpose you have to infer is a form people fill in wrongly.
          */}
          <p className="text-sm font-medium">Book the crew</p>
          <p className="mt-0.5 text-xs text-text-muted">
            Sets &ldquo;crew booked for&rdquo; above. The customer&rsquo;s date is set on the ticket
            itself and is not changed here.
          </p>

          {/*
            Add one at a time from a list, and each one appears as a chip that can be taken off.

            The company asked for a dropdown rather than a row of ticks, and it is the better control
            once a crew can be four or five people: ticks make you read every name to find who is on,
            whereas the chips say who is going and the list offers only who is not.

            A **subcontractor** is a free-text entry rather than a user, because that is the truth —
            they have no login, no timesheet and no competence record here. Recording the name is
            still worth doing: §8's crew gate is about knowing who is on site, and "Delta Calibration
            Services, two men" is an answer to that question even though the platform cannot check
            their induction. What the platform must not do is pretend a subcontractor is staff.
          */}
          <div className="mt-2">
            <Label htmlFor="sched-crew">Who else is going</Label>
            <div className="mt-1 flex flex-wrap items-center gap-2">
              <Select
                id="sched-crew"
                className="w-52"
                value=""
                onChange={(event) => {
                  if (event.target.value) toggleCrew(event.target.value);
                }}
              >
                <option value="">Add somebody…</option>
                {(people.data ?? [])
                  .filter((person) => person.id !== currentLead && !currentCrew.includes(person.id))
                  .map((person) => (
                    <option key={person.id} value={person.id}>
                      {person.name}
                    </option>
                  ))}
              </Select>

              {currentCrew.map((id) => {
                const person = (people.data ?? []).find((candidate) => candidate.id === id);
                return (
                  <span
                    key={id}
                    className="inline-flex items-center gap-1 rounded-full border border-border px-2 py-0.5 text-sm"
                  >
                    {person?.name ?? "Somebody"}
                    <button
                      type="button"
                      aria-label={`Take ${person?.name ?? "them"} off the crew`}
                      className="text-text-muted hover:text-danger"
                      onClick={() => toggleCrew(id)}
                    >
                      ×
                    </button>
                  </span>
                );
              })}
            </div>

            <div className="mt-2">
              <Label htmlFor="sched-subcontractor">Or a subcontractor</Label>
              <Input
                id="sched-subcontractor"
                className="w-72"
                placeholder="Company name, and how many they are sending"
                value={subcontractor}
                onChange={(event) => setSubcontractor(event.target.value)}
              />
              <p className="mt-1 text-xs text-text-muted">
                Recorded as a note on the booking. They have no login here, so the platform cannot
                check their induction or their hours — it can only record that they are the ones
                going.
              </p>
            </div>

            <p className="mt-1 text-xs text-text-muted">
              Everybody named is checked for clashes and clears §8&rsquo;s crew gate. Somebody who
              is going and is not named cannot be warned about.
            </p>
          </div>

          <div className="mt-2 flex flex-wrap items-end gap-2">
            <div className="w-52">
              <Label htmlFor="sched-lead">Who leads it</Label>
              <Select
                id="sched-lead"
                value={currentLead}
                onChange={(event) => setLeadId(event.target.value)}
              >
                <option value="">Nobody yet</option>
                {(people.data ?? []).map((person) => (
                  <option key={person.id} value={person.id}>
                    {person.name}
                  </option>
                ))}
              </Select>
            </div>
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
            <Button
              disabled={!start || checking || schedule.isPending}
              onClick={() => void check()}
            >
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

          {!currentLead && (
            <p className="mt-2 text-xs text-text-muted">
              Nobody is assigned, so nothing can clash. Pick who is going and the check becomes
              meaningful.
            </p>
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
