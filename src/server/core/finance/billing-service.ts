import { TRPCError } from "@trpc/server";
import { Prisma } from "@prisma/client";
import { db } from "@/lib/db";
import { writeAuditLog } from "@/server/core/audit/audit";
import type { ActorMeta } from "@/server/core/crm/account-service";
import { emit } from "@/server/core/events/emit";
import { notify } from "@/server/core/notify/notify";
import { registerNotificationType } from "@/server/core/notify/registry";
import {
  BILLING_TRIGGERS,
  BILLING_TRIGGER_LABELS,
  checkTermMilestones,
  dueDateFor,
  milestonesTriggeredBy,
  planMilestones,
  type BillingTrigger,
  type TermMilestone,
} from "./billing-rules";

/**
 * specs/05-finance-billing.md §2 — the billing schedule and its triggers.
 *
 * ## The one thing this file is for
 *
 * §2: "Finance never has to ask operations whether a project is done — this is the core coordination
 * failure the platform exists to fix."
 *
 * So the shape is: a schedule is planned once from the order's payment term, and after that
 * **nothing here decides anything**. Milestones become billable because a module that owns the
 * underlying fact emitted an event. Finance is told; finance does not have to go and look.
 *
 * ## Why the schedule is not generated automatically on `sales_order.created`
 *
 * It would be one line, and it would be wrong. Generating a schedule commits the company to a
 * billing plan, and §2's `on_order` milestone is *immediately billable* — so an automatic schedule
 * would raise a downpayment demand on an order somebody was still checking. Worse, an order raised
 * against a term with no milestones would either fail silently or invent a default, and the
 * invented default would be "bill it all at the end", which is the most expensive possible guess.
 *
 * Somebody presses the button. What is automatic is everything after it.
 */

export const BILLING_MILESTONE_READY_NOTIFICATION_TYPE = "billing.milestone_ready";

registerNotificationType({
  key: BILLING_MILESTONE_READY_NOTIFICATION_TYPE,
  label: "A milestone is ready to bill",
  // In-app only, like every other type in this build; module 05 §8 owns the email transport and
  // module 10 the sending. A milestone becoming billable is not urgent to the minute — what matters
  // is that finance sees it without asking, which the bell does.
  defaultChannels: { inApp: true, email: false, digest: true },
});

export const BILLING_SCHEDULE_ENTITY_TYPE = "BillingSchedule";
export const BILLING_MILESTONE_ENTITY_TYPE = "BillingMilestone";

function asTermMilestones(raw: unknown): TermMilestone[] {
  return Array.isArray(raw) ? (raw as TermMilestone[]) : [];
}

/**
 * Plans an order's billing, from its payment term.
 *
 * Refuses a second schedule for the same order. §2 has one schedule per order and the unique
 * constraint enforces it, but the message is the point: somebody pressing this twice is usually
 * trying to *change* the plan after a variation order, and that is a different act with different
 * consequences than planning it fresh.
 */
