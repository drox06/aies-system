"use client";

import Link from "next/link";
import { useState } from "react";
import { Button } from "@/components/ui/button";
import { DateCell } from "@/components/ui/cells";
import { Input, Label, Select } from "@/components/ui/input";
import { Card, EmptyState, PageHeader } from "@/components/ui/layout";
import { StatusBadge } from "@/components/ui/status-badge";
import { toastError, toastSuccess } from "@/lib/errors";
import { trpc } from "@/lib/trpc/client";

/**
 * §6's meetings: *"Since meetings will not disappear, make them produce records instead of replacing
 * them."*
 *
 * ## What this list is really showing
 *
 * The column that matters is **open action items**. A meeting with minutes and nothing owed is a
 * conversation; a meeting with four open items is four pieces of work somebody agreed to. §1's
 * complaint is that the second kind used to leave no trace at all.
 */
export default function MeetingsPage() {
  const utils = trpc.useUtils();
  const meetings = trpc.collab.meetings.useQuery();
  const me = trpc.system.whoami.useQuery(undefined, { retry: false });
  const canManage = me.data?.permissions.includes("meeting.manage") ?? false;
  const [calling, setCalling] = useState(false);

  const rows = meetings.data ?? [];
  const upcoming = rows.filter((row) => row.status === "scheduled");
  const past = rows.filter((row) => row.status !== "scheduled");

  return (
    <div className="mx-auto max-w-3xl">
      <PageHeader
        title="Meetings"
        description="What was agreed, who is doing it, and by when."
        actions={
          canManage && (
            <Button variant="secondary" onClick={() => setCalling((was) => !was)}>
              {calling ? "Close" : "Call a meeting"}
            </Button>
          )
        }
      />

      {calling && canManage && (
        <CallMeeting
          onDone={() => {
            setCalling(false);
            void utils.collab.meetings.invalidate();
          }}
        />
      )}

      {meetings.isLoading && <Card className="text-sm text-text-muted">Loading…</Card>}

      {rows.length === 0 && !meetings.isLoading && (
        <Card>
          <EmptyState
            title="No meetings recorded."
            description="A meeting here carries its agenda, its minutes, its decisions, and action items that are real tasks."
          />
        </Card>
      )}

      {upcoming.length > 0 && (
        <section className="mb-6">
          <h2 className="mb-2 text-sm font-medium">Coming up</h2>
          <div className="flex flex-col gap-2">
            {upcoming.map((meeting) => (
              <Row key={meeting.id} meeting={meeting} />
            ))}
          </div>
        </section>
      )}

      {past.length > 0 && (
        <section>
          <h2 className="mb-2 text-sm font-medium">Held</h2>
          <div className="flex flex-col gap-2">
            {past.map((meeting) => (
              <Row key={meeting.id} meeting={meeting} />
            ))}
          </div>
        </section>
      )}
    </div>
  );
}

function Row({
  meeting,
}: {
  meeting: {
    id: string;
    number: string;
    title: string;
    scheduledAt: Date;
    location: string | null;
    seriesKey: string | null;
    status: string;
    hasMinutes: boolean;
    openActionItems: number;
    attendeeIds: string[];
  };
}) {
  return (
    <Card className="flex flex-wrap items-center gap-3">
      <div className="min-w-0 flex-1">
        <div className="flex flex-wrap items-center gap-2">
          <span className="tabular text-sm text-text-muted">{meeting.number}</span>
          <Link href={`/meetings/${meeting.id}`} className="font-medium hover:underline">
            {meeting.title}
          </Link>
          {meeting.status === "cancelled" && <StatusBadge tone="cancelled">Cancelled</StatusBadge>}
          {meeting.status === "held" && !meeting.hasMinutes && (
            // The gap §6 exists to close: it happened and nobody wrote it down.
            <StatusBadge tone="pending">No minutes</StatusBadge>
          )}
          {meeting.openActionItems > 0 && (
            <StatusBadge tone="active">{meeting.openActionItems} still owed</StatusBadge>
          )}
          {meeting.seriesKey && <StatusBadge tone="draft">{meeting.seriesKey}</StatusBadge>}
        </div>
        <p className="mt-1 text-xs text-text-muted">
          <DateCell value={meeting.scheduledAt} withTime />
          {meeting.location ? ` · ${meeting.location}` : ""}
          {` · ${meeting.attendeeIds.length} invited`}
        </p>
      </div>
      <Button variant="secondary" size="sm" asChild>
        <Link href={`/meetings/${meeting.id}`}>Open</Link>
      </Button>
    </Card>
  );
}

function CallMeeting({ onDone }: { onDone: () => void }) {
  const [title, setTitle] = useState("");
  const [scheduledAt, setScheduledAt] = useState("");
  const [location, setLocation] = useState("");
  const [seriesKey, setSeriesKey] = useState("");
  const [attendeeIds, setAttendeeIds] = useState<string[]>([]);

  const people = trpc.collab.assignableUsers.useQuery();
  const schedule = trpc.collab.scheduleMeeting.useMutation({
    onSuccess: (meeting) => {
      toastSuccess(`Called ${meeting.number}.`);
      onDone();
    },
    onError: toastError,
  });

  return (
    <Card className="mb-4 flex flex-col gap-3">
      <div className="grid gap-3 sm:grid-cols-2">
        <div>
          <Label htmlFor="meeting-title">Subject</Label>
          <Input
            id="meeting-title"
            value={title}
            onChange={(event) => setTitle(event.target.value)}
            placeholder="Weekly operations review"
          />
        </div>
        <div>
          <Label htmlFor="meeting-when">When</Label>
          <Input
            id="meeting-when"
            type="datetime-local"
            value={scheduledAt}
            onChange={(event) => setScheduledAt(event.target.value)}
          />
        </div>
      </div>

      <div className="grid gap-3 sm:grid-cols-2">
        <div>
          <Label htmlFor="meeting-where">Where (optional)</Label>
          <Input
            id="meeting-where"
            value={location}
            onChange={(event) => setLocation(event.target.value)}
          />
        </div>
        <div>
          <Label htmlFor="meeting-series">Part of a series (optional)</Label>
          <Input
            id="meeting-series"
            value={seriesKey}
            onChange={(event) => setSeriesKey(event.target.value)}
            placeholder="weekly-ops"
          />
          <p className="mt-1 text-xs text-text-muted">
            Give the next one the same name and it will carry forward whatever is still open.
          </p>
        </div>
      </div>

      <div>
        <Label htmlFor="meeting-attendees">Who is invited</Label>
        <Select
          id="meeting-attendees"
          multiple
          className="h-28"
          value={attendeeIds}
          onChange={(event) =>
            setAttendeeIds([...event.target.selectedOptions].map((option) => option.value))
          }
        >
          {(people.data ?? []).map((person) => (
            <option key={person.id} value={person.id}>
              {person.name}
            </option>
          ))}
        </Select>
      </div>

      <div>
        <Button
          disabled={schedule.isPending || title.trim().length < 3 || !scheduledAt}
          onClick={() =>
            schedule.mutate({
              title,
              scheduledAt: new Date(scheduledAt),
              location: location.trim() || null,
              seriesKey: seriesKey.trim() || null,
              attendeeIds,
            })
          }
        >
          Call it
        </Button>
      </div>
    </Card>
  );
}
