import { TRPCError } from "@trpc/server";
import { db } from "@/lib/db";
import { writeAuditLog } from "@/server/core/audit/audit";
import type { ActorMeta } from "@/server/core/crm/account-service";
import { notify } from "@/server/core/notify/notify";
import { registerNotificationType } from "@/server/core/notify/registry";
import { statementStatusFor } from "./invoice-rules";
import {
  advanceDunningCycle,
  collectionPriority,
  daysOverdue,
  suggestChase,
  type CollectionActivityType,
  type CollectionCycleState,
  type CollectionOutcome,
} from "./collection-rules";

/**
 * specs/05-finance-billing.md §5 — the collection worklist, the log, and docs/DECISIONS.md #188's
 * dunning cycle.
 *
 * ## What makes the worklist different from the ageing report
 *
 * Ageing is a picture of the debt. The worklist is a queue of work: what to chase first, what was
 * said last time, and what somebody promised. The distinction matters because an ageing report is
 * read once a month by a manager, and a worklist is read every morning by whoever is making the
 * calls.
 *
 * ## What makes the dunning cycle different from the worklist
 *
 * The worklist is a person deciding what to do. The cycle is the platform doing the one thing a
 * person should never have to remember to do themselves: notice a statement has gone quiet and say
 * so, on a schedule, without fail, for as long as it takes. Neither replaces the other — see
 * `advanceDunningCycle` in collection-rules.ts for the schedule itself, in EA's own words.
 */

export const COLLECTION_ACTIVITY_ENTITY_TYPE = "CollectionActivity";
export const COLLECTION_CYCLE_ENTITY_TYPE = "CollectionCycle";

export const COLLECTIONS_MATURED_NOTIFICATION_TYPE = "collections.matured";
export const COLLECTIONS_WEEKLY_NOTIFICATION_TYPE = "collections.weekly_reminder";
export const COLLECTIONS_TIMELINE_NEEDED_NOTIFICATION_TYPE = "collections.timeline_needed";
export const COLLECTIONS_TIMELINE_MISSED_NOTIFICATION_TYPE = "collections.timeline_missed";

registerNotificationType({
  key: COLLECTIONS_MATURED_NOTIFICATION_TYPE,
  label: "A statement has reached its due date",
  defaultChannels: { inApp: true, email: false, digest: true },
});
registerNotificationType({
  key: COLLECTIONS_WEEKLY_NOTIFICATION_TYPE,
  label: "A weekly overdue reminder",
  defaultChannels: { inApp: true, email: false, digest: true },
});
registerNotificationType({
  key: COLLECTIONS_TIMELINE_NEEDED_NOTIFICATION_TYPE,
  // Not a digest item — a prompt that only shows up in tomorrow's summary is a prompt nobody
  // answers today, and the whole point of the daily escalation below is that it does not wait.
  label: "A customer needs a payment timeline",
  defaultChannels: { inApp: true, email: false, digest: false },
});
registerNotificationType({
  key: COLLECTIONS_TIMELINE_MISSED_NOTIFICATION_TYPE,
  label: "A promised payment date passed unpaid",
  defaultChannels: { inApp: true, email: false, digest: false },
});

const pesos = (centavos: number) =>
  `₱${(centavos / 100).toLocaleString("en-PH", { minimumFractionDigits: 2 })}`;

/**
 * Finance alone — the audience for the maturity notice and the ordinary weekly reminders. The same
 * permission `billing_schedule.manage` already gates planning and releasing a billing schedule: this
 * is the same job, reading the schedule's other end.
 */
async function financeRecipients(): Promise<string[]> {
  const users = await db.user.findMany({
    where: {
      isActive: true,
      deletedAt: null,
      roles: {
        some: {
          role: { permissions: { some: { permission: { key: "billing_schedule.manage" } } } },
        },
      },
    },
    select: { id: true },
  });
  return users.map((user) => user.id);
}

