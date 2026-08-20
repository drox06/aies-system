"use client";

import Link from "next/link";
import { use, useState } from "react";
import { BoardSettings } from "./BoardSettings";
import { Button } from "@/components/ui/button";
import { DateCell } from "@/components/ui/cells";
import { Select } from "@/components/ui/input";
import { Card, EmptyState, PageHeader } from "@/components/ui/layout";
import { StatusBadge } from "@/components/ui/status-badge";
import { toastError, toastSuccess } from "@/lib/errors";
import { trpc } from "@/lib/trpc/client";
import { TASK_ENTITY_HREF, isTaskEntityType } from "@/server/core/collab/task-rules";

/**
 * One board (specs/06-collaboration.md §2).
 *
 * ## Dragging, and what happens when dragging is not available
 *
 * Cards are moved with the browser's own drag-and-drop, which is right on a desk and does not exist
 * on a touch screen. So **every card also carries a column dropdown**: the same move, one tap, no
 * dragging. That is not a fallback bolted on — a technician looking at this on a phone is a real
 * reader, and a board they can only look at is half a board.
 *
 * ## A move is a status change
 *
 * Dropping a card in **In progress** sets the task's status. The alternative is a board that records
 * where a card sits and a task that records what is happening, disagreeing by Wednesday.
 *
 * ## Smart boards refuse the move, and say why
 *
 * Nothing is ever placed on a smart board. The drop is refused with the reason, because a move that
 * silently did nothing would read as a bug.
 */

