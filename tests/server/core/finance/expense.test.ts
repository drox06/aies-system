import { randomUUID } from "node:crypto";
import { afterAll, describe, expect, it } from "vitest";
import { db } from "@/lib/db";
import {
  decideExpenseService,
  expensesService,
  submitExpenseService,
} from "@/server/core/finance/expense-service";

/**
 * §6's direct expenses.
 *
 * The table existed with a numbering series and **nothing could write to it** until 2026-08-20, so
 * the only direct costs any project could show were ones a seed script had put there.
 * docs/DECISIONS.md #133.
 *
 * What these pin is the set of refusals, because each one is a way a project's margin could be made
 * wrong quietly:
 *
 *   - charged to nothing → a cost that appears on no job
 *   - dated in the future → a commitment counted as spend
 *   - approved by the person who submitted it → no second pair of eyes on a figure that lands
 *     directly on a margin
 *
 * And one thing that is *not* a refusal: a submitted expense does not count towards project cost.
 * §6 counts only approved and paid, because counting claims would make every job look worse the
 * moment somebody typed something and better again when it was rejected.
 */

const suffix = randomUUID().slice(0, 8);
const spender = { actorId: `exp-a-${suffix}`, actorLabel: "Spender" };
const approver = { actorId: `exp-b-${suffix}`, actorLabel: "Approver" };

const accountIds: string[] = [];
const projectIds: string[] = [];
const expenseIds: string[] = [];

async function makeProject() {
  const account = await db.customerAccount.create({
    data: {
      code: `EXP-${randomUUID().slice(0, 12)}`,
      name: `Expense Co ${suffix}`,
      ownerId: spender.actorId,
    },
  });
  accountIds.push(account.id);

  const project = await db.project.create({
    data: {
      code: `EXP-${randomUUID().slice(0, 10)}`,
      name: `Expense project ${suffix}`,
      accountId: account.id,
      scopeOfWork: "Something with costs on it.",
    },
  });
  projectIds.push(project.id);
  return project;
}

async function submit(projectId: string, overrides: Record<string, unknown> = {}) {
  const created = await submitExpenseService(spender, {
    category: "subcontract",
    vendorName: "Mariveles Rigging",
    expenseDate: new Date(Date.now() - 24 * 60 * 60 * 1000),
    amount: 46_000,
    description: "Crane and two riggers for the valve lift.",
    projectId,
    ...overrides,
  });
  expenseIds.push(created.id);
  return created;
}

afterAll(async () => {
  await db.expense.deleteMany({ where: { id: { in: expenseIds } } });
  await db.auditLog.deleteMany({ where: { entityId: { in: expenseIds } } });
  await db.project.deleteMany({ where: { id: { in: projectIds } } });
  await db.customerAccount.deleteMany({ where: { id: { in: accountIds } } });
});

