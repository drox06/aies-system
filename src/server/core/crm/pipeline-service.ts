import type { Prisma } from "@prisma/client";
import { db } from "@/lib/db";
import { writeAuditLog } from "@/server/core/audit/audit";
import { ACCOUNT_ENTITY_TYPE } from "@/server/core/crm/account-service";
import { lastContactByAccount } from "@/server/core/crm/activity-service";
import { assessInquirySla, TERMINAL_STATUSES } from "@/server/core/crm/inquiry-lifecycle";
import { inquiryScopeWhere } from "@/server/core/crm/inquiry-service";
import { notify } from "@/server/core/notify/notify";
import { registerNotificationType } from "@/server/core/notify/registry";
import {
  ACCOUNT_ACTIVITY_KINDS,
  DORMANT_WITHOUT_PO_DAYS,
  QUOTE_SILENCE_FOLLOW_UP_DAYS,
  STALE_ACCOUNT_DAYS,
} from "@/server/core/crm/pipeline-rules";

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

// Defined in the pure file so the UI can read them too; re-exported so existing callers of this
// service need no second import.
export { STALE_ACCOUNT_DAYS, DORMANT_WITHOUT_PO_DAYS, QUOTE_SILENCE_FOLLOW_UP_DAYS };

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
        // The live quotation, for the cards sitting in "Sent". Recording a customer PO has to link
        // it to the quotation it answers, and asking for that per card as the dialog opens would
        // put a round-trip between a person and a document they are holding.
        //
        // Widened past `sent`/`under_negotiation` so the card can show what was actually quoted
        // once the deal moves on — an accepted quotation is still the answer to "how much is this
        // job?", and it is the last thing that answers it before the PO arrives.
        quotations: {
          where: {
            deletedAt: null,
            status: { in: ["sent", "under_negotiation", "accepted"] },
          },
          orderBy: { revision: "desc" },
          take: 1,
          select: {
            id: true,
            number: true,
            revision: true,
            total: true,
            currency: true,
            status: true,
          },
        },
        // What the customer actually ordered. The final word on value, and the reason this query
        // exists at all — see `value` below.
        customerPOs: {
          where: { deletedAt: null },
          orderBy: { receivedAt: "desc" },
          take: 1,
          select: { id: true, poNumber: true, amount: true, currency: true },
        },
      },
    }),
    db.inquiry.count({ where }),
  ]);

  const owners = await resolveOwnerLabels(rows.map((row) => row.ownerId));
  const now = new Date();

  return {
    truncated: total > PIPELINE_LIMIT,
    total,
    cards: rows.map(({ quotations, customerPOs, ...row }) => {
      const quotation = quotations[0] ?? null;
      const po = customerPOs[0] ?? null;

      /**
       * What the card shows for money, and where that figure comes from.
       *
       * The company caught this: a card that reached "Received PO" was still showing the 10,000
       * somebody guessed at intake. `estimatedValue` is exactly that — a guess typed before anyone
       * had costed anything — and it should stop being the answer the moment a better one exists.
       *
       * So the card reports the **best-known** figure and says which it is, rather than silently
       * swapping one number for another: a purchase order beats a quotation, a quotation beats the
       * estimate. The estimate is still what a brand-new inquiry has, which is correct — it is the
       * only number anybody has on the day the phone rings.
       */
      const value = po
        ? { amount: po.amount.toString(), currency: po.currency, basis: "purchase order" as const }
        : quotation
          ? {
              amount: quotation.total.toString(),
              currency: quotation.currency,
              basis: "quoted" as const,
            }
          : {
              amount: row.estimatedValue?.toString() ?? null,
              currency: row.currency,
              basis: "estimate" as const,
            };

      return {
        ...row,
        estimatedValue: row.estimatedValue?.toString() ?? null,
        value,
        liveQuotation: quotation ? { ...quotation, total: quotation.total.toString() } : null,
        customerPo: po ? { ...po, amount: po.amount.toString() } : null,
        ownerLabel: owners.get(row.ownerId) ?? row.ownerId,
        // §6: the card shows "age" — days since it arrived, which is the number that makes a stale
        // card look stale without anybody computing it.
        ageDays: Math.floor((now.getTime() - row.receivedAt.getTime()) / DAY_MS),
        sla: assessInquirySla(row, now),
      };
    }),
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
  staleAccounts: {
    id: string;
    code: string;
    name: string;
    lastContactAt: Date | null;
    lastActivityKind: string | null;
  }[];
  /** Quotations sent to my customers that have gone quiet — the company's seven-day rule. */
  silentQuotations: {
    id: string;
    number: string;
    title: string;
    accountName: string;
    sentAt: Date;
    daysSilent: number;
  }[];
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

  const [staleAccounts, silentQuotations] = await Promise.all([
    findStaleAccounts(user.id, now),
    findSilentQuotations(user.id, now),
  ]);

  return {
    overdueFollowUps: overdue.map(toCard),
    awaitingMyAction: awaiting.map(toCard),
    needsNextStep: missingNextStep.map(toCard),
    staleAccounts,
    silentQuotations,
  };
}