export default function BoardPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = use(params);
  const utils = trpc.useUtils();
  const [includeDone, setIncludeDone] = useState(false);
  const [placing, setPlacing] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [dragging, setDragging] = useState<string | null>(null);

  const board = trpc.collab.board.useQuery({ boardId: id, includeDone });
  const placeable = trpc.collab.placeableTasks.useQuery({ boardId: id }, { enabled: placing });

  const refresh = () => {
    void utils.collab.board.invalidate({ boardId: id });
    void utils.collab.placeableTasks.invalidate({ boardId: id });
    void utils.collab.myWork.invalidate();
  };

  const move = trpc.collab.moveCard.useMutation({
    onSuccess: () => {
      refresh();
    },
    onError: toastError,
  });

  const remove = trpc.collab.removeCard.useMutation({
    onSuccess: () => {
      toastSuccess("Taken off the board. The task itself is untouched.");
      refresh();
    },
    onError: toastError,
  });

  if (board.isLoading) return <Card className="text-sm text-text-muted">Loading…</Card>;

  if (board.isError) {
    return (
      <Card className="text-sm">
        <p className="font-medium">This board could not be opened.</p>
        <p className="mt-1 text-text-muted">{board.error.message}</p>
        <Button className="mt-3" variant="secondary" asChild>
          <Link href="/boards">Back to boards</Link>
        </Button>
      </Card>
    );
  }

  const data = board.data!;
  const isSmart = data.type === "smart";

  return (
    <div>
      <PageHeader
        title={data.name}
        description={
          isSmart
            ? "Keeps itself current — what is here is decided by this board's filter."
            : "Arranged by hand. Dragging a card also sets its status."
        }
        actions={
          <div className="flex flex-wrap items-center gap-2">
            <label className="flex items-center gap-2 text-sm text-text-muted">
              <input
                type="checkbox"
                checked={includeDone}
                onChange={(event) => setIncludeDone(event.target.checked)}
              />
              Show finished
            </label>
            {!isSmart && (
              <Button variant="secondary" onClick={() => setPlacing((was) => !was)}>
                {placing ? "Close" : "Put a task on it"}
              </Button>
            )}
            <Button variant="secondary" onClick={() => setSettingsOpen((was) => !was)}>
              {settingsOpen ? "Close settings" : "Settings"}
            </Button>
            <Button variant="ghost" asChild>
              <Link href="/boards">All boards</Link>
            </Button>
          </div>
        }
      />

      {settingsOpen && (
        <BoardSettings
          boardId={data.id}
          name={data.name}
          isPrivate={data.isPrivate}
          swimlaneBy={data.swimlaneBy}
          type={data.type}
          columns={data.columns}
          onSaved={() => {
            setSettingsOpen(false);
            refresh();
          }}
        />
      )}

      {placing && !isSmart && (
        <Card className="mb-4">
          <p className="text-sm font-medium">Open tasks not on this board</p>
          {placeable.data?.length === 0 && (
            <p className="mt-1 text-sm text-text-muted">
              Every open task is already here. New work arrives from My Work or from a template.
            </p>
          )}
          <ul className="mt-2 flex flex-col gap-2">
            {(placeable.data ?? []).map((task) => (
              <li key={task.id} className="flex flex-wrap items-center gap-2 text-sm">
                <span className="tabular text-text-muted">{task.number}</span>
                <span className="min-w-0 flex-1">{task.title}</span>
                <Button
                  size="sm"
                  variant="secondary"
                  disabled={move.isPending}
                  onClick={() =>
                    move.mutate({
                      taskId: task.id,
                      boardId: id,
                      columnKey: data.columns[0]!.key,
                    })
                  }
                >
                  Add to {data.columns[0]!.label}
                </Button>
              </li>
            ))}
          </ul>
        </Card>
      )}

      {data.emptyBecause && (
        <Card className="mb-4">
          <EmptyState
            title={data.emptyBecause}
            description={
              isSmart
                ? "This is the board working, not failing — nothing in the company answers its question at the moment."
                : "Use “Put a task on it” to bring existing work here."
            }
          />
        </Card>
      )}

      {/* The board scrolls sideways inside itself; the page never does. */}
      <div className="overflow-x-auto pb-2">
        <div className="min-w-max">
          {/* Column headings once, above every lane, so the board reads as columns rather than as a
              stack of unrelated rows. */}
          <div className="flex gap-3">
            {data.columns.map((column) => {
              const count = data.cards.filter((card) => card.columnKey === column.key).length;
              return (
                <div
                  key={column.key}
                  className="flex w-72 shrink-0 items-baseline justify-between gap-2 px-1 pb-2"
                >
                  <h2 className="text-sm font-medium">{column.label}</h2>
                  {column.wip.limit === null ? (
                    <span className="text-xs text-text-muted">{count}</span>
                  ) : (
                    /*
                      Over its limit reads loudly and still allows the move.

                      A WIP limit's job is to make overload visible. Refusing the drop would not
                      reduce the work - it would leave the card in a column it has already left, and
                      a board that disagrees with reality is worse than no board.
                    */
                    <span
                      className={
                        column.wip.over
                          ? "text-xs font-medium text-danger"
                          : "text-xs text-text-muted"
                      }
                    >
                      {count} / {column.wip.limit}
                      {column.wip.over ? " over" : ""}
                    </span>
                  )}
                </div>
              );
            })}
          </div>

          {data.lanes.map((lane) => (
            <div key={lane.key} className="mb-3">
              {lane.label && (
                <p className="mb-1 text-xs font-medium tracking-wide text-text-muted uppercase">
                  {lane.label}
                </p>
              )}
              <div className="flex gap-3">
                {data.columns.map((column) => {
                  const cards = data.cards.filter(
                    (card) => card.columnKey === column.key && card.laneKey === lane.key,
                  );
                  return (
                    <section
                      key={column.key}
                      className="min-h-16 w-72 shrink-0 rounded-md border border-border bg-surface-2 p-2"
                      onDragOver={(event) => {
                        if (!isSmart) event.preventDefault();
                      }}
                      onDrop={(event) => {
                        event.preventDefault();
                        if (!dragging) return;
                        move.mutate({ taskId: dragging, boardId: id, columnKey: column.key });
                        setDragging(null);
                      }}
                    >
                      <div className="flex flex-col gap-2">
                        {cards.map((card) => (
                          <article
                            key={card.id}
                            draggable={!isSmart}
                            onDragStart={() => setDragging(card.id)}
                            onDragEnd={() => setDragging(null)}
                            className="rounded-md border border-border bg-surface p-2"
                          >
                            <div className="flex flex-wrap items-center gap-1.5">
                              <span className="tabular text-xs text-text-muted">{card.number}</span>
                              {card.urgency === "overdue" && (
                                <StatusBadge tone="failed">
                                  {card.daysLate} day{card.daysLate === 1 ? "" : "s"} late
                                </StatusBadge>
                              )}
                              {card.priority === "urgent" && (
                                <StatusBadge tone="failed">Urgent</StatusBadge>
                              )}
                              {card.fromTemplate && (
                                <StatusBadge tone="info">Automatic</StatusBadge>
                              )}
                            </div>

                            <p className="mt-1 text-sm">{card.title}</p>

                            <p className="mt-1 flex flex-wrap items-center gap-2 text-xs text-text-muted">
                              <span>{card.assigneeName ?? "Nobody yet"}</span>
                              {card.dueAt ? (
                                <DateCell value={card.dueAt} />
                              ) : (
                                <span>no date agreed</span>
                              )}
                              {card.entityType &&
                                card.entityId &&
                                isTaskEntityType(card.entityType) && (
                                  <Link
                                    className="text-blue-600 underline-offset-4 hover:underline"
                                    href={TASK_ENTITY_HREF[card.entityType](card.entityId)}
                                  >
                                    Open the record
                                  </Link>
                                )}
                            </p>

                            {!isSmart && (
                              <div className="mt-2 flex items-center gap-2">
                                {/* The same move as a drag, for anybody without one. A phone has no
                                    drag-and-drop, and a board somebody can only look at is half a
                                    board. */}
                                <Select
                                  aria-label={`Column for ${card.number}`}
                                  className="h-8 text-xs"
                                  value={card.columnKey}
                                  disabled={move.isPending}
                                  onChange={(event) =>
                                    move.mutate({
                                      taskId: card.id,
                                      boardId: id,
                                      columnKey: event.target.value,
                                    })
                                  }
                                >
                                  {data.columns.map((option) => (
                                    <option key={option.key} value={option.key}>
                                      {option.label}
                                    </option>
                                  ))}
                                </Select>
                                <Button
                                  size="sm"
                                  variant="ghost"
                                  disabled={remove.isPending}
                                  onClick={() => remove.mutate({ taskId: card.id })}
                                >
                                  Off the board
                                </Button>
                              </div>
                            )}
                          </article>
                        ))}
                      </div>
                    </section>
                  );
                })}
              </div>
            </div>
          ))}
        </div>
      </div>

      {data.hidingDone && (
        <p className="mt-3 text-xs text-text-muted">
          Finished work is hidden. The column stays so the board still reads left to right.
        </p>
      )}
    </div>
  );
}
