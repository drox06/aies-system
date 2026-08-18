import { TRPCError } from "@trpc/server";
import { Prisma } from "@prisma/client";
import { db } from "@/lib/db";
import { writeAuditLog } from "@/server/core/audit/audit";
import type { ActorMeta } from "@/server/core/crm/account-service";
import { emit } from "@/server/core/events/emit";
import { registerFileAccessChecker } from "@/server/core/storage/access";
import {
  FIELD_EXPENSE_ENTITY_TYPE,
  TIMESHEET_ENTITY_TYPE,
  advanceStanding,
  checkExpense,
  checkExpenseClaimable,
  checkHours,
  sumHours,
  type ExpenseCategory,
} from "./timesheet-rules";

/**
 * specs/04-operations-projects.md §16's hours and field spend.
 *
 * ## Who may approve what
 *
 * Nobody approves their own. It is the one rule in this file that is not about accuracy: a timesheet
 * or an expense is a claim on the company, and a claim somebody can grant themselves is not a
 * control. §5 already makes the same call about cash advances, and this follows it rather than
 * inventing a second answer.
 *
 * ## The link to §5's liquidation
 *
 * §16: "field expenses linked to a cash advance flow into its liquidation automatically." What that
 * means concretely is `advanceStanding` — the advance's released amount less its *approved* expenses.
 * Submitted-but-unapproved claims are reported separately and deliberately do not reduce the balance;
 * otherwise somebody clears their own advance by typing, which is exactly what §5's liquidation
 * exists to prevent.
 */

registerFileAccessChecker(FIELD_EXPENSE_ENTITY_TYPE, async (user) => {
  return (
    user.permissions.has("timesheet.approve") ||
    user.permissions.has("cash_advance.review_liquidation") ||
    user.permissions.has("ticket.execute")
  );
});

// ---- timesheets ------------------------------------------------------------------------------------

export interface TimesheetInput {
  ticketId?: string | null;
  projectId?: string | null;
  date: Date;
  regularHours: number;
  overtimeHours?: number;
  travelHours?: number;
  standbyHours?: number;
  activity?: string | null;
  notes?: string | null;
}

const hoursOf = (input: TimesheetInput) => ({
  regularHours: input.regularHours,
  overtimeHours: input.overtimeHours ?? 0,
  travelHours: input.travelHours ?? 0,
  standbyHours: input.standbyHours ?? 0,
});

/**
 * Records a day, or corrects one already recorded.
 *
 * Upserted on the schema's `(userId, date, ticketId)` key rather than created: a second sheet for the
 * same day on the same ticket is an *edit*, not a second fact, and creating one would double
 * somebody's week the first time a phone retried a submission.
 */
export async function saveTimesheetService(actor: ActorMeta, input: TimesheetInput) {
  const check = checkHours(hoursOf(input));
  if (!check.ok) {
    throw new TRPCError({ code: "BAD_REQUEST", message: check.errors.join(" ") });
  }

  const existing = await db.timesheet.findFirst({
    where: {
      userId: actor.actorId,
      date: input.date,
      ticketId: input.ticketId ?? null,
      deletedAt: null,
    },
  });

  if (existing && existing.status !== "draft" && existing.status !== "rejected") {
    throw new TRPCError({
      code: "BAD_REQUEST",
      message:
        `That day is already ${existing.status === "approved" ? "approved" : "submitted"}. ` +
        `Ask for it to be sent back rather than editing it underneath whoever is reviewing it.`,
    });
  }

  const data = {
    ...hoursOf(input),
    projectId: input.projectId ?? null,
    activity: input.activity ?? null,
    notes: input.notes ?? null,
    // A corrected sheet goes back to draft, so a rejection is not silently re-submitted unread.
    status: "draft",
    rejectedReason: null,
  };

  if (existing) {
    return db.timesheet.update({
      where: { id: existing.id },
      data: { ...data, version: { increment: 1 } },
    });
  }

  return db.timesheet.create({
    data: {
      ...data,
      userId: actor.actorId,
      date: input.date,
      ticketId: input.ticketId ?? null,
    },
  });
}

export async function submitTimesheetsService(actor: ActorMeta, input: { ids: string[] }) {
  const rows = await db.timesheet.findMany({
    where: { id: { in: input.ids }, userId: actor.actorId, deletedAt: null },
  });

  const blocked = rows.filter((row) => row.status !== "draft" && row.status !== "rejected");
  if (blocked.length > 0) {
    throw new TRPCError({
      code: "BAD_REQUEST",
      message: `${blocked.length} of those are already submitted or approved.`,
    });
  }

  const result = await db.timesheet.updateMany({
    where: { id: { in: rows.map((row) => row.id) } },
    data: { status: "submitted", version: { increment: 1 } },
  });

  return { submitted: result.count };
}