export async function generateScheduleService(
  actor: ActorMeta,
  input: { salesOrderId: string; paymentTermId?: string },
) {
  const order = await db.salesOrder.findFirst({
    where: { id: input.salesOrderId, deletedAt: null },
    select: {
      id: true,
      number: true,
      total: true,
      accountId: true,
      paymentTermsId: true,
      ownerId: true,
    },
  });
  if (!order) {
    throw new TRPCError({ code: "NOT_FOUND", message: "That sales order no longer exists." });
  }

  const existing = await db.billingSchedule.findFirst({
    where: { salesOrderId: order.id, deletedAt: null },
    select: { id: true },
  });
  if (existing) {
    throw new TRPCError({
      code: "BAD_REQUEST",
      message:
        `${order.number} already has a billing schedule. If the order's value or terms have ` +
        `changed, the milestones are edited — a second schedule would leave two plans disagreeing ` +
        `about what has been billed.`,
    });
  }

  const paymentTermId = input.paymentTermId ?? order.paymentTermsId;
  if (!paymentTermId) {
    throw new TRPCError({
      code: "BAD_REQUEST",
      message:
        `${order.number} has no payment term, so there is nothing to derive a billing plan from. ` +
        `Set the term on the order first — it is a commercial decision, not a default.`,
    });
  }

  const term = await db.paymentTerm.findFirst({ where: { id: paymentTermId } });
  if (!term) {
    throw new TRPCError({ code: "NOT_FOUND", message: "That payment term no longer exists." });
  }

  const milestones = asTermMilestones(term.milestones);
  const check = checkTermMilestones(milestones);
  if (!check.ok) {
    throw new TRPCError({
      code: "BAD_REQUEST",
      message:
        `"${term.name}" cannot be billed from as it stands. ${check.errors.join(" ")} ` +
        `Nothing has been planned — fix the term and try again.`,
    });
  }

  // The order total is a Decimal in pesos; every money field this module writes is integer centavos.
  const totalCentavos = Math.round(Number(order.total) * 100);
  const planned = planMilestones(totalCentavos, milestones);

  const schedule = await db.$transaction(async (tx) => {
    const created = await tx.billingSchedule.create({
      data: {
        salesOrderId: order.id,
        paymentTermId: term.id,
        // What this order agreed to, frozen. A later edit to the term does not re-plan a live order.
        termSnapshot: milestones as unknown as Prisma.InputJsonValue,
        generatedById: actor.actorId,
      },
    });

    await tx.billingMilestone.createMany({
      data: planned.map((milestone) => ({
        scheduleId: created.id,
        salesOrderId: order.id,
        sequence: milestone.sequence,
        label: milestone.label,
        pct: milestone.pct,
        amount: milestone.amount,
        trigger: milestone.trigger,
        status: "pending",
      })),
    });

    await writeAuditLog(tx, {
      actorId: actor.actorId,
      actorLabel: actor.actorLabel,
      action: "created",
      entityType: BILLING_SCHEDULE_ENTITY_TYPE,
      entityId: created.id,
      summary:
        `Planned billing for ${order.number} on "${term.name}": ` +
        planned.map((m) => `${m.pct}% ${m.label}`).join(", "),
      ip: actor.ip,
      userAgent: actor.userAgent,
      requestId: actor.requestId,
    });

    return created;
  });

  /**
   * `on_order` is billable the moment the order exists, so it fires here rather than waiting for a
   * `sales_order.created` event that has already been and gone.
   *
   * This is the one trigger a subscriber cannot serve: the schedule did not exist when the order was
   * created, so nothing was listening. Handling it at generation time is what makes a downpayment
   * appear on finance's list at all — without it, the most common term in the company ("50/50") would
   * silently never bill its first half.
   */
  await applyTriggerToSchedule(actor, {
    scheduleId: schedule.id,
    eventName: BILLING_TRIGGERS.on_order,
    reason: `${order.number} was raised`,
  });

  return { scheduleId: schedule.id, milestones: planned.length, warnings: check.warnings };
}

/**
 * Flips whichever of a schedule's milestones this event makes billable, and tells finance.
 *
 * Shared by the subscribers and by `generateScheduleService`, so "what happens when a trigger fires"
 * has one definition. A second copy in the subscriber path is how the notification ends up missing
 * from one of them.
 */
export async function applyTriggerToSchedule(
  actor: ActorMeta,
  input: { scheduleId: string; eventName: string; reason: string },
) {
  const schedule = await db.billingSchedule.findFirst({
    where: { id: input.scheduleId, deletedAt: null },
    include: {
      paymentTerm: { select: { name: true, netDays: true } },
      milestones: { where: { deletedAt: null }, orderBy: { sequence: "asc" } },
    },
  });
  if (!schedule) return { readied: 0 };

  const due = milestonesTriggeredBy(input.eventName, schedule.milestones);
  if (due.length === 0) return { readied: 0 };

  const snapshot = asTermMilestones(schedule.termSnapshot);
  const readyAt = new Date();

  for (const milestone of due) {
    const fromTerm = snapshot[milestone.sequence - 1];
    const dueDate = dueDateFor(readyAt, schedule.paymentTerm.netDays, {
      trigger: milestone.trigger as BillingTrigger,
      daysAfter: fromTerm?.daysAfter ?? null,
    });

    await db.$transaction(async (tx) => {
      /**
       * Guarded on `status: "pending"` in the WHERE clause, not just read-then-write.
       *
       * §11 asks that a trigger fires "exactly once per event". Two events arriving together — a
       * delivery signed for on the same tick the project closed — would otherwise both read
       * `pending` and both write, and the milestone would notify twice and carry the second one's
       * due date. `updateMany` makes the transition itself the lock.
       */
      const { count } = await tx.billingMilestone.updateMany({
        where: { id: milestone.id, status: "pending", deletedAt: null },
        data: {
          status: "ready_to_bill",
          readyAt,
          readyReason: input.reason,
          dueDate,
          version: { increment: 1 },
        },
      });
      if (count === 0) return;

      await writeAuditLog(tx, {
        actorId: actor.actorId,
        actorLabel: actor.actorLabel,
        action: "ready_to_bill",
        entityType: BILLING_MILESTONE_ENTITY_TYPE,
        entityId: milestone.id,
        summary:
          `${milestone.label} became billable — ${input.reason}. ` +
          `${BILLING_TRIGGER_LABELS[milestone.trigger as BillingTrigger]}.`,
        diff: { status: { from: "pending", to: "ready_to_bill" } },
        ip: actor.ip,
        userAgent: actor.userAgent,
        requestId: actor.requestId,
      });

      await emit(
        tx,
        "milestone.ready_to_bill",
        {
          milestoneId: milestone.id,
          salesOrderId: milestone.salesOrderId,
          label: milestone.label,
          amount: milestone.amount,
          trigger: milestone.trigger,
          dueDate: dueDate.toISOString(),
        },
        { actorId: actor.actorId },
      );
    });
  }

  await notifyFinance(schedule.salesOrderId, due.length, input.reason);

  return { readied: due.length };
}

