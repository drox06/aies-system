import { randomUUID } from "node:crypto";
import { afterAll, describe, expect, it } from "vitest";
import { db } from "@/lib/db";
import { runTemplatesForEvent } from "@/server/core/collab/task-template-service";
import type { TaskTemplateSpec } from "@/server/core/collab/task-template-rules";

/**
 * §2's templates firing against the real database.
 *
 * ## Why the fixtures use `viewer`
 *
 * `least_loaded` and `round_robin` pick from everybody active holding a role, so a test using
 * `finance_officer` would be choosing between its own fixture and the company's real finance
 * officer — and would notify a real person on every run. Nobody holds `viewer`, so a template
 * pointed at it chooses only among the users this file creates. The mode arithmetic itself is
 * pinned by the pure test; what is pinned here is that the service gathers the right numbers, writes
 * the right rows, and does not write them twice.
 *
 * ## Why every run is scoped to its own template
 *
 * There is no separate test database here. Firing a trigger unscoped would set the company's
 * fourteen real templates going and raise real work, with real notifications, for real people — so
 * each run names the fixture template it is testing. That narrowing exists in the service for
 * exactly this reason and nothing in production passes it.
 *
 * ## Why the fixtures use a real cash advance
 *
 * The service refuses to raise work on a record that is no longer there (docs/DECISIONS.md #142), so
 * a test firing at an invented id would be testing the refusal rather than the template. A real
 * record is also the truer test.
 *
 * ## What is pinned
 *
 *  1. **A template raises the work.** One event, four tasks, on the record the event was about.
 *  2. **A retry raises nothing.** specs/00-foundation.md §6 requires idempotent handlers, and this
 *     one creates numbered records that notify people.
 *  3. **`all` gives one task to each holder** — and the retry check is per person, so the second
 *     approver is not mistaken for a duplicate of the first.
 *  4. **A condition that does not match raises nothing.**
 *  5. **A role with no active holder produces an unassigned task**, not a lost one.
 *  6. **A due date the record cannot supply leaves the task undated**, rather than substituting a
 *     different deadline.
 *  7. **Business days, not calendar days.**
 */

const suffix = randomUUID().slice(0, 8);
const KEY = (name: string) => `zz-test-${name}-${suffix}`;

const templateIds: string[] = [];
const templateKeys: string[] = [];
const userIds: string[] = [];
const advanceIds: string[] = [];
/** Every record these tests hang tasks off, so cleanup can find them by target too. */
const entityIds: string[] = [];

async function makeTemplate(spec: TaskTemplateSpec) {
  const row = await db.taskTemplate.create({
    data: {
      key: spec.key,
      name: spec.name,
      trigger: spec.trigger,
      condition: spec.condition ?? undefined,
      tasks: spec.tasks as unknown as object[],
    },
  });
  templateIds.push(row.id);
  templateKeys.push(row.key);
  return row;
}

/**
 * A real cash advance for the generic cases to be about.
 *
 * They used to fire `sales_order.created` at an invented id. That stopped working the moment the
 * service learned to check the record still exists (docs/DECISIONS.md #142) — correctly: raising work
 * on a record that is not there is exactly what that check is for. So the fixtures now use a record
 * that genuinely exists, which is also a truer test.
 */
async function makeAdvance(requestedById: string, over: Record<string, unknown> = {}) {
  const advance = await db.cashAdvance.create({
    data: {
      number: `CA-TEST-${randomUUID().slice(0, 8)}`,
      requestedById,
      amountRequested: 250000,
      neededBy: new Date("2026-09-01T00:00:00.000Z"),
      purpose: "Fixture for the task template tests",
      status: "requested",
      ...over,
    },
    select: { id: true },
  });
  advanceIds.push(advance.id);
  entityIds.push(advance.id);
  return advance;
}

async function makeViewer(name: string) {
  const role = await db.role.findUniqueOrThrow({ where: { key: "viewer" } });
  const user = await db.user.create({
    data: {
      name: `${name} ${suffix}`,
      email: `tpl-${randomUUID().slice(0, 8)}@test.local`,
      passwordHash: "x",
      isActive: true,
      roles: { create: { roleId: role.id } },
    },
  });
  userIds.push(user.id);
  return user;
}

