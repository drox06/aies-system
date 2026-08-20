"use client";

import Link from "next/link";
import { useState } from "react";
import { Button } from "@/components/ui/button";
import { DateCell } from "@/components/ui/cells";
import { Input, Label, Select, Textarea } from "@/components/ui/input";
import { Card, EmptyState, PageHeader } from "@/components/ui/layout";
import { StatusBadge, type StatusTone } from "@/components/ui/status-badge";
import { toastError, toastSuccess } from "@/lib/errors";
import { trpc } from "@/lib/trpc/client";
import {
  TASK_ENTITY_HREF,
  TASK_ENTITY_TYPES,
  TASK_PRIORITIES,
  TASK_PRIORITY_LABELS,
  TASK_STATUSES,
  TASK_STATUS_LABELS,
  isTaskEntityType,
  type TaskStatus,
  type TaskUrgency,
} from "@/server/core/collab/task-rules";

/**
 * §2's My Work — *"One screen answers 'what am I supposed to be doing?'"*
 *
 * ## Why this screen is module 06's whole argument
 *
 * §1: *"All work assignments are done thru meetings without proper documentation."* Everything else
 * in this module — boards, templates, channels — is machinery for filling this list. If a person
 * cannot open one page and see what is owed, the meeting comes back.
 *
 * ## The bands, not a sort
 *
 * Rows are grouped by how late they are rather than listed by date, because a date on its own asks
 * the reader to do the arithmetic. Priority orders rows *within* a band and never across one: an
 * urgent task due next month is not more pressing than a normal one that was due last Tuesday.
 *
 * ## Undated tasks are shown, counted, and kept last
 *
 * They are not late and not on time — they are uncommitted. Hiding them would lose work; mixing them
 * into the dated list would make the list stop being a plan. So they get their own band at the
 * bottom and a number in the summary, which is the prompt to go and agree a date with somebody.
 */

const URGENCY_BANDS: { key: TaskUrgency; heading: string; note: string; tone: StatusTone }[] = [
  {
    key: "overdue",
    heading: "Overdue",
    note: "Past their date. Longest overdue first.",
    tone: "failed",
  },
  { key: "today", heading: "Due today", note: "", tone: "pending" },
  { key: "soon", heading: "Next three days", note: "", tone: "active" },
  { key: "later", heading: "Later", note: "", tone: "draft" },
  {
    key: "undated",
    heading: "No date agreed",
    note: "Nobody has said when these are due. Agree a date or they will keep sliding.",
    tone: "draft",
  },
];

const STATUS_TONE: Record<TaskStatus, StatusTone> = {
  todo: "draft",
  in_progress: "active",
  blocked: "failed",
  for_review: "pending",
  done: "approved",
  cancelled: "cancelled",
};

/** How late, in words. Null means undated, which is a different thing from on time. */
function lateness(days: number | null): string {
  if (days === null) return "no due date";
  if (days > 0) return `${days} day${days === 1 ? "" : "s"} overdue`;
  if (days === 0) return "due today";
  return `${-days} day${days === -1 ? "" : "s"} left`;
}

