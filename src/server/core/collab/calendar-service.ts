import { randomBytes } from "node:crypto";
import { TRPCError } from "@trpc/server";
import { db } from "@/lib/db";
import { writeAuditLog } from "@/server/core/audit/audit";
import type { ActorMeta } from "@/server/core/crm/account-service";
import {
  CALENDAR_SOURCE_PERMISSION,
  overlaps,
  toIcs,
  type CalendarEntry,
  type CalendarSource,
} from "@/server/core/collab/calendar-rules";

/**
 * §4's unified calendar.
 *
 * ## Derived, not copied
 *
 * Every source but `manual` reads the date off the record that owns it. Nothing is written here when
 * a ticket is scheduled or an invoice raised — a copied due date is a second thing to keep in step,
 * and experience says the copy on the calendar is the one nobody updates. The cost is that this
 * function makes a dozen queries; the benefit is that it cannot be wrong.
 *
 * ## Permissions are applied per source
 *
 * A calendar is a summary of the whole company, and a summary that ignores permissions is a way to
 * read what you could not otherwise open. The two finance sources are gated; the operational ones
 * are not, because knowing a crew is out on Thursday is not privileged information in a company of
 * nine.
 */

export const CALENDAR_EVENT_ENTITY_TYPE = "CalendarEvent";

const day = 24 * 60 * 60 * 1000;

export interface CalendarQuery {
  from: Date;
  to: Date;
  /** `mine` narrows to entries that name the viewer. `team` is everything they may see. */
  scope?: "mine" | "team";
}

