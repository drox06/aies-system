import { TRPCError } from "@trpc/server";
import { db } from "@/lib/db";
import { writeAuditLog } from "@/server/core/audit/audit";
import type { ActorMeta } from "@/server/core/crm/account-service";
import { emit } from "@/server/core/events/emit";
import { notify } from "@/server/core/notify/notify";
import { registerNotificationType } from "@/server/core/notify/registry";
import { formatAddress } from "@/lib/address";
import { readinessForTicketService } from "./mobilization-service";
import {
  capacityByWeek,
  cardStatus,
  daysBetween,
  findConflicts,
  travelBetween,
  weekOf,
  type Assignment,
  type Unavailability,
} from "./dispatch-rules";

/**
 * specs/04-operations-projects.md §17's dispatch board.
 *
 * ## The board is a view, not a second source of truth
 *
 * Everything it shows already exists somewhere: §8 owns readiness, the ticket owns its assignment,
 * §16 owns the crew's other commitments. The board's whole job is to put them on one screen at one
 * moment in time, and its one original fact is `scheduledStart` — when AIES has committed a crew, as
 * distinct from `requiredByDate`, which is when the customer needs it. Managing the gap between
 * those two *is* dispatching.
 *
 * ## Conflicts are reported, never refused
 *
 * A dispatcher putting one technician on two short jobs in the same industrial estate is doing their
 * job well. A scheduler that refuses it teaches people to schedule around the scheduler — on paper,
 * in a group chat — and then the board is wrong about everything rather than about one day. So
 * `scheduleTicketService` writes the schedule and returns the conflicts it created.
 */

export const BUMPED_NOTIFICATION_TYPE = "ticket.bumped";

registerNotificationType({
  key: BUMPED_NOTIFICATION_TYPE,
  label: "Your scheduled job was moved for an emergency",
  // In-app only while `notify_email` has no handler (docs/DECISIONS.md #10). This one wants email
  // when a provider exists — somebody whose Thursday just changed is not looking at the app.
  defaultChannels: { inApp: true, email: false, digest: false },
});

// ---- the board -------------------------------------------------------------------------------------

export interface BoardInput {
  /** Any date inside the week wanted. Monday is derived. */
  weekOf?: Date;
}

/**
 * A week of work, by technician.
 *
 * Readiness is fetched per ticket rather than recomputed, so the colour on a card is §8's answer.
 * That costs a query per scheduled ticket, which is the right trade at this size: a week of a
 * five-technician crew is tens of tickets, and a wrong colour on a dispatch board is a crew sent to
 * a site they cannot work.
 */