export default function MyWorkPage() {
  const work = trpc.collab.myWork.useQuery();
  const utils = trpc.useUtils();
  const [raising, setRaising] = useState(false);

  const setStatus = trpc.collab.setStatus.useMutation({
    onSuccess: () => {
      toastSuccess("Moved.");
      void utils.collab.myWork.invalidate();
    },
    onError: toastError,
  });

  const rows = work.data?.rows ?? [];

  return (
    <div className="mx-auto max-w-4xl">
      <PageHeader
        title="My Work"
        description="Everything assigned to you, across every module."
        actions={
          <Button variant="secondary" onClick={() => setRaising((open) => !open)}>
            {raising ? "Close" : "Raise a task"}
          </Button>
        }
      />

      {raising && (
        <RaiseTask
          onDone={() => {
            setRaising(false);
            void utils.collab.myWork.invalidate();
          }}
        />
      )}

      {work.isLoading && <Card className="text-sm text-text-muted">Loading…</Card>}

      {/* An empty page under the heading would read as "nothing is assigned to you", which is a
          different and much more reassuring statement than "the list could not be read". */}
      {work.isError && (
        <Card className="text-sm">
          <p className="font-medium">Your work list could not be read.</p>
          <p className="mt-1 text-text-muted">{work.error.message}</p>
        </Card>
      )}

      {work.data && (
        <>
          <Card className="mb-4 flex flex-wrap gap-6 text-sm">
            <Summary label="Overdue" value={work.data.overdue} tone="failed" />
            <Summary label="Due today" value={work.data.dueToday} tone="pending" />
            <Summary label="No date agreed" value={work.data.undated} tone="draft" />
            <Summary label="Open in total" value={rows.length} tone="draft" />
          </Card>

          {rows.length === 0 && (
            <Card>
              <EmptyState
                title="Nothing is assigned to you."
                description={
                  "This is genuinely empty, not broken — no open task names you as the owner. " +
                  "Tasks arrive when somebody assigns one, or automatically when a record moves."
                }
              />
            </Card>
          )}

          {URGENCY_BANDS.map((band) => {
            const inBand = rows.filter((row) => row.urgency === band.key);
            if (inBand.length === 0) return null;

            return (
              <section key={band.key} className="mb-6">
                <div className="mb-2 flex items-baseline gap-2">
                  <h2 className="text-sm font-medium">{band.heading}</h2>
                  <span className="text-sm text-text-muted">{inBand.length}</span>
                </div>
                {band.note && <p className="mb-2 text-sm text-text-muted">{band.note}</p>}

                <div className="flex flex-col gap-2">
                  {inBand.map((task) => (
                    <Card key={task.id} className="flex flex-wrap items-start gap-3">
                      <div className="min-w-0 flex-1">
                        <div className="flex flex-wrap items-center gap-2">
                          <span className="tabular text-sm text-text-muted">{task.number}</span>
                          <StatusBadge tone={STATUS_TONE[task.status as TaskStatus] ?? "draft"}>
                            {TASK_STATUS_LABELS[task.status as TaskStatus] ?? task.status}
                          </StatusBadge>
                          {task.priority !== "normal" && (
                            <StatusBadge tone={task.priority === "urgent" ? "failed" : "pending"}>
                              {TASK_PRIORITY_LABELS[
                                task.priority as keyof typeof TASK_PRIORITY_LABELS
                              ] ?? task.priority}
                            </StatusBadge>
                          )}
                        </div>

                        <p className="mt-1 font-medium">{task.title}</p>
                        {task.description && (
                          <p className="mt-1 text-sm text-text-muted">{task.description}</p>
                        )}

                        <p className="mt-1 flex flex-wrap items-center gap-2 text-sm text-text-muted">
                          {task.dueAt ? (
                            <>
                              <DateCell value={task.dueAt} />
                              <span>· {lateness(task.daysLate)}</span>
                            </>
                          ) : (
                            <span>{lateness(task.daysLate)}</span>
                          )}
                          {/* The link back to the record is what makes this a task and not a to-do
                              list — §2's whole point is that work hangs off something. */}
                          {task.entityType &&
                            task.entityId &&
                            isTaskEntityType(task.entityType) && (
                              <Link
                                className="text-blue-600 underline-offset-4 hover:underline"
                                href={TASK_ENTITY_HREF[task.entityType](task.entityId)}
                              >
                                Open the {task.entityType.replace(/([a-z])([A-Z])/g, "$1 $2")}
                              </Link>
                            )}
                        </p>
                      </div>

                      <div className="flex shrink-0 items-center gap-2">
                        <Select
                          aria-label={`Status of ${task.number}`}
                          value={task.status}
                          disabled={setStatus.isPending}
                          onChange={(event) =>
                            setStatus.mutate({
                              taskId: task.id,
                              status: event.target.value as TaskStatus,
                            })
                          }
                        >
                          {TASK_STATUSES.map((status) => (
                            <option key={status} value={status}>
                              {TASK_STATUS_LABELS[status]}
                            </option>
                          ))}
                        </Select>
                        <Button
                          size="sm"
                          disabled={setStatus.isPending}
                          onClick={() => setStatus.mutate({ taskId: task.id, status: "done" })}
                        >
                          Done
                        </Button>
                      </div>
                    </Card>
                  ))}
                </div>
              </section>
            );
          })}
        </>
      )}
    </div>
  );
}

function Summary({ label, value, tone }: { label: string; value: number; tone: StatusTone }) {
  return (
    <div>
      <div className="text-xs text-text-muted">{label}</div>
      <div className="mt-1 flex items-center gap-2">
        <span className="tabular text-lg">{value}</span>
        {value > 0 && tone !== "draft" && <StatusBadge tone={tone}>needs attention</StatusBadge>}
      </div>
    </div>
  );
}