/** Every task any of this file's templates created, whatever it is attached to. */
async function tasksFrom(templateKey: string) {
  return db.task.findMany({
    where: { createdByTemplate: { startsWith: `${templateKey}:` } },
    select: {
      id: true,
      title: true,
      dueAt: true,
      assigneeId: true,
      entityType: true,
      entityId: true,
      createdByTemplate: true,
      priority: true,
    },
    orderBy: { createdAt: "asc" },
  });
}

afterAll(async () => {
  const step = async (label: string, run: () => Promise<unknown>) => {
    try {
      await run();
    } catch (error) {
      console.error(`[task-templates.test cleanup] ${label} failed`, error);
    }
  };

  /*
    Matched on the **entity ids** as well as the fixture template keys.

    The first run of this file matched on the template keys alone and left 25 real tasks in the
    company's database, assigned to real people with real notifications — created by the *seeded*
    templates, which fired on the same events because the runs were not yet scoped. The scoping
    fixes the cause; this fixes the blast radius, because a cleanup that can only remove what it
    expected to create is a cleanup that has already been wrong once. docs/DECISIONS.md #139.
  */
  const created = await db.task.findMany({
    where: {
      OR: [
        ...templateKeys.map((key) => ({ createdByTemplate: { startsWith: `${key}:` } })),
        { entityId: { in: [...entityIds, ...advanceIds] } },
      ],
    },
    select: { id: true },
  });
  const taskIds = created.map((task) => task.id);

  await step("notifications", () =>
    db.notification.deleteMany({ where: { entityId: { in: taskIds } } }),
  );
  await step("audit", () =>
    db.auditLog.deleteMany({ where: { entityId: { in: [...taskIds, ...advanceIds] } } }),
  );
  await step("events", () => db.eventOutbox.deleteMany({ where: { actorId: "system" } }));
  await step("tasks", () => db.task.deleteMany({ where: { id: { in: taskIds } } }));
  await step("templates", () => db.taskTemplate.deleteMany({ where: { id: { in: templateIds } } }));
  await step("advances", () => db.cashAdvance.deleteMany({ where: { id: { in: advanceIds } } }));
  await step("user roles", () => db.userRole.deleteMany({ where: { userId: { in: userIds } } }));
  await step("users", () => db.user.deleteMany({ where: { id: { in: userIds } } }));
  await db.$disconnect();
});

