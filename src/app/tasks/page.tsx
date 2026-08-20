"use client";

import Link from "next/link";
import { useState } from "react";
import { Button } from "@/components/ui/button";
import { DateCell } from "@/components/ui/cells";
import { Label, Select } from "@/components/ui/input";
import { Card, EmptyState, PageHeader } from "@/components/ui/layout";
import { StatusBadge, type StatusTone } from "@/components/ui/status-badge";
import { toastError, toastSuccess } from "@/lib/errors";
import { trpc } from "@/lib/trpc/client";
import {
  TASK_ENTITY_HREF,
  TASK_ENTITY_TYPES,
  TASK_STATUSES,
  TASK_STATUS_LABELS,
  isTaskEntityType,
  type TaskStatus,
} from "@/server/core/collab/task-rules";

/**
 * Every task in the company, and the one thing this screen exists to fix: work nobody owns.
 *
 * ## Why unassigned comes first
 *
 * §2's templates raise work the moment a record moves, and they assign it by role. When a role has
 * no active holder — nobody is a finance officer that week, the technician who left is still on the
 * ticket — the template creates the task anyway and leaves it ownerless, because recording the work
 * and losing it are not the same failure. But an unassigned task is on nobody's My Work, so this is
 * the only screen where it can be seen. It leads.
 *
 * ## Why this needs `task.assign`
 *
 * Reading everybody's queue and re-routing it are the same job. Somebody who can see that the
 * operations manager is carrying eleven open tasks and act on it is doing the work this module was
 * built for; somebody who can only see it is being shown other people's workload for no reason.
 */

const STATUS_TONE: Record<TaskStatus, StatusTone> = {
  todo: "draft",
  in_progress: "active",
  blocked: "failed",
  for_review: "pending",
  done: "approved",
  cancelled: "cancelled",
};

export default function AllTasksPage() {
  const utils = trpc.useUtils();
  const [status, setStatus] = useState<string>("open");
  const [assigneeId, setAssigneeId] = useState<string>("");
  const [entityType, setEntityType] = useState<string>("");

  const people = trpc.collab.assignableUsers.useQuery();
  const tasks = trpc.collab.list.useQuery({
    ...(status && status !== "open" ? { status: status as TaskStatus } : {}),
    ...(assigneeId ? { assigneeId } : {}),
    ...(entityType ? { entityType: entityType as (typeof TASK_ENTITY_TYPES)[number] } : {}),
  });

  const assign = trpc.collab.assign.useMutation({
    onSuccess: () => {
      toastSuccess("Reassigned.");
      void utils.collab.list.invalidate();
      void utils.collab.myWork.invalidate();
    },
    onError: toastError,
  });

  const rows = tasks.data ?? [];
  // "Open" is not a status — it is the question this screen is usually asked. Filtering it here
  // rather than in the service keeps the service honest about what a status is.
  const visible =
    status === "open"
      ? rows.filter((row) => row.status !== "done" && row.status !== "cancelled")
      : rows;

  const unassigned = visible.filter((row) => !row.assigneeId);
  const assigned = visible.filter((row) => row.assigneeId);

  return (
    <div className="mx-auto max-w-5xl">
      <PageHeader
        title="All tasks"
        description="Everything the company owes, whoever owes it — including what nobody owes yet."
        actions={
          <Button variant="secondary" asChild>
            <Link href="/tasks/templates">Templates</Link>
          </Button>
        }
      />

      <Card className="mb-4 flex flex-wrap items-end gap-4">
        <div>
          <Label htmlFor="filter-status">Status</Label>
          <Select
            id="filter-status"
            value={status}
            onChange={(event) => setStatus(event.target.value)}
          >
            <option value="open">Open — anything not finished</option>
            {TASK_STATUSES.map((value) => (
              <option key={value} value={value}>
                {TASK_STATUS_LABELS[value]}
              </option>
            ))}
          </Select>
        </div>
        <div>
          <Label htmlFor="filter-assignee">Whose</Label>
          <Select
            id="filter-assignee"
            value={assigneeId}
            onChange={(event) => setAssigneeId(event.target.value)}
          >
            <option value="">Anyone</option>
            {(people.data ?? []).map((person) => (
              <option key={person.id} value={person.id}>
                {person.name}
              </option>
            ))}
          </Select>
        </div>
        <div>
          <Label htmlFor="filter-entity">On a</Label>
          <Select
            id="filter-entity"
            value={entityType}
            onChange={(event) => setEntityType(event.target.value)}
          >
            <option value="">Any record</option>
            {TASK_ENTITY_TYPES.map((value) => (
              <option key={value} value={value}>
                {value.replace(/([a-z])([A-Z])/g, "$1 $2")}
              </option>
            ))}
          </Select>
        </div>
      </Card>

      {tasks.isLoading && <Card className="text-sm text-text-muted">Loading…</Card>}

      {tasks.isError && (
        <Card className="text-sm">
          <p className="font-medium">The task list could not be read.</p>
          <p className="mt-1 text-text-muted">{tasks.error.message}</p>
        </Card>
      )}

      {tasks.data && visible.length === 0 && (
        <Card>
          <EmptyState
            title="Nothing matches."
            description="Widen the filters, or there is genuinely no task in this state."
          />
        </Card>
      )}

      {unassigned.length > 0 && (
        <section className="mb-6">
          <div className="mb-2 flex items-baseline gap-2">
            <h2 className="text-sm font-medium">Nobody owns these</h2>
            <StatusBadge tone="failed">{unassigned.length}</StatusBadge>
          </div>
          <p className="mb-2 text-sm text-text-muted">
            Raised by a template that found no active holder for the role it wanted. They are on no
            one&rsquo;s My Work until somebody is named here.
          </p>
          <div className="flex flex-col gap-2">
            {unassigned.map((task) => (
              <Row
                key={task.id}
                task={task}
                people={people.data ?? []}
                onAssign={(id) => assign.mutate({ taskId: task.id, assigneeId: id })}
                busy={assign.isPending}
              />
            ))}
          </div>
        </section>
      )}

      {assigned.length > 0 && (
        <section>
          <h2 className="mb-2 text-sm font-medium">Assigned</h2>
          <div className="flex flex-col gap-2">
            {assigned.map((task) => (
              <Row
                key={task.id}
                task={task}
                people={people.data ?? []}
                onAssign={(id) => assign.mutate({ taskId: task.id, assigneeId: id })}
                busy={assign.isPending}
              />
            ))}
          </div>
        </section>
      )}
    </div>
  );
}