/**
 * Finance plus admin — EA's own escalation: "which is filled by admin," and the every-cycle "notif is
 * sent to finance and admin." `ar.view` already includes `admin_manager` alongside finance
 * (docs/DECISIONS.md #151 put PD there by name), so widening from `financeRecipients` to this one
 * permission key *is* the escalation, not a second list to keep in step with the first.
 */
async function financeAndAdminRecipients(): Promise<string[]> {
  const users = await db.user.findMany({
    where: {
      isActive: true,
      deletedAt: null,
      roles: { some: { role: { permissions: { some: { permission: { key: "ar.view" } } } } } },
    },
    select: { id: true },
  });
  return users.map((user) => user.id);
}

/** Independent writes, one per recipient — no reason for a sweep processing several statements a
 *  night, each with its own small audience, to serialise what does not depend on itself. */
async function notifyCollections(
  recipientIds: string[],
  type: string,
  title: string,
  body: string,
) {
  await Promise.all(recipientIds.map((recipientId) => notify({ recipientId, type, title, body })));
}

/**
 * §5's worklist: overdue statements by amount × days overdue, with the last contact and the promise.
 *
 * Every row carries a **suggested next move with its reason**, because the ranking answers "what
 * first" and not "what now" — and a person opening this at nine in the morning needs both.
 */
export async function collectionWorklistService(filter: { accountId?: string } = {}) {
  const now = new Date();

  const statements = await db.billingStatement.findMany({
    where: {
      deletedAt: null,
      balance: { gt: 0 },
      status: { in: ["issued", "partially_paid", "overdue"] },
      dueDate: { lt: now },
      ...(filter.accountId ? { accountId: filter.accountId } : {}),
    },
    take: 300,
  });

  if (statements.length === 0) return [];

  const statementIds = statements.map((statement) => statement.id);

  const [accounts, activities, cycles] = await Promise.all([
    db.customerAccount.findMany({
      where: { id: { in: statements.map((statement) => statement.accountId) } },
      select: { id: true, name: true, ownerId: true },
    }),
    db.collectionActivity.findMany({
      where: { statementId: { in: statementIds }, deletedAt: null },
      orderBy: { contactedAt: "desc" },
    }),
    db.collectionCycle.findMany({ where: { statementId: { in: statementIds } } }),
  ]);

  const accountById = new Map(accounts.map((account) => [account.id, account]));
  const cycleByStatement = new Map(cycles.map((cycle) => [cycle.statementId, cycle]));

  // The most recent contact per statement, and the promise that is still live.
  const lastByStatement = new Map<string, (typeof activities)[number]>();
  const promiseByStatement = new Map<string, Date>();
  for (const activity of activities) {
    if (!lastByStatement.has(activity.statementId)) {
      lastByStatement.set(activity.statementId, activity);
    }
    if (activity.promisedDate && !promiseByStatement.has(activity.statementId)) {
      promiseByStatement.set(activity.statementId, activity.promisedDate);
    }
  }

  const rows = statements.map((statement) => {
    const last = lastByStatement.get(statement.id);
    const promisedDate = promiseByStatement.get(statement.id) ?? null;
    const account = accountById.get(statement.accountId);
    const cycle = cycleByStatement.get(statement.id);

    return {
      id: statement.id,
      number: statement.number,
      accountId: statement.accountId,
      accountName: account?.name ?? null,
      ownerId: account?.ownerId ?? null,
      dueDate: statement.dueDate,
      daysOverdue: daysOverdue(statement.dueDate, now),
      balance: statement.balance,
      expectedNetCollectible: statement.expectedNetCollectible,
      priority: collectionPriority(statement, now),
      lastContactAt: last?.contactedAt ?? null,
      lastContactType: last?.type ?? null,
      lastContactNotes: last?.notes ?? null,
      lastOutcome: last?.outcome ?? null,
      promisedDate,
      suggestion: suggestChase({
        balance: statement.balance,
        dueDate: statement.dueDate,
        lastContactAt: last?.contactedAt ?? null,
        promisedDate,
        now,
      }),
      // docs/DECISIONS.md #188's automatic cycle, alongside the human worklist above — the two run
      // side by side rather than one replacing the other.
      cycle: cycle
        ? {
            state: cycle.state,
            weeklyNotifiedCount: cycle.weeklyNotifiedCount,
            timelinePromptOpenedAt: cycle.timelinePromptOpenedAt,
            expectedPaymentDate: cycle.expectedPaymentDate,
            missedDateCount: cycle.missedDateCount,
            needsTimeline: cycle.state === "awaiting_timeline" && !cycle.expectedPaymentDate,
          }
        : null,
    };
  });

  // Highest peso-days first — see collectionPriority for why the product rather than either alone.
  return rows.sort((a, b) => b.priority - a.priority);
}