describe("a template firing", () => {
  it("raises the work on the record the event was about, and not again on a retry", async () => {
    await makeViewer("Solo");
    const key = KEY("so");
    await makeTemplate({
      key,
      name: "A sales order is raised",
      trigger: "cash_advance.requested",
      tasks: [
        {
          key: "acknowledge-po",
          title: "Acknowledge the PO to the customer",
          roleKeys: ["viewer"],
          assignMode: "least_loaded",
          dueInDays: 1,
        },
        {
          key: "downpayment-invoice",
          title: "Raise the downpayment invoice",
          roleKeys: ["viewer"],
          assignMode: "least_loaded",
          dueInDays: 1,
          priority: "high",
        },
      ],
    });

    const requester = await makeViewer("Requester one");
    const advance = await makeAdvance(requester.id);
    const payload = { cashAdvanceId: advance.id, number: `AIESCA-TEST${suffix}` };

    const first = await runTemplatesForEvent("cash_advance.requested", payload, new Date(), {
      templateKeys: [key],
    });
    expect(first.failures).toEqual([]);
    expect(first.created).toHaveLength(2);

    const rows = await tasksFrom(key);
    expect(rows).toHaveLength(2);
    expect(rows.every((row) => row.entityType === "CashAdvance")).toBe(true);
    expect(rows.every((row) => row.entityId === advance.id)).toBe(true);
    // The title says which record it is about — a queue of five identical titles is unusable. The
    // reference comes off the record itself, not off the payload.
    expect(rows[0]!.title).toContain("CA-TEST-");
    expect(
      rows.find((row) => row.createdByTemplate === `${key}:downpayment-invoice`)!.priority,
    ).toBe("high");

    // The retry. §6 of module 00 requires this handler to be idempotent, and it creates numbered
    // records that ring somebody's bell.
    const second = await runTemplatesForEvent("cash_advance.requested", payload, new Date(), {
      templateKeys: [key],
    });
    expect(second.created).toEqual([]);
    expect(second.skipped).toBe(2);
    expect(await tasksFrom(key)).toHaveLength(2);
  });

  it("gives everybody a task in `all` mode, and still skips only what already exists", async () => {
    const first = await makeViewer("Approver one");
    const second = await makeViewer("Approver two");
    const key = KEY("all");
    await makeTemplate({
      key,
      name: "A cash advance is requested",
      trigger: "cash_advance.requested",
      tasks: [
        {
          key: "approve",
          title: "Approve it",
          roleKeys: ["viewer"],
          assignMode: "all",
        },
      ],
    });

    const advance = await makeAdvance(first.id);
    const payload = { cashAdvanceId: advance.id };
    const run = await runTemplatesForEvent("cash_advance.requested", payload, new Date(), {
      templateKeys: [key],
    });

    const rows = await tasksFrom(key);
    const owners = rows.map((row) => row.assigneeId).filter(Boolean);
    // One each. The idempotency check is per assignee for exactly this reason — on the stamp alone
    // the second approver would have looked like a duplicate of the first and been dropped.
    expect(run.created.length).toBeGreaterThanOrEqual(2);
    expect(owners).toContain(first.id);
    expect(owners).toContain(second.id);

    const retry = await runTemplatesForEvent("cash_advance.requested", payload, new Date(), {
      templateKeys: [key],
    });
    expect(retry.created).toEqual([]);
    expect(retry.skipped).toBe(owners.length);
  });

  it("raises nothing when the condition does not match", async () => {
    const conditional = await makeViewer("Conditional");
    const condAdvance = await makeAdvance(conditional.id);
    const key = KEY("cond");
    await makeTemplate({
      key,
      name: "Only accepted commissioning",
      trigger: "cash_advance.requested",
      condition: { result: "accepted" },
      tasks: [
        {
          key: "closeout",
          title: "Prepare the close-out pack",
          roleKeys: ["viewer"],
          assignMode: "least_loaded",
        },
      ],
    });

    await runTemplatesForEvent(
      "cash_advance.requested",
      { cashAdvanceId: condAdvance.id, result: "rejected" },
      new Date(),
      { templateKeys: [key] },
    );
    expect(await tasksFrom(key)).toHaveLength(0);

    await runTemplatesForEvent(
      "cash_advance.requested",
      { cashAdvanceId: condAdvance.id, result: "accepted" },
      new Date(),
      { templateKeys: [key] },
    );
    expect(await tasksFrom(key)).toHaveLength(1);
  });

  it("records the work unassigned when the role has no active holder", async () => {
    const orphanRequester = await makeViewer("Orphan requester");
    const orphanAdvance = await makeAdvance(orphanRequester.id);
    const key = KEY("nobody");
    await makeTemplate({
      key,
      name: "Nobody holds this",
      trigger: "cash_advance.requested",
      tasks: [
        {
          key: "orphan",
          title: "Something that must still be done",
          // Nobody active holds `sales` in this database, which is itself worth knowing.
          roleKeys: ["sales"],
          assignMode: "least_loaded",
        },
      ],
    });

    await runTemplatesForEvent(
      "cash_advance.requested",
      { cashAdvanceId: orphanAdvance.id },
      new Date(),
      { templateKeys: [key] },
    );

    const rows = await tasksFrom(key);
    expect(rows).toHaveLength(1);
    // Recorded and ownerless beats never recorded. `/tasks` leads with these.
    expect(rows[0]!.assigneeId).toBeNull();
  });

  it("counts business days, not calendar days", async () => {
    const weekend = await makeViewer("Weekend");
    const bizAdvance = await makeAdvance(weekend.id);
    const key = KEY("bizdays");
    await makeTemplate({
      key,
      name: "Due tomorrow",
      trigger: "cash_advance.requested",
      tasks: [
        {
          key: "next-day",
          title: "Do it the next working day",
          roleKeys: ["viewer"],
          assignMode: "least_loaded",
          dueInDays: 1,
        },
      ],
    });

    // A Friday. "+1 day" must not land on Saturday.
    const friday = new Date("2026-08-21T09:00:00.000Z");
    await runTemplatesForEvent("cash_advance.requested", { cashAdvanceId: bizAdvance.id }, friday, {
      templateKeys: [key],
    });

    const rows = await tasksFrom(key);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.dueAt!.getUTCDay()).not.toBe(6);
    expect(rows[0]!.dueAt!.getUTCDay()).not.toBe(0);
  });
});

