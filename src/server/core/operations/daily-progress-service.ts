import { TRPCError } from "@trpc/server";
import { Prisma } from "@prisma/client";
import { db } from "@/lib/db";
import { writeAuditLog } from "@/server/core/audit/audit";
import type { ActorMeta } from "@/server/core/crm/account-service";
import { registerFileAccessChecker } from "@/server/core/storage/access";
import {
  DAILY_PROGRESS_ENTITY_TYPE,
  checkProgressEntry,
  latestProgress,
  summariseStandby,
  type StandbyCause,
} from "./daily-progress-rules";

/**
 * The daily progress log (specs/04-operations-projects.md §8's execution half).
 *
 * ## One row per day, edited rather than appended
 *
 * The unique index on `(ticketId, logDate)` is the design, not an optimisation. Two logs for one day
 * would be two accounts of the same day, and when they disagree — as they will, since they are
 * written by whoever is nearest the phone — the claim built on them is worthless. `logDayService`
 * upserts.
 *
 * ## The steps are numbers, not prose
 *
 * §8: "daily progress logging **against the methodology's sequence of work**." So `stepsCompleted`
 * holds step numbers from `Methodology.sequenceOfWork`, and `stepsForTicketService` gives the screen
 * the list to tick. A percentage nobody can trace back to a step is a number somebody made up.
 */

registerFileAccessChecker(DAILY_PROGRESS_ENTITY_TYPE, async (user) => {
  return user.permissions.has("ticket.view") || user.permissions.has("ticket.view_all");
});

export interface LogDayInput {
  ticketId: string;
  logDate: Date;
  stepsCompleted?: number[];
  percentComplete: number;
  manpowerOnSite: number;
  hoursWorked: number;
  weather?: string | null;
  standbyHours?: number;
  standbyCause?: StandbyCause | null;
  standbyNotes?: string | null;
  issuesRaised?: string | null;
  notes?: string | null;
  photoFileIds?: string[];
}

/**
 * Files — or corrects — one day.
 *
 * The previous day's percentage is read first so `checkProgressEntry` can notice progress going
 * backwards. That is a warning rather than a refusal: rework happens, and a form that refuses it
 * would be answered with a number somebody invented to get past the validation.
 */
export async function logDayService(actor: ActorMeta, input: LogDayInput) {
  const ticket = await db.ticket.findFirst({
    where: { id: input.ticketId, deletedAt: null },
    select: { id: true, number: true, projectId: true, status: true },
  });
  if (!ticket) {
    throw new TRPCError({ code: "NOT_FOUND", message: "That ticket no longer exists." });
  }

  const day = startOfDay(input.logDate);

  const previous = await db.dailyProgress.findFirst({
    where: { ticketId: ticket.id, deletedAt: null, logDate: { lt: day } },
    orderBy: { logDate: "desc" },
    select: { percentComplete: true },
  });

  const check = checkProgressEntry({
    percentComplete: input.percentComplete,
    hoursWorked: input.hoursWorked,
    standbyHours: input.standbyHours ?? 0,
    standbyCause: input.standbyCause,
    manpowerOnSite: input.manpowerOnSite,
    stepsCompleted: input.stepsCompleted,
    previousPercent: previous?.percentComplete,
  });
  if (!check.ok) {
    throw new TRPCError({ code: "BAD_REQUEST", message: check.errors.join(" ") });
  }

  const existing = await db.dailyProgress.findUnique({
    where: { ticketId_logDate: { ticketId: ticket.id, logDate: day } },
    select: { id: true },
  });

  const data = {
    stepsCompleted: input.stepsCompleted ?? [],
    percentComplete: input.percentComplete,
    manpowerOnSite: input.manpowerOnSite,
    hoursWorked: new Prisma.Decimal(input.hoursWorked),
    weather: input.weather ?? null,
    standbyHours: new Prisma.Decimal(input.standbyHours ?? 0),
    standbyCause: input.standbyCause ?? null,
    standbyNotes: input.standbyNotes ?? null,
    issuesRaised: input.issuesRaised ?? null,
    notes: input.notes ?? null,
    ...(input.photoFileIds !== undefined ? { photoFileIds: input.photoFileIds } : {}),
  };

  const row = await db.$transaction(async (tx) => {
    const saved = existing
      ? await tx.dailyProgress.update({
          where: { id: existing.id },
          data: { ...data, version: { increment: 1 } },
        })
      : await tx.dailyProgress.create({
          data: {
            ...data,
            ticketId: ticket.id,
            projectId: ticket.projectId,
            logDate: day,
            loggedById: actor.actorId,
          },
        });

    await writeAuditLog(tx, {
      actorId: actor.actorId,
      actorLabel: actor.actorLabel,
      action: existing ? "corrected" : "logged",
      entityType: DAILY_PROGRESS_ENTITY_TYPE,
      entityId: saved.id,
      summary:
        `${existing ? "Corrected" : "Logged"} ${day.toISOString().slice(0, 10)} on ${ticket.number} — ` +
        `${input.percentComplete}% complete, ${input.hoursWorked}h worked` +
        ((input.standbyHours ?? 0) > 0
          ? `, ${input.standbyHours}h standby (${input.standbyCause})`
          : ""),
      ip: actor.ip,
      userAgent: actor.userAgent,
      requestId: actor.requestId,
    });

    return saved;
  });

  return { id: row.id, corrected: !!existing, warnings: check.warnings };
}

