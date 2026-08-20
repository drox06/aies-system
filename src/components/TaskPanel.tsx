"use client";

import { useState } from "react";
import { Button } from "@/components/ui/button";
import { DateCell } from "@/components/ui/cells";
import { Input, Select } from "@/components/ui/input";
import { StatusBadge, type StatusTone } from "@/components/ui/status-badge";
import { toastError, toastSuccess } from "@/lib/errors";
import { trpc } from "@/lib/trpc/client";
import {
  TASK_STATUS_LABELS,
  type TaskEntityType,
  type TaskStatus,
} from "@/server/core/collab/task-rules";

/**
 * The tasks hanging off one record (specs/06-collaboration.md §2).
 *
 * Dropped into a record page the way `AuditTrail` is, and for a related reason: the audit trail says
 * what has been done to this record, and this says what is still owed on it and by whom. §1's
 * problem — *"All work assignments are done thru meetings without proper documentation"* — is only
 * really solved when the assignment is visible from the thing it is about, not just on the
 * assignee's own list.
 *
 * Deliberately shows finished tasks too, unlike My Work. My Work answers "what do I still owe"; this
 * answers "what has this record needed", and a job that was done last week is part of that answer.
 */
export function TaskPanel({
  entityType,
  entityId,
}: {
  entityType: TaskEntityType;
  entityId: string;
}) {
  const utils = trpc.useUtils();
  const tasks = trpc.collab.forRecord.useQuery({ entityType, entityId });
  const people = trpc.collab.assignableUsers.useQuery();
  const [adding, setAdding] = useState(false);
  const [title, setTitle] = useState("");
  const [assigneeId, setAssigneeId] = useState("");
  const [dueAt, setDueAt] = useState("");

  const refresh = () => {
    void utils.collab.forRecord.invalidate({ entityType, entityId });
    void utils.collab.myWork.invalidate();
  };

  const create = trpc.collab.create.useMutation({
    onSuccess: (result) => {
      toastSuccess(`Raised ${result.number}.`);
      setTitle("");
      setDueAt("");
      setAdding(false);
      refresh();
    },
    onError: toastError,
  });

  const setStatus = trpc.collab.setStatus.useMutation({
    onSuccess: () => {
      toastSuccess("Moved.");
      refresh();
    },
    onError: toastError,
  });

  const rows = tasks.data ?? [];
  const open = rows.filter((row) => row.status !== "done" && row.status !== "cancelled");

  return (
    <div>
      <div className="flex items-baseline justify-between gap-2">
        <h2 className="text-sm font-semibold">Tasks</h2>
        <Button size="sm" variant="ghost" onClick={() => setAdding((was) => !was)}>
          {adding ? "Cancel" : "Add"}
        </Button>
      </div>

      {adding && (
        <div className="mt-2 flex flex-col gap-2">
          <Input
            aria-label="What needs doing"
            placeholder="What needs doing"
            value={title}
            onChange={(event) => setTitle(event.target.value)}
          />
          <Select
            aria-label="Whose is it"
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
          <Input
            aria-label="Due"
            type="date"
            value={dueAt}
            onChange={(event) => setDueAt(event.target.value)}
          />
          <Button
            size="sm"
            disabled={create.isPending || title.trim().length < 3}
            onClick={() =>
              create.mutate({
                title,
                entityType,
                entityId,
                assigneeId: assigneeId || null,
                dueAt: dueAt ? new Date(dueAt) : null,
              })
            }
          >
            Raise it
          </Button>
        </div>
      )}

      {tasks.isLoading && <p className="mt-2 text-xs text-text-muted">Loading…</p>}

      {/* Said out loud rather than left as an empty list. A panel that renders nothing when the
          read is refused is indistinguishable from a record with no tasks on it. */}
      {tasks.isError && (
        <p className="mt-2 text-xs text-text-muted">
          The tasks on this record could not be read: {tasks.error.message}
        </p>
      )}

      {tasks.data && rows.length === 0 && (
        <p className="mt-2 text-xs text-text-muted">
          Nothing is owed on this record. Anything somebody agrees to do should be raised here
          rather than remembered.
        </p>
      )}

      <ul className="mt-2 space-y-2">
        {rows.map((task) => (
          <li key={task.id} className="text-sm">
            <div className="flex flex-wrap items-center gap-1.5">
              <StatusBadge tone={TONE[task.status as TaskStatus] ?? "draft"}>
                {TASK_STATUS_LABELS[task.status as TaskStatus] ?? task.status}
              </StatusBadge>
              {task.urgency === "overdue" && (
                <StatusBadge tone="failed">
                  {task.daysLate} day{task.daysLate === 1 ? "" : "s"} late
                </StatusBadge>
              )}
            </div>
            <p className="mt-0.5">{task.title}</p>
            <p className="text-xs text-text-muted">
              {task.assigneeName ?? "Nobody yet"}
              {task.dueAt ? (
                <>
                  {" · due "}
                  <DateCell value={task.dueAt} />
                </>
              ) : (
                " · no date agreed"
              )}
            </p>
            {task.status !== "done" && task.status !== "cancelled" && (
              <Button
                size="sm"
                variant="ghost"
                className="mt-0.5 px-0"
                disabled={setStatus.isPending}
                onClick={() => setStatus.mutate({ taskId: task.id, status: "done" })}
              >
                Mark done
              </Button>
            )}
          </li>
        ))}
      </ul>

      {rows.length > 0 && (
        <p className="mt-2 text-xs text-text-muted">
          {open.length} of {rows.length} still open.
        </p>
      )}
    </div>
  );
}

const TONE: Record<TaskStatus, StatusTone> = {
  todo: "draft",
  in_progress: "active",
  blocked: "failed",
  for_review: "pending",
  done: "approved",
  cancelled: "cancelled",
};
