import { describe, expect, it } from "vitest";
import {
  checkTemplate,
  chooseAssignee,
  conditionMatches,
  parseStamp,
  templateStamp,
  type Candidate,
} from "@/server/core/collab/task-template-rules";
import { TASK_TEMPLATE_SEEDS } from "@/server/core/collab/task-template-seeds";

/**
 * §2's template rules, without a database.
 *
 * The three assignment modes are the part §2 asks for by name — *"Make this configurable and test
 * all three"* — and they are pure here precisely so all three can be tested against fixed inputs
 * rather than against whoever happens to hold a role in the company this week.
 */

const at = (iso: string) => new Date(`${iso}T09:00:00.000Z`);

describe("conditionMatches", () => {
  it("passes everything when there is no condition", () => {
    expect(conditionMatches(null, { anything: "at all" })).toBe(true);
  });

  it("separates the two ticket.generated templates", () => {
    // The whole reason conditions exist: one event, two kinds of work.
    expect(conditionMatches({ ticketType: "delivery" }, { ticketType: "delivery" })).toBe(true);
    expect(conditionMatches({ ticketType: "delivery" }, { ticketType: "new_project" })).toBe(false);
  });

  it("refuses to match a field that is not there", () => {
    /*
      A failed commissioning must not raise close-out work.

      If the payload carries no `result`, the platform cannot tell whether commissioning was
      accepted — and raising "prepare the close-out pack" on a guess is worse than raising nothing.
    */
    expect(conditionMatches({ result: "accepted" }, {})).toBe(false);
    expect(conditionMatches({ result: "accepted" }, { result: "rejected" })).toBe(false);
    expect(conditionMatches({ result: "accepted" }, { result: "accepted" })).toBe(true);
  });

  it("does not treat a non-string as a match", () => {
    expect(conditionMatches({ ticketType: "true" }, { ticketType: true })).toBe(false);
  });
});

describe("chooseAssignee", () => {
  const candidate = (id: string, openTasks: number, lastAssignedAt: Date | null): Candidate => ({
    id,
    openTasks,
    lastAssignedAt,
  });

  it("gives one task to every holder in `all` mode", () => {
    // The approval shape: whoever is free acts, and nothing waits on a named person being at
    // their desk.
    const chosen = chooseAssignee("all", [
      candidate("ops", 4, null),
      candidate("fin", 0, null),
      candidate("vp", 9, null),
    ]);
    expect(chosen).toEqual(["ops", "fin", "vp"]);
  });

  it("picks the lightest queue in `least_loaded` mode", () => {
    const chosen = chooseAssignee("least_loaded", [
      candidate("ops", 11, null),
      candidate("fin", 2, null),
      candidate("adm", 7, null),
    ]);
    expect(chosen).toEqual(["fin"]);
  });

  it("breaks a least-loaded tie reproducibly", () => {
    // Two empty queues must not depend on row order — a test that pinned today's order would pin
    // nothing at all.
    const chosen = chooseAssignee("least_loaded", [
      candidate("zoe", 0, null),
      candidate("amy", 0, null),
    ]);
    expect(chosen).toEqual(["amy"]);
  });

  it("gives the round-robin turn to whoever has waited longest", () => {
    const chosen = chooseAssignee("round_robin", [
      candidate("ops", 0, at("2026-08-20")),
      candidate("adm", 0, at("2026-08-12")),
      candidate("vp", 0, at("2026-08-18")),
    ]);
    expect(chosen).toEqual(["adm"]);
  });

  it("puts somebody who has never had one at the front", () => {
    // A person new to the role should not wait out a full rotation before their first task.
    const chosen = chooseAssignee("round_robin", [
      candidate("ops", 0, at("2026-08-20")),
      candidate("new", 0, null),
    ]);
    expect(chosen).toEqual(["new"]);
  });

  it("returns nobody when the role has no holders", () => {
    // Not an error. The service turns this into one unassigned task, which is recorded work with
    // no owner rather than work that vanished.
    expect(chooseAssignee("least_loaded", [])).toEqual([]);
    expect(chooseAssignee("all", [])).toEqual([]);
  });
});

describe("the stamp", () => {
  it("survives a round trip, including a task key with a colon in it", () => {
    expect(parseStamp(templateStamp("so-created", "acknowledge-po"))).toEqual({
      templateKey: "so-created",
      taskKey: "acknowledge-po",
    });
    expect(parseStamp("t:a:b")).toEqual({ templateKey: "t", taskKey: "a:b" });
    expect(parseStamp(null)).toBeNull();
    expect(parseStamp("nocolon")).toBeNull();
  });
});

describe("checkTemplate", () => {
  it("accepts all fourteen seeded templates", () => {
    /*
      The seeds are the operations flowchart written down, and nothing else validates them: they go
      into a Json column, so a typo in a role key or a duplicated task key would be stored happily
      and only discovered when a template fired and quietly did the wrong thing.
    */
    for (const template of TASK_TEMPLATE_SEEDS) {
      const result = checkTemplate(template);
      expect(result.errors, `${template.key}: ${result.errors.join(" ")}`).toEqual([]);
    }
    expect(TASK_TEMPLATE_SEEDS).toHaveLength(14);
  });

  it("gives every seeded template a unique key", () => {
    const keys = TASK_TEMPLATE_SEEDS.map((template) => template.key);
    expect(new Set(keys).size).toBe(keys.length);
  });

  it("catches two tasks sharing a key", () => {
    // They would collapse through the idempotency check: the second would look created and never
    // exist.
    const result = checkTemplate({
      key: "dupe",
      name: "Duplicate",
      trigger: "sales_order.created",
      tasks: [
        { key: "a", title: "First", roleKeys: ["sales"], assignMode: "all" },
        { key: "a", title: "Second", roleKeys: ["sales"], assignMode: "all" },
      ],
    });
    expect(result.ok).toBe(false);
    expect(result.errors.join(" ")).toContain("duplicate");
  });

  it("catches a task that names no role", () => {
    const result = checkTemplate({
      key: "orphan",
      name: "Orphan",
      trigger: "qa.failed",
      tasks: [{ key: "a", title: "Fix it", roleKeys: [], assignMode: "all" }],
    });
    expect(result.ok).toBe(false);
    expect(result.errors.join(" ")).toContain("reach nobody");
  });
});