export async function decideTimesheetService(
  actor: ActorMeta,
  input: { id: string; approve: boolean; reason?: string | null },
) {
  const sheet = await db.timesheet.findFirst({ where: { id: input.id, deletedAt: null } });
  if (!sheet) throw new TRPCError({ code: "NOT_FOUND", message: "No such timesheet." });

  // The rule this file exists to enforce. A claim on the company that the claimant can grant is not
  // a control, whatever the amount.
  if (sheet.userId === actor.actorId) {
    throw new TRPCError({
      code: "FORBIDDEN",
      message:
        "Somebody else has to approve your hours. §5 makes the same call about cash advances.",
    });
  }
  if (sheet.status !== "submitted") {
    throw new TRPCError({
      code: "BAD_REQUEST",
      message: `That sheet is ${sheet.status}, not waiting for a decision.`,
    });
  }
  if (!input.approve && !input.reason?.trim()) {
    throw new TRPCError({
      code: "BAD_REQUEST",
      message: "Say why it is going back, or the person cannot fix it.",
    });
  }

  return db.$transaction(async (tx) => {
    const decided = await tx.timesheet.update({
      where: { id: sheet.id },
      data: input.approve
        ? {
            status: "approved",
            approvedById: actor.actorId,
            approvedAt: new Date(),
            rejectedReason: null,
            version: { increment: 1 },
          }
        : {
            status: "rejected",
            rejectedReason: input.reason!.trim(),
            version: { increment: 1 },
          },
    });

    await writeAuditLog(tx, {
      actorId: actor.actorId,
      actorLabel: actor.actorLabel,
      action: input.approve ? "timesheet_approved" : "timesheet_rejected",
      entityType: TIMESHEET_ENTITY_TYPE,
      entityId: sheet.id,
      summary: input.approve
        ? `Approved ${sheet.date.toISOString().slice(0, 10)}.`
        : `Sent back: ${input.reason!.trim()}`,
      ip: actor.ip,
      userAgent: actor.userAgent,
      requestId: actor.requestId,
    });

    return decided;
  });
}

/** What a ticket has cost in hours, with §8's standby kept separate from the work. */
export async function ticketHoursService(ticketId: string) {
  const rows = await db.timesheet.findMany({
    where: { ticketId, deletedAt: null, status: { in: ["submitted", "approved"] } },
    orderBy: { date: "asc" },
  });

  const numeric = rows.map((row) => ({
    regularHours: Number(row.regularHours),
    overtimeHours: Number(row.overtimeHours),
    travelHours: Number(row.travelHours),
    standbyHours: Number(row.standbyHours),
  }));

  return {
    rows: rows.map((row, index) => ({
      id: row.id,
      date: row.date,
      userId: row.userId,
      status: row.status,
      activity: row.activity,
      ...numeric[index]!,
    })),
    // Approved only, so a total nobody has agreed to is never presented as a cost.
    approved: sumHours(
      rows.flatMap((row, index) => (row.status === "approved" ? [numeric[index]!] : [])),
    ),
    submitted: sumHours(numeric),
  };
}

export async function myTimesheetsService(userId: string, from: Date, to: Date) {
  const rows = await db.timesheet.findMany({
    where: { userId, deletedAt: null, date: { gte: from, lte: to } },
    orderBy: { date: "asc" },
  });
  return rows.map((row) => ({
    ...row,
    regularHours: Number(row.regularHours),
    overtimeHours: Number(row.overtimeHours),
    travelHours: Number(row.travelHours),
    standbyHours: Number(row.standbyHours),
  }));
}

/** Everything waiting on somebody who can approve — never their own. */
export async function timesheetsAwaitingService(reviewerId: string) {
  return db.timesheet.findMany({
    where: { status: "submitted", deletedAt: null, userId: { not: reviewerId } },
    orderBy: { date: "asc" },
    take: 200,
  });
}

// ---- field expenses --------------------------------------------------------------------------------

export interface ExpenseInput {
  ticketId?: string | null;
  projectId?: string | null;
  cashAdvanceId?: string | null;
  date: Date;
  category: ExpenseCategory;
  amount: number;
  description: string;
  receiptFileIds?: string[];
}

