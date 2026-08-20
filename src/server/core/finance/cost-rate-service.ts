import { TRPCError } from "@trpc/server";
import { db } from "@/lib/db";
import { writeAuditLog } from "@/server/core/audit/audit";
import type { ActorMeta } from "@/server/core/crm/account-service";
import { rateOn } from "@/server/core/finance/project-pnl-rules";

export const COST_RATE_ENTITY_TYPE = "CostRate";

/**
 * §6's cost rates — what an hour of somebody's time costs the company.
 *
 * ## Why this file exists at all
 *
 * `CostRate` was a table with **no service, no router procedure and no screen**. §6's P&L read it,
 * priced labour from it, and reported *"N days with no rate"* when it found nothing — and there was
 * no way on earth for a person to answer that. The company found it by walking the P&L, reading the
 * caveat, and asking the only sensible question: *where do I look for these?*
 *
 * Third occurrence of the shape docs/DECISIONS.md #128 named. A number is defined before its input
 * exists, the reporting half looks finished, and the caveat that was supposed to be the safety net
 * turns out to point at a door that was never built.
 *
 * ## Rates are a history, not a setting
 *
 * A job costed in March must keep March's rate however many times somebody has had a rise since —
 * otherwise last year's margins move every time payroll does, and the one figure §6 says management
 * cannot get anywhere else becomes unauditable. So a new rate is a **new row with a start date**,
 * never an edit to the old one, and `rateOn()` picks whichever was in force on the day worked.
 *
 * The single exception is a correction on the same start date, which replaces rather than
 * accumulates — that is what the `@@unique([userId, effectiveFrom])` constraint is for, and a second
 * row for the same day is somebody fixing a typo, not a second rise.
 */

/** Everyone who could have a rate, with the one in force today and their full history. */
export async function costRatesService() {
  const users = await db.user.findMany({
    where: { deletedAt: null },
    select: { id: true, name: true, email: true, isActive: true },
    orderBy: { name: "asc" },
  });

  const rates = await db.costRate.findMany({
    where: { deletedAt: null },
    orderBy: { effectiveFrom: "desc" },
  });

  const today = new Date();

  return users.map((user) => {
    const mine = rates.filter((rate) => rate.userId === user.id);
    const current = rateOn(mine, today);

    return {
      userId: user.id,
      name: user.name,
      email: user.email,
      isActive: user.isActive,
      /*
        Null rather than zero when nobody has set one.

        A rate of zero is a real statement — an unpaid director, a volunteer — and it is not the same
        as nobody having decided. §6 counts a day it cannot price as *uncosted* and says how many;
        collapsing the two here would put that distinction back where it came from.
      */
      current: current
        ? {
            hourlyCost: current.hourlyCost.toString(),
            overtimeMultiplier: current.overtimeMultiplier.toString(),
            travelMultiplier: current.travelMultiplier.toString(),
            standbyMultiplier: current.standbyMultiplier.toString(),
            effectiveFrom: current.effectiveFrom,
          }
        : null,
      history: mine.map((rate) => ({
        id: rate.id,
        hourlyCost: rate.hourlyCost.toString(),
        overtimeMultiplier: rate.overtimeMultiplier.toString(),
        travelMultiplier: rate.travelMultiplier.toString(),
        standbyMultiplier: rate.standbyMultiplier.toString(),
        effectiveFrom: rate.effectiveFrom,
        notes: rate.notes,
      })),
    };
  });
}

/**
 * How many approved timesheet days currently have no rate to price them.
 *
 * The same question §6's caveat asks, answered **across the company** rather than per project — so
 * somebody arriving at this screen from that caveat can see the whole of what needs fixing rather
 * than one project's share of it, and can tell whether it is one forgotten person or a general gap.
 */
