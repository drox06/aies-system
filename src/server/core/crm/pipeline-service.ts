import type { Prisma } from "@prisma/client";
import { db } from "@/lib/db";
import { lastContactByAccount } from "@/server/core/crm/activity-service";
import { assessInquirySla, TERMINAL_STATUSES } from "@/server/core/crm/inquiry-lifecycle";
import { inquiryScopeWhere } from "@/server/core/crm/inquiry-service";
import { notify } from "@/server/core/notify/notify";
import { registerNotificationType } from "@/server/core/notify/registry";
import { STALE_ACCOUNT_DAYS } from "@/server/core/crm/pipeline-rules";

/**
 * The pipeline views (specs/01-crm-inquiry.md §6).
 *
 * §1 says what these are for, and it is worth quoting because it rules out most of what a CRM
 * usually does here: "A salesperson's real question is 'who haven't I talked to in 60 days, and
 * what's stuck?' Design for that question." So there is no lead scoring, no forecast weighting and
 * no probability field — just the two lists that answer it.
 */

export const FOLLOW_UP_NOTIFICATION_TYPE = "crm.follow_up_due";

registerNotificationType({
  key: FOLLOW_UP_NOTIFICATION_TYPE,
  label: "Follow-ups are due today",
  // In-app only for now, like the rest of module 01 — `notify_email` has no handler
  // (docs/DECISIONS.md #10). §6 asks for "a daily job emails each salesperson their list", so this
  // is the one notification in the module the spec explicitly wants on email; turn the channel on
  // in the same change that wires a provider. One notification per person per day, not per record,
  // which is what makes it an email-shaped thing rather than a stream of interruptions.
  defaultChannels: { inApp: true, email: false, digest: false },
});

// Defined in the pure file so the UI can read it too; re-exported so existing callers of this
// service need no second import.
export { STALE_ACCOUNT_DAYS };

const DAY_MS = 86_400_000;

// ---- kanban -------------------------------------------------------------------------------------

/**
 * Every live inquiry, grouped by status.
 *
 * Not paginated, deliberately. A kanban that pages is not a kanban — the whole point is seeing the
 * board at once — and Spec.md §10's budget is "any list view < 800 ms at 50k rows", which a
 * five-person company's open pipeline will not approach. The `take` is a guard against that being
 * wrong rather than a feature: if it ever trips, the board says so instead of quietly truncating.
 */
export const PIPELINE_LIMIT = 500;

export async function getPipelineService(user: { id: string; permissions: ReadonlySet<string> }) {
  const where: Prisma.InquiryWhereInput = {
    deletedAt: null,
    ...inquiryScopeWhere(user),
    // Won, lost and disqualified leave the board. They are history, and a column of them grows
    // forever while telling a salesperson nothing about what to do next.
    status: { notIn: [...TERMINAL_STATUSES] },
  };

  const [rows, total] = await Promise.all([
    db.inquiry.findMany({
      where,
      orderBy: { receivedAt: "asc" },
      take: PIPELINE_LIMIT,
      select: {
        id: true,
        number: true,
        subject: true,
        status: true,
        receivedAt: true,
        acknowledgedAt: true,
        slaPausedAt: true,
        slaPausedMs: true,
        estimatedValue: true,
        currency: true,
        ownerId: true,
        nextFollowUpAt: true,
        account: { select: { id: true, code: true, name: true } },
      },
    }),
    db.inquiry.count({ where }),
  ]);

  const owners = await resolveOwnerLabels(rows.map((row) => row.ownerId));
  const now = new Date();

  return {
    truncated: total > PIPELINE_LIMIT,
    total,
    cards: rows.map((row) => ({
      ...row,
      estimatedValue: row.estimatedValue?.toString() ?? null,
      ownerLabel: owners.get(row.ownerId) ?? row.ownerId,
      // §6: the card shows "age" — days since it arrived, which is the number that makes a stale
      // card look stale without anybody computing it.
      ageDays: Math.floor((now.getTime() - row.receivedAt.getTime()) / DAY_MS),
      sla: assessInquirySla(row, now),
    })),
  };
}