export async function saveExpenseService(actor: ActorMeta, input: ExpenseInput) {
  const check = checkExpense(input);
  if (!check.ok) {
    throw new TRPCError({ code: "BAD_REQUEST", message: check.errors.join(" ") });
  }

  if (input.cashAdvanceId) {
    const advance = await db.cashAdvance.findFirst({
      where: { id: input.cashAdvanceId, deletedAt: null },
      select: { id: true, status: true, requestedById: true },
    });
    if (!advance) {
      throw new TRPCError({ code: "NOT_FOUND", message: "That cash advance no longer exists." });
    }
    // Charging an advance that was never released, or one already closed, would make its
    // liquidation disagree with itself — and §5's reconciliation is the thing that has to balance.
    if (
      !["released", "partially_liquidated", "overdue_liquidation", "extended"].includes(
        advance.status,
      )
    ) {
      throw new TRPCError({
        code: "BAD_REQUEST",
        message: `That advance is ${advance.status}. Only a released advance can be spent against.`,
      });
    }
  }

  return db.fieldExpense.create({
    data: {
      ticketId: input.ticketId ?? null,
      projectId: input.projectId ?? null,
      cashAdvanceId: input.cashAdvanceId ?? null,
      userId: actor.actorId,
      date: input.date,
      category: input.category,
      amount: input.amount,
      description: input.description,
      receiptFileIds: input.receiptFileIds ?? [],
      status: "draft",
    },
  });
}

/**
 * Submit expenses for approval — the point where the receipt rule bites.
 *
 * ## Where a receipt is counted from
 *
 * A receipt reaches an expense two ways: `receiptFileIds` passed when the row is created, or a file
 * uploaded against the saved row afterwards, which is what the screen actually offers because the
 * row has no id until it exists. Counting only the column made every uploaded receipt invisible, so
 * this counts **both**, unioned, in this one place. One derived value computed once beats two
 * sources of truth that drift — and the drift here would read as "I attached it and it still says
 * missing", which is the kind of thing that makes people stop trusting the screen.
 *
 * ## Why a partial submit rather than a refusal
 *
 * Somebody submitting five days of spend with one receipt missing should get four submitted and one
 * named, not five refused. A rejection that throws away the good rows teaches people to submit one
 * at a time, and then the rule has made the platform slower without making anything more accurate.
 */
export async function submitExpensesService(actor: ActorMeta, input: { ids: string[] }) {
  const rows = await db.fieldExpense.findMany({
    where: {
      id: { in: input.ids },
      userId: actor.actorId,
      status: { in: ["draft", "rejected"] },
      deletedAt: null,
    },
    select: { id: true, amount: true, description: true, receiptFileIds: true },
  });

  const attached = await db.fileObject.findMany({
    where: {
      entityType: FIELD_EXPENSE_ENTITY_TYPE,
      entityId: { in: rows.map((row) => row.id) },
      deletedAt: null,
    },
    select: { id: true, entityId: true },
  });

  const blocked: { id: string; description: string; reason: string }[] = [];
  const allowed: string[] = [];

  for (const row of rows) {
    const receiptFileIds = [
      ...new Set([
        ...row.receiptFileIds,
        ...attached.filter((file) => file.entityId === row.id).map((file) => file.id),
      ]),
    ];
    const check = checkExpenseClaimable({ amount: row.amount, receiptFileIds });
    if (check.ok) {
      allowed.push(row.id);
    } else {
      blocked.push({ id: row.id, description: row.description, reason: check.errors.join(" ") });
    }
  }

  const result = allowed.length
    ? await db.fieldExpense.updateMany({
        where: { id: { in: allowed } },
        data: { status: "submitted", version: { increment: 1 } },
      })
    : { count: 0 };

  return { submitted: result.count, blocked };
}

