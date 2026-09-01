import { randomUUID } from "node:crypto";
import { afterAll, describe, expect, it } from "vitest";
import { db } from "@/lib/db";
import {
  boardViewService,
  createBoardService,
  deleteBoardService,
  ensureDefaultBoardService,
  moveCardService,
  removeCardService,
} from "@/server/core/collab/board-service";
import { createTaskService } from "@/server/core/collab/task-service";

/**
 * §2's boards against the real database.
 *
 * ## What is pinned
 *
 *  1. **A move is a status change.** Dragging a card to *In progress* has to change the task, or the
 *     board becomes a second record of the same fact and the two start disagreeing.
 *  2. **A smart board refuses the move, with the reason.** Nothing is placed on one, so a move that
 *     silently did nothing would read as a bug in the software rather than a misunderstanding.
 *  3. **A smart board answers its question for whoever is looking.** `assignee: "me"` is what makes
 *     one board show each person their own work.
 *  4. **Deleting a board frees its cards.** A board is a way of looking at work; deleting one must
 *     not delete the work, and must not strand it on a board that no longer exists.
 *  5. **A private board is private.**
 */

const suffix = randomUUID().slice(0, 8);
const actor = (id: string, label: string) => ({
  actorId: id,
  actorLabel: label,
  ip: null,
  userAgent: null,
  requestId: null,
});

const owner = actor(`board-${suffix}`, "Board fixture");
const stranger = actor(`other-${suffix}`, "Somebody else");

const boardIds: string[] = [];
const taskIds: string[] = [];
const entityId = `board-entity-${suffix}`;

async function makeTask(title: string, over: Record<string, unknown> = {}) {
  const task = await createTaskService(owner, {
    title,
    entityType: "Ticket",
    entityId,
    ...over,
  });
  taskIds.push(task.id);
  return task;
}

async function makeBoard(input: Parameters<typeof createBoardService>[1]) {
  const board = await createBoardService(owner, input);
  boardIds.push(board.id);
  return board;
}

afterAll(async () => {
  const step = async (label: string, run: () => Promise<unknown>) => {
    try {
      await run();
    } catch (error) {
      console.error(`[board.test cleanup] ${label} failed`, error);
    }
  };

  // By entity id as well as by tracked id — docs/DECISIONS.md #139.
  const created = await db.task.findMany({
    where: { OR: [{ id: { in: taskIds } }, { entityId }] },
    select: { id: true },
  });
  const ids = created.map((task) => task.id);

  await step("notifications", () =>
    db.notification.deleteMany({ where: { entityId: { in: ids } } }),
  );
  await step("audit", () =>
    db.auditLog.deleteMany({ where: { entityId: { in: [...ids, ...boardIds] } } }),
  );
  await step("events", () => db.eventOutbox.deleteMany({ where: { actorId: owner.actorId } }));
  await step("tasks", () => db.task.deleteMany({ where: { id: { in: ids } } }));
  await step("boards", () => db.board.deleteMany({ where: { id: { in: boardIds } } }));
  await db.$disconnect();
});