export async function dispatchBoardService(input: BoardInput = {}) {
  const monday = new Date(weekOf(input.weekOf ?? new Date()));
  const sunday = new Date(monday.getTime() + 6 * 24 * 60 * 60 * 1000);

  const tickets = await db.ticket.findMany({
    where: {
      deletedAt: null,
      scheduledStart: { gte: monday, lte: sunday },
    },
    select: {
      id: true,
      number: true,
      title: true,
      type: true,
      priority: true,
      status: true,
      scheduledStart: true,
      scheduledEnd: true,
      requiredByDate: true,
      assignedLeadId: true,
      assignedUserIds: true,
      account: { select: { id: true, name: true } },
      site: { select: { id: true, name: true, address: true } },
    },
    orderBy: { scheduledStart: "asc" },
  });

  const cards = await Promise.all(
    tickets.map(async (ticket) => {
      const readiness = await readinessForTicketService(ticket.id).catch(() => null);
      return {
        ...ticket,
        siteAddress: formatAddress(ticket.site?.address),
        card: cardStatus({
          // A ticket whose readiness could not be read is not assumed ready. An unknown gate is a
          // blocker everywhere else in this platform and it is one here too.
          readiness: readiness ?? {
            ready: false,
            blockers: [{ key: "unknown", label: "Readiness could not be read", state: "unknown" }],
          },
          scheduledStart: ticket.scheduledStart,
        }),
      };
    }),
  );

  const technicianIds = [
    ...new Set(cards.flatMap((card) => [card.assignedLeadId, ...card.assignedUserIds])),
  ].filter((id): id is string => !!id);

  const [technicians, unavailability] = await Promise.all([
    technicianIds.length
      ? db.user.findMany({
          where: { id: { in: technicianIds } },
          select: { id: true, name: true, email: true },
        })
      : Promise.resolve([]),
    db.technicianAvailability.findMany({
      where: { deletedAt: null, toDate: { gte: monday }, fromDate: { lte: sunday } },
    }),
  ]);

  const assignments: Assignment[] = cards.flatMap((card) =>
    [card.assignedLeadId, ...card.assignedUserIds]
      .filter((id): id is string => !!id)
      .map((userId) => ({
        ticketId: card.id,
        ticketNumber: card.number,
        userId,
        scheduledStart: card.scheduledStart!,
        scheduledEnd: card.scheduledEnd,
      })),
  );

  const away: Unavailability[] = unavailability.map((row) => ({
    userId: row.userId,
    from: row.fromDate,
    to: row.toDate,
    kind: row.kind,
    notes: row.notes,
  }));

  return {
    weekOf: monday,
    days: daysBetween(monday, sunday),
    technicians,
    cards,
    unavailability: away,
    conflicts: findConflicts(assignments, away),
  };
}

/**
 * §17's capacity view — "the number sales needs before promising a date".
 *
 * Counts everyone who holds `ticket.execute`, rather than only those already on the board. A crew of
 * six with two people idle has capacity; counting only the busy four would report the company full
 * while two technicians read the newspaper.
 */
export async function capacityService(input: { weeks?: number } = {}) {
  /**
   * By permission rather than by role name.
   *
   * `ticket.execute` is what makes somebody able to do the work; the `technician` role is one way to
   * hold it and not the only one — an operations manager who goes out on jobs holds it too. Counting
   * the role would report the company full while a manager who spends half their week in the field
   * is invisible to the number sales is about to promise against.
   */
  const executors = await db.userRole.findMany({
    where: {
      user: { isActive: true, deletedAt: null },
      role: { permissions: { some: { permission: { key: "ticket.execute" } } } },
    },
    select: { userId: true },
  });

  const technicianIds = [...new Set(executors.map((row) => row.userId))];
  const from = new Date();
  const horizon = new Date(from.getTime() + (input.weeks ?? 4) * 7 * 24 * 60 * 60 * 1000);

  const [tickets, unavailability] = await Promise.all([
    db.ticket.findMany({
      where: { deletedAt: null, scheduledStart: { gte: from, lte: horizon } },
      select: {
        id: true,
        number: true,
        assignedLeadId: true,
        assignedUserIds: true,
        scheduledStart: true,
        scheduledEnd: true,
      },
    }),
    db.technicianAvailability.findMany({
      where: { deletedAt: null, toDate: { gte: from } },
    }),
  ]);

  const assignments: Assignment[] = tickets.flatMap((ticket) =>
    [ticket.assignedLeadId, ...ticket.assignedUserIds]
      .filter((id): id is string => !!id)
      .map((userId) => ({
        ticketId: ticket.id,
        ticketNumber: ticket.number,
        userId,
        scheduledStart: ticket.scheduledStart!,
        scheduledEnd: ticket.scheduledEnd,
      })),
  );

  return {
    technicianCount: technicianIds.length,
    weeks: capacityByWeek({
      technicianIds,
      assignments,
      unavailability: unavailability.map((row) => ({
        userId: row.userId,
        from: row.fromDate,
        to: row.toDate,
        kind: row.kind,
        notes: row.notes,
      })),
      from,
      weeks: input.weeks,
    }),
  };
}

// ---- scheduling ------------------------------------------------------------------------------------