/**
 * §5's "one-click log follow-up".
 *
 * The notes are required. A contact record saying only "called" is worth almost nothing three weeks
 * later when somebody else picks up the account — what was said is the whole value of the log, and
 * making it optional is how a log becomes a list of timestamps.
 */
export async function logCollectionActivityService(
  actor: ActorMeta,
  input: {
    statementId: string;
    type: CollectionActivityType;
    notes: string;
    contactId?: string | null;
    contactName?: string | null;
    promisedDate?: Date | null;
    outcome?: CollectionOutcome | null;
    contactedAt?: Date;
  },
) {
  if (input.notes.trim().length < 3) {
    throw new TRPCError({
      code: "BAD_REQUEST",
      message:
        "Say what was said. A contact record with no notes is a timestamp, and the next person to " +
        "pick this up needs more than that.",
    });
  }

  const statement = await db.billingStatement.findFirst({
    where: { id: input.statementId, deletedAt: null },
    select: { id: true, number: true, accountId: true },
  });
  if (!statement) {
    throw new TRPCError({ code: "NOT_FOUND", message: "That statement no longer exists." });
  }

  const activity = await db.$transaction(async (tx) => {
    const created = await tx.collectionActivity.create({
      data: {
        statementId: statement.id,
        accountId: statement.accountId,
        type: input.type,
        contactedAt: input.contactedAt ?? new Date(),
        contactId: input.contactId ?? null,
        contactName: input.contactName ?? null,
        notes: input.notes.trim(),
        promisedDate: input.promisedDate ?? null,
        outcome: input.outcome ?? null,
        byId: actor.actorId,
      },
    });

    await writeAuditLog(tx, {
      actorId: actor.actorId,
      actorLabel: actor.actorLabel,
      action: "collection_contact",
      entityType: COLLECTION_ACTIVITY_ENTITY_TYPE,
      entityId: created.id,
      summary:
        `${input.type.replace(/_/g, " ")} on ${statement.number}` +
        (input.promisedDate ? ` — promised ${input.promisedDate.toISOString().slice(0, 10)}` : "") +
        `: ${input.notes.trim()}`,
      ip: actor.ip,
      userAgent: actor.userAgent,
      requestId: actor.requestId,
    });

    return created;
  });

  return { id: activity.id };
}

/** Everything anybody has done about one statement, newest first. */
export async function collectionHistoryService(statementId: string) {
  const activities = await db.collectionActivity.findMany({
    where: { statementId, deletedAt: null },
    orderBy: { contactedAt: "desc" },
    take: 100,
  });

  const users = await db.user.findMany({
    where: { id: { in: activities.map((activity) => activity.byId) } },
    select: { id: true, name: true },
  });
  const byId = new Map(users.map((user) => [user.id, user.name]));

  return activities.map((activity) => ({
    id: activity.id,
    type: activity.type,
    contactedAt: activity.contactedAt,
    contactName: activity.contactName,
    notes: activity.notes,
    promisedDate: activity.promisedDate,
    outcome: activity.outcome,
    by: byId.get(activity.byId) ?? "Somebody",
  }));
}

