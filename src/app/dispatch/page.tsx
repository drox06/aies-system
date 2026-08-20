"use client";

import { useMemo, useState } from "react";
import Link from "next/link";
import { Button } from "@/components/ui/button";
import { Card, PageHeader } from "@/components/ui/layout";
import { StatusBadge, type StatusTone } from "@/components/ui/status-badge";
import {
  CARD_STATE_LABELS,
  UNAVAILABILITY_LABELS,
  dayKey,
  type CardState,
  type UnavailabilityKind,
} from "@/server/core/operations/dispatch-rules";
import { EmergencyBump } from "./EmergencyBump";
import { Unavailability } from "./Unavailability";
import { trpc } from "@/lib/trpc/client";

/**
 * §17's dispatch board.
 *
 * Technicians as rows, days as columns, one card per job. The colour on a card is §8's readiness
 * answer, not a second opinion computed here — see dispatch-rules.ts for why that matters.
 *
 * **Drag to reschedule is not built.** §17 asks for it and this renders a read-and-click board
 * instead: pick a card, pick a day, move it. Drag-and-drop that works on a touch screen, with
 * keyboard access and a sensible failure when the drop is refused, is a real piece of work rather
 * than an afternoon — and a board you can read correctly beats one you can drag but cannot trust.
 * Recorded in PROGRESS rather than half-built.
 */

const CARD_TONE: Record<CardState, StatusTone> = {
  ready: "approved",
  blocked: "failed",
  unscheduled: "draft",
};

const TYPE_TONE: Record<string, StatusTone> = {
  new_project: "info",
  installation: "info",
  after_sales: "pending",
  delivery: "approved",
};

const WEEKDAYS = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];