/**
 * What a booking *would* collide with, without booking it.
 *
 * The company asked for a confirmation step rather than a notice after the fact: "enable the person
 * scheduling to either confirm the booking or cancel the booking." That needs the answer before the
 * write, not after — an undo leaves a window where the board is wrong, and somebody who navigates
 * away mid-decision leaves it wrong permanently.
 *
 * It is still not a refusal. The caller may confirm anything this reports; the point is only that
 * the decision is made knowingly, by the person who knows whether two sites are ten minutes apart.
 */
export async function previewScheduleService(input: {
  ticketId: string;
  scheduledStart: Date;
  scheduledEnd?: Date | null;
  assignedLeadId?: string | null;
  assignedUserIds?: string[];
}) {
  const ticket = await db.ticket.findFirst({
    where: { id: input.ticketId, deletedAt: null },
    select: { id: true, number: true, assignedLeadId: true, assignedUserIds: true },
  });
  if (!ticket) throw new TRPCError({ code: "NOT_FOUND", message: "That ticket no longer exists." });

  // Who the booking would put on it: whatever the caller is proposing, falling back to whoever is
  // already on the ticket. A reschedule that changes only the date still has a crew.
  const crew = [
    input.assignedLeadId !== undefined ? input.assignedLeadId : ticket.assignedLeadId,
    ...(input.assignedUserIds ?? ticket.assignedUserIds),
  ].filter((id): id is string => !!id);

  if (crew.length === 0) return { conflicts: [], crew: [] as { id: string; name: string }[] };

  const from = new Date(weekOf(input.scheduledStart));
  const to = new Date(from.getTime() + 6 * 24 * 60 * 60 * 1000);

  const [others, unavailability, people] = await Promise.all([
    db.ticket.findMany({
      where: {
        deletedAt: null,
        id: { not: ticket.id },
        scheduledStart: { gte: from, lte: to },
      },
      select: {
        id: true,
        number: true,
        assignedLeadId: true,
        assignedUserIds: true,
        scheduledStart: true,
        scheduledEnd: true,
      },
    }),
    db.technicianAvailability.findMany({
      where: {
        deletedAt: null,
        userId: { in: crew },
        toDate: { gte: from },
        fromDate: { lte: to },
      },
    }),
    db.user.findMany({ where: { id: { in: crew } }, select: { id: true, name: true } }),
  ]);

  const existing: Assignment[] = others.flatMap((other) =>
    [other.assignedLeadId, ...other.assignedUserIds]
      .filter((id): id is string => !!id && crew.includes(id))
      .map((userId) => ({
        ticketId: other.id,
        ticketNumber: other.number,
        userId,
        scheduledStart: other.scheduledStart!,
        scheduledEnd: other.scheduledEnd,
      })),
  );

  const proposed: Assignment[] = crew.map((userId) => ({
    ticketId: ticket.id,
    ticketNumber: ticket.number,
    userId,
    scheduledStart: input.scheduledStart,
    scheduledEnd: input.scheduledEnd ?? null,
  }));

  const conflicts = findConflicts(
    [...existing, ...proposed],
    unavailability.map((row) => ({
      userId: row.userId,
      from: row.fromDate,
      to: row.toDate,
      kind: row.kind,
      notes: row.notes,
    })),
  )
    // Only what *this* booking causes. A clash between two other jobs is not this dispatcher's
    // decision to make and would read as noise on a confirmation dialog.
    .filter((conflict) => conflict.ticketNumbers.includes(ticket.number));

  return {
    conflicts: conflicts.map((conflict) => ({
      ...conflict,
      who: people.find((person) => person.id === conflict.userId)?.name ?? conflict.userId,
      otherTickets: conflict.ticketNumbers.filter((number) => number !== ticket.number),
    })),
    crew: people,
  };
}

