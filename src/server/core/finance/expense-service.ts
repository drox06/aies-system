import { TRPCError } from "@trpc/server";
import { db } from "@/lib/db";
import { writeAuditLog } from "@/server/core/audit/audit";
import { allocateNumber } from "@/server/core/numbering/numbering";
import { notify } from "@/server/core/notify/notify";
import { registerNotificationType } from "@/server/core/notify/registry";
import type { ActorMeta } from "@/server/core/crm/account-service";
import { EXPENSE_CATEGORY_LABELS, type ExpenseCategory } from "@/server/core/finance/expense-rules";

export const EXPENSE_ENTITY_TYPE = "Expense";
export const EXPENSE_DOCUMENT_TYPE = "expense";

export const EXPENSE_SUBMITTED_NOTIFICATION_TYPE = "expense.submitted";
export const EXPENSE_DECIDED_NOTIFICATION_TYPE = "expense.decided";

/*
  Asked for by the company on 2026-08-20, and it is the answer to a real objection.

  §6 refuses to let anybody approve their own expense, which leaves a gap AIES actually has: the
  President arranges a crane at nine at night, submits it, and nobody else is online. Without a
  notification that cost is invisible until somebody happens to open the screen — and an invisible
  cost is exactly what the refusal was protecting the margin from in the first place.

  So the control stays and the silence goes: whoever can approve is told the moment it is submitted.
*/
registerNotificationType({
  key: EXPENSE_SUBMITTED_NOTIFICATION_TYPE,
  label: "A cost was recorded against a job and needs approving",
  // Not coalesced. Each expense is a separate decision with its own amount and its own reason, and
  // rolling three into "3 expenses waiting" would make somebody open the screen to find out what
  // they are — which is the trip the notification exists to save.
  defaultChannels: { inApp: true, email: false, digest: true },
});

registerNotificationType({
  key: EXPENSE_DECIDED_NOTIFICATION_TYPE,
  label: "A cost you recorded was approved or rejected",
  defaultChannels: { inApp: true, email: false, digest: true },
});

/**
 * Everybody who could approve this, minus the person who submitted it.
 *
 * Excluding the submitter matters: the service refuses their approval anyway, so telling them the
 * thing they cannot do is waiting for them is noise — and noise in a notification list is how the
 * useful ones stop being read.
 */
async function approversOtherThan(submitterId: string) {
  return db.user.findMany({
    where: {
      isActive: true,
      deletedAt: null,
      id: { not: submitterId },
      roles: {
        some: { role: { permissions: { some: { permission: { key: "expense.approve" } } } } },
      },
    },
    select: { id: true },
  });
}

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

  /*
    A real sentence, not a word.

    This was `length < 3`, which let "crane" through — and the company caught it walking the
    screen: a one-word description passed the check that exists to stop one-word descriptions. The
    minimum was measuring the wrong thing. "Crane" is a repeat of the category, and six months later
    it cannot be told from any other crane on any other day.

    Two conditions rather than one, because either alone is gameable: enough characters to be a
    phrase, and enough words that a single long noun does not satisfy it. Deliberately not longer —
    "Crane and riggers for the valve lift" is 36 characters and is a perfectly good answer, and a
    threshold that rejected it would teach people to pad.
  */
  const description = input.description.trim();
  const words = description.split(/\s+/).filter(Boolean);
  if (description.length < 15 || words.length < 3) {
    throw new TRPCError({
      code: "BAD_REQUEST",
      message:
        "Say what it was for in a few words — what was bought or done, and for which part of the " +
        "job. A word or two repeats the category, and §6 exists so a cost can be argued with six " +
        "months later.",
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
        description,
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
        `: ${description}`,
      ip: actor.ip,
      userAgent: actor.userAgent,
      requestId: actor.requestId,
    });

    return row;
  });

  /*
    Told, not left to be found.

    Outside the transaction and swallowed on failure, exactly as billing-service does it: the expense
    is recorded whatever the notification does, and a notify that throws must never roll back a cost
    somebody has correctly entered. A missing bell is an annoyance; a lost expense is a wrong margin.
  */
  try {
    const project = input.projectId
      ? await db.project.findUnique({
          where: { id: input.projectId },
          select: { code: true, name: true },
        })
      : null;

    for (const approver of await approversOtherThan(actor.actorId)) {
      await notify({
        recipientId: approver.id,
        type: EXPENSE_SUBMITTED_NOTIFICATION_TYPE,
        title: `${actor.actorLabel} recorded PHP ${input.amount.toFixed(2)} against ${
          project?.code ?? "a job"
        }`,
        // The amount and the reason in the body, so the decision can be made from the bell rather
        // than only from the screen.
        body:
          `${created.number} — ${EXPENSE_CATEGORY_LABELS[input.category]}` +
          (input.vendorName ? `, ${input.vendorName.trim()}` : "") +
          `: ${description}`,
        entityType: EXPENSE_ENTITY_TYPE,
        entityId: created.id,
      });
    }
  } catch {
    // Deliberately swallowed. See the note above.
  }

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

  /*
    And the person who submitted it is told what happened.

    A rejection especially: §6 makes the approver write down why, and a reason nobody reads is a
    reason nobody acts on. Same swallow — the decision is already committed.
  */
  try {
    await notify({
      recipientId: expense.submittedById,
      type: EXPENSE_DECIDED_NOTIFICATION_TYPE,
      title: input.approve ? `${expense.number} was approved` : `${expense.number} was rejected`,
      body: input.approve
        ? `${actor.actorLabel} approved it. It now counts against the job.`
        : `${actor.actorLabel} rejected it — ${reason}`,
      entityType: EXPENSE_ENTITY_TYPE,
      entityId: expense.id,
    });
  } catch {
    // Deliberately swallowed.
  }

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