export async function decideExpenseService(
  actor: ActorMeta,
  input: { id: string; approve: boolean; reason?: string | null },
) {
  const expense = await db.fieldExpense.findFirst({ where: { id: input.id, deletedAt: null } });
  if (!expense) throw new TRPCError({ code: "NOT_FOUND", message: "No such expense." });

  if (expense.userId === actor.actorId) {
    throw new TRPCError({
      code: "FORBIDDEN",
      message: "Somebody else has to approve your expenses.",
    });
  }
  if (expense.status !== "submitted") {
    throw new TRPCError({
      code: "BAD_REQUEST",
      message: `That expense is ${expense.status}, not waiting for a decision.`,
    });
  }
  if (!input.approve && !input.reason?.trim()) {
    throw new TRPCError({ code: "BAD_REQUEST", message: "Say why it is being refused." });
  }

  return db.$transaction(async (tx) => {
    const decided = await tx.fieldExpense.update({
      where: { id: expense.id },
      data: input.approve
        ? {
            status: "approved",
            approvedById: actor.actorId,
            approvedAt: new Date(),
            rejectedReason: null,
            version: { increment: 1 },
          }
        : {
            status: "rejected",
            rejectedReason: input.reason!.trim(),
            version: { increment: 1 },
          },
    });

    await writeAuditLog(tx, {
      actorId: actor.actorId,
      actorLabel: actor.actorLabel,
      action: input.approve ? "expense_approved" : "expense_rejected",
      entityType: FIELD_EXPENSE_ENTITY_TYPE,
      entityId: expense.id,
      summary: `${input.approve ? "Approved" : "Refused"} ${expense.category}: ${expense.description}`,
      ip: actor.ip,
      userAgent: actor.userAgent,
      requestId: actor.requestId,
    });

    /**
     * §16's automatic flow into §5. Emitted rather than written straight into the advance, because
     * the liquidation is §5's record and this module should not be reaching into it — the same
     * boundary every other cross-section link in module 04 keeps.
     */
    if (input.approve && expense.cashAdvanceId) {
      await emit(
        tx,
        "field_expense.approved",
        {
          expenseId: expense.id,
          cashAdvanceId: expense.cashAdvanceId,
          amount: expense.amount,
          category: expense.category,
        },
        { actorId: actor.actorId },
      );
    }

    return decided;
  });
}

/**
 * §5's liquidation, computed from §16's expenses.
 *
 * The number that matters is `outstanding`, and it is allowed to be negative — a technician who
 * spent more than they were given is owed the difference, which is common and which a
 * `Math.max(0, …)` would have hidden.
 */
export async function advanceLiquidationService(cashAdvanceId: string) {
  const advance = await db.cashAdvance.findFirst({
    where: { id: cashAdvanceId, deletedAt: null },
    select: { id: true, number: true, amountApproved: true, status: true, releasedAt: true },
  });
  if (!advance) return null;

  const expenses = await db.fieldExpense.findMany({
    where: { cashAdvanceId, deletedAt: null },
    orderBy: { date: "asc" },
  });

  const released = Math.round(Number(advance.amountApproved ?? 0) * 100);

  return {
    advance,
    expenses,
    standing: advanceStanding({
      released,
      expenses: expenses.map((expense) => ({ amount: expense.amount, status: expense.status })),
    }),
  };
}

/**
 * Each row carries `receiptMissing` — whether *this* row is the one holding up a claim.
 *
 * Derived on the server from the same union `submitExpensesService` uses, so the badge on the screen
 * and the refusal at submit can never disagree. A screen that says a receipt is attached while the
 * submit says it is not is worse than either answer alone.
 */
export async function listExpensesService(filter: {
  ticketId?: string;
  projectId?: string;
  cashAdvanceId?: string;
  status?: string;
}) {
  const rows = await db.fieldExpense.findMany({
    where: {
      deletedAt: null,
      ...(filter.ticketId ? { ticketId: filter.ticketId } : {}),
      ...(filter.projectId ? { projectId: filter.projectId } : {}),
      ...(filter.cashAdvanceId ? { cashAdvanceId: filter.cashAdvanceId } : {}),
      ...(filter.status ? { status: filter.status } : {}),
    },
    orderBy: { date: "desc" },
    take: 200,
  });

  const attached = await db.fileObject.findMany({
    where: {
      entityType: FIELD_EXPENSE_ENTITY_TYPE,
      entityId: { in: rows.map((row) => row.id) },
      deletedAt: null,
    },
    select: { id: true, entityId: true },
  });

  return rows.map((row) => {
    const receiptFileIds = [
      ...new Set([
        ...row.receiptFileIds,
        ...attached.filter((file) => file.entityId === row.id).map((file) => file.id),
      ]),
    ];
    return {
      ...row,
      receiptCount: receiptFileIds.length,
      receiptMissing: !checkExpenseClaimable({ amount: row.amount, receiptFileIds }).ok,
    };
  });
}

export async function expensesAwaitingService(reviewerId: string) {
  return db.fieldExpense.findMany({
    where: { status: "submitted", deletedAt: null, userId: { not: reviewerId } },
    orderBy: { date: "asc" },
    take: 200,
  });
}

/** Re-exported so a caller does not need to know the shape is stored as Decimal. */
export type { Prisma };