/**
 * Puts a ticket on the board, and says what that broke.
 *
 * Returns the conflicts rather than throwing on them — see the header. The one thing it does refuse
 * is a window that runs backwards, because that is not a judgement call, it is a typo.
 */
export async function scheduleTicketService(
  actor: ActorMeta,
  input: {
    ticketId: string;
    scheduledStart: Date | null;
    scheduledEnd?: Date | null;
    assignedLeadId?: string | null;
    assignedUserIds?: string[];
    /** A subcontractor doing the work. See Ticket.crewNote for why this is free text. */
    crewNote?: string | null;
  },
) {
  const ticket = await db.ticket.findFirst({
    where: { id: input.ticketId, deletedAt: null },
    select: { id: true, number: true, scheduledStart: true },
  });
  if (!ticket) throw new TRPCError({ code: "NOT_FOUND", message: "That ticket no longer exists." });

  if (input.scheduledStart && input.scheduledEnd && input.scheduledEnd < input.scheduledStart) {
    throw new TRPCError({
      code: "BAD_REQUEST",
      message: "The job cannot finish before it starts.",
    });
  }

  const updated = await db.$transaction(async (tx) => {
    const row = await tx.ticket.update({
      where: { id: ticket.id },
      data: {
        scheduledStart: input.scheduledStart,
        scheduledEnd: input.scheduledEnd ?? null,
        ...(input.assignedLeadId !== undefined ? { assignedLeadId: input.assignedLeadId } : {}),
        ...(input.assignedUserIds ? { assignedUserIds: input.assignedUserIds } : {}),
        ...(input.crewNote !== undefined ? { crewNote: input.crewNote } : {}),
        version: { increment: 1 },
      },
    });

    await writeAuditLog(tx, {
      actorId: actor.actorId,
      actorLabel: actor.actorLabel,
      action: input.scheduledStart ? "ticket_scheduled" : "ticket_unscheduled",
      entityType: "Ticket",
      entityId: ticket.id,
      summary: input.scheduledStart
        ? `${ticket.number} scheduled for ${input.scheduledStart.toISOString().slice(0, 10)}.`
        : `${ticket.number} taken off the board.`,
      ip: actor.ip,
      userAgent: actor.userAgent,
      requestId: actor.requestId,
    });

    return row;
  });

  // What this schedule broke, computed after the write so it reflects what is actually on the board.
  const conflicts = input.scheduledStart
    ? (await dispatchBoardService({ weekOf: input.scheduledStart })).conflicts.filter((conflict) =>
        conflict.ticketNumbers.includes(ticket.number),
      )
    : [];

  return { ticket: updated, conflicts };
}

/**
 * §17: "Emergency and warranty tickets can be injected, bumping lower-priority work with
 * notifications to affected owners."
 *
 * The notification is the requirement, not a courtesy. Moving somebody's Thursday without telling
 * them means they turn up at the original site — so a bump that fails to notify has done harm rather
 * than none, and the whole feature is the telling rather than the moving.
 */