/**
 * Quotations that went out and have heard nothing back.
 *
 * §6 asked for "quotes expiring this week" and module 01 could not provide it, because module 02
 * did not exist. This is the company's version of that section and it is the better question:
 * expiry is the *end* of the silence, and by then the customer has moved on. Seven days is while
 * they still remember the conversation.
 *
 * "Nothing back" is read from the record rather than from anybody remembering to log it — still
 * `sent` (not moved to `under_negotiation`, `accepted` or `rejected`), no negotiation round
 * recorded, no purchase order against it. Any of those three is feedback, whether or not somebody
 * wrote a note about it.
 *
 * Scoped to the caller's own accounts, like everything else on My Day.
 */
export async function findSilentQuotations(ownerId: string, now: Date = new Date()) {
  const cutoff = new Date(now.getTime() - QUOTE_SILENCE_FOLLOW_UP_DAYS * DAY_MS);

  const quotations = await db.quotation.findMany({
    where: {
      deletedAt: null,
      status: "sent",
      sentAt: { not: null, lte: cutoff },
      account: { ownerId, deletedAt: null },
      negotiationRounds: { none: {} },
      customerPOs: { none: { deletedAt: null } },
    },
    orderBy: { sentAt: "asc" },
    select: {
      id: true,
      number: true,
      revision: true,
      title: true,
      sentAt: true,
      account: { select: { name: true } },
    },
  });

  return quotations.map((q) => ({
    id: q.id,
    number: q.revision > 0 ? `${q.number}REV${String(q.revision).padStart(2, "0")}` : q.number,
    title: q.title,
    accountName: q.account.name,
    sentAt: q.sentAt!,
    daysSilent: Math.floor((now.getTime() - q.sentAt!.getTime()) / DAY_MS),
  }));
}

/**
 * The last time anything real happened with each of these customers.
 *
 * Four sources, unioned and reduced to the most recent per account — see ACCOUNT_ACTIVITY_KINDS in
 * pipeline-rules.ts for why it is four rather than the one §6 originally implied. The kind is
 * carried back with the date because "last heard from: 84 days ago" and "last *order*: 84 days ago"
 * are different sentences, and the screen should be able to say which one it means.
 *
 * Four queries rather than one clever union: they hit four different indexes, each is trivially
 * readable, and the largest of them scans a five-person company's order history.
 */
export interface AccountActivity {
  at: Date;
  kind: (typeof ACCOUNT_ACTIVITY_KINDS)[number];
}

export async function lastBusinessActivityByAccount(
  accountIds: string[],
): Promise<Map<string, AccountActivity>> {
  if (accountIds.length === 0) return new Map();

  const [pos, quotations, inquiries, contacts] = await Promise.all([
    db.customerPO.groupBy({
      by: ["accountId"],
      where: { accountId: { in: accountIds }, deletedAt: null },
      _max: { receivedAt: true },
    }),
    db.quotation.groupBy({
      by: ["accountId"],
      where: { accountId: { in: accountIds }, deletedAt: null, sentAt: { not: null } },
      _max: { sentAt: true },
    }),
    db.inquiry.groupBy({
      by: ["accountId"],
      where: { accountId: { in: accountIds }, deletedAt: null },
      _max: { receivedAt: true },
    }),
    lastContactByAccount(accountIds),
  ]);

  const latest = new Map<string, AccountActivity>();
  const consider = (
    accountId: string | null,
    at: Date | null | undefined,
    kind: AccountActivity["kind"],
  ) => {
    if (!accountId || !at) return;
    const current = latest.get(accountId);
    if (!current || at > current.at) latest.set(accountId, { at, kind });
  };

  for (const row of pos) consider(row.accountId, row._max.receivedAt, "purchase order received");
  for (const row of quotations) consider(row.accountId, row._max.sentAt, "quotation sent");
  for (const row of inquiries) consider(row.accountId, row._max.receivedAt, "inquiry received");
  for (const [accountId, at] of contacts) {
    consider(accountId, at, "call, meeting or site visit");
  }

  return latest;
}