/**
 * Answers docs/DECISIONS.md #188's prompt: "when is payment expected?"
 *
 * Refused unless the cycle is actually asking — the same exchange-direction discipline #185 built for
 * "are we ready to bill this?": a date offered when nothing is waiting on one is not an answer to
 * anything, and letting it through would make the cycle's own record disagree with what actually
 * happened. Refused again if a date is already on file, for the same reason — the next one only
 * arrives through `record_missed_date_and_reopen`, once this one has had its chance and passed.
 */
export async function setExpectedPaymentDateService(
  actor: ActorMeta,
  input: { statementId: string; expectedDate: Date; notes?: string | null },
) {
  const cycle = await db.collectionCycle.findUnique({ where: { statementId: input.statementId } });
  if (!cycle || cycle.state !== "awaiting_timeline") {
    throw new TRPCError({
      code: "BAD_REQUEST",
      message: "This statement is not currently waiting on a payment date.",
    });
  }
  if (cycle.expectedPaymentDate) {
    throw new TRPCError({
      code: "BAD_REQUEST",
      message:
        "A date is already on file for this round — it will be asked again if that one passes unpaid.",
    });
  }
  const today = new Date();
  today.setUTCHours(0, 0, 0, 0);
  if (input.expectedDate.getTime() < today.getTime()) {
    throw new TRPCError({
      code: "BAD_REQUEST",
      message: "Give a date that has not already passed.",
    });
  }

  const statement = await db.billingStatement.findFirst({
    where: { id: input.statementId, deletedAt: null },
    select: { number: true },
  });

  await db.$transaction(async (tx) => {
    await tx.collectionCycle.update({
      where: { id: cycle.id },
      data: {
        expectedPaymentDate: input.expectedDate,
        expectedPaymentSetAt: new Date(),
        expectedPaymentSetById: actor.actorId,
      },
    });
    await writeAuditLog(tx, {
      actorId: actor.actorId,
      actorLabel: actor.actorLabel,
      action: "expected_payment_date_set",
      entityType: COLLECTION_CYCLE_ENTITY_TYPE,
      entityId: cycle.id,
      summary:
        `Expected payment on ${statement?.number ?? input.statementId} by ` +
        `${input.expectedDate.toISOString().slice(0, 10)}` +
        (input.notes?.trim() ? ` — ${input.notes.trim()}` : ""),
      ip: actor.ip,
      userAgent: actor.userAgent,
      requestId: actor.requestId,
    });
  });

  return { expectedPaymentDate: input.expectedDate };
}

export interface DunningSweepResult {
  matured: number;
  weekly: number;
  timelineOpened: number;
  timelineEscalated: number;
  timelineMissed: number;
  closed: number;
}

/**
 * The nightly run of docs/DECISIONS.md #188's cycle — one `CollectionCycle` row per overdue
 * statement, advanced by exactly one step each night through `advanceDunningCycle`.
 *
 * A row is created the moment a statement matures (its due date arrives) whether or not one already
 * exists, so the very first sweep after a due date passes both creates the record and sends the
 * maturity notice in the same pass — nobody has to wait a day for the row to "catch up" before
 * anything happens.
 *
 * Replaces the fixed five-offset `CollectionReminder` sweep entirely (docs/DECISIONS.md #188): that
 * one sent five scheduled reminders and stopped, win or lose; this one runs until the balance says
 * otherwise.
 */
