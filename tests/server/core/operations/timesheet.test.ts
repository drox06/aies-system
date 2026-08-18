import { randomUUID } from "node:crypto";
import { afterAll, describe, expect, it } from "vitest";
import { db } from "@/lib/db";
import { createStandaloneTicketService } from "@/server/core/operations/ticket-service";
import {
  listExpensesService,
  saveExpenseService,
  submitExpensesService,
} from "@/server/core/operations/timesheet-service";
import {
  FIELD_EXPENSE_ENTITY_TYPE,
  RECEIPT_REQUIRED_ABOVE,
} from "@/server/core/operations/timesheet-rules";

/**
 * §16's receipt rule, against the real database.
 *
 * ## Why this file exists at all
 *
 * §16 shipped with rules tests and no service test, and the defect that followed lived exactly in
 * the gap: `checkExpense` refused anything over ₱499 without a receipt, `saveExpenseService` threw
 * on that refusal, and the screen had no control to attach one. Every unit test passed. Nothing
 * asked the only question that mattered — *can a person who spent ₱800 write it down?*
 *
 * The company asked it, in one sentence: "how does the personnel comply with this request? there's
 * no place to attach receipt." Third instance of docs/DECISIONS.md #101.
 *
 * ## What is pinned here
 *
 *  1. **Recording always works.** Spending is a fact; the platform does not get to refuse a fact.
 *  2. **Claiming does not.** The control is still real — the money does not move without the paper.
 *  3. **A receipt uploaded against the saved row counts.** This is the half a rules test cannot
 *     reach: the file lands in `FileObject`, not in the row's own column, and a claim check that
 *     only read the column would tell somebody their attached receipt does not exist.
 *  4. **A partial submit takes the good rows.** Four of five going through, with the fifth named,
 *     is the behaviour; five refused because of one is not.
 */

const suffix = randomUUID().slice(0, 8);
const actor = { actorId: `exp-${suffix}`, actorLabel: "Field technician" };

const ticketIds: string[] = [];
const accountIds: string[] = [];
const expenseIds: string[] = [];
const fileIds: string[] = [];

async function makeTicket() {
  const account = await db.customerAccount.create({
    data: {
      code: `EXP-${randomUUID().slice(0, 12)}`,
      name: `Expense Co ${suffix}`,
      ownerId: actor.actorId,
    },
  });
  accountIds.push(account.id);

  const ticket = await createStandaloneTicketService(actor, {
    accountId: account.id,
    type: "after_sales",
    title: `Expense test ${randomUUID().slice(0, 6)}`,
    scopeOfWork: "Do the work.",
    justification: "Standalone for the expense fixture.",
  });
  ticketIds.push(ticket.id);
  return ticket;
}

/** A receipt as the screen produces one: a file attached to the saved expense. */
async function attachReceipt(expenseId: string) {
  const file = await db.fileObject.create({
    data: {
      entityType: FIELD_EXPENSE_ENTITY_TYPE,
      entityId: expenseId,
      filename: "receipt.jpg",
      mimeType: "image/jpeg",
      size: 1024,
      sha256: randomUUID().replace(/-/g, ""),
      storageKey: `test/${randomUUID()}.jpg`,
      uploaderId: actor.actorId,
    },
  });
  fileIds.push(file.id);
  return file;
}

afterAll(async () => {
  await db.fileObject.deleteMany({ where: { id: { in: fileIds } } });
  await db.fieldExpense.deleteMany({ where: { id: { in: expenseIds } } });
  await db.ticket.deleteMany({ where: { id: { in: ticketIds } } });
  await db.customerAccount.deleteMany({ where: { id: { in: accountIds } } });
});