export async function calendarService(
  viewer: { id: string; permissions: ReadonlySet<string> },
  input: CalendarQuery,
): Promise<{ entries: CalendarEntry[]; hiddenSources: CalendarSource[] }> {
  const { from, to } = input;
  const entries: CalendarEntry[] = [];
  const hiddenSources: CalendarSource[] = [];

  const may = (source: CalendarSource) => {
    const needed = CALENDAR_SOURCE_PERMISSION[source];
    if (!needed) return true;
    const allowed = viewer.permissions.has(needed);
    if (!allowed && !hiddenSources.includes(source)) hiddenSources.push(source);
    return allowed;
  };

  // ---- Operations -------------------------------------------------------------------------------

  const tickets = await db.ticket.findMany({
    where: { deletedAt: null, scheduledStart: { gte: from, lt: to } },
    select: {
      id: true,
      number: true,
      title: true,
      scheduledStart: true,
      assignedLeadId: true,
      assignedUserIds: true,
    },
  });
  for (const ticket of tickets) {
    entries.push({
      id: ticket.id,
      source: "ticket",
      title: ticket.title,
      startsAt: ticket.scheduledStart!,
      endsAt: null,
      allDay: false,
      userIds: [ticket.assignedLeadId, ...ticket.assignedUserIds].filter(
        (id): id is string => !!id,
      ),
      entityType: "Ticket",
      entityId: ticket.id,
      reference: ticket.number,
    });
  }

  const mobilizations = await db.mobilization.findMany({
    where: { deletedAt: null, plannedAt: { gte: from, lt: to } },
    select: { id: true, plannedAt: true, ticketId: true, ticket: { select: { number: true } } },
  });
  for (const mobilization of mobilizations) {
    entries.push({
      id: mobilization.id,
      source: "mobilization",
      title: "Crew mobilises",
      startsAt: mobilization.plannedAt!,
      endsAt: null,
      allDay: false,
      userIds: [],
      entityType: "Ticket",
      entityId: mobilization.ticketId,
      reference: mobilization.ticket?.number ?? null,
    });
  }

  const leave = await db.technicianAvailability.findMany({
    where: { deletedAt: null, toDate: { gte: from }, fromDate: { lt: to } },
    select: { id: true, userId: true, fromDate: true, toDate: true, kind: true },
  });
  const leaveNames = await namesFor(leave.map((row) => row.userId));
  for (const row of leave) {
    entries.push({
      id: row.id,
      source: "leave",
      title: `${leaveNames.get(row.userId) ?? "Somebody"} — ${row.kind}`,
      startsAt: row.fromDate,
      endsAt: row.toDate,
      // Leave is a day thing, not a time thing. Nobody is off from 09:00.
      allDay: true,
      userIds: [row.userId],
      entityType: null,
      entityId: null,
      reference: null,
    });
  }

  const equipment = await db.equipment.findMany({
    where: {
      deletedAt: null,
      OR: [{ calibrationDueAt: { gte: from, lt: to } }, { nextPMDueAt: { gte: from, lt: to } }],
    },
    select: {
      id: true,
      description: true,
      tagNumber: true,
      serialNumber: true,
      calibrationDueAt: true,
      nextPMDueAt: true,
    },
  });
  for (const item of equipment) {
    if (item.calibrationDueAt && item.calibrationDueAt >= from && item.calibrationDueAt < to) {
      entries.push({
        id: `${item.id}-cal`,
        source: "calibration_due",
        title: `${item.description} calibration due`,
        startsAt: item.calibrationDueAt,
        endsAt: null,
        allDay: true,
        userIds: [],
        entityType: null,
        entityId: null,
        reference: item.tagNumber ?? item.serialNumber,
      });
    }
    if (item.nextPMDueAt && item.nextPMDueAt >= from && item.nextPMDueAt < to) {
      entries.push({
        id: `${item.id}-pm`,
        source: "pm_visit",
        title: `${item.description} PM due`,
        startsAt: item.nextPMDueAt,
        endsAt: null,
        allDay: true,
        userIds: [],
        entityType: null,
        entityId: null,
        reference: item.tagNumber ?? item.serialNumber,
      });
    }
  }

  // ---- Sales ------------------------------------------------------------------------------------

  const quotations = await db.quotation.findMany({
    where: { deletedAt: null, status: "sent", validUntil: { gte: from, lt: to } },
    select: { id: true, number: true, title: true, validUntil: true, preparedById: true },
  });
  for (const quotation of quotations) {
    entries.push({
      id: quotation.id,
      source: "quotation_expiry",
      title: `${quotation.title} expires`,
      startsAt: quotation.validUntil,
      endsAt: null,
      allDay: true,
      userIds: quotation.preparedById ? [quotation.preparedById] : [],
      entityType: "Quotation",
      entityId: quotation.id,
      reference: quotation.number,
    });
  }

  // ---- Money ------------------------------------------------------------------------------------

  if (may("invoice_due")) {
    const statements = await db.billingStatement.findMany({
      where: {
        deletedAt: null,
        status: { in: ["issued", "partially_paid"] },
        dueDate: { gte: from, lt: to },
      },
      select: { id: true, number: true, dueDate: true, accountId: true },
    });
    const accountNames = await accountNamesFor(statements.map((row) => row.accountId));
    for (const statement of statements) {
      entries.push({
        id: statement.id,
        source: "invoice_due",
        title: `${accountNames.get(statement.accountId) ?? "A customer"} owes`,
        startsAt: statement.dueDate,
        endsAt: null,
        allDay: true,
        userIds: [],
        entityType: null,
        entityId: null,
        reference: statement.number,
      });
    }
  }

  if (may("liquidation_due")) {
    const advances = await db.cashAdvance.findMany({
      where: {
        deletedAt: null,
        status: "released",
        liquidatedAt: null,
        liquidationDueAt: { gte: from, lt: to },
      },
      select: { id: true, number: true, liquidationDueAt: true, requestedById: true },
    });
    for (const advance of advances) {
      entries.push({
        id: advance.id,
        source: "liquidation_due",
        title: "Cash advance to liquidate",
        startsAt: advance.liquidationDueAt!,
        endsAt: null,
        allDay: true,
        userIds: [advance.requestedById],
        entityType: "CashAdvance",
        entityId: advance.id,
        reference: advance.number,
      });
    }
  }

  // ---- The diary --------------------------------------------------------------------------------

  const manual = await db.calendarEvent.findMany({
    where: { deletedAt: null, startsAt: { gte: new Date(from.getTime() - 30 * day), lt: to } },
    select: {
      id: true,
      title: true,
      startsAt: true,
      endsAt: true,
      allDay: true,
      ownerId: true,
      attendeeIds: true,
      entityType: true,
      entityId: true,
    },
  });
  for (const event of manual) {
    const entry: CalendarEntry = {
      id: event.id,
      source: "manual",
      title: event.title,
      startsAt: event.startsAt,
      endsAt: event.endsAt,
      allDay: event.allDay,
      userIds: [event.ownerId, ...event.attendeeIds],
      entityType: event.entityType,
      entityId: event.entityId,
      reference: null,
    };
    // Looked back thirty days so a long event that began before the window still shows inside it.
    if (overlaps(entry, from, to)) entries.push(entry);
  }

  const visible =
    input.scope === "mine" ? entries.filter((entry) => entry.userIds.includes(viewer.id)) : entries;

  visible.sort((a, b) => a.startsAt.getTime() - b.startsAt.getTime());
  return { entries: visible, hiddenSources };
}

async function accountNamesFor(ids: string[]) {
  const wanted = [...new Set(ids)];
  if (wanted.length === 0) return new Map<string, string>();
  const accounts = await db.customerAccount.findMany({
    where: { id: { in: wanted } },
    select: { id: true, name: true },
  });
  return new Map(accounts.map((account) => [account.id, account.name]));
}

async function namesFor(ids: string[]) {
  const wanted = [...new Set(ids)];
  if (wanted.length === 0) return new Map<string, string>();
  const users = await db.user.findMany({
    where: { id: { in: wanted } },
    select: { id: true, name: true },
  });
  return new Map(users.map((user) => [user.id, user.name]));
}

