"use client";

import Link from "next/link";
import { use, useState } from "react";
import { Button } from "@/components/ui/button";
import { DateCell } from "@/components/ui/cells";
import { Input, Label, Select, Textarea } from "@/components/ui/input";
import { ConfirmDialog } from "@/components/ui/confirm-dialog";
import { Card, EmptyState, PageHeader } from "@/components/ui/layout";
import { StatusBadge } from "@/components/ui/status-badge";
import { toastError, toastSuccess } from "@/lib/errors";
import { trpc } from "@/lib/trpc/client";
import { TASK_STATUS_LABELS, type TaskStatus } from "@/server/core/collab/task-rules";

/**
 * One meeting (specs/06-collaboration.md §6).
 *
 * ## The action items are tasks, and it shows
 *
 * Each one carries a task number and appears on somebody's My Work. That is the difference §6 is
 * after: *"action items that are created as real tasks with owners and due dates"* rather than a
 * to-do list buried in minutes, which is §1's meeting with better formatting.
 *
 * ## Carried forward is read, not copied
 *
 * A meeting in a series shows what the previous one left open — read live, so an item somebody
 * closed yesterday is not on today's agenda. Copying them would make two records of one job, and the
 * copy would be the stale one.
 */
export default function MeetingPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = use(params);
  const utils = trpc.useUtils();
  const meeting = trpc.collab.meeting.useQuery({ meetingId: id });
  const me = trpc.system.whoami.useQuery(undefined, { retry: false });
  const canManage = me.data?.permissions.includes("meeting.manage") ?? false;

  const [writing, setWriting] = useState(false);
  const [adding, setAdding] = useState(false);
  const [cancelling, setCancelling] = useState(false);
  const [reason, setReason] = useState("");

  const refresh = () => {
    void utils.collab.meeting.invalidate({ meetingId: id });
    void utils.collab.meetings.invalidate();
    void utils.collab.myWork.invalidate();
  };

  const cancel = trpc.collab.cancelMeeting.useMutation({
    onSuccess: () => {
      toastSuccess("Cancelled. Everybody invited can see why.");
      setCancelling(false);
      refresh();
    },
    onError: toastError,
  });

  if (meeting.isLoading) return <Card className="text-sm text-text-muted">Loading…</Card>;

  if (meeting.isError) {
    return (
      <Card className="text-sm">
        <p className="font-medium">That meeting could not be opened.</p>
        <p className="mt-1 text-text-muted">{meeting.error.message}</p>
        <Button className="mt-3" variant="secondary" asChild>
          <Link href="/meetings">Back to meetings</Link>
        </Button>
      </Card>
    );
  }

  const data = meeting.data!;

  return (
    <div className="mx-auto max-w-3xl">
      <PageHeader
        title={data.title}
        description={`${data.number}`}
        actions={
          <div className="flex flex-wrap items-center gap-2">
            <Button variant="secondary" size="sm" onClick={() => setAdding((was) => !was)}>
              {adding ? "Close" : "Add an action item"}
            </Button>
            {canManage && data.status !== "cancelled" && (
              <Button variant="secondary" size="sm" onClick={() => setWriting((was) => !was)}>
                {writing ? "Close" : data.minutes ? "Edit the write-up" : "Write it up"}
              </Button>
            )}
            {canManage && data.status === "scheduled" && (
              <Button variant="ghost" size="sm" onClick={() => setCancelling(true)}>
                Cancel it
              </Button>
            )}
            <Button variant="ghost" size="sm" asChild>
              <Link href="/meetings">All meetings</Link>
            </Button>
          </div>
        }
      />

      <Card className="mb-4 text-sm">
        <p>
          <DateCell value={data.scheduledAt} withTime />
          {data.location ? ` · ${data.location}` : ""}
          {data.seriesKey ? ` · series “${data.seriesKey}”` : ""}
        </p>
        <p className="mt-1 text-text-muted">
          {data.attendees.map((person) => person.name).join(", ") || "Nobody invited yet"}
          {data.apologies.length > 0 && (
            <span> · apologies: {data.apologies.map((person) => person.name).join(", ")}</span>
          )}
        </p>
        {data.status === "cancelled" && (
          <StatusBadge tone="cancelled" className="mt-2">
            Cancelled
          </StatusBadge>
        )}
      </Card>

      {adding && (
        <AddActionItem
          meetingId={id}
          onDone={() => {
            setAdding(false);
            refresh();
          }}
        />
      )}

      {writing && canManage && (
        <WriteUp
          meetingId={id}
          minutes={data.minutes}
          attendeeIds={data.attendees.map((person) => person.id)}
          onDone={() => {
            setWriting(false);
            refresh();
          }}
        />
      )}

      {data.carriedForward.length > 0 && (
        <Card className="mb-4">
          <h2 className="text-sm font-medium">Still open from last time</h2>
          <p className="mt-1 text-xs text-text-muted">
            From {data.carriedFrom?.number}, <DateCell value={data.carriedFrom!.scheduledAt} />.
            Read live — anything closed since has already dropped off.
          </p>
          <ul className="mt-2 flex flex-col gap-1 text-sm">
            {data.carriedForward.map((task) => (
              <li key={task.id} className="flex flex-wrap items-center gap-2">
                <StatusBadge tone="pending">
                  {TASK_STATUS_LABELS[task.status as TaskStatus] ?? task.status}
                </StatusBadge>
                <span className="tabular text-xs text-text-muted">{task.number}</span>
                <span>{task.title}</span>
                <span className="text-xs text-text-muted">
                  {task.assigneeName ?? "nobody"}
                  {task.dueAt ? " · " : ""}
                  {task.dueAt && <DateCell value={task.dueAt} />}
                </span>
              </li>
            ))}
          </ul>
        </Card>
      )}

      {data.agenda.length > 0 && (
        <Card className="mb-4">
          <h2 className="text-sm font-medium">Agenda</h2>
          <ol className="mt-2 flex list-decimal flex-col gap-1 pl-5 text-sm">
            {data.agenda.map((entry, index) => (
              <li key={index}>
                {entry.item}
                {entry.note && <span className="text-text-muted"> — {entry.note}</span>}
              </li>
            ))}
          </ol>
        </Card>
      )}

      <Card className="mb-4">
        <h2 className="text-sm font-medium">Action items</h2>
        {data.actionItems.length === 0 ? (
          <EmptyState
            title="Nothing was agreed here yet."
            description="An action item raised here is a real task — it lands on somebody's My Work and links back to this meeting."
          />
        ) : (
          <ul className="mt-2 flex flex-col gap-2 text-sm">
            {data.actionItems.map((task) => (
              <li key={task.id} className="flex flex-wrap items-center gap-2">
                <StatusBadge
                  tone={
                    task.status === "done"
                      ? "approved"
                      : task.status === "cancelled"
                        ? "cancelled"
                        : "active"
                  }
                >
                  {TASK_STATUS_LABELS[task.status as TaskStatus] ?? task.status}
                </StatusBadge>
                <span className="tabular text-xs text-text-muted">{task.number}</span>
                <span className="min-w-0 flex-1">{task.title}</span>
                <span className="text-xs text-text-muted">
                  {task.assigneeName ?? "nobody yet"}
                  {task.dueAt ? " · " : ""}
                  {task.dueAt && <DateCell value={task.dueAt} />}
                </span>
              </li>
            ))}
          </ul>
        )}
      </Card>

      {data.decisions.length > 0 && (
        <Card className="mb-4">
          <h2 className="text-sm font-medium">Decisions</h2>
          {/* Kept apart from the minutes because a decision is what anybody will search for later,
              and one buried in prose cannot be found. */}
          <ul className="mt-2 flex list-disc flex-col gap-1 pl-5 text-sm">
            {data.decisions.map((entry, index) => (
              <li key={index}>{entry.decision}</li>
            ))}
          </ul>
        </Card>
      )}

      <ConfirmDialog
        open={cancelling}
        onOpenChange={setCancelling}
        title={`Cancel ${data.number}?`}
        description={
          "Say why. Everybody invited sees the reason, and a meeting cancelled without one is the " +
          "kind that gets called again next week for the same purpose."
        }
        confirmLabel="Cancel the meeting"
        destructive
        isPending={cancel.isPending}
        onConfirm={() => cancel.mutate({ meetingId: id, reason })}
      />

      {cancelling && (
        <Card className="mb-4">
          <Label htmlFor="cancel-reason">Why it is not happening</Label>
          <Input
            id="cancel-reason"
            value={reason}
            onChange={(event) => setReason(event.target.value)}
            placeholder="Half the team is on site"
          />
        </Card>
      )}

      {data.minutes && (
        <Card>
          <h2 className="text-sm font-medium">Minutes</h2>
          <p className="mt-2 text-sm whitespace-pre-wrap">{data.minutes}</p>
          {data.heldAt && (
            <p className="mt-2 text-xs text-text-muted">
              Held <DateCell value={data.heldAt} withTime />
            </p>
          )}
        </Card>
      )}
    </div>
  );
}