/**
 * The method statement's steps, for the screen to tick against.
 *
 * Reads the newest live method statement on the ticket or its project. When there is none — an
 * after-sales callout usually has none — this returns an empty list and the screen says so rather
 * than pretending the sequence exists.
 */
export async function stepsForTicketService(ticketId: string) {
  const ticket = await db.ticket.findFirst({
    where: { id: ticketId, deletedAt: null },
    select: { id: true, projectId: true },
  });
  if (!ticket) {
    throw new TRPCError({ code: "NOT_FOUND", message: "That ticket no longer exists." });
  }

  const methodology = await db.methodology.findFirst({
    where: {
      deletedAt: null,
      status: { not: "superseded" },
      OR: [{ ticketId: ticket.id }, ...(ticket.projectId ? [{ projectId: ticket.projectId }] : [])],
    },
    orderBy: { revision: "desc" },
    select: { id: true, number: true, revision: true, sequenceOfWork: true },
  });

  if (!methodology) return { methodology: null, steps: [] };

  const raw = Array.isArray(methodology.sequenceOfWork) ? methodology.sequenceOfWork : [];
  const steps = raw
    .filter((entry): entry is { step: number; description: string } => {
      if (!entry || typeof entry !== "object") return false;
      const row = entry as { step?: unknown; description?: unknown };
      return typeof row.description === "string";
    })
    .map((entry, index) => ({
      step: Number(entry.step) || index + 1,
      description: entry.description,
    }));

  return {
    methodology: {
      id: methodology.id,
      number: methodology.number,
      revision: methodology.revision,
    },
    steps,
  };
}

export async function listProgressService(ticketId: string) {
  const rows = await db.dailyProgress.findMany({
    where: { ticketId, deletedAt: null },
    orderBy: { logDate: "desc" },
    take: 200,
  });

  const entries = rows.map((row) => ({
    logDate: row.logDate,
    percentComplete: row.percentComplete,
    hoursWorked: Number(row.hoursWorked),
    standbyHours: Number(row.standbyHours),
    standbyCause: row.standbyCause,
  }));

  return {
    rows: rows.map((row) => ({
      ...row,
      hoursWorked: row.hoursWorked.toString(),
      standbyHours: row.standbyHours.toString(),
    })),
    standby: summariseStandby(entries),
    percentComplete: latestProgress(entries),
  };
}

/**
 * §8's evidence base, for one ticket or across a project.
 *
 * Exported separately from the list because the question "how much standby did this customer cause"
 * is asked by somebody preparing a claim, not by somebody reading a diary — and they want the total
 * without three hundred rows attached.
 */
export async function standbyEvidenceService(filter: { ticketId?: string; projectId?: string }) {
  if (!filter.ticketId && !filter.projectId) {
    throw new TRPCError({
      code: "BAD_REQUEST",
      message: "Ask for a ticket or a project — standby across the whole company is not a claim.",
    });
  }

  const rows = await db.dailyProgress.findMany({
    where: {
      deletedAt: null,
      ...(filter.ticketId ? { ticketId: filter.ticketId } : {}),
      ...(filter.projectId ? { projectId: filter.projectId } : {}),
    },
    select: {
      logDate: true,
      percentComplete: true,
      hoursWorked: true,
      standbyHours: true,
      standbyCause: true,
      standbyNotes: true,
      ticket: { select: { id: true, number: true } },
    },
    orderBy: { logDate: "asc" },
  });

  const summary = summariseStandby(
    rows.map((row) => ({
      logDate: row.logDate,
      percentComplete: row.percentComplete,
      hoursWorked: Number(row.hoursWorked),
      standbyHours: Number(row.standbyHours),
      standbyCause: row.standbyCause,
    })),
  );

  return {
    summary,
    // Only the days that actually had standby: a claim is read line by line, and the days nothing
    // went wrong are noise in it.
    days: rows
      .filter((row) => Number(row.standbyHours) > 0)
      .map((row) => ({
        logDate: row.logDate,
        ticket: row.ticket,
        hours: Number(row.standbyHours),
        cause: row.standbyCause,
        notes: row.standbyNotes,
      })),
  };
}

function startOfDay(date: Date): Date {
  // The column is a `@db.Date`, so the time is meaningless — normalised in UTC so a log filed at
  // 11pm in Manila does not land on the previous day.
  return new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()));
}
