import { TRPCError } from "@trpc/server";
import { db } from "@/lib/db";
import { writeAuditLog } from "@/server/core/audit/audit";
import type { ActorMeta } from "@/server/core/crm/account-service";
import { emit } from "@/server/core/events/emit";
import { allocateNumber } from "@/server/core/numbering/numbering";
import { createStandaloneTicketService } from "./ticket-service";
import {
  WARRANTY_DOCUMENT_TYPE,
  WARRANTY_ENTITY_TYPE,
  checkClaim,
  determine,
  expiringWithin,
  readCoverage,
  warrantySummary,
  type Attribution,
  type Coverage,
  type RootCauseCategory,
} from "./warranty-rules";

/**
 * The warranty gate (specs/04-operations-projects.md §11).
 *
 * §11's diamond sits after T&C and loops back to Project Execution, which models the warranty
 * callback rather than a hold on the way out. Passing it with no claim needs no record at all — that
 * is what §10's acceptance moving a ticket to `for_closeout` already does. This file is what happens
 * when a claim *does* arrive.
 */

// ---- the installed base (§16's Equipment, the part §11 needs) -------------------------------------

export interface UpsertEquipmentInput {
  id?: string;
  accountId: string;
  siteId?: string | null;
  description: string;
  serialNumber?: string | null;
  tagNumber?: string | null;
  manufacturer?: string | null;
  modelNumber?: string | null;
  installedAt?: Date | null;
  installedByTicketId?: string | null;
  commissionedAt?: Date | null;
  commissionedByTcId?: string | null;
  warrantyStart?: Date | null;
  warrantyEnd?: Date | null;
  warrantyTerms?: string | null;
  location?: string | null;
}

export async function upsertEquipmentService(actor: ActorMeta, input: UpsertEquipmentInput) {
  const account = await db.customerAccount.findFirst({
    where: { id: input.accountId, deletedAt: null },
    select: { id: true, name: true },
  });
  if (!account) {
    throw new TRPCError({ code: "NOT_FOUND", message: "That account no longer exists." });
  }

  if (input.warrantyStart && input.warrantyEnd && input.warrantyEnd < input.warrantyStart) {
    throw new TRPCError({
      code: "BAD_REQUEST",
      message: "The warranty ends before it starts. Check the dates.",
    });
  }

  const { id, accountId, ...rest } = input;
  void accountId;

  const saved = id
    ? await db.equipment.update({
        where: { id },
        data: { ...rest, version: { increment: 1 } },
      })
    : await db.equipment.create({ data: { accountId: account.id, ...rest } });

  await writeAuditLog(db, {
    actorId: actor.actorId,
    actorLabel: actor.actorLabel,
    action: id ? "equipment_updated" : "equipment_added",
    entityType: "Equipment",
    entityId: saved.id,
    summary:
      `${saved.description}${saved.serialNumber ? ` (${saved.serialNumber})` : ""} on ${account.name}` +
      (saved.warrantyEnd
        ? `, warranty to ${saved.warrantyEnd.toISOString().slice(0, 10)}.`
        : ", with no warranty window recorded."),
    ip: actor.ip,
    userAgent: actor.userAgent,
    requestId: actor.requestId,
  });

  return saved;
}

export async function listEquipmentService(filter: { accountId?: string } = {}) {
  const rows = await db.equipment.findMany({
    where: { deletedAt: null, ...(filter.accountId ? { accountId: filter.accountId } : {}) },
    orderBy: { createdAt: "desc" },
    take: 200,
  });

  return rows.map((row) => ({ ...row, coverage: readCoverage(row) }));
}

// ---- §11's claim ---------------------------------------------------------------------------------

export interface RaiseClaimInput {
  accountId: string;
  equipmentId?: string | null;
  originalProjectId?: string | null;
  originalTicketId?: string | null;
  faultDescription: string;
  /** What the person answering says. Defaults to what the dates say, but they may disagree. */
  coverage?: Coverage;
  attribution?: Attribution;
  rootCause?: string | null;
  rootCauseCategory?: RootCauseCategory | null;
  coverageOverrideReason?: string | null;
  remarks?: string | null;
}

/**
 * Raises a claim and does what §11 says to do with it.
 *
 * The determination is computed by `determine()` and then **stored**, not left to be recalculated on
 * read. Billability is a commercial position the company took on a date; recomputing it later from
 * whatever the equipment record says by then would let a corrected warranty date silently rewrite
 * what the customer was told.
 */
