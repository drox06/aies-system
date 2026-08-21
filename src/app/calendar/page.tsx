"use client";

import Link from "next/link";
import { useMemo, useState } from "react";
import { Button } from "@/components/ui/button";
import { Input, Label, Select } from "@/components/ui/input";
import { Card, EmptyState, PageHeader } from "@/components/ui/layout";
import { StatusBadge, type StatusTone } from "@/components/ui/status-badge";
import { toastError, toastSuccess } from "@/lib/errors";
import { trpc } from "@/lib/trpc/client";
import {
  CALENDAR_SOURCE_LABELS,
  manilaDayKey,
  monthGrid,
  type CalendarSource,
} from "@/server/core/collab/calendar-rules";
import { TASK_ENTITY_HREF, isTaskEntityType } from "@/server/core/collab/task-rules";

/**
 * §4's unified calendar.
 *
 * ## What is on it, and where it comes from
 *
 * Tickets, mobilisations, deliveries, PM and calibration dates, quotation expiries, payment due
 * dates, liquidation deadlines and leave — each read from the record that holds it. Nothing is
 * copied here, so nothing here can be out of date. The only rows this module stores are the diary
 * entries somebody types.
 *
 * ## Why a hidden source says so
 *
 * The two money sources need a finance permission. A calendar that quietly omitted them would read
 * as a quiet month; a line saying what is not being shown is the difference between a summary and a
 * misleading one.
 */

const SOURCE_TONE: Partial<Record<CalendarSource, StatusTone>> = {
  ticket: "active",
  mobilization: "active",
  demobilization: "draft",
  delivery: "info",
  pm_visit: "pending",
  quotation_expiry: "pending",
  invoice_due: "failed",
  liquidation_due: "failed",
  calibration_due: "pending",
  leave: "cancelled",
  manual: "draft",
};

