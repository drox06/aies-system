import { TRPCError } from "@trpc/server";
import { db } from "@/lib/db";
import { writeAuditLog } from "@/server/core/audit/audit";
import { allocateNumber } from "@/server/core/numbering/numbering";
import type { ActorMeta } from "@/server/core/crm/account-service";
import { EXPENSE_CATEGORY_LABELS, type ExpenseCategory } from "@/server/core/finance/expense-rules";

export const EXPENSE_ENTITY_TYPE = "Expense";
export const EXPENSE_DOCUMENT_TYPE = "expense";

/**
 * §6's direct expenses — the costs that arrive on paper rather than through another module.
 *
 * ## Why this exists, and what it is not
 *
 * `Expense` was a table §6's P&L read and **nothing could write**. There was no service, no
 * procedure and no screen, so the only direct costs a project could ever show were ones a seed
 * script had put there. Third occurrence of the shape docs/DECISIONS.md #128 named; #133 records
 * this one alongside the cost rates and the supplier bill form.
 *
 * **It is not module 04's field expense.** A `FieldExpense` is money a technician spent on site and
 * is claiming back, and it belongs to a ticket and its cash advance. This is an invoice AIES
 * received for something bought for a job — a subcontracted crane, a permit, a rental — and it
 * belongs to the project. §6 reads both, under different categories, and keeping them apart is what
 * stops the same peso being counted twice.
 *
 * A cash advance's liquidation lines are also **not** expenses. §5b is explicit that approved
 * liquidation lines post as project costs automatically and "must not be re-keyed as expenses", so
 * `projectPnlService` reads them directly and this path deliberately offers no way to duplicate them.
 */

export async function submitExpenseService(
  actor: ActorMeta,
  input: {
    category: ExpenseCategory;
    vendorName?: string | null;
    expenseDate: Date;
    amount: number;
    vatAmount?: number | null;
    description: string;
    projectId?: string | null;
    salesOrderId?: string | null;
    ticketId?: string | null;
    paymentMethod?: string | null;
    receiptFileIds?: string[];
  },
) {
  if (input.amount <= 0) {
    throw new TRPCError({
      code: "BAD_REQUEST",
      message: "An expense of nothing is not an expense. Check the amount.",
    });
  }

  if (input.expenseDate.getTime() > Date.now()) {
    throw new TRPCError({
      code: "BAD_REQUEST",
      message:
        "That date is in the future. An expense records money already spent — a commitment that " +
        "has not been paid yet belongs on a purchase order.",
    });
  }

  if (input.description.trim().length < 3) {
    throw new TRPCError({
      code: "BAD_REQUEST",
      message:
        "Say what it was for. A category alone cannot be argued with six months later, and §6 " +
        "exists so a cost can be argued with.",
    });
  }

  /*
    A project or a sales order is required — one of the two, not neither.

    An expense charged to nothing is a cost that leaves the company and appears on no job's margin.
    §6's whole purpose is that the gap between quoted and actual is knowable, and an untethered
    expense makes every project look better than it was. The sales order is accepted as well as the
    project because a job whose project was never created still has costs, and losing them would
    flatter the margin exactly as much.
  */
  if (!input.projectId && !input.salesOrderId) {
    throw new TRPCError({
      code: "BAD_REQUEST",
      message:
        "Charge it to a project or a sales order. An expense against nothing is a cost that shows " +
        "up on no job's margin.",
    });
  }

  const number = await allocateNumber(EXPENSE_DOCUMENT_TYPE);

  const created = await db.$transaction(async (tx) => {
    const row = await tx.expense.create({
      data: {
        number,
        category: input.category,
        vendorName: input.vendorName?.trim() || null,
        expenseDate: input.expenseDate,
        amount: input.amount.toFixed(2),
        vatAmount:
          input.vatAmount === null || input.vatAmount === undefined
            ? null
            : input.vatAmount.toFixed(2),
        description: input.description.trim(),
        projectId: input.projectId ?? null,
        salesOrderId: input.salesOrderId ?? null,
        ticketId: input.ticketId ?? null,
        paymentMethod: input.paymentMethod?.trim() || null,
        receiptFileIds: input.receiptFileIds ?? [],
        // Submitted, not approved. §6 counts only approved and paid towards project cost, because
        // counting claims would make every project look worse the moment somebody typed something
        // and better again when it was rejected.
        status: "submitted",
        submittedById: actor.actorId,
      },
    });

    await writeAuditLog(tx, {
      actorId: actor.actorId,
      actorLabel: actor.actorLabel,
      action: "create",
      entityType: EXPENSE_ENTITY_TYPE,
      entityId: row.id,
      summary:
        `Submitted ${row.number} — ${EXPENSE_CATEGORY_LABELS[input.category]}, ` +
        `PHP ${input.amount.toFixed(2)}` +
        (input.vendorName ? ` to ${input.vendorName.trim()}` : "") +
        `: ${input.description.trim()}`,
      ip: actor.ip,
      userAgent: actor.userAgent,
      requestId: actor.requestId,
    });

    return row;
  });

  return { id: created.id, number: created.number };
}