export async function raiseWarrantyClaimService(actor: ActorMeta, input: RaiseClaimInput) {
  const account = await db.customerAccount.findFirst({
    where: { id: input.accountId, deletedAt: null },
    select: { id: true, name: true },
  });
  if (!account) {
    throw new TRPCError({ code: "NOT_FOUND", message: "That account no longer exists." });
  }

  const equipment = input.equipmentId
    ? await db.equipment.findFirst({ where: { id: input.equipmentId, deletedAt: null } })
    : null;
  if (input.equipmentId && !equipment) {
    throw new TRPCError({ code: "NOT_FOUND", message: "That equipment record no longer exists." });
  }

  const reading = readCoverage(equipment);
  const coverage = input.coverage ?? reading.coverage;
  const attribution = input.attribution ?? "undetermined";

  const check = checkClaim({
    faultDescription: input.faultDescription,
    coverage,
    attribution,
    rootCauseCategory: input.rootCauseCategory,
    coverageOverrideReason: input.coverageOverrideReason,
    readingCoverage: equipment ? reading.coverage : null,
  });
  if (!check.ok) {
    throw new TRPCError({ code: "BAD_REQUEST", message: check.errors.join(" ") });
  }

  const verdict = determine({ coverage, attribution });
  const number = await allocateNumber(WARRANTY_DOCUMENT_TYPE);
  const overrode = equipment !== null && reading.coverage !== coverage;

  // The after-sales ticket is created outside the claim's transaction because it allocates its own
  // number and writes its own audit row. A claim without its ticket is recoverable — the panel shows
  // it as unrouted; a ticket without its claim would be an orphan nobody looks for.
  let resultingTicketId: string | null = null;
  if (verdict.raisesTicket) {
    const ticket = await createStandaloneTicketService(actor, {
      accountId: account.id,
      projectId: input.originalProjectId ?? null,
      type: "after_sales",
      subType: "warranty",
      priority: "high",
      title: `Warranty callback: ${input.faultDescription.slice(0, 80)}`,
      scopeOfWork: input.faultDescription,
      billable: verdict.billable,
      justification: `${number}: ${verdict.reason}`,
    });
    resultingTicketId = ticket.id;
  }

  const claim = await db.$transaction(async (tx) => {
    const created = await tx.warrantyClaim.create({
      data: {
        number,
        accountId: account.id,
        equipmentId: equipment?.id ?? null,
        originalProjectId: input.originalProjectId ?? null,
        originalTicketId: input.originalTicketId ?? null,
        reportedById: actor.actorId,
        faultDescription: input.faultDescription,
        coverage,
        coverageDeterminedAt: new Date(),
        coverageDeterminedById: actor.actorId,
        coverageOverrideReason: overrode ? (input.coverageOverrideReason ?? null) : null,
        attribution,
        rootCause: input.rootCause ?? null,
        rootCauseCategory: input.rootCauseCategory ?? null,
        billable: verdict.billable,
        resultingTicketId,
        ncrRequired: verdict.ncrRequired,
        salesReferredAt: verdict.referToSales ? new Date() : null,
        status: verdict.route === "needs_determination" ? "open" : "routed",
        remarks: input.remarks ?? null,
      },
    });

    await writeAuditLog(tx, {
      actorId: actor.actorId,
      actorLabel: actor.actorLabel,
      action: "warranty_claim_raised",
      entityType: WARRANTY_ENTITY_TYPE,
      entityId: created.id,
      summary:
        `${number} on ${account.name}: ${coverage.replace(/_/g, " ")}, ` +
        `${attribution.replace(/_/g, " ")}, ${verdict.billable ? "billable" : "not billable"}. ` +
        verdict.reason +
        (overrode ? ` Coverage overridden: ${input.coverageOverrideReason}` : ""),
      ip: actor.ip,
      userAgent: actor.userAgent,
      requestId: actor.requestId,
    });

    await emit(
      tx,
      "warranty.claim_raised",
      {
        warrantyClaimId: created.id,
        number,
        accountId: account.id,
        equipmentId: equipment?.id ?? null,
        originalProjectId: input.originalProjectId ?? null,
        coverage,
        attribution,
        billable: verdict.billable,
        route: verdict.route,
        resultingTicketId,
        // §11: an AIES-caused defect auto-raises an NCR. Module 08 does not exist yet, so the
        // obligation travels on the event and is recorded on the claim — rather than being
        // remembered by nobody until module 08 lands.
        ncrRequired: verdict.ncrRequired,
        rootCauseCategory: input.rootCauseCategory ?? null,
      },
      { actorId: actor.actorId },
    );

    return created;
  });

  return {
    id: claim.id,
    number: claim.number,
    coverage,
    attribution,
    billable: verdict.billable,
    route: verdict.route,
    reason: verdict.reason,
    ncrRequired: verdict.ncrRequired,
    referToSales: verdict.referToSales,
    resultingTicketId,
    warnings: check.warnings,
    /** What the dates said, so the screen can show it beside what was decided. */
    reading,
  };
}