export async function createCalendarEventService(
  actor: ActorMeta,
  input: {
    title: string;
    description?: string | null;
    location?: string | null;
    startsAt: Date;
    endsAt?: Date | null;
    allDay?: boolean;
    attendeeIds?: string[];
  },
) {
  if (input.title.trim().length < 2) {
    throw new TRPCError({ code: "BAD_REQUEST", message: "Give it a name." });
  }
  if (input.endsAt && input.endsAt < input.startsAt) {
    throw new TRPCError({ code: "BAD_REQUEST", message: "It cannot end before it starts." });
  }

  const event = await db.calendarEvent.create({
    data: {
      title: input.title.trim(),
      description: input.description?.trim() || null,
      location: input.location?.trim() || null,
      startsAt: input.startsAt,
      endsAt: input.endsAt ?? null,
      allDay: input.allDay ?? false,
      ownerId: actor.actorId,
      attendeeIds: input.attendeeIds ?? [],
    },
  });

  return { id: event.id };
}

export async function deleteCalendarEventService(actor: ActorMeta, input: { eventId: string }) {
  const event = await db.calendarEvent.findFirst({
    where: { id: input.eventId, deletedAt: null },
    select: { id: true, title: true, ownerId: true },
  });
  if (!event) throw new TRPCError({ code: "NOT_FOUND", message: "That entry is gone." });
  if (event.ownerId !== actor.actorId) {
    // Somebody else's diary. Not a permission to hand out — it is simply not yours to clear.
    throw new TRPCError({ code: "FORBIDDEN", message: "That is somebody else's entry." });
  }

  await db.calendarEvent.update({
    where: { id: event.id },
    data: { deletedAt: new Date() },
  });

  return { id: event.id };
}

/**
 * The feed URL, made on demand and rotatable.
 *
 * **The token is the credential.** Anybody holding the URL can read that person's calendar, which is
 * how every calendar subscription works — a phone cannot log in. So it is 32 random bytes, it is
 * per-user, `lastUsedAt` shows whether it is in use, and rotating it kills the old URL immediately.
 * Worth knowing before pasting it anywhere shared.
 */
export async function calendarFeedService(userId: string, rotate = false) {
  const existing = await db.calendarFeedToken.findUnique({ where: { userId } });

  if (existing && !rotate) {
    return { token: existing.token, lastUsedAt: existing.lastUsedAt, isNew: false };
  }

  const token = randomBytes(32).toString("hex");
  if (existing) {
    await db.calendarFeedToken.update({
      where: { userId },
      data: { token, lastUsedAt: null },
    });
  } else {
    await db.calendarFeedToken.create({ data: { userId, token } });
  }

  return { token, lastUsedAt: null, isNew: true };
}

/** The feed itself. Called by the route handler, which has no session — the token is the identity. */
export async function icsFeedService(token: string): Promise<string | null> {
  const row = await db.calendarFeedToken.findUnique({
    where: { token },
    select: { userId: true },
  });
  if (!row) return null;

  const user = await db.user.findFirst({
    where: { id: row.userId, isActive: true, deletedAt: null },
    select: { id: true, name: true, roles: { select: { role: { select: { key: true } } } } },
  });
  // A revoked account's feed stops working without anybody having to remember to delete the token.
  if (!user) return null;

  const permissions = await db.rolePermission.findMany({
    where: { role: { key: { in: user.roles.map((entry) => entry.role.key) } } },
    select: { permission: { select: { key: true } } },
  });

  const now = new Date();
  const { entries } = await calendarService(
    { id: user.id, permissions: new Set(permissions.map((row) => row.permission.key)) },
    {
      // A phone calendar wants the near future, not the archive: a fortnight back for context and a
      // quarter forward for planning.
      from: new Date(now.getTime() - 14 * day),
      to: new Date(now.getTime() + 90 * day),
      scope: "mine",
    },
  );

  await db.calendarFeedToken.update({
    where: { token },
    data: { lastUsedAt: new Date() },
  });

  return toIcs(entries, `AIES — ${user.name}`);
}

/** Recorded when somebody rotates their feed, because it silently breaks whatever was subscribed. */
export async function auditFeedRotation(actor: ActorMeta) {
  await db.$transaction(async (tx) => {
    await writeAuditLog(tx, {
      actorId: actor.actorId,
      actorLabel: actor.actorLabel,
      action: "update",
      entityType: CALENDAR_EVENT_ENTITY_TYPE,
      entityId: actor.actorId,
      summary: "Rotated their calendar feed link. Any device still using the old one will stop.",
      ip: actor.ip,
      userAgent: actor.userAgent,
      requestId: actor.requestId,
    });
  });
}
