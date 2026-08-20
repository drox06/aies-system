"use client";

import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Input, Label, Select } from "@/components/ui/input";
import { Card } from "@/components/ui/layout";
import { toastError, toastSuccess } from "@/lib/errors";
import { trpc } from "@/lib/trpc/client";

/**
 * §17's emergency — putting a job in front of the week and saying which ones moved.
 *
 * ## Why bumping is one act and not several
 *
 * `bumpForEmergency` schedules the emergency **and** displaces the tickets it collides with, in one
 * call. Doing it by hand — reschedule the emergency, then edit three other tickets — is the same
 * outcome with three chances to forget one, and the ticket somebody forgets is a customer expecting
 * a technician who is now in Bataan.
 *
 * The service also records *why* each bumped ticket moved. A ticket that slipped a day with no
 * reason attached is indistinguishable from a scheduling mistake, and the customer asking why will
 * get "I don't know" rather than "there was an emergency at the refinery".
 *
 * ## Why the week's tickets are picked from, rather than computed
 *
 * The board could work out which tickets overlap the emergency's slot and offer those. It would be
 * wrong about the ones that matter: a technician can move a job that is *near* the emergency and
 * cannot move one whose customer has a plant shutdown booked. Only the dispatcher knows which.
 * So the collision is theirs to judge and the platform's to record.
 */
export function EmergencyBump({
  cards,
  onDone,
}: {
  cards: { id: string; number: string; title: string; scheduledStart: Date | string | null }[];
  onDone: () => void;
}) {
  const [open, setOpen] = useState(false);
  const [emergencyTicketId, setEmergencyTicketId] = useState("");
  const [scheduledStart, setScheduledStart] = useState("");
  const [bumped, setBumped] = useState<string[]>([]);

  const bump = trpc.operations.bumpForEmergency.useMutation({
    onSuccess: () => {
      toastSuccess(
        `Scheduled. ${bumped.length} ticket${bumped.length === 1 ? "" : "s"} moved, each with the reason recorded.`,
      );
      setOpen(false);
      setBumped([]);
      onDone();
    },
    onError: toastError,
  });

  if (!open) {
    return (
      <Button variant="secondary" size="sm" onClick={() => setOpen(true)}>
        Something urgent came in
      </Button>
    );
  }

  const toggle = (id: string) =>
    setBumped((current) =>
      current.includes(id) ? current.filter((entry) => entry !== id) : [...current, id],
    );

  const canSubmit = emergencyTicketId !== "" && scheduledStart !== "" && bumped.length > 0;

  return (
    <Card className="mt-3 p-4">
      <h2 className="text-sm font-semibold">Put an emergency in front of the week</h2>
      <p className="mt-0.5 text-xs text-text-muted">
        Schedules the emergency and moves what it collides with, in one act — so nothing is left
        half-rescheduled, and every ticket that moved says why.
      </p>

      <div className="mt-3 grid gap-3 sm:grid-cols-2">
        <div>
          <Label htmlFor="eb-ticket">Which ticket is the emergency</Label>
          <Select
            id="eb-ticket"
            value={emergencyTicketId}
            onChange={(event) => setEmergencyTicketId(event.target.value)}
          >
            <option value="">Choose a ticket…</option>
            {cards.map((card) => (
              <option key={card.id} value={card.id}>
                {card.number} — {card.title}
              </option>
            ))}
          </Select>
        </div>

        <div>
          <Label htmlFor="eb-when">Starting</Label>
          <Input
            id="eb-when"
            type="datetime-local"
            value={scheduledStart}
            onChange={(event) => setScheduledStart(event.target.value)}
          />
        </div>
      </div>

      <div className="mt-3">
        <Label>What has to move for it</Label>
        <p className="mb-1.5 text-xs text-text-muted">
          {/*
            Chosen, not computed. A job near the emergency may be movable and one whose customer has
            a shutdown booked is not, and only the dispatcher knows which is which.
          */}
          Your judgement, not the board&rsquo;s — it knows what overlaps, not what can actually
          give.
        </p>
        <ul className="space-y-1">
          {cards
            .filter((card) => card.id !== emergencyTicketId)
            .map((card) => (
              <li key={card.id}>
                <label className="flex items-baseline gap-2 text-sm">
                  <input
                    type="checkbox"
                    checked={bumped.includes(card.id)}
                    onChange={() => toggle(card.id)}
                  />
                  <span>
                    <span className="tabular">{card.number}</span>{" "}
                    <span className="text-text-muted">{card.title}</span>
                  </span>
                </label>
              </li>
            ))}
        </ul>
        {cards.length <= 1 && (
          <p className="text-sm text-text-muted">
            Nothing else is scheduled this week, so nothing needs to move.
          </p>
        )}
      </div>

      <div className="mt-3 flex gap-2">
        <Button
          size="sm"
          disabled={!canSubmit || bump.isPending}
          onClick={() =>
            bump.mutate({
              emergencyTicketId,
              scheduledStart: new Date(scheduledStart),
              bumpTicketIds: bumped,
            })
          }
        >
          {bump.isPending ? "Rescheduling…" : "Schedule it and move the rest"}
        </Button>
        <Button variant="ghost" size="sm" onClick={() => setOpen(false)}>
          Discard
        </Button>
      </div>
    </Card>
  );
}