describe("dates read off the record", () => {
  it("dates the liquidation from the advance, and assigns it to whoever asked for the money", async () => {
    const requester = await makeViewer("Requester");
    const liquidationDueAt = new Date("2026-09-15T00:00:00.000Z");

    const advance = await db.cashAdvance.create({
      data: {
        number: `CA-TEST-${suffix}`,
        requestedById: requester.id,
        amountRequested: 500000,
        neededBy: new Date("2026-09-01T00:00:00.000Z"),
        purpose: "Fixture for the liquidation template",
        status: "released",
        liquidationDueAt,
      },
      select: { id: true },
    });
    advanceIds.push(advance.id);

    const key = KEY("liq");
    await makeTemplate({
      key,
      name: "A cash advance is released",
      trigger: "cash_advance.released",
      tasks: [
        {
          key: "liquidate",
          title: "Liquidate the advance",
          assignTo: "record_owner",
          roleKeys: ["viewer"],
          assignMode: "least_loaded",
          dueFrom: "liquidationDue",
        },
      ],
    });

    await runTemplatesForEvent("cash_advance.released", { cashAdvanceId: advance.id }, new Date(), {
      templateKeys: [key],
    });

    const rows = await tasksFrom(key);
    expect(rows).toHaveLength(1);
    // The person who asked for the money accounts for it — not a role, and not a colleague.
    expect(rows[0]!.assigneeId).toBe(requester.id);
    expect(rows[0]!.dueAt!.toISOString()).toBe(liquidationDueAt.toISOString());
    expect(rows[0]!.entityType).toBe("CashAdvance");
  });

  it("leaves a task undated when the record has no such date", async () => {
    const requester = await makeViewer("Undated requester");
    const advance = await db.cashAdvance.create({
      data: {
        number: `CA-TEST-U-${suffix}`,
        requestedById: requester.id,
        amountRequested: 100000,
        neededBy: new Date("2026-09-01T00:00:00.000Z"),
        purpose: "Fixture with no liquidation date",
        status: "approved",
      },
      select: { id: true },
    });
    advanceIds.push(advance.id);

    const key = KEY("undated");
    await makeTemplate({
      key,
      name: "Released with nothing to date it from",
      trigger: "cash_advance.released",
      tasks: [
        {
          key: "liquidate",
          title: "Liquidate the advance",
          roleKeys: ["viewer"],
          assignMode: "least_loaded",
          dueFrom: "liquidationDue",
        },
      ],
    });

    await runTemplatesForEvent("cash_advance.released", { cashAdvanceId: advance.id }, new Date(), {
      templateKeys: [key],
    });

    const rows = await tasksFrom(key);
    expect(rows).toHaveLength(1);
    /*
      Undated rather than dated from the event.

      §2 gave this task its deadline for a reason. Substituting a different one quietly would be the
      platform inventing a commitment nobody made — the same rule that makes `daysLate` null rather
      than zero, and My Work shows it under "No date agreed" where somebody can fix it.
    */
    expect(rows[0]!.dueAt).toBeNull();
  });
});