export async function sweepDunningCycleService(
  now: Date = new Date(),
): Promise<DunningSweepResult> {
  const result: DunningSweepResult = {
    matured: 0,
    weekly: 0,
    timelineOpened: 0,
    timelineEscalated: 0,
    timelineMissed: 0,
    closed: 0,
  };

  const newlyMatured = await db.billingStatement.findMany({
    where: {
      deletedAt: null,
      status: { in: ["issued", "partially_paid", "overdue"] },
      balance: { gt: 0 },
      dueDate: { lte: now },
    },
    select: { id: true },
  });

  // A statement that was just paid in full drops out of the query above the moment it happens —
  // `status` moves off the three named here and `balance` hits zero in the same write. Without this
  // second half, its `CollectionCycle` would never be read again to close, and the cycle's own "until
  // payment is received" promise would go unkept for exactly the case that matters most.
  const stillOpen = await db.collectionCycle.findMany({
    where: { state: { not: "closed" } },
    select: { statementId: true },
  });

  const statementIds = [
    ...new Set([...newlyMatured.map((s) => s.id), ...stillOpen.map((c) => c.statementId)]),
  ].slice(0, 500);
  if (statementIds.length === 0) return result;

  const [statements, existing] = await Promise.all([
    db.billingStatement.findMany({
      where: { id: { in: statementIds }, deletedAt: null },
      select: { id: true, number: true, accountId: true, dueDate: true, balance: true },
    }),
    db.collectionCycle.findMany({ where: { statementId: { in: statementIds } } }),
  ]);
  const cycleByStatement = new Map(existing.map((cycle) => [cycle.statementId, cycle]));

  for (const statement of statements) {
    let cycle = cycleByStatement.get(statement.id);
    cycle ??= await db.collectionCycle.create({
      data: { statementId: statement.id, accountId: statement.accountId, state: "matured" },
    });
    if (cycle.state === "closed") continue;

    const step = advanceDunningCycle(
      {
        state: cycle.state as CollectionCycleState,
        dueDate: statement.dueDate,
        balance: statement.balance,
        maturedNotifiedAt: cycle.maturedNotifiedAt,
        weeklyNotifiedCount: cycle.weeklyNotifiedCount,
        lastWeeklyNotifiedAt: cycle.lastWeeklyNotifiedAt,
        expectedPaymentDate: cycle.expectedPaymentDate,
        lastEscalationNotifiedAt: cycle.lastEscalationNotifiedAt,
        missedDateCount: cycle.missedDateCount,
      },
      now,
    );

    const amount = pesos(statement.balance);

    switch (step.action) {
      case "close":
        await db.collectionCycle.update({
          where: { id: cycle.id },
          data: { state: "closed", closedAt: now },
        });
        result.closed += 1;
        break;

      case "notify_matured":
        await db.collectionCycle.update({
          where: { id: cycle.id },
          data: { maturedNotifiedAt: now },
        });
        await notifyCollections(
          await financeRecipients(),
          COLLECTIONS_MATURED_NOTIFICATION_TYPE,
          `${statement.number} is now due`,
          `${amount} matured today. Five days of grace before it enters the collections cycle.`,
        );
        result.matured += 1;
        break;

      case "start_dunning_and_notify":
        await db.collectionCycle.update({
          where: { id: cycle.id },
          data: { state: "dunning", weeklyNotifiedCount: 1, lastWeeklyNotifiedAt: now },
        });
        await notifyCollections(
          await financeRecipients(),
          COLLECTIONS_WEEKLY_NOTIFICATION_TYPE,
          `Overdue: ${statement.number}`,
          `${amount}, five days past due with nothing recorded. Weekly reminders start now.`,
        );
        result.weekly += 1;
        break;

      case "send_weekly_notice":
        await db.collectionCycle.update({
          where: { id: cycle.id },
          data: { weeklyNotifiedCount: step.count, lastWeeklyNotifiedAt: now },
        });
        await notifyCollections(
          await financeRecipients(),
          COLLECTIONS_WEEKLY_NOTIFICATION_TYPE,
          `Still overdue: ${statement.number}`,
          `${amount}, still unpaid. Reminder ${step.count}.`,
        );
        result.weekly += 1;
        break;

      case "open_timeline_prompt":
        await db.collectionCycle.update({
          where: { id: cycle.id },
          data: {
            state: "awaiting_timeline",
            weeklyNotifiedCount: { increment: 1 },
            lastWeeklyNotifiedAt: now,
            timelinePromptOpenedAt: now,
            lastEscalationNotifiedAt: now,
          },
        });
        await notifyCollections(
          await financeAndAdminRecipients(),
          COLLECTIONS_TIMELINE_NEEDED_NOTIFICATION_TYPE,
          `Two reminders sent, still unpaid: ${statement.number}`,
          `${amount}. When is this expected? Set a date on the Collections screen.`,
        );
        result.timelineOpened += 1;
        break;

      case "escalate_unfilled_timeline":
        await db.collectionCycle.update({
          where: { id: cycle.id },
          data: { lastEscalationNotifiedAt: now },
        });
        await notifyCollections(
          await financeAndAdminRecipients(),
          COLLECTIONS_TIMELINE_NEEDED_NOTIFICATION_TYPE,
          `Still waiting on a date: ${statement.number}`,
          `${amount}. Nobody has said when this is expected yet.`,
        );
        result.timelineEscalated += 1;
        break;

      case "record_missed_date_and_reopen":
        await db.collectionCycle.update({
          where: { id: cycle.id },
          data: {
            missedDateCount: step.missedCount,
            expectedPaymentDate: null,
            expectedPaymentSetAt: null,
            expectedPaymentSetById: null,
            timelinePromptOpenedAt: now,
            lastEscalationNotifiedAt: null,
          },
        });
        await notifyCollections(
          await financeAndAdminRecipients(),
          COLLECTIONS_TIMELINE_MISSED_NOTIFICATION_TYPE,
          `Promised date passed, still unpaid: ${statement.number}`,
          `${amount}. The expected date has come and gone ` +
            `${step.missedCount} time${step.missedCount === 1 ? "" : "s"} now. A new date is needed.`,
        );
        result.timelineMissed += 1;
        break;

      case "none":
        break;
    }
  }

  return result;
}