/**
 * Tells whoever bills that there is something to bill.
 *
 * Best-effort: a notification failure must not roll back the milestone becoming billable. The
 * milestone is the fact; the bell is a courtesy, and the billable list is read from the milestones
 * either way — which is why finance seeing it does not depend on this having worked.
 */
async function notifyFinance(salesOrderId: string, count: number, reason: string) {
  try {
    const order = await db.salesOrder.findUnique({
      where: { id: salesOrderId },
      select: { number: true, account: { select: { name: true } } },
    });

    const recipients = await db.user.findMany({
      where: {
        isActive: true,
        deletedAt: null,
        roles: {
          some: {
            role: {
              permissions: { some: { permission: { key: "billing_statement.create" } } },
            },
          },
        },
      },
      select: { id: true },
    });

    for (const recipient of recipients) {
      await notify({
        recipientId: recipient.id,
        type: BILLING_MILESTONE_READY_NOTIFICATION_TYPE,
        title: `${count} milestone${count === 1 ? "" : "s"} ready to bill on ${order?.number ?? "an order"}`,
        body: `${order?.account?.name ?? "A customer"} — ${reason}.`,
        entityType: BILLING_SCHEDULE_ENTITY_TYPE,
        entityId: salesOrderId,
      });
    }
  } catch {
    // Deliberately swallowed. See the note above.
  }
}

/**
 * The subscriber side: an event arrives naming a record, and whichever schedules it touches advance.
 *
 * Takes the sales order ids rather than resolving them, because how an event maps to an order is the
 * emitting module's knowledge — a `ticket.completed` payload knows its ticket's order, and asking
 * finance to work that out again would put module 04's join logic in two places.
 */
export async function applyTriggerToOrdersService(
  actor: ActorMeta,
  input: { salesOrderIds: readonly string[]; eventName: string; reason: string },
) {
  if (input.salesOrderIds.length === 0) return { readied: 0 };

  const schedules = await db.billingSchedule.findMany({
    where: { salesOrderId: { in: [...input.salesOrderIds] }, deletedAt: null },
    select: { id: true },
  });

  let readied = 0;
  for (const schedule of schedules) {
    const result = await applyTriggerToSchedule(actor, {
      scheduleId: schedule.id,
      eventName: input.eventName,
      reason: input.reason,
    });
    readied += result.readied;
  }
  return { readied };
}

/** One order's plan, for the screen. */
export async function getScheduleService(salesOrderId: string) {
  const schedule = await db.billingSchedule.findFirst({
    where: { salesOrderId, deletedAt: null },
    include: {
      paymentTerm: { select: { id: true, name: true, netDays: true } },
      milestones: { where: { deletedAt: null }, orderBy: { sequence: "asc" } },
    },
  });
  if (!schedule) return null;

  return {
    id: schedule.id,
    salesOrderId: schedule.salesOrderId,
    generatedAt: schedule.generatedAt,
    paymentTerm: schedule.paymentTerm,
    milestones: schedule.milestones.map((milestone) => ({
      id: milestone.id,
      sequence: milestone.sequence,
      label: milestone.label,
      pct: milestone.pct.toString(),
      amount: milestone.amount,
      trigger: milestone.trigger,
      triggerLabel:
        BILLING_TRIGGER_LABELS[milestone.trigger as BillingTrigger] ?? milestone.trigger,
      status: milestone.status,
      readyAt: milestone.readyAt,
      readyReason: milestone.readyReason,
      dueDate: milestone.dueDate,
      billingStatementId: milestone.billingStatementId,
    })),
  };
}