/**
 * Answers a claim that was left open because nobody could say who paid.
 *
 * Kept separate from raising because §11's undetermined route exists precisely so that the company
 * does not have to answer immediately — and a second act, by a named person, on a date, is what
 * makes the answer worth having.
 */
export async function determineWarrantyClaimService(
  actor: ActorMeta,
  input: {
    id: string;
    coverage: Coverage;
    attribution: Attribution;
    rootCause?: string | null;
    rootCauseCategory?: RootCauseCategory | null;
    coverageOverrideReason?: string | null;
  },
) {
  const claim = await db.warrantyClaim.findFirst({
    where: { id: input.id, deletedAt: null },
    include: { equipment: true, account: { select: { id: true, name: true } } },
  });
  if (!claim) {
    throw new TRPCError({ code: "NOT_FOUND", message: "That claim no longer exists." });
  }
  if (claim.status === "closed") {
    throw new TRPCError({ code: "BAD_REQUEST", message: "That claim is closed." });
  }

  const reading = readCoverage(claim.equipment);
  const check = checkClaim({
    faultDescription: claim.faultDescription,
    coverage: input.coverage,
    attribution: input.attribution,
    rootCauseCategory: input.rootCauseCategory,
    coverageOverrideReason: input.coverageOverrideReason,
    readingCoverage: claim.equipment ? reading.coverage : null,
  });
  if (!check.ok) {
    throw new TRPCError({ code: "BAD_REQUEST", message: check.errors.join(" ") });
  }

  const verdict = determine({ coverage: input.coverage, attribution: input.attribution });

  let resultingTicketId = claim.resultingTicketId;
  if (verdict.raisesTicket && !resultingTicketId) {
    const ticket = await createStandaloneTicketService(actor, {
      accountId: claim.accountId,
      projectId: claim.originalProjectId,
      type: "after_sales",
      subType: "warranty",
      priority: "high",
      title: `Warranty callback: ${claim.faultDescription.slice(0, 80)}`,
      scopeOfWork: claim.faultDescription,
      billable: verdict.billable,
      justification: `${claim.number}: ${verdict.reason}`,
    });
    resultingTicketId = ticket.id;
  }

  const updated = await db.$transaction(async (tx) => {
    const saved = await tx.warrantyClaim.update({
      where: { id: claim.id },
      data: {
        coverage: input.coverage,
        attribution: input.attribution,
        coverageDeterminedAt: new Date(),
        coverageDeterminedById: actor.actorId,
        coverageOverrideReason:
          claim.equipment && reading.coverage !== input.coverage
            ? (input.coverageOverrideReason ?? null)
            : null,
        rootCause: input.rootCause ?? claim.rootCause,
        rootCauseCategory: input.rootCauseCategory ?? claim.rootCauseCategory,
        billable: verdict.billable,
        ncrRequired: verdict.ncrRequired,
        salesReferredAt: verdict.referToSales ? new Date() : claim.salesReferredAt,
        resultingTicketId,
        status: verdict.route === "needs_determination" ? "open" : "routed",
        version: { increment: 1 },
      },
    });

    await writeAuditLog(tx, {
      actorId: actor.actorId,
      actorLabel: actor.actorLabel,
      action: "warranty_claim_determined",
      entityType: WARRANTY_ENTITY_TYPE,
      entityId: claim.id,
      summary:
        `${claim.number}: ${input.coverage.replace(/_/g, " ")}, ` +
        `${input.attribution.replace(/_/g, " ")}, ` +
        `${verdict.billable ? "billable" : "not billable"}. ${verdict.reason}`,
      diff: {
        coverage: { from: claim.coverage, to: input.coverage },
        attribution: { from: claim.attribution, to: input.attribution },
        billable: { from: claim.billable, to: verdict.billable },
      },
      ip: actor.ip,
      userAgent: actor.userAgent,
      requestId: actor.requestId,
    });

    await emit(
      tx,
      "warranty.claim_raised",
      {
        warrantyClaimId: claim.id,
        number: claim.number,
        accountId: claim.accountId,
        equipmentId: claim.equipmentId,
        originalProjectId: claim.originalProjectId,
        coverage: input.coverage,
        attribution: input.attribution,
        billable: verdict.billable,
        route: verdict.route,
        resultingTicketId,
        ncrRequired: verdict.ncrRequired,
        rootCauseCategory: input.rootCauseCategory ?? claim.rootCauseCategory,
      },
      { actorId: actor.actorId },
    );

    return saved;
  });

  return {
    id: updated.id,
    number: updated.number,
    billable: verdict.billable,
    route: verdict.route,
    reason: verdict.reason,
    ncrRequired: verdict.ncrRequired,
    resultingTicketId,
    warnings: check.warnings,
  };
}