describe("recording what was spent", () => {
  it("accepts an amount over the threshold with no receipt", async () => {
    const ticket = await makeTicket();

    const expense = await saveExpenseService(actor, {
      ticketId: ticket.id,
      date: new Date(),
      category: "transport_fare",
      amount: RECEIPT_REQUIRED_ABOVE + 30_100,
      description: "Taxi to site, receipt still in the truck",
    });
    expenseIds.push(expense.id);

    expect(expense.status).toBe("draft");
    expect(expense.amount).toBe(RECEIPT_REQUIRED_ABOVE + 30_100);
  });

  it("marks the row as needing a receipt before it can be claimed", async () => {
    const ticket = await makeTicket();
    const expense = await saveExpenseService(actor, {
      ticketId: ticket.id,
      date: new Date(),
      category: "transport_fare",
      amount: 80_000,
      description: "Taxi",
    });
    expenseIds.push(expense.id);

    const [row] = await listExpensesService({ ticketId: ticket.id });
    expect(row).toBeDefined();
    expect(row!.receiptMissing).toBe(true);
    expect(row!.receiptCount).toBe(0);
  });
});

describe("claiming it", () => {
  it("refuses to submit an over-threshold expense with no receipt, and says which", async () => {
    const ticket = await makeTicket();
    const expense = await saveExpenseService(actor, {
      ticketId: ticket.id,
      date: new Date(),
      category: "transport_fare",
      amount: 80_000,
      description: "Taxi with no paper",
    });
    expenseIds.push(expense.id);

    const result = await submitExpensesService(actor, { ids: [expense.id] });

    expect(result.submitted).toBe(0);
    expect(result.blocked).toHaveLength(1);
    expect(result.blocked[0]!.description).toBe("Taxi with no paper");
    expect(result.blocked[0]!.reason).toMatch(/needs its receipt attached/);

    const after = await db.fieldExpense.findUnique({ where: { id: expense.id } });
    expect(after?.status).toBe("draft");
  });

  /**
   * The half that only a real database settles. The receipt arrives as a `FileObject` row, and the
   * expense's own `receiptFileIds` column stays empty — because the screen can only attach a file
   * after the expense exists. A claim check reading the column alone passes every unit test and
   * tells the technician their attached receipt is missing.
   */
  it("lets it through once a receipt is attached to the saved row", async () => {
    const ticket = await makeTicket();
    const expense = await saveExpenseService(actor, {
      ticketId: ticket.id,
      date: new Date(),
      category: "transport_fare",
      amount: 80_000,
      description: "Taxi, receipt photographed",
    });
    expenseIds.push(expense.id);

    expect((await submitExpensesService(actor, { ids: [expense.id] })).submitted).toBe(0);

    await attachReceipt(expense.id);

    const [row] = await listExpensesService({ ticketId: ticket.id });
    expect(row).toBeDefined();
    expect(row!.receiptMissing).toBe(false);
    expect(row!.receiptCount).toBe(1);

    const result = await submitExpensesService(actor, { ids: [expense.id] });
    expect(result.submitted).toBe(1);
    expect(result.blocked).toEqual([]);

    const after = await db.fieldExpense.findUnique({ where: { id: expense.id } });
    expect(after?.status).toBe("submitted");
  });

  it("submits everything it can and names only what stayed behind", async () => {
    const ticket = await makeTicket();

    const fine = await saveExpenseService(actor, {
      ticketId: ticket.id,
      date: new Date(),
      category: "meals",
      amount: 30_000,
      description: "Lunch, under the threshold",
    });
    const blockedOne = await saveExpenseService(actor, {
      ticketId: ticket.id,
      date: new Date(),
      category: "transport_fare",
      amount: 120_000,
      description: "Van hire, no receipt yet",
    });
    expenseIds.push(fine.id, blockedOne.id);

    const result = await submitExpensesService(actor, { ids: [fine.id, blockedOne.id] });

    expect(result.submitted).toBe(1);
    expect(result.blocked.map((item) => item.description)).toEqual(["Van hire, no receipt yet"]);

    expect((await db.fieldExpense.findUnique({ where: { id: fine.id } }))?.status).toBe(
      "submitted",
    );
    expect((await db.fieldExpense.findUnique({ where: { id: blockedOne.id } }))?.status).toBe(
      "draft",
    );
  });
});