/**
 * Everything billable, oldest due first — finance's work list.
 *
 * §2's whole promise is that this list fills itself. A milestone appears here because an event
 * happened somewhere else in the platform, and the `readyReason` on each row says which, so nobody
 * has to reconstruct why they are being asked to raise a bill.
 */
export async function billableMilestonesService(filter: { accountId?: string } = {}) {
  const milestones = await db.billingMilestone.findMany({
    where: { status: "ready_to_bill", deletedAt: null },
    orderBy: [{ dueDate: "asc" }, { readyAt: "asc" }],
    take: 200,
  });

  const orders = await db.salesOrder.findMany({
    where: { id: { in: milestones.map((m) => m.salesOrderId) } },
    select: {
      id: true,
      number: true,
      accountId: true,
      account: { select: { id: true, name: true } },
    },
  });
  const byId = new Map(orders.map((order) => [order.id, order]));

  return milestones
    .map((milestone) => {
      const order = byId.get(milestone.salesOrderId);
      return {
        id: milestone.id,
        label: milestone.label,
        amount: milestone.amount,
        pct: milestone.pct.toString(),
        trigger: milestone.trigger,
        triggerLabel:
          BILLING_TRIGGER_LABELS[milestone.trigger as BillingTrigger] ?? milestone.trigger,
        readyAt: milestone.readyAt,
        readyReason: milestone.readyReason,
        dueDate: milestone.dueDate,
        salesOrderId: milestone.salesOrderId,
        salesOrderNumber: order?.number ?? null,
        accountId: order?.accountId ?? null,
        accountName: order?.account?.name ?? null,
      };
    })
    .filter((row) => !filter.accountId || row.accountId === filter.accountId);
}

/**
 * Cancels a milestone that is never going to be billed.
 *
 * A scope reduction removes work, and a milestone for work nobody will do would otherwise sit on
 * finance's list forever — or worse, get billed. Cancelled rather than deleted: the plan said this
 * would be billed, and why it was not is part of the order's history.
 *
 * An already-invoiced milestone is refused. Cancelling one would leave a statement pointing at a
 * milestone claiming it was never going to happen, and the statement is the document a customer
 * holds.
 */
export async function cancelMilestoneService(
  actor: ActorMeta,
  input: { milestoneId: string; reason: string },
) {
  if (input.reason.trim().length < 5) {
    throw new TRPCError({
      code: "BAD_REQUEST",
      message: "Say why it will not be billed — the plan said it would.",
    });
  }

  const milestone = await db.billingMilestone.findFirst({
    where: { id: input.milestoneId, deletedAt: null },
  });
  if (!milestone) {
    throw new TRPCError({ code: "NOT_FOUND", message: "That milestone no longer exists." });
  }
  if (milestone.status === "invoiced") {
    throw new TRPCError({
      code: "BAD_REQUEST",
      message:
        `${milestone.label} has already been billed. A credit note reverses a bill; cancelling the ` +
        `milestone would leave the customer holding a statement for something the plan says was ` +
        `never going to happen.`,
    });
  }
  if (milestone.status === "cancelled") {
    return { status: "cancelled" as const };
  }

  await db.$transaction(async (tx) => {
    await tx.billingMilestone.update({
      where: { id: milestone.id },
      data: {
        status: "cancelled",
        cancelledAt: new Date(),
        cancelledReason: input.reason.trim(),
        version: { increment: 1 },
      },
    });
    await writeAuditLog(tx, {
      actorId: actor.actorId,
      actorLabel: actor.actorLabel,
      action: "cancelled",
      entityType: BILLING_MILESTONE_ENTITY_TYPE,
      entityId: milestone.id,
      summary: `${milestone.label} will not be billed — ${input.reason.trim()}`,
      diff: { status: { from: milestone.status, to: "cancelled" } },
      ip: actor.ip,
      userAgent: actor.userAgent,
      requestId: actor.requestId,
    });
  });

  return { status: "cancelled" as const };
}