/**
 * §6's list, renamed at the company's request from "not contacted" to **"no activity"**.
 *
 * The rename is not cosmetic. "Not contacted" read the `Activity` log alone, so an account that had
 * placed an order last week could appear on a salesperson's chase list because nobody had typed a
 * call into the CRM — which is precisely the kind of false alarm that teaches people to skim past a
 * list. Now a purchase order, a quotation going out and an inquiry arriving all count, and only an
 * account where *none* of those has happened in sixty days appears.
 *
 * An account with no activity at all counts from its creation date — otherwise the customers nobody
 * has ever done anything with would be the only ones the list never mentions.
 */
export async function findStaleAccounts(ownerId: string, now: Date = new Date()) {
  const cutoff = new Date(now.getTime() - STALE_ACCOUNT_DAYS * DAY_MS);

  const accounts = await db.customerAccount.findMany({
    where: { deletedAt: null, ownerId, status: "active", createdAt: { lte: cutoff } },
    select: { id: true, code: true, name: true, createdAt: true },
  });
  if (accounts.length === 0) return [];

  const activity = await lastBusinessActivityByAccount(accounts.map((a) => a.id));

  return accounts
    .map((account) => {
      const last = activity.get(account.id) ?? null;
      return {
        id: account.id,
        code: account.code,
        name: account.name,
        lastContactAt: last?.at ?? null,
        lastActivityKind: last?.kind ?? null,
      };
    })
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

// ---- the seven-day quotation silence sweep -------------------------------------------------------

export const QUOTE_SILENT_NOTIFICATION_TYPE = "crm.quotation_silent";

registerNotificationType({
  key: QUOTE_SILENT_NOTIFICATION_TYPE,
  label: "A sent quotation has had no response",
  defaultChannels: { inApp: true, email: false, digest: false },
});

export interface QuoteSilenceSweepResult {
  notified: { quotationId: string; number: string; daysSilent: number; ownerId: string }[];
  scanned: number;
}

/**
 * Tells the account owner when a quotation has sat unanswered for a week.
 *
 * Fires on day seven and then weekly, the same cadence as the overdue-RFQ sweep and for the same
 * reason: a customer who has not answered in a week will not answer faster for being chased every
 * morning, and a notification that arrives daily is one people turn off.
 *
 * One notification per quotation rather than per owner, unlike `sweepFollowUps`. The difference is
 * that this one names something specific to do — ring this customer about this document — and
 * collapsing three of those into "you have 3 quiet quotations" would throw away the only part that
 * makes it actionable.
 */
export async function sweepSilentQuotations(
  now: Date = new Date(),
): Promise<QuoteSilenceSweepResult> {
  const cutoff = new Date(now.getTime() - QUOTE_SILENCE_FOLLOW_UP_DAYS * DAY_MS);

  const candidates = await db.quotation.findMany({
    where: {
      deletedAt: null,
      status: "sent",
      sentAt: { not: null, lte: cutoff },
      negotiationRounds: { none: {} },
      customerPOs: { none: { deletedAt: null } },
    },
    select: {
      id: true,
      number: true,
      revision: true,
      title: true,
      sentAt: true,
      preparedById: true,
      account: { select: { name: true, ownerId: true } },
    },
  });

  const dayIndex = (d: Date) => Math.floor(d.getTime() / DAY_MS);
  const notified: QuoteSilenceSweepResult["notified"] = [];

  for (const quotation of candidates) {
    if (!quotation.sentAt) continue;
    const daysSilent = dayIndex(now) - dayIndex(quotation.sentAt);
    if (daysSilent < QUOTE_SILENCE_FOLLOW_UP_DAYS) continue;
    if ((daysSilent - QUOTE_SILENCE_FOLLOW_UP_DAYS) % 7 !== 0) continue;

    const display =
      quotation.revision > 0
        ? `${quotation.number}REV${String(quotation.revision).padStart(2, "0")}`
        : quotation.number;

    // The account owner is who chases a customer. The preparer is told too when they are somebody
    // else, because they are the one who knows what was quoted — `notify` de-duplicates when they
    // are the same person.
    for (const recipientId of new Set([quotation.account.ownerId, quotation.preparedById])) {
      try {
        await notify({
          recipientId,
          type: QUOTE_SILENT_NOTIFICATION_TYPE,
          title: `${display} has had no response in ${daysSilent} days`,
          body:
            `${quotation.account.name} — ${quotation.title}. No feedback, no negotiation and no ` +
            `purchase order. Worth a call while they still remember the conversation.`,
          entityType: "Quotation",
          entityId: quotation.id,
        });
      } catch (error) {
        console.error("[crm] failed to notify about a silent quotation", quotation.id, error);
      }
    }

    notified.push({
      quotationId: quotation.id,
      number: display,
      daysSilent,
      ownerId: quotation.account.ownerId,
    });
  }

  return { notified, scanned: candidates.length };
}

// ---- the 500-day dormancy sweep ------------------------------------------------------------------

export interface DormancySweepResult {
  madeDormant: { accountId: string; code: string; daysSinceOrder: number | null }[];
  revived: { accountId: string; code: string }[];
  scanned: number;
}

/**
 * Marks a customer dormant when no purchase order has arrived in 500 days, and wakes it when one
 * does.
 *
 * The company's rule, in their words: *"log the customer dormant if AIES did not receive a PO from
 * this customer in 500 days."* It is a statement about what `status` means that the build had left
 * to human judgement — before this, every account created stayed `active` forever unless somebody
 * remembered to change it, which nobody ever does.
 *
 * Three guards, each protecting a decision a person made:
 *
 * 1. **`blacklisted` is never touched.** That status exists because somebody decided this customer
 *    is a problem; replacing it with the milder `dormant` would erase that on the day it counts.
 * 2. **Only accounts this sweep itself parked are revived.** `autoDormantAt` is what distinguishes
 *    them — a customer somebody deliberately parked stays parked when an order arrives, and a
 *    person can look at it.
 * 3. **Every change is audited** against the account, as a `System` actor, so the record says why
 *    its status changed and does not read as though a colleague did it.
 */
export async function sweepDormantAccounts(now: Date = new Date()): Promise<DormancySweepResult> {
  const cutoff = new Date(now.getTime() - DORMANT_WITHOUT_PO_DAYS * DAY_MS);

  const accounts = await db.customerAccount.findMany({
    where: { deletedAt: null, status: { in: ["active", "dormant"] } },
    select: {
      id: true,
      code: true,
      name: true,
      status: true,
      createdAt: true,
      autoDormantAt: true,
    },
  });
  if (accounts.length === 0) {
    return { madeDormant: [], revived: [], scanned: 0 };
  }

  const lastOrders = await db.customerPO.groupBy({
    by: ["accountId"],
    where: { accountId: { in: accounts.map((a) => a.id) }, deletedAt: null },
    _max: { receivedAt: true },
  });
  const lastOrderByAccount = new Map(
    lastOrders.map((row) => [row.accountId, row._max.receivedAt] as const),
  );

  const madeDormant: DormancySweepResult["madeDormant"] = [];
  const revived: DormancySweepResult["revived"] = [];

  for (const account of accounts) {
    const lastOrder = lastOrderByAccount.get(account.id) ?? null;
    // No order ever: the clock runs from when the customer was created. A prospect that has sat
    // sixteen months without buying anything is what `dormant` describes.
    const since = lastOrder ?? account.createdAt;
    const stale = since < cutoff;
    const daysSince = Math.floor((now.getTime() - since.getTime()) / DAY_MS);

    if (account.status === "active" && stale) {
      await db.$transaction(async (tx) => {
        await tx.customerAccount.update({
          where: { id: account.id },
          data: { status: "dormant", autoDormantAt: now },
        });
        await writeAuditLog(tx, {
          // No person did this. `actorId: null` is what the audit log uses for system actions —
          // attributing it to whoever happened to trigger the cron would be a lie on the record.
          actorId: null,
          actorLabel: "System (dormancy sweep)",
          action: "status_changed",
          entityType: ACCOUNT_ENTITY_TYPE,
          entityId: account.id,
          summary:
            `${account.code} marked dormant: no purchase order in ${daysSince} days` +
            (lastOrder ? "" : " — and none ever received"),
          diff: { status: { from: "active", to: "dormant" } },
        });
      });
      madeDormant.push({ accountId: account.id, code: account.code, daysSinceOrder: daysSince });
      continue;
    }

    if (account.status === "dormant" && account.autoDormantAt && !stale) {
      await db.$transaction(async (tx) => {
        await tx.customerAccount.update({
          where: { id: account.id },
          data: { status: "active", autoDormantAt: null },
        });
        await writeAuditLog(tx, {
          actorId: null,
          actorLabel: "System (dormancy sweep)",
          action: "status_changed",
          entityType: ACCOUNT_ENTITY_TYPE,
          entityId: account.id,
          summary: `${account.code} is active again: a purchase order arrived.`,
          diff: { status: { from: "dormant", to: "active" } },
        });
      });
      revived.push({ accountId: account.id, code: account.code });
    }
  }

  return { madeDormant, revived, scanned: accounts.length };
}
