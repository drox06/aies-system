import { describe, expect, it } from "vitest";
import {
  checkStatusChange,
  checkTask,
  compareForMyWork,
  daysLate,
  urgencyFor,
} from "@/server/core/collab/task-rules";

/**
 * specs/06-collaboration.md §2's rules, without a database.
 *
 * The interesting cases here are all about *absence*: a task with no due date, a task attached to
 * half a record, a task nobody has picked up. §1's failure is work that exists only in somebody's
 * memory, so the rules that decide what an incomplete task means are the ones worth pinning.
 */

const day = (iso: string) => new Date(`${iso}T00:00:00.000Z`);
const NOW = day("2026-08-21");

describe("checkTask", () => {
  it("accepts a task with no assignee and no due date", () => {
    // Not an oversight in the input — §2's templates raise work before anybody owns it, and
    // "book the Christmas party" has no deadline and is still work.
    expect(checkTask({ title: "Book the Christmas party" }).ok).toBe(true);
  });

  it("refuses a task attached to half a record", () => {
    const result = checkTask({ title: "Chase the supplier", entityType: "Ticket" });
    expect(result.ok).toBe(false);
    expect(result.errors.join(" ")).toContain("whole record");
  });

  it("refuses a record type nothing can resolve", () => {
    const result = checkTask({ title: "Chase it", entityType: "Invoice", entityId: "abc" });
    expect(result.ok).toBe(false);
    // A link that looks real and goes nowhere is worse than no link.
    expect(result.errors.join(" ")).toContain("not a kind of record");
  });

  it("refuses an estimate of zero rather than storing it", () => {
    // Zero is not "unestimated" — somebody would later average it in.
    expect(checkTask({ title: "Something", estimateHours: 0 }).ok).toBe(false);
    expect(checkTask({ title: "Something", estimateHours: null }).ok).toBe(true);
  });

  it("refuses a due date before the start date", () => {
    const result = checkTask({
      title: "Impossible task",
      startAt: day("2026-09-01"),
      dueAt: day("2026-08-25"),
    });
    expect(result.ok).toBe(false);
  });
});

describe("daysLate", () => {
  it("returns null for an undated task, not zero", () => {
    // The whole point. Zero would sort an uncommitted task among the healthy ones.
    expect(daysLate(null, NOW)).toBeNull();
  });

  it("counts whole days late and days remaining", () => {
    expect(daysLate(day("2026-08-18"), NOW)).toBe(3);
    expect(daysLate(day("2026-08-21"), NOW)).toBe(0);
    expect(daysLate(day("2026-08-24"), NOW)).toBe(-3);
  });
});

describe("urgencyFor", () => {
  it("keeps undated in its own band", () => {
    expect(urgencyFor(null, "todo", NOW)).toBe("undated");
  });

  it("bands a dated task by how close it is", () => {
    expect(urgencyFor(day("2026-08-19"), "todo", NOW)).toBe("overdue");
    expect(urgencyFor(day("2026-08-21"), "todo", NOW)).toBe("today");
    expect(urgencyFor(day("2026-08-23"), "todo", NOW)).toBe("soon");
    expect(urgencyFor(day("2026-09-30"), "todo", NOW)).toBe("later");
  });

  it("never calls a finished task overdue", () => {
    // It was done. Whether it was done late is a question for the record, not for a red badge on a
    // list of what is still owed.
    expect(urgencyFor(day("2026-01-01"), "done", NOW)).toBe("later");
  });
});

describe("compareForMyWork", () => {
  const row = (dueAt: Date | null, priority: string, status = "todo") => ({
    dueAt,
    priority,
    status,
  });

  it("puts the longest overdue first", () => {
    const sorted = [
      row(day("2026-08-20"), "normal"),
      row(day("2026-08-10"), "normal"),
      row(day("2026-08-18"), "normal"),
    ].sort((a, b) => compareForMyWork(a, b, NOW));

    expect(sorted.map((r) => r.dueAt)).toEqual([
      day("2026-08-10"),
      day("2026-08-18"),
      day("2026-08-20"),
    ]);
  });

  it("does not let priority jump a band", () => {
    /*
      The rule this file exists to defend.

      An urgent task due next month is not more pressing than a normal one that was due last
      Tuesday. A queue where priority outranks lateness fills up with things marked urgent by
      whoever shouted loudest, which is the meeting culture §1 describes, moved into software.
    */
    const overdueNormal = row(day("2026-08-14"), "normal");
    const futureUrgent = row(day("2026-09-30"), "urgent");

    expect(compareForMyWork(overdueNormal, futureUrgent, NOW)).toBeLessThan(0);
  });

  it("breaks a tie within a band on priority", () => {
    const sameDayUrgent = row(day("2026-08-21"), "urgent");
    const sameDayLow = row(day("2026-08-21"), "low");

    expect(compareForMyWork(sameDayUrgent, sameDayLow, NOW)).toBeLessThan(0);
  });

  it("keeps undated tasks last, whatever their priority", () => {
    const undatedUrgent = row(null, "urgent");
    const distantLow = row(day("2027-01-01"), "low");

    expect(compareForMyWork(undatedUrgent, distantLow, NOW)).toBeGreaterThan(0);
  });
});

describe("checkStatusChange", () => {
  it("allows a board to be dragged backwards", () => {
    // §2 describes a kanban board. A state machine that refused "back to in progress" would be
    // fighting how the tool is used.
    expect(checkStatusChange("done", "in_progress").ok).toBe(true);
    expect(checkStatusChange("for_review", "todo").ok).toBe(true);
  });

  it("refuses to reopen a cancelled task", () => {
    const result = checkStatusChange("cancelled", "todo");
    expect(result.ok).toBe(false);
    expect(result.errors.join(" ")).toContain("raise a new one");
  });

  it("refuses a status that does not exist", () => {
    expect(checkStatusChange("todo", "finished").ok).toBe(false);
  });
});