describe("recording a cost bought in for a job", () => {
  it("records it as submitted, not approved", async () => {
    const project = await makeProject();
    const created = await submit(project.id);

    const saved = await db.expense.findUniqueOrThrow({ where: { id: created.id } });

    /*
      Submitted. §6 counts only approved and paid towards project cost — a claim nobody has looked
      at must not move a margin, and it must not move it back when it is rejected either.
    */
    expect(saved.status).toBe("submitted");
    expect(saved.number).toMatch(/^AIESEXP/);
    expect(saved.approvedAt).toBeNull();
  }, 60_000);

  it("refuses a cost charged to nothing", async () => {
    await expect(
      submitExpenseService(spender, {
        category: "rental",
        expenseDate: new Date(),
        amount: 5_000,
        // A description that passes its own rule, so this test isolates the charged-to-nothing
        // refusal rather than tripping the one above it.
        description: "Scaffold hire for the pump house platform",
        projectId: null,
        salesOrderId: null,
      }),
    ).rejects.toThrow(/shows up on no job/);
  }, 60_000);

  it("refuses a date in the future", async () => {
    const project = await makeProject();

    // An expense records money already spent. A commitment that has not been paid is a purchase
    // order, and counting it here would put a cost on a job before it existed.
    await expect(
      submit(project.id, { expenseDate: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000) }),
    ).rejects.toThrow(/in the future/);
  }, 60_000);

  it("refuses an amount of nothing", async () => {
    const project = await makeProject();
    await expect(submit(project.id, { amount: 0 })).rejects.toThrow(/not an expense/);
  }, 60_000);

  it("refuses a description that says nothing", async () => {
    const project = await makeProject();
    // A category alone cannot be argued with six months later, and §6 exists so a cost can be.
    await expect(submit(project.id, { description: "x" })).rejects.toThrow(/Say what it was for/);
  }, 60_000);

  it("refuses a one-word description, which the first version of this rule let through", async () => {
    const project = await makeProject();

    /*
      The company caught this walking the screen on 2026-08-20: the rule was `length < 3`, so
      "crane" passed the check that exists to stop exactly that. The minimum was measuring the
      wrong thing — length, when the problem is that a single word just repeats the category.
    */
    await expect(submit(project.id, { description: "crane" })).rejects.toThrow(
      /Say what it was for/,
    );
    // Long enough by characters, still one word. Both conditions have to hold.
    await expect(submit(project.id, { description: "cranehirefortheday" })).rejects.toThrow(
      /Say what it was for/,
    );
  }, 60_000);

  it("accepts a short but genuine description without demanding padding", async () => {
    const project = await makeProject();

    // 36 characters, five words, and a perfectly good answer. A threshold that rejected this would
    // teach people to pad, which is worse than a short description.
    const created = await submit(project.id, {
      description: "Crane and riggers for the valve lift",
    });
    const saved = await db.expense.findUniqueOrThrow({ where: { id: created.id } });
    expect(saved.description).toBe("Crane and riggers for the valve lift");
  }, 60_000);
});

describe("deciding it", () => {
  it("refuses to let the person who submitted it approve it", async () => {
    const project = await makeProject();
    const created = await submit(project.id);

    /*
      The specific case, not a general rule about self-approval: the person who spent the money
      signing it off leaves no second pair of eyes on a figure that lands directly on a margin.
    */
    await expect(decideExpenseService(spender, { id: created.id, approve: true })).rejects.toThrow(
      /Somebody else has to approve it/,
    );

    const saved = await db.expense.findUniqueOrThrow({ where: { id: created.id } });
    expect(saved.status).toBe("submitted");
  }, 60_000);

  it("lets somebody else approve it, and only then does it count", async () => {
    const project = await makeProject();
    const created = await submit(project.id);

    await decideExpenseService(approver, { id: created.id, approve: true });

    const saved = await db.expense.findUniqueOrThrow({ where: { id: created.id } });
    expect(saved.status).toBe("approved");
    expect(saved.approvedById).toBe(approver.actorId);
    expect(saved.approvedAt).not.toBeNull();
  }, 60_000);

  it("demands a reason for a rejection", async () => {
    const project = await makeProject();
    const created = await submit(project.id);

    // Whoever submitted it has to know what to do differently, and "rejected" alone does not say.
    await expect(
      decideExpenseService(approver, { id: created.id, approve: false, reason: "no" }),
    ).rejects.toThrow(/Say why/);

    await decideExpenseService(approver, {
      id: created.id,
      approve: false,
      reason: "Already claimed on the cash advance liquidation for this ticket.",
    });

    const saved = await db.expense.findUniqueOrThrow({ where: { id: created.id } });
    expect(saved.status).toBe("rejected");
    expect(saved.rejectedReason).toContain("cash advance liquidation");
  }, 60_000);

  it("refuses to decide one that has already been decided", async () => {
    const project = await makeProject();
    const created = await submit(project.id);

    await decideExpenseService(approver, { id: created.id, approve: true });
    await expect(
      decideExpenseService(approver, { id: created.id, approve: false, reason: "changed my mind" }),
    ).rejects.toThrow(/nothing to decide/);
  }, 60_000);
});

describe("the list", () => {
  it("says what each one is charged to", async () => {
    const project = await makeProject();
    const created = await submit(project.id);

    const rows = await expensesService({});
    const mine = rows.find((row) => row.id === created.id);

    // The answer to "charged to what" belongs on every row — an expense against nothing is the
    // failure the submit path refuses, so the list must make its absence visible rather than blank.
    expect(mine?.project?.code).toBe(project.code);
    expect(mine?.submittedById).toBe(spender.actorId);
  }, 60_000);
});