/**
 * Raising one by hand.
 *
 * Most tasks will arrive from a template once session 2 lands. This exists because the ones that do
 * not — "chase the supplier about the delivery date" — are exactly the assignments §1 says currently
 * live in somebody's head.
 */
function RaiseTask({ onDone }: { onDone: () => void }) {
  const [title, setTitle] = useState("");
  const [description, setDescription] = useState("");
  const [assigneeId, setAssigneeId] = useState("");
  const [priority, setPriority] = useState<string>("normal");
  const [dueAt, setDueAt] = useState("");
  const [entityType, setEntityType] = useState("");
  const [entityId, setEntityId] = useState("");

  const people = trpc.collab.assignableUsers.useQuery();
  const create = trpc.collab.create.useMutation({
    onSuccess: (result) => {
      toastSuccess(`Raised ${result.number}.`);
      onDone();
    },
    onError: toastError,
  });

  return (
    <Card className="mb-4 flex flex-col gap-3">
      <div>
        <Label htmlFor="task-title">What needs doing</Label>
        <Input
          id="task-title"
          value={title}
          onChange={(event) => setTitle(event.target.value)}
          placeholder="Chase Acme for the revised delivery date"
        />
      </div>

      <div>
        <Label htmlFor="task-description">Any detail (optional)</Label>
        <Textarea
          id="task-description"
          rows={2}
          value={description}
          onChange={(event) => setDescription(event.target.value)}
        />
      </div>

      <div className="grid gap-3 sm:grid-cols-3">
        <div>
          <Label htmlFor="task-assignee">Whose is it</Label>
          <Select
            id="task-assignee"
            value={assigneeId}
            onChange={(event) => setAssigneeId(event.target.value)}
          >
            {/* Blank means yours, not nobody's — a task raised with an empty owner in a hurry
                should land somewhere rather than float. */}
            <option value="">Mine</option>
            {(people.data ?? []).map((person) => (
              <option key={person.id} value={person.id}>
                {person.name}
                {person.jobTitle ? ` — ${person.jobTitle}` : ""}
              </option>
            ))}
          </Select>
        </div>

        <div>
          <Label htmlFor="task-priority">Priority</Label>
          <Select
            id="task-priority"
            value={priority}
            onChange={(event) => setPriority(event.target.value)}
          >
            {TASK_PRIORITIES.map((value) => (
              <option key={value} value={value}>
                {TASK_PRIORITY_LABELS[value]}
              </option>
            ))}
          </Select>
        </div>

        <div>
          <Label htmlFor="task-due">Due</Label>
          <Input
            id="task-due"
            type="date"
            value={dueAt}
            onChange={(event) => setDueAt(event.target.value)}
          />
        </div>
      </div>

      <div className="grid gap-3 sm:grid-cols-2">
        <div>
          <Label htmlFor="task-entity-type">Attach to a record (optional)</Label>
          <Select
            id="task-entity-type"
            value={entityType}
            onChange={(event) => setEntityType(event.target.value)}
          >
            <option value="">Not attached</option>
            {TASK_ENTITY_TYPES.map((value) => (
              <option key={value} value={value}>
                {value.replace(/([a-z])([A-Z])/g, "$1 $2")}
              </option>
            ))}
          </Select>
        </div>
        <div>
          <Label htmlFor="task-entity-id">Its id</Label>
          <Input
            id="task-entity-id"
            value={entityId}
            disabled={!entityType}
            onChange={(event) => setEntityId(event.target.value)}
            placeholder={entityType ? "Paste from the record's URL" : "Pick a record type first"}
          />
        </div>
      </div>

      <div className="flex items-center gap-2">
        <Button
          disabled={create.isPending || title.trim().length < 3}
          onClick={() =>
            create.mutate({
              title,
              description: description.trim() || null,
              assigneeId: assigneeId || null,
              priority: priority as (typeof TASK_PRIORITIES)[number],
              dueAt: dueAt ? new Date(dueAt) : null,
              entityType: entityType ? (entityType as (typeof TASK_ENTITY_TYPES)[number]) : null,
              entityId: entityType ? entityId.trim() || null : null,
            })
          }
        >
          Raise it
        </Button>
        <span className="text-sm text-text-muted">
          No due date is allowed — it will sit under &ldquo;No date agreed&rdquo; until somebody
          sets one.
        </span>
      </div>
    </Card>
  );
}