interface RowTask {
  id: string;
  number: string;
  title: string;
  status: string;
  priority: string;
  dueAt: Date | null;
  daysLate: number | null;
  urgency: string;
  assigneeId: string | null;
  assigneeName: string | null;
  entityType: string | null;
  entityId: string | null;
}

function Row({
  task,
  people,
  onAssign,
  busy,
}: {
  task: RowTask;
  people: { id: string; name: string }[];
  onAssign: (assigneeId: string | null) => void;
  busy: boolean;
}) {
  return (
    <Card className="flex flex-wrap items-start gap-3">
      <div className="min-w-0 flex-1">
        <div className="flex flex-wrap items-center gap-2">
          <span className="tabular text-sm text-text-muted">{task.number}</span>
          <StatusBadge tone={STATUS_TONE[task.status as TaskStatus] ?? "draft"}>
            {TASK_STATUS_LABELS[task.status as TaskStatus] ?? task.status}
          </StatusBadge>
          {task.urgency === "overdue" && (
            <StatusBadge tone="failed">
              {task.daysLate} day{task.daysLate === 1 ? "" : "s"} late
            </StatusBadge>
          )}
          {task.priority === "urgent" && <StatusBadge tone="failed">Urgent</StatusBadge>}
        </div>
        <p className="mt-1 font-medium">{task.title}</p>
        <p className="mt-1 flex flex-wrap items-center gap-2 text-sm text-text-muted">
          {task.dueAt ? <DateCell value={task.dueAt} /> : <span>no date agreed</span>}
          {task.entityType && task.entityId && isTaskEntityType(task.entityType) && (
            <Link
              className="text-blue-600 underline-offset-4 hover:underline"
              href={TASK_ENTITY_HREF[task.entityType](task.entityId)}
            >
              Open the {task.entityType.replace(/([a-z])([A-Z])/g, "$1 $2")}
            </Link>
          )}
        </p>
      </div>

      <div className="shrink-0">
        <Select
          aria-label={`Who owns ${task.number}`}
          value={task.assigneeId ?? ""}
          disabled={busy}
          onChange={(event) => onAssign(event.target.value || null)}
        >
          <option value="">Nobody</option>
          {people.map((person) => (
            <option key={person.id} value={person.id}>
              {person.name}
            </option>
          ))}
        </Select>
      </div>
    </Card>
  );
}
