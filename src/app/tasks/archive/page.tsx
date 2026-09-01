"use client";

import Link from "next/link";
import { useSession } from "next-auth/react";
import { useMemo, useState } from "react";
import {
  DataTable,
  DEFAULT_TABLE_STATE,
  type Column,
  type DataTableState,
} from "@/components/ui/data-table";
import { DateCell } from "@/components/ui/cells";
import { Button } from "@/components/ui/button";
import { Label, Select } from "@/components/ui/input";
import { EmptyState, PageHeader } from "@/components/ui/layout";
import { StatusBadge } from "@/components/ui/status-badge";
import { trpc } from "@/lib/trpc/client";
import {
  TASK_ENTITY_HREF,
  canSeeEveryArchivedTask,
  isTaskEntityType,
} from "@/server/core/collab/task-rules";

/**
 * §2's finished work, kept and searchable — the company's own words: *"an archive of tasks where
 * all completed tasks are saved for later viewing and traceability."*
 *
 * A separate screen from `/tasks` rather than a toggle on it, unlike the quotations archive: that
 * one flips the same `DataTable` between two states because its working list already runs through
 * one. This module's working list is a plain row list built for quick inline editing, not bulk
 * historical search — a different job, so it gets `DataTable`'s search, sort, pagination and CSV
 * export here rather than retrofitting all of that onto a screen that does not need most of it.
 *
 * Nothing here can be edited. A completed task is the record of what happened; changing it after
 * the fact would be rewriting history rather than tracing it.
 */

type ArchivedTaskRow = {
  id: string;
  number: string;
  title: string;
  description: string | null;
  priority: string;
  assigneeId: string | null;
  assigneeName: string | null;
  createdByName: string;
  entityType: string | null;
  entityId: string | null;
  labels: string[];
  createdAt: Date;
  completedAt: Date | null;
};

export default function TaskArchivePage() {
  const { data: session } = useSession();
  const seesEverything = !!session?.user && canSeeEveryArchivedTask(session.user.email ?? "");
  const [state, setState] = useState<DataTableState>(DEFAULT_TABLE_STATE);
  const [assigneeId, setAssigneeId] = useState("");

  const people = trpc.collab.assignableUsers.useQuery();
  const list = trpc.collab.archive.useQuery({
    search: state.search || undefined,
    assigneeId: assigneeId || undefined,
    page: state.page,
    pageSize: state.pageSize,
    sortKey: state.sortKey,
    sortDir: state.sortDir,
  });

  const columns = useMemo<Column<ArchivedTaskRow>[]>(
    () => [
      {
        key: "number",
        header: "Number",
        sortable: true,
        width: "9rem",
        cell: (row) => <span className="tabular text-sm text-text-muted">{row.number}</span>,
        exportValue: (row) => row.number,
      },
      {
        key: "title",
        header: "Task",
        sortable: true,
        cell: (row) => (
          <div className="min-w-0">
            <p className="truncate font-medium">{row.title}</p>
            {row.description && (
              <p className="truncate text-xs text-text-muted">{row.description}</p>
            )}
          </div>
        ),
        exportValue: (row) => row.title,
      },
      {
        key: "priority",
        header: "Priority",
        cell: (row) =>
          row.priority === "urgent" ? (
            <StatusBadge tone="failed">Urgent</StatusBadge>
          ) : (
            <span className="text-sm text-text-muted capitalize">{row.priority}</span>
          ),
        exportValue: (row) => row.priority,
      },
      {
        key: "assignee",
        header: "Done by",
        cell: (row) => row.assigneeName ?? <span className="text-text-muted">—</span>,
        exportValue: (row) => row.assigneeName ?? "",
      },
      {
        key: "createdBy",
        header: "Raised by",
        cell: (row) => row.createdByName,
        exportValue: (row) => row.createdByName,
      },
      {
        key: "record",
        header: "On",
        cell: (row) =>
          row.entityType && row.entityId && isTaskEntityType(row.entityType) ? (
            <Link
              className="text-blue-600 underline-offset-4 hover:underline"
              href={TASK_ENTITY_HREF[row.entityType](row.entityId)}
            >
              {row.entityType.replace(/([a-z])([A-Z])/g, "$1 $2")}
            </Link>
          ) : (
            <span className="text-text-muted">Not attached</span>
          ),
        exportValue: (row) => row.entityType ?? "",
      },
      {
        key: "completedAt",
        header: "Completed",
        sortable: true,
        cell: (row) =>
          row.completedAt ? (
            <DateCell value={row.completedAt} withTime />
          ) : (
            <span className="text-text-muted">—</span>
          ),
        exportValue: (row) => row.completedAt?.toISOString() ?? "",
      },
    ],
    [],
  );

  return (
    <div className="mx-auto max-w-6xl">
      <PageHeader
        title="Task archive"
        description={
          seesEverything
            ? "Every completed task in the company, kept for later viewing and traceability."
            : "Completed tasks you raised or were assigned. EA and KJ can see everyone's."
        }
        actions={
          <Button variant="secondary" asChild>
            <Link href="/tasks">Back to all tasks</Link>
          </Button>
        }
      />

      <div className="mb-3 max-w-64">
        <Label htmlFor="archive-assignee">Done by</Label>
        <Select
          id="archive-assignee"
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

      <DataTable<ArchivedTaskRow>
        columns={columns}
        rows={(list.data?.rows ?? []) as ArchivedTaskRow[]}
        total={list.data?.total ?? 0}
        rowId={(row) => row.id}
        state={state}
        onStateChange={setState}
        isLoading={list.isPending}
        exportFilename="aies-task-archive"
        emptyState={
          <EmptyState
            title={state.search || assigneeId ? "Nothing matches." : "Nothing completed yet."}
            description={
              state.search || assigneeId
                ? "Widen the search or clear the filter."
                : "Finished tasks land here the moment they're marked done."
            }
          />
        }
      />
    </div>
  );
}
