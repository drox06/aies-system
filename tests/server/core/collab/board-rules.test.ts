import { describe, expect, it } from "vitest";
import {
  DEFAULT_COLUMNS,
  checkBoard,
  columnFor,
  compareCards,
  laneFor,
  matchesFilter,
  wipFor,
  type BoardTask,
} from "@/server/core/collab/board-rules";

/**
 * §2's board rules, without a database.
 *
 * The two that carry weight: a smart board is its filter, and a WIP limit reports rather than
 * refuses. Both are decisions rather than arithmetic, so both are pinned here in the form somebody
 * arguing with them would have to change.
 */

const task = (over: Partial<BoardTask> = {}): BoardTask => ({
  id: "t1",
  status: "todo",
  priority: "normal",
  dueAt: null,
  assigneeId: null,
  entityType: null,
  labels: [],
  createdByTemplate: null,
  columnId: null,
  ...over,
});

describe("checkBoard", () => {
  const base = { name: "A board", columns: DEFAULT_COLUMNS };

  it("accepts the default board", () => {
    expect(checkBoard({ ...base, type: "manual" }).ok).toBe(true);
  });

  it("refuses a smart board with no filter", () => {
    // A smart board *is* its filter. Without one it is empty forever and reads as broken rather
    // than as unconfigured.
    const result = checkBoard({ ...base, type: "smart", filterRule: null });
    expect(result.ok).toBe(false);
    expect(result.errors.join(" ")).toContain("is its filter");
  });

  it("refuses WIP limits on a smart board", () => {
    // Nothing is placed on one, so a limit could never be respected or breached by an act — it
    // would be a number that sometimes went red for reasons nobody chose.
    const result = checkBoard({
      ...base,
      type: "smart",
      filterRule: { assignee: "me" },
      wipLimits: { todo: 3 },
    });
    expect(result.ok).toBe(false);
    expect(result.errors.join(" ")).toContain("no WIP limits");
  });

  it("refuses a filter on a manual board rather than ignoring it", () => {
    const result = checkBoard({ ...base, type: "manual", filterRule: { assignee: "me" } });
    expect(result.ok).toBe(false);
  });

  it("refuses two columns sharing a key", () => {
    const result = checkBoard({
      ...base,
      type: "manual",
      columns: [
        { key: "a", label: "One" },
        { key: "a", label: "Two" },
      ],
    });
    expect(result.ok).toBe(false);
    expect(result.errors.join(" ")).toContain("share the key");
  });

  it("refuses a WIP limit on a column that does not exist", () => {
    const result = checkBoard({ ...base, type: "manual", wipLimits: { nowhere: 2 } });
    expect(result.ok).toBe(false);
  });
});

describe("matchesFilter", () => {
  it("resolves `me` to whoever is looking", () => {
    // What makes one smart board show each person their own work, rather than needing a board each.
    expect(matchesFilter({ assignee: "me" }, task({ assigneeId: "kj" }), "kj")).toBe(true);
    expect(matchesFilter({ assignee: "me" }, task({ assigneeId: "ea" }), "kj")).toBe(false);
  });

  it("finds work nobody owns", () => {
    expect(matchesFilter({ assignee: "unassigned" }, task(), "kj")).toBe(true);
    expect(matchesFilter({ assignee: "unassigned" }, task({ assigneeId: "kj" }), "kj")).toBe(false);
  });

  it("never counts an undated task as overdue", () => {
    /*
      The rule that runs through this module. A task nobody set a deadline for is uncommitted, not
      late — and a board that quietly counted them as late would overstate how much trouble the
      company is in, which is the kind of report people stop believing.
    */
    const now = new Date("2026-08-21T00:00:00.000Z");
    expect(matchesFilter({ overdueOnly: true }, task(), "kj", now)).toBe(false);
    expect(
      matchesFilter({ overdueOnly: true }, task({ dueAt: new Date("2026-08-19") }), "kj", now),
    ).toBe(true);
    expect(
      matchesFilter({ overdueOnly: true }, task({ dueAt: new Date("2026-09-19") }), "kj", now),
    ).toBe(false);
  });

  it("ands its conditions together", () => {
    const rule = { entityTypes: ["Ticket"], statuses: ["blocked" as const] };
    expect(matchesFilter(rule, task({ entityType: "Ticket", status: "blocked" }), "kj")).toBe(true);
    expect(matchesFilter(rule, task({ entityType: "Ticket", status: "todo" }), "kj")).toBe(false);
    expect(matchesFilter(rule, task({ entityType: "Project", status: "blocked" }), "kj")).toBe(
      false,
    );
  });

  it("separates work a template raised from work a person raised", () => {
    expect(matchesFilter({ raisedBy: "template" }, task({ createdByTemplate: "so:x" }), "kj")).toBe(
      true,
    );
    expect(matchesFilter({ raisedBy: "template" }, task(), "kj")).toBe(false);
    expect(matchesFilter({ raisedBy: "person" }, task(), "kj")).toBe(true);
  });
});