describe("a manual board", () => {
  it("moves a card and changes the task with it", async () => {
    const board = await makeBoard({ name: `Manual ${suffix}` });
    const task = await makeTask("Fit the replacement bearing");

    await moveCardService(owner, {
      taskId: task.id,
      boardId: board.id,
      columnKey: "in_progress",
    });

    const row = await db.task.findUniqueOrThrow({ where: { id: task.id } });
    expect(row.boardId).toBe(board.id);
    expect(row.columnId).toBe("in_progress");
    // The column carries the status it stands for. Without this the board would say one thing and
    // the task another.
    expect(row.status).toBe("in_progress");

    const view = await boardViewService(owner.actorId, { boardId: board.id });
    expect(view.cards.map((card) => card.id)).toEqual([task.id]);
    expect(view.cards[0]!.columnKey).toBe("in_progress");
  });

  it("takes a card off without deleting the work", async () => {
    const board = await makeBoard({ name: `Removable ${suffix}` });
    const task = await makeTask("Chase the delivery note");
    await moveCardService(owner, { taskId: task.id, boardId: board.id, columnKey: "todo" });

    await removeCardService(owner, { taskId: task.id });

    const row = await db.task.findUniqueOrThrow({ where: { id: task.id } });
    expect(row.boardId).toBeNull();
    expect(row.deletedAt).toBeNull();
    expect(row.status).toBe("todo");
  });

  it("hides finished work but keeps the column", async () => {
    const board = await makeBoard({ name: `Done-hiding ${suffix}` });
    const task = await makeTask("Already finished");
    await moveCardService(owner, { taskId: task.id, boardId: board.id, columnKey: "done" });

    const hidden = await boardViewService(owner.actorId, { boardId: board.id });
    expect(hidden.cards).toHaveLength(0);
    // A board whose last column vanished would look broken rather than tidy.
    expect(hidden.columns.map((column) => column.key)).toContain("done");
    expect(hidden.hidingDone).toBe(true);

    const shown = await boardViewService(owner.actorId, { boardId: board.id, includeDone: true });
    expect(shown.cards.map((card) => card.id)).toEqual([task.id]);
  });

  it("frees the cards when the board is deleted", async () => {
    const board = await makeBoard({ name: `Doomed ${suffix}` });
    const task = await makeTask("Survives its board");
    await moveCardService(owner, { taskId: task.id, boardId: board.id, columnKey: "todo" });

    await deleteBoardService(owner, { boardId: board.id });

    const row = await db.task.findUniqueOrThrow({ where: { id: task.id } });
    // The work outlives the way somebody chose to look at it.
    expect(row.deletedAt).toBeNull();
    expect(row.boardId).toBeNull();
    await expect(boardViewService(owner.actorId, { boardId: board.id })).rejects.toThrow();
  });
});

describe("a smart board", () => {
  it("answers its question for whoever is looking, and is never placed on", async () => {
    const mine = await makeTask("Mine to do", { assigneeId: owner.actorId });
    await makeTask("Nobody's yet");

    const board = await makeBoard({
      name: `Smart ${suffix}`,
      type: "smart",
      filterRule: { assignee: "me", entityTypes: ["Ticket"] },
    });

    const forOwner = await boardViewService(owner.actorId, { boardId: board.id });
    expect(forOwner.cards.map((card) => card.id)).toEqual([mine.id]);

    // The same board, a different reader, a different answer. One board, not one per person.
    const forStranger = await boardViewService(stranger.actorId, { boardId: board.id });
    expect(forStranger.cards).toHaveLength(0);
    expect(forStranger.emptyBecause).toContain("filter");

    await expect(
      moveCardService(owner, { taskId: mine.id, boardId: board.id, columnKey: "done" }),
    ).rejects.toThrow(/smart board/);
  });

  it("refuses to be created without a filter", async () => {
    await expect(
      createBoardService(owner, { name: `Filterless ${suffix}`, type: "smart" }),
    ).rejects.toThrow(/is its filter/);
  });
});

describe("privacy", () => {
  it("keeps a private board to its owner", async () => {
    const board = await makeBoard({ name: `Private ${suffix}`, isPrivate: true });

    await expect(boardViewService(owner.actorId, { boardId: board.id })).resolves.toBeTruthy();
    await expect(boardViewService(stranger.actorId, { boardId: board.id })).rejects.toThrow(
      /private/,
    );
  });
});

describe("ensureDefaultBoardService", () => {
  // Not tracked in `boardIds` for cleanup: whichever board this resolves to is the one `/boards`
  // shows in the running app, real or not — deleting it here would take a real, in-use board out
  // from under whoever is looking at it right now, the same reason board.test.ts never deletes it
  // either.
  it("is idempotent, and the board it resolves to matches every open task", async () => {
    const first = await ensureDefaultBoardService(owner);
    const second = await ensureDefaultBoardService(owner);
    expect(second.id).toBe(first.id);

    const row = await db.board.findUniqueOrThrow({ where: { id: first.id } });
    expect(row.isDefault).toBe(true);
    expect(row.type).toBe("smart");
    expect(row.isPrivate).toBe(false);

    const task = await makeTask("Shows on the default board with nobody having made one");
    const view = await boardViewService(owner.actorId, { boardId: first.id });
    expect(view.cards.map((card) => card.id)).toContain(task.id);
  });
});