/**
 * Marks a statement overdue once its due date passes.
 *
 * Separate from the reminder sweep on purpose: the status is what the ageing report and the worklist
 * both read, and it should be right whether or not anybody is being reminded about anything.
 */
export async function sweepOverdueStatementsService(now: Date = new Date()) {
  const candidates = await db.billingStatement.findMany({
    where: {
      deletedAt: null,
      status: { in: ["issued", "partially_paid"] },
      dueDate: { lt: now },
      balance: { gt: 0 },
    },
    select: { id: true, total: true, amountPaid: true, dueDate: true, status: true },
    take: 500,
  });

  let moved = 0;
  for (const statement of candidates) {
    const next = statementStatusFor({ ...statement, now });
    if (next === statement.status) continue;
    await db.billingStatement.update({
      where: { id: statement.id },
      data: { status: next, version: { increment: 1 } },
    });
    moved += 1;
  }

  return { moved };
}

/**
 * §5's credit limit check, for the screen that raises a sales order.
 *
 * Returns the numbers rather than a verdict the caller has to trust — see `checkCreditLimit` in
 * collection-rules.ts for why this warns rather than blocks.
 */
export async function creditExposureService(input: { accountId: string; newOrderAmount: number }) {
  const account = await db.customerAccount.findFirst({
    where: { id: input.accountId, deletedAt: null },
    select: { id: true, name: true, creditLimit: true },
  });
  if (!account) {
    throw new TRPCError({ code: "NOT_FOUND", message: "That account no longer exists." });
  }

  const open = await db.billingStatement.aggregate({
    where: {
      accountId: account.id,
      deletedAt: null,
      status: { in: ["issued", "partially_paid", "overdue"] },
    },
    _sum: { balance: true },
  });

  const openReceivables = open._sum.balance ?? 0;
  const creditLimit = account.creditLimit ? Math.round(Number(account.creditLimit) * 100) : null;

  const { checkCreditLimit } = await import("./collection-rules");
  return {
    accountName: account.name,
    openReceivables,
    ...checkCreditLimit({
      openReceivables,
      newOrderAmount: input.newOrderAmount,
      creditLimit,
    }),
  };
}