export async function bumpForEmergencyService(
  actor: ActorMeta,
  input: { emergencyTicketId: string; scheduledStart: Date; bumpTicketIds: string[] },
) {
  const emergency = await db.ticket.findFirst({
    where: { id: input.emergencyTicketId, deletedAt: null },
    select: { id: true, number: true, priority: true, type: true },
  });
  if (!emergency) throw new TRPCError({ code: "NOT_FOUND", message: "No such ticket." });

  // §17 names which work may bump: emergencies and warranty callbacks. Anything else displacing a
  // committed crew is a dispatcher's judgement, made by rescheduling both jobs deliberately.
  const mayBump = emergency.priority === "emergency" || emergency.type === "after_sales";
  if (!mayBump) {
    throw new TRPCError({
      code: "BAD_REQUEST",
      message:
        `${emergency.number} is neither an emergency nor an after-sales callback. Move the other ` +
        `jobs yourself rather than bumping them — somebody should be deciding what gets displaced.`,
    });
  }

  const bumped = await db.ticket.findMany({
    where: { id: { in: input.bumpTicketIds }, deletedAt: null },
    select: {
      id: true,
      number: true,
      scheduledStart: true,
      assignedLeadId: true,
      assignedUserIds: true,
    },
  });

  await db.$transaction(async (tx) => {
    await tx.ticket.update({
      where: { id: emergency.id },
      data: { scheduledStart: input.scheduledStart, version: { increment: 1 } },
    });

    for (const ticket of bumped) {
      await tx.ticket.update({
        where: { id: ticket.id },
        data: { scheduledStart: null, scheduledEnd: null, version: { increment: 1 } },
      });

      await writeAuditLog(tx, {
        actorId: actor.actorId,
        actorLabel: actor.actorLabel,
        action: "ticket_bumped",
        entityType: "Ticket",
        entityId: ticket.id,
        summary: `Taken off the board for ${emergency.number}.`,
        ip: actor.ip,
        userAgent: actor.userAgent,
        requestId: actor.requestId,
      });

      await emit(
        tx,
        "ticket.bumped",
        {
          ticketId: ticket.id,
          ticketNumber: ticket.number,
          bumpedFor: emergency.number,
          wasScheduledFor: ticket.scheduledStart,
        },
        { actorId: actor.actorId },
      );
    }
  });

  // Outside the transaction: a notification that fails must not roll back the schedule, and the
  // schedule is the thing that has to be right.
  let notified = 0;
  for (const ticket of bumped) {
    const recipients = [ticket.assignedLeadId, ...ticket.assignedUserIds].filter(
      (id): id is string => !!id,
    );
    for (const recipientId of new Set(recipients)) {
      try {
        await notify({
          recipientId,
          type: BUMPED_NOTIFICATION_TYPE,
          title: `${ticket.number} came off the board`,
          body:
            `${emergency.number} took its slot. ${ticket.number} now has no date — it needs one, ` +
            `and the customer may be expecting you.`,
          entityType: "Ticket",
          entityId: ticket.id,
        });
        notified += 1;
      } catch (error) {
        console.error("[dispatch] failed to notify about a bumped ticket", ticket.id, error);
      }
    }
  }

  return { bumped: bumped.length, notified };
}

// ---- availability ------------------------------------------------------------------------------------

export async function recordUnavailabilityService(
  actor: ActorMeta,
  input: { userId: string; fromDate: Date; toDate: Date; kind: string; notes?: string | null },
) {
  if (input.toDate < input.fromDate) {
    throw new TRPCError({ code: "BAD_REQUEST", message: "That range runs backwards." });
  }

  return db.technicianAvailability.create({
    data: {
      userId: input.userId,
      fromDate: input.fromDate,
      toDate: input.toDate,
      kind: input.kind,
      notes: input.notes ?? null,
      recordedById: actor.actorId,
    },
  });
}

export async function listUnavailabilityService(input: { from: Date; to: Date }) {
  return db.technicianAvailability.findMany({
    where: { deletedAt: null, toDate: { gte: input.from }, fromDate: { lte: input.to } },
    orderBy: { fromDate: "asc" },
  });
}

export async function removeUnavailabilityService(actor: ActorMeta, input: { id: string }) {
  return db.technicianAvailability.update({
    where: { id: input.id },
    data: { deletedAt: new Date() },
  });
}

/** §17's "travel time between consecutive sites", for two tickets the dispatcher is comparing. */
export async function travelBetweenTicketsService(input: {
  fromTicketId: string;
  toTicketId: string;
}) {
  const [from, to] = await Promise.all([
    db.ticket.findFirst({
      where: { id: input.fromTicketId },
      select: { site: { select: { address: true } } },
    }),
    db.ticket.findFirst({
      where: { id: input.toTicketId },
      select: { site: { select: { address: true } } },
    }),
  ]);

  return travelBetween(from?.site?.address, to?.site?.address);
}