export async function uncostedDaysService() {
  const sheets = await db.timesheet.findMany({
    where: { deletedAt: null, status: "approved" },
    select: { userId: true, date: true },
  });
  if (sheets.length === 0) return [];

  const rates = await db.costRate.findMany({
    where: { deletedAt: null, userId: { in: [...new Set(sheets.map((sheet) => sheet.userId))] } },
    orderBy: { effectiveFrom: "desc" },
  });

  const byUser = new Map<string, { days: number; earliest: Date }>();
  for (const sheet of sheets) {
    const mine = rates.filter((rate) => rate.userId === sheet.userId);
    if (rateOn(mine, sheet.date)) continue;

    const seen = byUser.get(sheet.userId);
    if (seen) {
      seen.days += 1;
      if (sheet.date < seen.earliest) seen.earliest = sheet.date;
    } else {
      byUser.set(sheet.userId, { days: 1, earliest: sheet.date });
    }
  }
  if (byUser.size === 0) return [];

  const users = await db.user.findMany({
    where: { id: { in: [...byUser.keys()] } },
    select: { id: true, name: true },
  });
  const nameById = new Map(users.map((user) => [user.id, user.name]));

  return [...byUser.entries()]
    .map(([userId, found]) => ({
      userId,
      name: nameById.get(userId) ?? "somebody",
      days: found.days,
      /*
        The earliest unpriced day, because it is what decides the start date of the fix.

        A rate entered from today forward leaves every day before it still uncosted, and somebody who
        cannot see how far back the gap runs will do exactly that and wonder why the caveat did not
        clear.
      */
      earliestDay: found.earliest,
    }))
    .sort((a, b) => b.days - a.days);
}

export async function setCostRateService(
  actor: ActorMeta,
  input: {
    userId: string;
    effectiveFrom: Date;
    hourlyCost: number;
    overtimeMultiplier?: number;
    travelMultiplier?: number;
    standbyMultiplier?: number;
    notes?: string | null;
  },
) {
  const user = await db.user.findFirst({
    where: { id: input.userId, deletedAt: null },
    select: { id: true, name: true },
  });
  if (!user) {
    throw new TRPCError({ code: "BAD_REQUEST", message: "That person no longer exists." });
  }

  if (input.hourlyCost < 0) {
    throw new TRPCError({
      code: "BAD_REQUEST",
      message: "An hour cannot cost less than nothing.",
    });
  }

  /*
    Multipliers below 1 are refused.

    Overtime, travel and standby are paid at plain time or better under Philippine rules; a
    multiplier under 1 means an hour of overtime costing less than an ordinary hour, which is either
    a typo or a decimal in the wrong place. Both would quietly understate the cost of exactly the
    jobs that ran long — the ones the P&L exists to find.
  */
  for (const [label, value] of [
    ["Overtime", input.overtimeMultiplier],
    ["Travel", input.travelMultiplier],
    ["Standby", input.standbyMultiplier],
  ] as const) {
    if (value !== undefined && value < 1) {
      throw new TRPCError({
        code: "BAD_REQUEST",
        message: `${label} cannot be cheaper than ordinary time. Check the multiplier.`,
      });
    }
  }

  const existing = await db.costRate.findUnique({
    where: { userId_effectiveFrom: { userId: user.id, effectiveFrom: input.effectiveFrom } },
    select: { id: true, hourlyCost: true },
  });

  const data = {
    hourlyCost: input.hourlyCost.toFixed(2),
    overtimeMultiplier: (input.overtimeMultiplier ?? 1.25).toFixed(2),
    travelMultiplier: (input.travelMultiplier ?? 1).toFixed(2),
    standbyMultiplier: (input.standbyMultiplier ?? 1).toFixed(2),
    notes: input.notes?.trim() || null,
  };

  const saved = await db.$transaction(async (tx) => {
    // A second row for the same start date is a correction, and corrections replace rather than
    // accumulate — the schema's unique constraint says so and this honours it.
    const row = existing
      ? await tx.costRate.update({ where: { id: existing.id }, data })
      : await tx.costRate.create({
          data: { userId: user.id, effectiveFrom: input.effectiveFrom, ...data },
        });

    await writeAuditLog(tx, {
      actorId: actor.actorId,
      actorLabel: actor.actorLabel,
      action: existing ? "update" : "create",
      entityType: COST_RATE_ENTITY_TYPE,
      entityId: row.id,
      summary:
        (existing
          ? `Corrected ${user.name}'s cost rate from `
          : `Set ${user.name}'s cost rate to `) +
        (existing ? `${existing.hourlyCost.toString()} to ` : "") +
        `PHP ${data.hourlyCost}/hour, effective ` +
        `${input.effectiveFrom.toISOString().slice(0, 10)}` +
        ` (overtime ×${data.overtimeMultiplier}, travel ×${data.travelMultiplier})`,
      ip: actor.ip,
      userAgent: actor.userAgent,
      requestId: actor.requestId,
    });

    return row;
  });

  return { id: saved.id, replaced: existing !== null };
}