export default function DispatchPage() {
  const [weekOffset, setWeekOffset] = useState(0);

  /**
   * Memoised, and floored to the day.
   *
   * `new Date(Date.now() + …)` computed inline produced a different value on every render, which
   * made a different React Query key on every render, which refetched forever — the screen sat on
   * "Loading the week…" indefinitely while the server answered in under three seconds each time.
   * Reported by the company as "stuck loading, no change for 2 minutes", on both desktop and phone.
   *
   * Flooring to midnight matters as much as the memo: without it the key changes at every
   * millisecond boundary the moment anything else triggers a re-render.
   */
  const weekDate = useMemo(() => {
    const at = new Date(Date.now() + weekOffset * 7 * 24 * 60 * 60 * 1000);
    return new Date(at.toISOString().slice(0, 10));
  }, [weekOffset]);

  const board = trpc.operations.dispatchBoard.useQuery({ weekOf: weekDate });
  const capacity = trpc.operations.capacity.useQuery({ weeks: 4 });

  if (board.isPending) return <p className="text-sm text-text-muted">Loading the week…</p>;
  if (board.error) return <p className="text-sm text-danger">{board.error.message}</p>;

  const data = board.data!;
  const cardsFor = (userId: string, day: string) =>
    data.cards.filter(
      (card) =>
        [card.assignedLeadId, ...card.assignedUserIds].includes(userId) &&
        card.scheduledStart &&
        dayKey(card.scheduledStart) <= day &&
        day <= dayKey(card.scheduledEnd ?? card.scheduledStart),
    );

  const awayOn = (userId: string, day: string) =>
    data.unavailability.find(
      (entry) => entry.userId === userId && dayKey(entry.from) <= day && day <= dayKey(entry.to),
    );

  const unassigned = data.cards.filter(
    (card) => !card.assignedLeadId && card.assignedUserIds.length === 0,
  );

  return (
    <div>
      <PageHeader
        title="Dispatch board"
        description="Who is where, this week. A card's colour is whether the job can actually start — the gates from §8, not a separate opinion."
      />

      <div className="flex flex-wrap items-center gap-2">
        <Button variant="secondary" size="sm" onClick={() => setWeekOffset((n) => n - 1)}>
          ← Previous
        </Button>
        <span className="text-sm font-medium">
          Week of {new Date(data.weekOf).toISOString().slice(0, 10)}
        </span>
        <Button variant="secondary" size="sm" onClick={() => setWeekOffset((n) => n + 1)}>
          Next →
        </Button>
        {weekOffset !== 0 && (
          <Button variant="ghost" size="sm" onClick={() => setWeekOffset(0)}>
            This week
          </Button>
        )}
      </div>

      {/* Conflicts first. A double-booking nobody is told about is the failure this board exists to
          prevent — it is deliberately not refused at the point of scheduling, so it has to be loud here. */}
      {data.conflicts.length > 0 && (
        <Card className="mt-4 border-2 border-amber-400 bg-amber-50 p-3">
          <h2 className="text-sm font-semibold text-amber-900">
            {data.conflicts.length} conflict{data.conflicts.length === 1 ? "" : "s"}
          </h2>
          <ul className="mt-2 space-y-1 text-sm text-amber-900">
            {data.conflicts.map((conflict, index) => {
              const who = data.technicians.find((t) => t.id === conflict.userId);
              return (
                <li key={index}>
                  <span className="font-medium">{who?.name ?? conflict.userId}</span> on{" "}
                  {conflict.day} — {conflict.reason} ({conflict.ticketNumbers.join(", ")})
                </li>
              );
            })}
          </ul>
        </Card>
      )}

      {data.technicians.length === 0 && data.cards.length === 0 && (
        <Card className="mt-4 p-4">
          <p className="text-sm">Nothing is scheduled this week.</p>
          <p className="mt-1 text-xs text-text-muted">
            Tickets appear here once they have a date. A ticket with a required-by date is not the
            same as one with a crew committed — that gap is what this board is for.
          </p>
        </Card>
      )}

      {/* The grid scrolls sideways on its own rather than the page doing it. */}
      {data.technicians.length > 0 && (
        <div className="mt-4 overflow-x-auto">
          <table className="w-full min-w-[52rem] border-collapse text-sm">
            <thead>
              <tr>
                <th className="border-b border-border p-2 text-left text-xs font-semibold text-text-muted">
                  Technician
                </th>
                {data.days.map((day, index) => (
                  <th
                    key={day}
                    className="border-b border-border p-2 text-left text-xs font-semibold text-text-muted"
                  >
                    {WEEKDAYS[index]} {day.slice(8)}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {data.technicians.map((technician) => (
                <tr key={technician.id}>
                  <td className="border-b border-border p-2 align-top font-medium">
                    {technician.name}
                  </td>
                  {data.days.map((day) => {
                    const away = awayOn(technician.id, day);
                    const cards = cardsFor(technician.id, day);
                    return (
                      <td key={day} className="border-b border-border p-1 align-top">
                        {away && (
                          <p className="mb-1 rounded bg-surface-2 px-1.5 py-1 text-xs text-text-muted">
                            {UNAVAILABILITY_LABELS[away.kind as UnavailabilityKind] ?? away.kind}
                          </p>
                        )}
                        {cards.map((card) => (
                          <Link key={card.id} href={`/tickets/${card.id}`} className="mb-1 block">
                            <div className="rounded-md border border-border p-1.5 hover:border-brand">
                              <div className="flex flex-wrap items-baseline justify-between gap-1">
                                <span className="text-xs font-medium">{card.number}</span>
                                <StatusBadge tone={CARD_TONE[card.card.state]}>
                                  {CARD_STATE_LABELS[card.card.state]}
                                </StatusBadge>
                              </div>
                              <p className="mt-0.5 truncate text-xs text-text-muted">
                                {card.account?.name ?? card.title}
                              </p>
                              {card.card.blockers.length > 0 && (
                                <p className="mt-0.5 text-xs text-danger">{card.card.summary}</p>
                              )}
                            </div>
                          </Link>
                        ))}
                      </td>
                    );
                  })}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {unassigned.length > 0 && (
        <Card className="mt-4 p-3">
          <h2 className="text-sm font-semibold">Scheduled, nobody assigned</h2>
          <ul className="mt-2 space-y-1 text-sm">
            {unassigned.map((card) => (
              <li key={card.id} className="flex flex-wrap items-baseline justify-between gap-2">
                <Link href={`/tickets/${card.id}`} className="underline">
                  {card.number} — {card.account?.name ?? card.title}
                </Link>
                <StatusBadge tone={TYPE_TONE[card.type] ?? "info"}>{card.type}</StatusBadge>
              </li>
            ))}
          </ul>
        </Card>
      )}

      {/*
        §17's emergency, which had no caller.

        Doing it by hand — reschedule the emergency, then edit each colliding ticket — is the same
        outcome with three chances to forget one, and the one forgotten is a customer expecting a
        technician who is now somewhere else.
      */}
      <EmergencyBump cards={data.cards} onDone={() => void board.refetch()} />

      {/* §17: "the number sales needs before promising a date". */}
      {/*
        Who is away, on the board that schedules them — §17's question is "who can I send on
        Thursday", and the answer belongs where it is asked rather than three clicks into an admin
        screen. It had no screen at all until 2026-08-20.
      */}
      <Unavailability
        from={weekDate}
        to={new Date(weekDate.getTime() + 27 * 24 * 60 * 60 * 1000)}
      />

      {capacity.data && (
        <Card className="mt-4 p-3">
          <h2 className="text-sm font-semibold">Capacity, next four weeks</h2>
          <p className="mt-1 text-xs text-text-muted">
            {capacity.data.technicianCount} people who can execute work. Working days only —
            weekends are not capacity.
          </p>
          <table className="mt-2 w-full text-sm">
            <thead>
              <tr className="text-xs text-text-muted">
                <th className="text-left font-medium">Week</th>
                <th className="text-right font-medium">Available</th>
                <th className="text-right font-medium">Committed</th>
                <th className="text-right font-medium">Spare</th>
              </tr>
            </thead>
            <tbody className="tabular">
              {capacity.data.weeks.map((week) => (
                <tr key={week.weekOf}>
                  <td>{week.weekOf}</td>
                  <td className="text-right">{week.available}</td>
                  <td className="text-right">{week.committed}</td>
                  <td className={`text-right ${week.spare < 0 ? "font-semibold text-danger" : ""}`}>
                    {week.spare}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </Card>
      )}
    </div>
  );
}
