import { TRPCError } from "@trpc/server";
import { db } from "@/lib/db";
import { writeAuditLog } from "@/server/core/audit/audit";
import type { ActorMeta } from "@/server/core/crm/account-service";
import { statementStatusFor } from "./invoice-rules";
import {
  REMINDER_OFFSETS_DAYS,
  collectionPriority,
  daysOverdue,
  suggestChase,
  type CollectionActivityType,
  type CollectionOutcome,
} from "./collection-rules";

/**
 * specs/05-finance-billing.md §5 — the collection worklist, the log, and the reminder sweep.
 *
 * ## What makes this different from the ageing report
 *
 * Ageing is a picture of the debt. This is a queue of work: what to chase first, what was said last
 * time, and what somebody promised. The distinction matters because an ageing report is read once a
 * month by a manager, and a worklist is read every morning by whoever is making the calls.
 */

export const COLLECTION_ACTIVITY_ENTITY_TYPE = "CollectionActivity";

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

  const [accounts, activities] = await Promise.all([
    db.customerAccount.findMany({
      where: { id: { in: statements.map((statement) => statement.accountId) } },
      select: {
        id: true,
        name: true,
        ownerId: true,
        collectionRemindersEnabled: true,
        collectionRemindersOffReason: true,
      },
    }),
    db.collectionActivity.findMany({
      where: { statementId: { in: statementIds }, deletedAt: null },
      orderBy: { contactedAt: "desc" },
    }),
  ]);

  const accountById = new Map(accounts.map((account) => [account.id, account]));

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

    return {
      id: statement.id,
      number: statement.number,
      accountId: statement.accountId,
      accountName: account?.name ?? null,
      ownerId: account?.ownerId ?? null,
      remindersEnabled: account?.collectionRemindersEnabled ?? true,
      remindersOffReason: account?.collectionRemindersOffReason ?? null,
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
 * Switches reminders off for an account, or back on.
 *
 * §5: "an off switch per account — some customers must be handled by phone only." The reason is
 * required when switching off, because a switch nobody can explain is one nobody dares turn back on,
 * and the account then never gets chased again by anybody.
 */
export async function setRemindersEnabledService(
  actor: ActorMeta,
  input: { accountId: string; enabled: boolean; reason?: string | null },
) {
  if (!input.enabled && (input.reason?.trim().length ?? 0) < 5) {
    throw new TRPCError({
      code: "BAD_REQUEST",
      message:
        "Say why this customer should not be reminded automatically — otherwise nobody will know " +
        "whether it is safe to turn back on.",
    });
  }

  const account = await db.customerAccount.findFirst({
    where: { id: input.accountId, deletedAt: null },
    select: { id: true, name: true },
  });
  if (!account) {
    throw new TRPCError({ code: "NOT_FOUND", message: "That account no longer exists." });
  }

  await db.$transaction(async (tx) => {
    await tx.customerAccount.update({
      where: { id: account.id },
      data: {
        collectionRemindersEnabled: input.enabled,
        collectionRemindersOffReason: input.enabled ? null : (input.reason?.trim() ?? null),
      },
    });
    await writeAuditLog(tx, {
      actorId: actor.actorId,
      actorLabel: actor.actorLabel,
      action: input.enabled ? "reminders_enabled" : "reminders_disabled",
      entityType: "CustomerAccount",
      entityId: account.id,
      summary: input.enabled
        ? `Automatic reminders back on for ${account.name}`
        : `Automatic reminders off for ${account.name} — ${input.reason?.trim()}`,
      ip: actor.ip,
      userAgent: actor.userAgent,
      requestId: actor.requestId,
    });
  });

  return { enabled: input.enabled };
}

export interface ReminderSweepResult {
  scheduled: number;
  due: { id: string; statementId: string; statementNumber: string; offsetDays: number }[];
  suppressed: number;
}

/**
 * The nightly reminder sweep.
 *
 * ## What it does and deliberately does not do
 *
 * It decides *which reminders are due*, records that decision, and returns them. It does **not**
 * send anything: module 10 owns outbound email, and §8 of that spec owns the transport. Recording
 * the decision here is what makes the sweep idempotent — a reminder row exists for a given statement
 * and offset or it does not, so running the sweep twice in one night sends nothing twice.
 *
 * Without that row, a nightly job would find the +7 reminder due every night from day seven onwards,
 * and a customer receiving the same demand daily stops reading any of them — which costs more than
 * never having chased at all.
 *
 * ## Suppression is recorded rather than skipped
 *
 * A statement paid between scheduling and sending, or an account with reminders switched off, gets a
 * row marked suppressed with a reason. "We did not chase them, and here is why" is a different fact
 * from "nobody looked", and only one of them is defensible when somebody asks why a debt sat for
 * three months.
 */
export async function sweepCollectionRemindersService(
  now: Date = new Date(),
): Promise<ReminderSweepResult> {
  const horizon = new Date(now);
  horizon.setUTCDate(horizon.getUTCDate() + 3);

  const statements = await db.billingStatement.findMany({
    where: {
      deletedAt: null,
      status: { in: ["issued", "partially_paid", "overdue"] },
      balance: { gt: 0 },
      dueDate: { lte: horizon },
    },
    select: { id: true, number: true, accountId: true, dueDate: true, balance: true, status: true },
    take: 500,
  });

  if (statements.length === 0) return { scheduled: 0, due: [], suppressed: 0 };

  const accounts = await db.customerAccount.findMany({
    where: { id: { in: statements.map((statement) => statement.accountId) } },
    select: { id: true, collectionRemindersEnabled: true },
  });
  const enabledById = new Map(
    accounts.map((account) => [account.id, account.collectionRemindersEnabled]),
  );

  const existing = await db.collectionReminder.findMany({
    where: { statementId: { in: statements.map((statement) => statement.id) } },
    select: { statementId: true, offsetDays: true },
  });
  const already = new Set(existing.map((row) => `${row.statementId}:${row.offsetDays}`));

  const due: ReminderSweepResult["due"] = [];
  let scheduled = 0;
  let suppressed = 0;

  for (const statement of statements) {
    const dueTime = new Date(statement.dueDate).getTime();

    for (const offset of REMINDER_OFFSETS_DAYS) {
      const when = new Date(dueTime + offset * 24 * 60 * 60 * 1000);
      // Not yet time for this one.
      if (when.getTime() > now.getTime()) continue;
      if (already.has(`${statement.id}:${offset}`)) continue;

      const remindersOn = enabledById.get(statement.accountId) ?? true;

      const row = await db.collectionReminder.create({
        data: {
          statementId: statement.id,
          accountId: statement.accountId,
          offsetDays: offset,
          scheduledFor: when,
          ...(remindersOn
            ? {}
            : {
                suppressedAt: now,
                suppressedReason: "Automatic reminders are switched off for this customer.",
              }),
        },
      });

      if (remindersOn) {
        scheduled += 1;
        due.push({
          id: row.id,
          statementId: statement.id,
          statementNumber: statement.number,
          offsetDays: offset,
        });
      } else {
        suppressed += 1;
      }
    }
  }

  return { scheduled, due, suppressed };
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