function AddActionItem({ meetingId, onDone }: { meetingId: string; onDone: () => void }) {
  const [title, setTitle] = useState("");
  const [assigneeId, setAssigneeId] = useState("");
  const [dueAt, setDueAt] = useState("");

  const people = trpc.collab.assignableUsers.useQuery();
  const add = trpc.collab.addActionItem.useMutation({
    onSuccess: (task) => {
      toastSuccess(`Raised ${task.number}.`);
      onDone();
    },
    onError: toastError,
  });

  return (
    <Card className="mb-4 flex flex-col gap-3">
      <div>
        <Label htmlFor="item-title">What was agreed</Label>
        <Input
          id="item-title"
          value={title}
          onChange={(event) => setTitle(event.target.value)}
          placeholder="Send the revised method statement to Bataan"
        />
      </div>
      <div className="grid gap-3 sm:grid-cols-2">
        <div>
          <Label htmlFor="item-assignee">Whose</Label>
          <Select
            id="item-assignee"
            value={assigneeId}
            onChange={(event) => setAssigneeId(event.target.value)}
          >
            <option value="">Mine</option>
            {(people.data ?? []).map((person) => (
              <option key={person.id} value={person.id}>
                {person.name}
              </option>
            ))}
          </Select>
        </div>
        <div>
          <Label htmlFor="item-due">By when</Label>
          <Input
            id="item-due"
            type="date"
            value={dueAt}
            onChange={(event) => setDueAt(event.target.value)}
          />
        </div>
      </div>
      <div className="flex items-center gap-2">
        <Button
          disabled={add.isPending || title.trim().length < 3}
          onClick={() =>
            add.mutate({
              meetingId,
              title,
              assigneeId: assigneeId || null,
              dueAt: dueAt ? new Date(dueAt) : null,
            })
          }
        >
          Raise it
        </Button>
        <span className="text-xs text-text-muted">
          It becomes a task on their My Work, linked back here.
        </span>
      </div>
    </Card>
  );
}