export async function decideExpenseService(
  actor: ActorMeta,
  input: { id: string; approve: boolean; reason?: string | null },
) {
  const expense = await db.expense.findFirst({
    where: { id: input.id, deletedAt: null },
    select: { id: true, number: true, status: true, amount: true, submittedById: true },
  });
  if (!expense) {
    throw new TRPCError({ code: "NOT_FOUND", message: "That expense no longer exists." });
  }
  if (expense.status !== "submitted") {
    throw new TRPCError({
      code: "BAD_REQUEST",
      message: `${expense.number} is ${expense.status}, so there is nothing to decide.`,
    });
  }

  /*
    Approving one's own expense is refused.

    Not a general rule about self-approval — §6 does not state one — but the specific case where the
    person who spent the money is the person who signs it off leaves no second pair of eyes on a cost
    that lands directly on a project's margin. Where the company genuinely has nobody else, the
    President's own approval is still a different person's decision on someone else's claim.
  */
  if (input.approve && expense.submittedById === actor.actorId) {
    throw new TRPCError({
      code: "FORBIDDEN",
      message:
        "You submitted this one. Somebody else has to approve it — an expense nobody but the " +
        "spender has looked at is a cost with no second pair of eyes on it.",
    });
  }

  const reason = input.reason?.trim() ?? "";
  if (!input.approve && reason.length < 5) {
    throw new TRPCError({
      code: "BAD_REQUEST",
      message: "Say why it was rejected, so whoever submitted it knows what to do differently.",
    });
  }

  await db.$transaction(async (tx) => {
    await tx.expense.update({
      where: { id: expense.id },
      data: input.approve
        ? { status: "approved", approvedById: actor.actorId, approvedAt: new Date() }
        : { status: "rejected", rejectedReason: reason },
    });

    await writeAuditLog(tx, {
      actorId: actor.actorId,
      actorLabel: actor.actorLabel,
      action: input.approve ? "approve" : "reject",
      entityType: EXPENSE_ENTITY_TYPE,
      entityId: expense.id,
      summary: input.approve
        ? `Approved ${expense.number} — PHP ${expense.amount.toString()}, now counted against the job`
        : `Rejected ${expense.number} — ${reason}`,
      ip: actor.ip,
      userAgent: actor.userAgent,
      requestId: actor.requestId,
    });
  });

  return { status: input.approve ? ("approved" as const) : ("rejected" as const) };
}

/** The expense list, newest first, with what each is charged to spelled out. */
export async function expensesService(filter: { status?: string } = {}) {
  const rows = await db.expense.findMany({
    where: { deletedAt: null, ...(filter.status ? { status: filter.status } : {}) },
    orderBy: [{ expenseDate: "desc" }, { createdAt: "desc" }],
    take: 200,
  });

  const [projects, orders, users] = await Promise.all([
    db.project.findMany({
      where: {
        id: { in: [...new Set(rows.map((r) => r.projectId).filter((id): id is string => !!id))] },
      },
      select: { id: true, code: true, name: true },
    }),
    db.salesOrder.findMany({
      where: {
        id: {
          in: [...new Set(rows.map((r) => r.salesOrderId).filter((id): id is string => !!id))],
        },
      },
      select: { id: true, number: true },
    }),
    db.user.findMany({
      where: { id: { in: [...new Set(rows.map((r) => r.submittedById))] } },
      select: { id: true, name: true },
    }),
  ]);
  const projectById = new Map(projects.map((p) => [p.id, p]));
  const orderById = new Map(orders.map((o) => [o.id, o]));
  const nameById = new Map(users.map((u) => [u.id, u.name]));

  return rows.map((row) => ({
    id: row.id,
    number: row.number,
    category: row.category,
    vendorName: row.vendorName,
    expenseDate: row.expenseDate,
    amount: row.amount.toString(),
    vatAmount: row.vatAmount?.toString() ?? null,
    currency: row.currency,
    description: row.description,
    status: row.status,
    rejectedReason: row.rejectedReason,
    submittedBy: nameById.get(row.submittedById) ?? "somebody",
    submittedById: row.submittedById,
    project: row.projectId ? (projectById.get(row.projectId) ?? null) : null,
    salesOrder: row.salesOrderId ? (orderById.get(row.salesOrderId) ?? null) : null,
  }));
}

/** The projects an expense can be charged to — open jobs, newest first. */
export async function chargeableProjectsService() {
  return db.project.findMany({
    where: { deletedAt: null, status: { notIn: ["closed", "cancelled"] } },
    select: { id: true, code: true, name: true },
    orderBy: { createdAt: "desc" },
    take: 200,
  });
}
