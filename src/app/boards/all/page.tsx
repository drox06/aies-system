"use client";

import Link from "next/link";
import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Input, Label, Select } from "@/components/ui/input";
import { Card, EmptyState, PageHeader } from "@/components/ui/layout";
import { StatusBadge } from "@/components/ui/status-badge";
import { toastError, toastSuccess } from "@/lib/errors";
import { trpc } from "@/lib/trpc/client";
import {
  TASK_ENTITY_TYPES,
  TASK_STATUSES,
  TASK_STATUS_LABELS,
} from "@/server/core/collab/task-rules";

/**
 * §2's boards, listed (specs/06-collaboration.md) — every custom board, plus the default "Task
 * board" `/boards` opens straight into. Reached from "All boards" on that default view (#160):
 * `/boards` itself is now the answer to "what state is everything in," and this is where somebody
 * builds a board that asks a narrower question — their own open tasks, one customer's jobs overdue.
 *
 * ## The distinction this screen has to teach
 *
 * A **manual** board is a place cards are put. A **smart** board is a question asked of every task,
 * and nothing is ever placed on it — §2: *"This is what makes the boards stay current without a
 * human maintaining them."* Somebody who does not know which kind they are looking at will try to
 * drag a card on a smart board and conclude the software is broken, so the kind is on the card, in
 * the new-board form, and in the refusal if they try.
 */
export default function BoardsPage() {
  const utils = trpc.useUtils();
  const boards = trpc.collab.boards.useQuery();
  const [making, setMaking] = useState(false);

  return (
    <div className="mx-auto max-w-4xl">
      <PageHeader
        title="All boards"
        description="Every way the company has of looking at tasks — including the default one, Task board."
        actions={
          <Button variant="secondary" onClick={() => setMaking((was) => !was)}>
            {making ? "Close" : "New board"}
          </Button>
        }
      />

      {making && (
        <NewBoard
          onDone={() => {
            setMaking(false);
            void utils.collab.boards.invalidate();
          }}
        />
      )}

      {boards.isLoading && <Card className="text-sm text-text-muted">Loading…</Card>}

      {boards.isError && (
        <Card className="text-sm">
          <p className="font-medium">The boards could not be read.</p>
          <p className="mt-1 text-text-muted">{boards.error.message}</p>
        </Card>
      )}

      {boards.data?.length === 0 && (
        <Card>
          <EmptyState
            title="No boards yet."
            description="A board is a way of looking at tasks that already exist — making one takes nothing away from My Work."
          />
        </Card>
      )}

      <div className="flex flex-col gap-2">
        {(boards.data ?? []).map((board) => (
          <Card key={board.id} className="flex flex-wrap items-center gap-3">
            <div className="min-w-0 flex-1">
              <div className="flex flex-wrap items-center gap-2">
                <Link href={`/boards/${board.id}`} className="font-medium hover:underline">
                  {board.name}
                </Link>
                {board.isDefault && <StatusBadge tone="approved">Default</StatusBadge>}
                {board.type === "smart" ? (
                  <StatusBadge tone="info">Keeps itself current</StatusBadge>
                ) : (
                  <StatusBadge tone="draft">Arranged by hand</StatusBadge>
                )}
                {board.isPrivate && <StatusBadge tone="cancelled">Private</StatusBadge>}
              </div>
              <p className="mt-1 text-sm text-text-muted">
                {board.columns.map((column) => column.label).join(" · ")}
              </p>
            </div>
            <Button variant="secondary" size="sm" asChild>
              <Link href={`/boards/${board.id}`}>Open</Link>
            </Button>
          </Card>
        ))}
      </div>
    </div>
  );
}

