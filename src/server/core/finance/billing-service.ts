import { TRPCError } from "@trpc/server";
import { Prisma } from "@prisma/client";
import { db } from "@/lib/db";
import { writeAuditLog } from "@/server/core/audit/audit";
import type { ActorMeta } from "@/server/core/crm/account-service";
import { emit } from "@/server/core/events/emit";
import { notify } from "@/server/core/notify/notify";
import { registerNotificationType } from "@/server/core/notify/registry";
import { issueStatementService, raiseStatementService } from "./invoice-service";
import {
  generateTicketsService,
  proposeTicketsForSalesOrderService,
} from "@/server/core/operations/ticket-service";
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
 * Releases one `manual` milestone by hand — docs/DECISIONS.md #184's eight terms, three of which
 * (30/70's two balances, both 50/50s' balance, "100% Payment on Delivery") bill on a judgement call
 * nobody's status field can prove, rather than on a domain event.
 *
 * ## Why this is not `applyTriggerToSchedule` with a different event name
 *
 * That function advances *every* pending milestone a schedule owns that matches the event — right for
 * a real event, which has no way to mean "just this one." A schedule can hold two `manual` milestones
 * at once (30/70's supply-and-delivery balance and its installation balance), each ready at a
 * different, unrelated moment; releasing one must never touch the other. So this targets exactly one
 * milestone by id, and refuses outright if it is not `manual` or not still `pending` — a status
 * transition an event proves is not one a click gets to shortcut.
 *
 * ## Why `autoRaiseOnRelease` is read from the frozen snapshot, not the live `PaymentTerm`
 *
 * `BillingSchedule.termSnapshot` is what the order actually agreed to; the live term could have been
 * edited since. Reading anywhere else risks releasing a milestone under one deal's rules and billing
 * it under another's.
 */
export async function releaseMilestoneService(actor: ActorMeta, input: { milestoneId: string }) {
  const milestone = await db.billingMilestone.findFirst({
    where: { id: input.milestoneId, deletedAt: null },
    include: { schedule: { include: { paymentTerm: { select: { netDays: true } } } } },
  });
  if (!milestone) {
    throw new TRPCError({ code: "NOT_FOUND", message: "That milestone no longer exists." });
  }
  if (milestone.trigger !== "manual") {
    throw new TRPCError({
      code: "BAD_REQUEST",
      message:
        `${milestone.label} becomes billable on its own — ` +
        `${BILLING_TRIGGER_LABELS[milestone.trigger as BillingTrigger]}. There is nothing to release.`,
    });
  }
  if (milestone.status !== "pending") {
    throw new TRPCError({
      code: "BAD_REQUEST",
      message: `${milestone.label} is already ${milestone.status.replace(/_/g, " ")}.`,
    });
  }

  const readyAt = new Date();
  const reason = `Released by ${actor.actorLabel}`;
  const dueDate = dueDateFor(readyAt, milestone.schedule.paymentTerm.netDays, {
    trigger: "manual",
    daysAfter: null,
  });

  await db.$transaction(async (tx) => {
    // Guarded on `status: "pending"` in the WHERE clause, same reason `applyTriggerToSchedule` is —
    // two clicks racing must produce one release, not a milestone billed twice.
    const { count } = await tx.billingMilestone.updateMany({
      where: { id: milestone.id, status: "pending", deletedAt: null },
      data: {
        status: "ready_to_bill",
        readyAt,
        readyReason: reason,
        dueDate,
        version: { increment: 1 },
      },
    });
    if (count === 0) {
      throw new TRPCError({
        code: "CONFLICT",
        message: `${milestone.label} was just released by somebody else.`,
      });
    }

    await writeAuditLog(tx, {
      actorId: actor.actorId,
      actorLabel: actor.actorLabel,
      action: "ready_to_bill",
      entityType: BILLING_MILESTONE_ENTITY_TYPE,
      entityId: milestone.id,
      summary: `${milestone.label} released manually — ${reason}.`,
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

  await notifyFinance(milestone.salesOrderId, 1, reason);

  const snapshot = asTermMilestones(milestone.schedule.termSnapshot);
  const original = snapshot[milestone.sequence - 1];
  if (!original?.autoRaiseOnRelease) {
    return { milestoneId: milestone.id, statement: null };
  }

  // §14's "100% Payment on Delivery": releasing this one milestone *is* finance's answer to "are we
  // ready to bill this", so the statement goes out in the same act rather than waiting for a second
  // person to notice it is ready.
  const order = await db.salesOrder.findUniqueOrThrow({
    where: { id: milestone.salesOrderId },
    select: { accountId: true },
  });
  const raised = await raiseStatementService(actor, {
    accountId: order.accountId,
    salesOrderId: milestone.salesOrderId,
    milestoneId: milestone.id,
    dueDate,
    lines: [{ description: milestone.label, quantity: 1, unitPrice: milestone.amount }],
  });
  await issueStatementService(actor, { statementId: raised.id });

  return { milestoneId: milestone.id, statement: { id: raised.id, number: raised.number } };
}

/**
 * §14's customer reply, for "100% Payment on Delivery": AIES has no customer portal, so whoever spoke
 * to the customer logs what was said, not the customer themselves.
 *
 * ## The gate this reads is "has this been billed", not "is this the right term"
 *
 * Any invoiced milestone can carry a reply — narrower would mean teaching this function which of the
 * eight terms are allowed to, which is a rule about *terms* leaking into a function about *facts*.
 * What actually matters is the same either way: a reply means nothing until a bill exists for it to
 * be a reply *to*.
 *
 * ## Why the delivery ticket is generated here rather than proposed for a human to confirm
 *
 * §4 is emphatic elsewhere that ticket generation is never automatic — "one PO can legitimately be
 * one ticket or eight, and only a human knows which." This does not overrule that: the human judgment
 * already happened, in this same call, when whoever spoke to the customer chose to log "payment is
 * ready" rather than "not yet". What is refused is the *ambiguous* case — if the order's own proposal
 * would proceed to `generateTicketsService` with anything other than exactly one goods-only delivery
 * ticket, this stops and asks a person to use the ordinary "review proposed tickets" screen instead,
 * rather than guessing which of several possible sets was meant.
 */
export async function recordCustomerBillingReplyService(
  actor: ActorMeta,
  input: {
    milestoneId: string;
    paymentReady: boolean;
    preferredDeliveryDate?: Date | null;
    notes?: string | null;
  },
) {
  const milestone = await db.billingMilestone.findFirst({
    where: { id: input.milestoneId, deletedAt: null },
  });
  if (!milestone) {
    throw new TRPCError({ code: "NOT_FOUND", message: "That milestone no longer exists." });
  }
  if (milestone.status !== "invoiced") {
    throw new TRPCError({
      code: "BAD_REQUEST",
      message:
        `${milestone.label} has not been billed yet — there is nothing for the customer to have ` +
        "replied to.",
    });
  }
  if (input.paymentReady && !input.preferredDeliveryDate) {
    throw new TRPCError({
      code: "BAD_REQUEST",
      message:
        "A preferred delivery date is what schedules the delivery — record it along with the " +
        "confirmation, not afterward.",
    });
  }

  const updated = await db.billingMilestone.update({
    where: { id: milestone.id },
    data: {
      customerConfirmedAt: input.paymentReady ? new Date() : null,
      customerPreferredDeliveryDate: input.paymentReady
        ? (input.preferredDeliveryDate ?? null)
        : null,
      customerReplyNotes: input.notes?.trim() || null,
      version: { increment: 1 },
    },
  });

  await writeAuditLog(db, {
    actorId: actor.actorId,
    actorLabel: actor.actorLabel,
    action: input.paymentReady ? "customer_confirmed_ready" : "customer_not_ready",
    entityType: BILLING_MILESTONE_ENTITY_TYPE,
    entityId: milestone.id,
    summary: input.paymentReady
      ? `Customer confirmed payment is in hand for ${milestone.label}; preferred delivery ` +
        `${input.preferredDeliveryDate!.toISOString().slice(0, 10)}.`
      : `Customer says payment on ${milestone.label} is not ready yet.` +
        (input.notes?.trim() ? ` ${input.notes.trim()}` : ""),
    ip: actor.ip,
    userAgent: actor.userAgent,
    requestId: actor.requestId,
  });

  if (!input.paymentReady) {
    return { milestone: updated, ticket: null };
  }

  const proposal = await proposeTicketsForSalesOrderService(milestone.salesOrderId);
  const simple = proposal.proposed.length === 1 && proposal.proposed[0]!.type === "delivery";
  if (!simple) {
    // Recorded above regardless — the reply is a fact whether or not a ticket follows from it
    // automatically. A person raises the ticket from the ordinary screen instead.
    return { milestone: updated, ticket: null };
  }

  const [delivery] = proposal.proposed;
  const generated = await generateTicketsService(actor, {
    salesOrderId: milestone.salesOrderId,
    tickets: [
      {
        type: "delivery",
        title: delivery!.title,
        scopeOfWork: delivery!.scopeOfWork,
        salesOrderLineIds: delivery!.salesOrderLineIds,
        requiredByDate: input.preferredDeliveryDate,
      },
    ],
  });

  return { milestone: updated, ticket: generated.tickets[0] ?? null };
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
      customerConfirmedAt: milestone.customerConfirmedAt,
      customerPreferredDeliveryDate: milestone.customerPreferredDeliveryDate,
      customerReplyNotes: milestone.customerReplyNotes,
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

// ---- the subscriber side (§2's triggers, wired) ---------------------------------------------------

/**
 * The actor a subscriber acts as.
 *
 * An event has no person behind it — the person was whoever completed the work, and they are not
 * billing anything. Labelling it honestly matters for the audit row: "The system, on
 * project.closed" is true and legible, where borrowing the completing user's name would put a
 * billing decision under somebody who never made one.
 */
function systemActor(eventName: string): ActorMeta {
  return { actorId: "system", actorLabel: `The system, on ${eventName}` };
}

/**
 * Resolves the orders a project's completion touches.
 *
 * A project can carry several tickets from one order, and §2 of module 04 allows several tickets to
 * roll up to one project — so this de-duplicates rather than assuming one.
 */
async function ordersForProject(projectId: string): Promise<string[]> {
  const tickets = await db.ticket.findMany({
    where: { projectId, deletedAt: null, salesOrderId: { not: null } },
    select: { salesOrderId: true },
  });
  return [...new Set(tickets.map((ticket) => ticket.salesOrderId!).filter(Boolean))];
}

async function orderForTicket(ticketId: string): Promise<string[]> {
  const ticket = await db.ticket.findFirst({
    where: { id: ticketId, deletedAt: null },
    select: { salesOrderId: true },
  });
  return ticket?.salesOrderId ? [ticket.salesOrderId] : [];
}

/**
 * `project.closed` — bills `on_project_close` and starts the clock on `net_days_after_close`.
 */
export async function onProjectClosed(payload: {
  projectId?: string;
  projectCode?: string;
}): Promise<void> {
  if (!payload.projectId) return;
  const salesOrderIds = await ordersForProject(payload.projectId);
  await applyTriggerToOrdersService(systemActor("project.closed"), {
    salesOrderIds,
    eventName: "project.closed",
    reason: `project ${payload.projectCode ?? payload.projectId} closed`,
  });
}

/**
 * `tc.completed` — bills `on_tc_accepted`, **only when the customer accepted it**.
 *
 * §2 is explicit: "with result accepted". A commissioning that failed, or that was accepted with a
 * punch list somebody is still arguing about, is not a billing event — and §10 of module 04 already
 * distinguishes the results. Billing on any `tc.completed` would invoice on a certificate that says
 * the equipment did not pass, which is the fastest possible way to lose a collections argument.
 */
export async function onTcCompleted(payload: {
  ticketId?: string;
  number?: string;
  result?: string;
}): Promise<void> {
  if (!payload.ticketId) return;
  if (payload.result !== "accepted") return;

  const salesOrderIds = await orderForTicket(payload.ticketId);
  await applyTriggerToOrdersService(systemActor("tc.completed"), {
    salesOrderIds,
    eventName: "tc.completed",
    reason: `the customer accepted commissioning${payload.number ? ` on ${payload.number}` : ""}`,
  });
}

/** `delivery.dr_signed` — bills `on_dr_signed`. The signature, not the despatch. */
export async function onDeliveryReceiptSigned(payload: {
  salesOrderId?: string;
  number?: string;
  recipientName?: string;
}): Promise<void> {
  if (!payload.salesOrderId) return;
  await applyTriggerToOrdersService(systemActor("delivery.dr_signed"), {
    salesOrderIds: [payload.salesOrderId],
    eventName: "delivery.dr_signed",
    reason:
      `${payload.recipientName ?? "somebody at the customer"} signed for the goods` +
      `${payload.number ? ` on ${payload.number}` : ""}`,
  });
}

/** `sales_order.goods_delivered` — bills `on_delivery`, once every non-execution line has moved. */
export async function onGoodsDelivered(payload: {
  salesOrderId?: string;
  salesOrderNumber?: string;
}): Promise<void> {
  if (!payload.salesOrderId) return;
  await applyTriggerToOrdersService(systemActor("sales_order.goods_delivered"), {
    salesOrderIds: [payload.salesOrderId],
    eventName: "sales_order.goods_delivered",
    reason: `every deliverable line on ${payload.salesOrderNumber ?? "the order"} was delivered`,
  });
}

/**
 * `qa.passed` — bills `on_installation`.
 *
 * The customer's acceptance, not ours. See BILLING_TRIGGERS for the three answers this question had
 * and why this is the one that stands: a service report is AIES describing its own work, a QA
 * approval carries the customer's inspector and their evidence.
 */
export async function onQaPassed(payload: {
  ticketId?: string;
  qaApprovalId?: string;
  number?: string;
}): Promise<void> {
  if (!payload.ticketId) return;
  const salesOrderIds = await orderForTicket(payload.ticketId);
  await applyTriggerToOrdersService(systemActor("qa.passed"), {
    salesOrderIds,
    eventName: "qa.passed",
    reason: `the customer accepted the work at QA${payload.number ? ` (${payload.number})` : ""}`,
  });
}

/**
 * `supplier_po.sent` — bills `on_supplier_order`.
 *
 * The term for orders where AIES has to commit money to a principal before anything ships: the
 * milestone bills when the commitment is made, not when the goods arrive.
 */
export async function onSupplierPoSent(payload: {
  salesOrderId?: string | null;
  number?: string;
}): Promise<void> {
  if (!payload.salesOrderId) return;
  await applyTriggerToOrdersService(systemActor("supplier_po.sent"), {
    salesOrderIds: [payload.salesOrderId],
    eventName: "supplier_po.sent",
    reason: `supplier order ${payload.number ?? ""}`.trim() + " went out",
  });
}