describe("columnFor", () => {
  it("honours where somebody put a card on a manual board", () => {
    expect(columnFor(DEFAULT_COLUMNS, task({ columnId: "blocked" }), "manual")).toBe("blocked");
  });

  it("falls back to the card's status when it has never been placed", () => {
    // Work arriving from a template has no placement. Without this it would be on the board and in
    // no column, which is the same as invisible.
    expect(columnFor(DEFAULT_COLUMNS, task({ status: "for_review" }), "manual")).toBe("for_review");
  });

  it("ignores placement entirely on a smart board", () => {
    expect(columnFor(DEFAULT_COLUMNS, task({ columnId: "done", status: "todo" }), "smart")).toBe(
      "todo",
    );
  });
});

describe("wipFor", () => {
  it("reports being over the limit without forbidding it", () => {
    /*
      The decision this test exists to defend. A limit's job is to make overload visible; refusing
      the move would not reduce the work, it would leave the card in a column it has already left.
      A board that disagrees with reality is worse than no board.
    */
    const state = wipFor("in_progress", 6, { in_progress: 4 });
    expect(state.over).toBe(true);
    expect(state.count).toBe(6);
    expect(state.limit).toBe(4);
  });

  it("says nothing about a column with no limit", () => {
    expect(wipFor("todo", 40, null)).toEqual({ count: 40, limit: null, over: false });
  });

  it("is not over when it is exactly at the limit", () => {
    expect(wipFor("todo", 4, { todo: 4 }).over).toBe(false);
  });
});

describe("compareCards", () => {
  it("puts dated work above undated, and earlier above later", () => {
    const sorted = [
      { dueAt: null, position: 0 },
      { dueAt: new Date("2026-09-01"), position: 5 },
      { dueAt: new Date("2026-08-01"), position: 9 },
    ].sort(compareCards);
    expect(sorted.map((card) => card.dueAt?.getUTCMonth() ?? null)).toEqual([7, 8, null]);
  });

  it("falls back to where somebody dragged it", () => {
    const sorted = [
      { dueAt: null, position: 2 },
      { dueAt: null, position: 1 },
    ].sort(compareCards);
    expect(sorted.map((card) => card.position)).toEqual([1, 2]);
  });
});

describe("laneFor", () => {
  const nameOf = (id: string) => (id === "kj" ? "KJ" : "Someone");

  it("names the lane after the person", () => {
    expect(laneFor("assignee", { assigneeId: "kj", priority: "normal" }, nameOf)).toEqual({
      key: "kj",
      label: "KJ",
    });
  });

  it("gives unowned work its own lane rather than hiding it", () => {
    expect(laneFor("assignee", { assigneeId: null, priority: "normal" }, nameOf).label).toBe(
      "Nobody yet",
    );
  });

  it("collapses to one lane when swimlanes are off", () => {
    expect(laneFor("none", { assigneeId: "kj", priority: "urgent" }, nameOf).key).toBe("all");
  });
});