function WriteUp({
  meetingId,
  minutes,
  attendeeIds,
  onDone,
}: {
  meetingId: string;
  minutes: string | null;
  attendeeIds: string[];
  onDone: () => void;
}) {
  const [text, setText] = useState(minutes ?? "");
  const [decisions, setDecisions] = useState("");
  const [present, setPresent] = useState<string[]>(attendeeIds);

  const people = trpc.collab.assignableUsers.useQuery();
  const record = trpc.collab.recordMinutes.useMutation({
    onSuccess: (result) => {
      toastSuccess(
        result.decisions > 0
          ? `Written up, with ${result.decisions} decision(s) recorded.`
          : "Written up.",
      );
      onDone();
    },
    onError: toastError,
  });

  return (
    <Card className="mb-4 flex flex-col gap-3">
      <div>
        <Label htmlFor="minutes">What happened</Label>
        <Textarea
          id="minutes"
          rows={6}
          value={text}
          onChange={(event) => setText(event.target.value)}
        />
      </div>

      <div>
        <Label htmlFor="decisions">Decisions, one per line</Label>
        <Textarea
          id="decisions"
          rows={3}
          value={decisions}
          onChange={(event) => setDecisions(event.target.value)}
          placeholder={"Approved the revised lifting method\nDeferred the Cebu visit to September"}
        />
        <p className="mt-1 text-xs text-text-muted">
          Kept separate from the write-up, because a decision is what somebody will search for in
          six months.
        </p>
      </div>

      <div>
        <Label htmlFor="present">Who was actually there</Label>
        <Select
          id="present"
          multiple
          className="h-28"
          value={present}
          onChange={(event) =>
            setPresent([...event.target.selectedOptions].map((option) => option.value))
          }
        >
          {(people.data ?? []).map((person) => (
            <option key={person.id} value={person.id}>
              {person.name}
            </option>
          ))}
        </Select>
      </div>

      <div className="flex items-center gap-2">
        <Button
          disabled={record.isPending || text.trim().length < 10}
          onClick={() =>
            record.mutate({
              meetingId,
              minutes: text,
              decisions: decisions
                .split("\n")
                .map((line) => line.trim())
                .filter(Boolean),
              attendeeIds: present,
            })
          }
        >
          Save the write-up
        </Button>
        <span className="text-xs text-text-muted">This also marks the meeting held.</span>
      </div>
    </Card>
  );
}