export default function CalendarPage() {
  const utils = trpc.useUtils();
  const today = new Date();
  const [year, setYear] = useState(today.getUTCFullYear());
  const [monthIndex, setMonthIndex] = useState(today.getUTCMonth());
  const [scope, setScope] = useState<"mine" | "team">("team");
  const [adding, setAdding] = useState(false);
  const [feedOpen, setFeedOpen] = useState(false);

  const days = useMemo(() => monthGrid(year, monthIndex), [year, monthIndex]);
  const from = days[0]!;
  const to = new Date(days[days.length - 1]!.getTime() + 24 * 60 * 60 * 1000);

  const calendar = trpc.collab.calendar.useQuery({ from, to, scope });

  const byDay = useMemo(() => {
    const map = new Map<string, typeof entries>();
    const entries = calendar.data?.entries ?? [];
    for (const entry of entries) {
      const last = entry.endsAt ?? entry.startsAt;
      for (
        let cursor = new Date(entry.startsAt);
        cursor.getTime() <= new Date(last).getTime();
        cursor = new Date(cursor.getTime() + 24 * 60 * 60 * 1000)
      ) {
        const key = manilaDayKey(cursor);
        map.set(key, [...(map.get(key) ?? []), entry]);
      }
    }
    return map;
  }, [calendar.data]);

  const monthName = new Date(Date.UTC(year, monthIndex, 1)).toLocaleDateString("en-PH", {
    month: "long",
    year: "numeric",
    timeZone: "UTC",
  });

  const step = (by: number) => {
    const next = new Date(Date.UTC(year, monthIndex + by, 1));
    setYear(next.getUTCFullYear());
    setMonthIndex(next.getUTCMonth());
  };

  return (
    <div>
      <PageHeader
        title="Calendar"
        description="Everything with a date on it, read from the records that hold them."
        actions={
          <div className="flex flex-wrap items-center gap-2">
            <Select
              aria-label="Whose"
              className="h-9 text-sm"
              value={scope}
              onChange={(event) => setScope(event.target.value as "mine" | "team")}
            >
              <option value="team">Everybody</option>
              <option value="mine">Only mine</option>
            </Select>
            <Button variant="secondary" size="sm" onClick={() => setAdding((was) => !was)}>
              {adding ? "Close" : "Add an entry"}
            </Button>
            <Button variant="ghost" size="sm" onClick={() => setFeedOpen((was) => !was)}>
              On my phone
            </Button>
          </div>
        }
      />

      {feedOpen && <FeedPanel />}

      {adding && (
        <AddEntry
          onDone={() => {
            setAdding(false);
            void utils.collab.calendar.invalidate();
          }}
        />
      )}

      <Card className="mb-4 flex flex-wrap items-center justify-between gap-3">
        <div className="flex items-center gap-2">
          <Button variant="secondary" size="sm" onClick={() => step(-1)}>
            ←
          </Button>
          <h2 className="text-sm font-medium">{monthName}</h2>
          <Button variant="secondary" size="sm" onClick={() => step(1)}>
            →
          </Button>
        </div>
        <Button
          variant="ghost"
          size="sm"
          onClick={() => {
            setYear(today.getUTCFullYear());
            setMonthIndex(today.getUTCMonth());
          }}
        >
          This month
        </Button>
      </Card>

      {calendar.data?.hiddenSources.length ? (
        <Card className="mb-4 text-sm text-text-muted">
          Not shown to you:{" "}
          {calendar.data.hiddenSources
            .map((source) => CALENDAR_SOURCE_LABELS[source].toLowerCase())
            .join(", ")}
          . Those need a finance permission — the month may be busier than it looks.
        </Card>
      ) : null}

      {calendar.isLoading && <Card className="text-sm text-text-muted">Loading…</Card>}

      {calendar.data?.entries.length === 0 && (
        <Card className="mb-4">
          <EmptyState
            title="Nothing dated in this month."
            description="Scheduled jobs, mobilisations, expiries and due dates appear here on their own as records are created."
          />
        </Card>
      )}

      {/* The grid scrolls sideways on a narrow screen rather than squeezing seven columns. */}
      <div className="overflow-x-auto">
        <div className="grid min-w-[56rem] grid-cols-7 gap-px rounded-md bg-border">
          {["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"].map((label) => (
            <div key={label} className="bg-surface-2 px-2 py-1 text-xs font-medium text-text-muted">
              {label}
            </div>
          ))}

          {days.map((date) => {
            const key = manilaDayKey(date);
            const entries = byDay.get(key) ?? [];
            const outside = date.getUTCMonth() !== monthIndex;
            const isToday = key === manilaDayKey(today);

            return (
              <div key={key} className={`min-h-24 bg-surface p-1.5 ${outside ? "opacity-45" : ""}`}>
                <div className="flex items-baseline justify-between">
                  <span className={`text-xs ${isToday ? "font-semibold text-blue-600" : ""}`}>
                    {date.getUTCDate()}
                  </span>
                  {entries.length > 3 && (
                    <span className="text-xs text-text-muted">{entries.length}</span>
                  )}
                </div>

                <div className="mt-1 flex flex-col gap-1">
                  {entries.slice(0, 3).map((entry) => {
                    const inner = (
                      <>
                        <StatusBadge tone={SOURCE_TONE[entry.source as CalendarSource] ?? "draft"}>
                          {CALENDAR_SOURCE_LABELS[entry.source as CalendarSource]}
                        </StatusBadge>
                        <span className="mt-0.5 block truncate">{entry.title}</span>
                      </>
                    );

                    return entry.entityType &&
                      entry.entityId &&
                      isTaskEntityType(entry.entityType) ? (
                      <Link
                        key={`${entry.source}-${entry.id}`}
                        href={TASK_ENTITY_HREF[entry.entityType](entry.entityId)}
                        className="block text-xs hover:underline"
                      >
                        {inner}
                      </Link>
                    ) : (
                      <span key={`${entry.source}-${entry.id}`} className="block text-xs">
                        {inner}
                      </span>
                    );
                  })}
                  {entries.length > 3 && (
                    <span className="text-xs text-text-muted">and {entries.length - 3} more</span>
                  )}
                </div>
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
}

/**
 * The subscription link.
 *
 * Shown behind a click and with the warning attached, because the URL is the credential: a phone
 * cannot log in, so anybody holding it can read this calendar until it is rotated.
 */
function FeedPanel() {
  const feed = trpc.collab.calendarFeed.useQuery();
  const utils = trpc.useUtils();
  const rotate = trpc.collab.rotateCalendarFeed.useMutation({
    onSuccess: () => {
      toastSuccess("New link made. Anything still using the old one has stopped.");
      void utils.collab.calendarFeed.invalidate();
    },
    onError: toastError,
  });

  const url =
    typeof window !== "undefined" && feed.data
      ? `${window.location.origin}/api/calendar/${feed.data.token}`
      : "";

  return (
    <Card className="mb-4">
      <p className="text-sm font-medium">Subscribe on your phone</p>
      <p className="mt-1 text-xs text-text-muted">
        Add this as a subscribed calendar. It refreshes about every half hour and shows what is
        yours — a fortnight back and a quarter ahead. It is read-only: changing something here means
        changing the record it came from.
      </p>
      <Input readOnly className="mt-2 font-mono text-xs" value={url} />
      <p className="mt-2 text-xs text-text-muted">
        <strong className="text-text">Treat the link as a password.</strong> A calendar app cannot
        sign in, so whoever holds this URL can read your schedule until you replace it.
        {feed.data?.lastUsedAt ? " It is being used." : " Nothing has fetched it yet."}
      </p>
      <Button
        className="mt-2"
        variant="secondary"
        size="sm"
        disabled={rotate.isPending}
        onClick={() => rotate.mutate()}
      >
        Replace the link
      </Button>
    </Card>
  );
}

function AddEntry({ onDone }: { onDone: () => void }) {
  const [title, setTitle] = useState("");
  const [startsAt, setStartsAt] = useState("");
  const [endsAt, setEndsAt] = useState("");
  const [allDay, setAllDay] = useState(true);
  const [location, setLocation] = useState("");

  const create = trpc.collab.addCalendarEvent.useMutation({
    onSuccess: () => {
      toastSuccess("Added.");
      onDone();
    },
    onError: toastError,
  });

  return (
    <Card className="mb-4 flex flex-col gap-3">
      <div className="grid gap-3 sm:grid-cols-2">
        <div>
          <Label htmlFor="event-title">What</Label>
          <Input
            id="event-title"
            value={title}
            onChange={(event) => setTitle(event.target.value)}
            placeholder="Client visit — Bataan"
          />
        </div>
        <div>
          <Label htmlFor="event-location">Where (optional)</Label>
          <Input
            id="event-location"
            value={location}
            onChange={(event) => setLocation(event.target.value)}
          />
        </div>
      </div>

      <div className="grid gap-3 sm:grid-cols-3">
        <div>
          <Label htmlFor="event-start">From</Label>
          <Input
            id="event-start"
            type={allDay ? "date" : "datetime-local"}
            value={startsAt}
            onChange={(event) => setStartsAt(event.target.value)}
          />
        </div>
        <div>
          <Label htmlFor="event-end">To (optional)</Label>
          <Input
            id="event-end"
            type={allDay ? "date" : "datetime-local"}
            value={endsAt}
            onChange={(event) => setEndsAt(event.target.value)}
          />
        </div>
        <label className="flex items-end gap-2 pb-2 text-sm">
          <input
            type="checkbox"
            checked={allDay}
            onChange={(event) => setAllDay(event.target.checked)}
          />
          All day
        </label>
      </div>

      <div>
        <Button
          disabled={create.isPending || title.trim().length < 2 || !startsAt}
          onClick={() =>
            create.mutate({
              title,
              location: location.trim() || null,
              startsAt: new Date(startsAt),
              endsAt: endsAt ? new Date(endsAt) : null,
              allDay,
            })
          }
        >
          Add it
        </Button>
      </div>
    </Card>
  );
}