/** Owner ids are plain strings (the decoupled-from-User convention), so names resolve on read. */
async function resolveOwnerLabels(ids: string[]): Promise<Map<string, string>> {
  const unique = [...new Set(ids)];
  if (unique.length === 0) return new Map();
  const users = await db.user.findMany({
    where: { id: { in: unique } },
    select: { id: true, name: true },
  });
  return new Map(users.map((u) => [u.id, u.name]));
}

// ---- My Day -------------------------------------------------------------------------------------

export interface MyDayResult {
  overdueFollowUps: PipelineCard[];
  awaitingMyAction: PipelineCard[];
  needsNextStep: PipelineCard[];
  staleAccounts: { id: string; code: string; name: string; lastContactAt: Date | null }[];
}

interface PipelineCard {
  id: string;
  number: string;
  subject: string;
  status: string;
  nextFollowUpAt: Date | null;
  accountName: string | null;
  ageDays: number;
  slaBreached: boolean;
}

/**
 * §6's My Day: "overdue follow-ups, inquiries awaiting my action, quotes expiring this week,
 * accounts not contacted in N days."
 *
 * Three of the four. Quotes belong to module 02 and do not exist; the section is added there rather
 * than stubbed here, because an empty "Quotes expiring" panel on every screen teaches people to
 * ignore that part of the page.
 *
 * Always scoped to the caller regardless of `crm.view_all` — this is *my* day. A president with
 * global visibility opening My Day wants their own work, not all five people's.
 */
export async function getMyDayService(user: { id: string }): Promise<MyDayResult> {
  const now = new Date();
  const live = {
    deletedAt: null,
    ownerId: user.id,
    status: { notIn: [...TERMINAL_STATUSES] },
  } satisfies Prisma.InquiryWhereInput;

  const select = {
    id: true,
    number: true,
    subject: true,
    status: true,
    receivedAt: true,
    acknowledgedAt: true,
    slaPausedAt: true,
    slaPausedMs: true,
    nextFollowUpAt: true,
    account: { select: { name: true } },
  } satisfies Prisma.InquirySelect;

  const [overdue, awaiting, missingNextStep] = await Promise.all([
    db.inquiry.findMany({
      where: { ...live, nextFollowUpAt: { not: null, lte: now } },
      orderBy: { nextFollowUpAt: "asc" },
      select,
    }),
    // "Awaiting my action" is the states where the ball is with the owner. `quoting` and `quoted`
    // are waiting on module 02 and on the customer respectively, so they are not my action.
    db.inquiry.findMany({
      where: { ...live, status: { in: ["new", "acknowledged", "evaluating"] } },
      orderBy: { receivedAt: "asc" },
      select,
    }),
    // §6: "Nothing is allowed to sit with no next step — a record with no `nextFollowUpAt` and
    // status not terminal appears in a 'Needs a next step' list."
    db.inquiry.findMany({
      where: { ...live, nextFollowUpAt: null },
      orderBy: { receivedAt: "asc" },
      select,
    }),
  ]);

  const toCard = (row: (typeof overdue)[number]): PipelineCard => ({
    id: row.id,
    number: row.number,
    subject: row.subject,
    status: row.status,
    nextFollowUpAt: row.nextFollowUpAt,
    accountName: row.account?.name ?? null,
    ageDays: Math.floor((now.getTime() - row.receivedAt.getTime()) / DAY_MS),
    slaBreached: assessInquirySla(row, now).breached,
  });

  return {
    overdueFollowUps: overdue.map(toCard),
    awaitingMyAction: awaiting.map(toCard),
    needsNextStep: missingNextStep.map(toCard),
    staleAccounts: await findStaleAccounts(user.id, now),
  };
}