// ---- reading ------------------------------------------------------------------------------------

export async function listWarrantyClaimsService(
  filter: { accountId?: string; projectId?: string; openOnly?: boolean } = {},
) {
  const rows = await db.warrantyClaim.findMany({
    where: {
      deletedAt: null,
      ...(filter.accountId ? { accountId: filter.accountId } : {}),
      ...(filter.projectId ? { originalProjectId: filter.projectId } : {}),
      ...(filter.openOnly ? { status: "open" } : {}),
    },
    include: { equipment: { select: { modelNumber: true, installedByTicketId: true } } },
    orderBy: { reportedAt: "desc" },
    take: 200,
  });

  return {
    rows,
    /** The ones nobody has answered. §11's undetermined route is a queue, not a resting place. */
    awaitingDetermination: rows.filter((row) => row.status === "open").length,
  };
}

/**
 * §11: "Warranty tickets are reported separately: count, cost, and root cause by product and by
 * technician. Warranty cost that nobody totals is warranty cost that never gets fixed."
 *
 * Cost is null until §16's timesheets and field expenses exist — the shape is here and the number
 * arrives with them, rather than the report waiting for a module that has not been built.
 */
export async function warrantyReportService(filter: { accountId?: string } = {}) {
  const rows = await db.warrantyClaim.findMany({
    where: { deletedAt: null, ...(filter.accountId ? { accountId: filter.accountId } : {}) },
    include: { equipment: { select: { modelNumber: true, installedByTicketId: true } } },
  });

  return warrantySummary(
    rows.map((row) => ({
      attribution: row.attribution as Attribution,
      coverage: row.coverage as Coverage,
      rootCauseCategory: row.rootCauseCategory,
      billable: row.billable,
      modelNumber: row.equipment?.modelNumber ?? null,
      installedByTicketId: row.equipment?.installedByTicketId ?? null,
      cost: null,
    })),
  );
}

/**
 * §16's renewal loop, run nightly: warranties about to expire.
 *
 * Emitted rather than notified directly, because §16 says this is where the recurring revenue lives
 * — the event is what module 01 will turn into a lead when it subscribes.
 */
export async function sweepExpiringWarrantiesService(days = 90) {
  const equipment = await db.equipment.findMany({
    where: { deletedAt: null, status: "active", warrantyEnd: { not: null } },
    select: {
      id: true,
      accountId: true,
      description: true,
      warrantyStart: true,
      warrantyEnd: true,
    },
  });

  const expiring = expiringWithin(equipment, days);
  if (expiring.length === 0) return { expiring: 0 };

  const byId = new Map(equipment.map((item) => [item.id, item]));

  await db.$transaction(async (tx) => {
    for (const entry of expiring) {
      const item = byId.get(entry.id);
      if (!item) continue;
      await emit(
        tx,
        "warranty.expiring",
        {
          equipmentId: item.id,
          accountId: item.accountId,
          description: item.description,
          warrantyEnd: item.warrantyEnd,
          daysRemaining: entry.daysRemaining,
        },
        {},
      );
    }
  });

  return { expiring: expiring.length };
}