function NewBoard({ onDone }: { onDone: () => void }) {
  const [name, setName] = useState("");
  const [type, setType] = useState<"manual" | "smart">("manual");
  const [isPrivate, setIsPrivate] = useState(false);
  const [swimlaneBy, setSwimlaneBy] = useState<"none" | "assignee" | "priority">("none");
  const [assignee, setAssignee] = useState("anyone");
  const [entityType, setEntityType] = useState("");
  const [status, setStatus] = useState("");
  const [overdueOnly, setOverdueOnly] = useState(false);

  const create = trpc.collab.createBoard.useMutation({
    onSuccess: () => {
      toastSuccess("Board created.");
      onDone();
    },
    onError: toastError,
  });

  return (
    <Card className="mb-4 flex flex-col gap-3">
      <div className="grid gap-3 sm:grid-cols-2">
        <div>
          <Label htmlFor="board-name">Name</Label>
          <Input
            id="board-name"
            value={name}
            onChange={(event) => setName(event.target.value)}
            placeholder="Jobs on site this month"
          />
        </div>
        <div>
          <Label htmlFor="board-type">Kind</Label>
          <Select
            id="board-type"
            value={type}
            onChange={(event) => setType(event.target.value as "manual" | "smart")}
          >
            <option value="manual">Arranged by hand — you drag cards onto it</option>
            <option value="smart">Keeps itself current — a filter decides what is on it</option>
          </Select>
        </div>
      </div>

      {type === "smart" && (
        <div className="rounded-md border border-border bg-surface-2 p-3">
          <p className="text-sm font-medium">What should be on it?</p>
          <p className="mt-1 text-xs text-text-muted">
            Every condition has to be true. Nothing is ever dragged onto a board like this — it
            answers the question again every time somebody opens it.
          </p>
          <div className="mt-3 grid gap-3 sm:grid-cols-3">
            <div>
              <Label htmlFor="filter-assignee">Whose</Label>
              <Select
                id="filter-assignee"
                value={assignee}
                onChange={(event) => setAssignee(event.target.value)}
              >
                <option value="anyone">Anyone&rsquo;s</option>
                <option value="me">Mine — whoever is looking</option>
                <option value="unassigned">Nobody&rsquo;s yet</option>
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
            <div>
              <Label htmlFor="filter-status">Status</Label>
              <Select
                id="filter-status"
                value={status}
                onChange={(event) => setStatus(event.target.value)}
              >
                <option value="">Any</option>
                {TASK_STATUSES.map((value) => (
                  <option key={value} value={value}>
                    {TASK_STATUS_LABELS[value]}
                  </option>
                ))}
              </Select>
            </div>
          </div>
          <label className="mt-3 flex items-center gap-2 text-sm">
            <input
              type="checkbox"
              checked={overdueOnly}
              onChange={(event) => setOverdueOnly(event.target.checked)}
            />
            Only what is past its date
          </label>
        </div>
      )}

      <div className="grid gap-3 sm:grid-cols-2">
        <div>
          <Label htmlFor="board-lanes">Rows</Label>
          <Select
            id="board-lanes"
            value={swimlaneBy}
            onChange={(event) =>
              setSwimlaneBy(event.target.value as "none" | "assignee" | "priority")
            }
          >
            <option value="none">One lane</option>
            <option value="assignee">A lane per person</option>
            <option value="priority">A lane per priority</option>
          </Select>
        </div>
        <label className="flex items-end gap-2 pb-2 text-sm">
          <input
            type="checkbox"
            checked={isPrivate}
            onChange={(event) => setIsPrivate(event.target.checked)}
          />
          Private — only you can open it
        </label>
      </div>

      <div>
        <Button
          disabled={create.isPending || name.trim().length < 2}
          onClick={() =>
            create.mutate({
              name,
              type,
              isPrivate,
              swimlaneBy,
              filterRule:
                type === "smart"
                  ? {
                      assignee,
                      ...(entityType ? { entityTypes: [entityType] } : {}),
                      ...(status ? { statuses: [status] } : {}),
                      ...(overdueOnly ? { overdueOnly: true } : {}),
                    }
                  : null,
            })
          }
        >
          Create it
        </Button>
      </div>
    </Card>
  );
}