/**
 * §6's "accounts not contacted in N days", and §1's headline question.
 *
 * "Not contacted" reads the `Activity` log, not `updatedAt`: editing a customer's address is not
 * talking to them, and a CRM that counts it as contact is the kind that tells you everything is
 * fine right up until a customer goes elsewhere.
 *
 * An account with no logged activity at all counts as stale from its creation date — otherwise the
 * accounts nobody has ever called would be the only ones the list never mentions.
 */
export async function findStaleAccounts(ownerId: string, now: Date = new Date()) {
  const cutoff = new Date(now.getTime() - STALE_ACCOUNT_DAYS * DAY_MS);

  const accounts = await db.customerAccount.findMany({
    where: { deletedAt: null, ownerId, status: "active", createdAt: { lte: cutoff } },
    select: { id: true, code: true, name: true, createdAt: true },
  });
  if (accounts.length === 0) return [];

  const lastContact = await lastContactByAccount(accounts.map((a) => a.id));

  return accounts
    .map((account) => ({
      id: account.id,
      code: account.code,
      name: account.name,
      lastContactAt: lastContact.get(account.id) ?? null,
    }))
    .filter((row) => row.lastContactAt === null || row.lastContactAt < cutoff)
    .sort((a, b) => (a.lastContactAt?.getTime() ?? 0) - (b.lastContactAt?.getTime() ?? 0));
}

// ---- the follow-up sweep ------------------------------------------------------------------------

export interface FollowUpSweepResult {
  notified: { ownerId: string; dueCount: number; needsNextStepCount: number }[];
  scanned: number;
}

/**
 * §6's follow-up engine: "A daily job emails each salesperson their list."
 *
 * One notification per owner, not one per inquiry. A person with eleven overdue follow-ups needs
 * one prompt to open My Day, not eleven badges — and the per-record detail is on that screen,
 * already sorted. This is also what makes the notification email-shaped for the day a provider is
 * wired up.
 *
 * Owners with nothing due get nothing. A daily "you have 0 follow-ups" is how a notification
 * channel becomes something people mute.
 */
export async function sweepFollowUps(now: Date = new Date()): Promise<FollowUpSweepResult> {
  const live = {
    deletedAt: null,
    status: { notIn: [...TERMINAL_STATUSES] },
  } satisfies Prisma.InquiryWhereInput;

  const [due, missing] = await Promise.all([
    db.inquiry.groupBy({
      by: ["ownerId"],
      where: { ...live, nextFollowUpAt: { not: null, lte: now } },
      _count: { _all: true },
    }),
    db.inquiry.groupBy({
      by: ["ownerId"],
      where: { ...live, nextFollowUpAt: null },
      _count: { _all: true },
    }),
  ]);

  const byOwner = new Map<string, { due: number; missing: number }>();
  for (const row of due) {
    byOwner.set(row.ownerId, { due: row._count._all, missing: 0 });
  }
  for (const row of missing) {
    const entry = byOwner.get(row.ownerId) ?? { due: 0, missing: 0 };
    entry.missing = row._count._all;
    byOwner.set(row.ownerId, entry);
  }

  const notified: FollowUpSweepResult["notified"] = [];

  for (const [ownerId, counts] of byOwner) {
    if (counts.due === 0 && counts.missing === 0) continue;

    const parts: string[] = [];
    if (counts.due > 0) parts.push(`${counts.due} follow-up(s) due`);
    if (counts.missing > 0) parts.push(`${counts.missing} with no next step`);

    await notify({
      recipientId: ownerId,
      type: FOLLOW_UP_NOTIFICATION_TYPE,
      title: `Your CRM day: ${parts.join(", ")}`,
      body: "Open My Day to work through them.",
      // Points at the person's own list rather than a record, because that is where the work is.
      entityType: "MyDay",
      entityId: ownerId,
    });

    notified.push({
      ownerId,
      dueCount: counts.due,
      needsNextStepCount: counts.missing,
    });
  }

  return { notified, scanned: byOwner.size };
}
