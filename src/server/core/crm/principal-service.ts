import { TRPCError } from "@trpc/server";
import type { Prisma } from "@prisma/client";
import { db } from "@/lib/db";
import { writeAuditLog } from "@/server/core/audit/audit";
import type { ActorMeta } from "@/server/core/crm/account-service";
import {
  assessPrincipal,
  checkPrincipalTransition,
  EXCLUSIVITY_TERMS,
  humanStage,
  PRINCIPAL_APPOINT_PERMISSION,
  PRINCIPAL_ENTITY_TYPE,
  PRINCIPAL_EXPIRY_WARNING_DAYS,
} from "@/server/core/crm/principal-lifecycle";
import { emit } from "@/server/core/events/emit";
import { notify } from "@/server/core/notify/notify";
import { registerNotificationType } from "@/server/core/notify/registry";
// Side-effect import: registers who may download an agreement or price list. Same pattern as
// accreditation-service.ts — the checker has to be loaded before /api/files/[id] can consult it.
import "./principal-access";

/**
 * Principal supplier and product acquisition (specs/01-crm-inquiry.md §5c).
 *
 * EM's pipeline. Structurally the inquiry's twin — an explicit stage machine, audit on every move,
 * events for other modules — pointed the other way: AIES pursuing a manufacturer rather than a
 * customer pursuing AIES.
 */

// Re-exported so callers that already import from this service do not need a second import. The
// definition lives in principal-lifecycle.ts to keep the access checker out of an import cycle.
export { PRINCIPAL_ENTITY_TYPE };

export const PRINCIPAL_EXPIRY_NOTIFICATION_TYPE = "principal.expiry_due";

registerNotificationType({
  key: PRINCIPAL_EXPIRY_NOTIFICATION_TYPE,
  label: "A distributor agreement or price list is expiring",
  // In-app only, like every other notification in this module, because `notify_email` still has no
  // handler and each send would dead-letter (docs/DECISIONS.md #10). This one has a stronger claim
  // on email than most once a provider exists: a lapsed price list is a margin incident, and §5c
  // says so in as many words.
  defaultChannels: { inApp: true, email: false, digest: false },
});

export interface CreatePrincipalInput {
  companyName: string;
  country?: string | null;
  website?: string | null;
  productLines?: string[];
  contactName?: string | null;
  email?: string | null;
  phone?: string | null;
  targetIndustries?: string[];
  competingBrands?: string[];
  estimatedOpportunity?: string | null;
  ownerId?: string | null;
  notes?: string | null;
}

export async function createPrincipalService(actor: ActorMeta, input: CreatePrincipalInput) {
  const companyName = input.companyName.trim();
  if (companyName.length === 0) {
    throw new TRPCError({ code: "BAD_REQUEST", message: "A prospect needs a company name." });
  }

  return db.$transaction(async (tx) => {
    const prospect = await tx.principalProspect.create({
      data: {
        companyName,
        country: input.country ?? null,
        website: input.website ?? null,
        productLines: input.productLines ?? [],
        contactName: input.contactName ?? null,
        email: input.email ?? null,
        phone: input.phone ?? null,
        targetIndustries: input.targetIndustries ?? [],
        competingBrands: input.competingBrands ?? [],
        estimatedOpportunity: input.estimatedOpportunity ?? null,
        notes: input.notes ?? null,
        // §5c is EM's work, but an unowned record is one nobody chases — the same reasoning as
        // accounts and inquiries.
        ownerId: input.ownerId ?? actor.actorId,
        stage: "identified",
      },
    });

    await writeAuditLog(tx, {
      actorId: actor.actorId,
      actorLabel: actor.actorLabel,
      action: "create",
      entityType: PRINCIPAL_ENTITY_TYPE,
      entityId: prospect.id,
      summary: `Added principal prospect ${prospect.companyName}`,
      ip: actor.ip,
      userAgent: actor.userAgent,
      requestId: actor.requestId,
    });

    return prospect;
  });
}

export interface UpdatePrincipalInput {
  prospectId: string;
  companyName?: string;
  country?: string | null;
  website?: string | null;
  productLines?: string[];
  contactName?: string | null;
  email?: string | null;
  phone?: string | null;
  targetIndustries?: string[];
  competingBrands?: string[];
  estimatedOpportunity?: string | null;
  exclusivity?: string;
  distributorAgreementFileId?: string | null;
  agreementSignedAt?: Date | null;
  agreementExpiresAt?: Date | null;
  priceListFileId?: string | null;
  priceListReceivedAt?: Date | null;
  priceListValidUntil?: Date | null;
  trainingStatus?: string | null;
  technicalContactId?: string | null;
  notes?: string | null;
  nextFollowUpAt?: Date | null;
  ownerId?: string | null;
}

/** Field edits only. `stage` moves through `transitionPrincipalService`, which is the only place
 *  §5c's pipeline rules are enforced. */
export async function updatePrincipalService(actor: ActorMeta, input: UpdatePrincipalInput) {
  if (input.exclusivity && !EXCLUSIVITY_TERMS.includes(input.exclusivity as "none")) {
    throw new TRPCError({
      code: "BAD_REQUEST",
      message: `"${input.exclusivity}" is not an exclusivity term.`,
    });
  }

  return db.$transaction(async (tx) => {
    const before = await tx.principalProspect.findFirst({
      where: { id: input.prospectId, deletedAt: null },
      select: {
        id: true,
        companyName: true,
        exclusivity: true,
        agreementExpiresAt: true,
        priceListValidUntil: true,
        ownerId: true,
      },
    });
    if (!before) {
      throw new TRPCError({ code: "NOT_FOUND", message: "That prospect no longer exists." });
    }

    const data: Record<string, unknown> = {};
    const diff: Record<string, { from: unknown; to: unknown }> = {};

    const track = <K extends keyof typeof before>(field: K, next: unknown) => {
      if (next === undefined) return;
      const current = before[field];
      const changed =
        current instanceof Date && next instanceof Date
          ? current.getTime() !== next.getTime()
          : current !== next;
      if (changed) diff[field as string] = { from: current, to: next };
      data[field as string] = next;
    };

    track("companyName", input.companyName?.trim());
    track("exclusivity", input.exclusivity);
    track("ownerId", input.ownerId ?? undefined);
    // Tracked in the diff rather than merely written: these two dates are the ones §5c cares about,
    // and "who moved the price-list validity, and when" is a question somebody will eventually ask
    // after a margin incident.
    track("agreementExpiresAt", input.agreementExpiresAt);
    track("priceListValidUntil", input.priceListValidUntil);

    for (const field of [
      "country",
      "website",
      "productLines",
      "contactName",
      "email",
      "phone",
      "targetIndustries",
      "competingBrands",
      "estimatedOpportunity",
      "distributorAgreementFileId",
      "agreementSignedAt",
      "priceListFileId",
      "priceListReceivedAt",
      "trainingStatus",
      "technicalContactId",
      "notes",
      "nextFollowUpAt",
    ] as const) {
      if (input[field] !== undefined) data[field] = input[field];
    }

    const prospect = await tx.principalProspect.update({
      where: { id: before.id },
      data,
    });

    await writeAuditLog(tx, {
      actorId: actor.actorId,
      actorLabel: actor.actorLabel,
      action: "update",
      entityType: PRINCIPAL_ENTITY_TYPE,
      entityId: prospect.id,
      summary: `Updated principal prospect ${prospect.companyName}`,
      diff: Object.keys(diff).length > 0 ? diff : undefined,
      ip: actor.ip,
      userAgent: actor.userAgent,
      requestId: actor.requestId,
    });

    return prospect;
  });
}

export interface TransitionPrincipalResult {
  stage: string;
  /** Set when this move was the appointment, so the caller can say what happens next. */
  appointed?: boolean;
}

/**
 * The one place a prospect's stage changes.
 *
 * The interesting move is `appointed`. §5c: "On `stage = appointed`, the prospect converts into a
 * `Supplier` (module 03) with `isPrincipal = true`, carrying the agreement, price list, and
 * contacts across. No re-keying."
 *
 * Module 03 does not exist, and inventing a `Supplier` model here would leave that module something
 * to reconcile rather than something to build — the same trap the ISO 8.4 supplier register was
 * kept out of in session 1. So the appointment emits `principal.appointed` carrying everything the
 * conversion needs, and module 03 subscribes and writes back `supplierId`. Until it does, the
 * prospect sits appointed with `supplierId` null, which is an accurate description of reality:
 * AIES has appointed them and the purchasing record does not exist yet.
 *
 * Appointing is gated on having an agreement on file. §5c calls the distributor agreement and its
 * expiry the substance of the appointment, and an appointment with no agreement behind it is a
 * claim nobody can check.
 */
export async function transitionPrincipalService(
  actor: ActorMeta,
  input: {
    prospectId: string;
    to: string;
    reason?: string | null;
    /**
     * Appoints without the agreement on file, at the company's explicit request: "sometimes these
     * are not needed for small suppliers". Requires `principal.appoint` and a typed reason — the
     * point is not to remove the rule but to record who set it aside and why.
     */
    overrideDocuments?: string | null;
  },
): Promise<TransitionPrincipalResult> {
  return db.$transaction(async (tx) => {
    const prospect = await tx.principalProspect.findFirst({
      where: { id: input.prospectId, deletedAt: null },
    });
    if (!prospect) {
      throw new TRPCError({ code: "NOT_FOUND", message: "That prospect no longer exists." });
    }

    const check = checkPrincipalTransition(prospect.stage, input.to);
    if (!check.ok) {
      throw new TRPCError({ code: "BAD_REQUEST", message: check.reason! });
    }

    const overrideReason = input.overrideDocuments?.trim() ?? "";

    if (input.to === "appointed") {
      /**
       * The appointment is the president's or the vice-president's, and nobody else's.
       *
       * The company asked for this directly. It is also the only stage that means anything outside
       * the pipeline: appointing commits AIES to sell a manufacturer's equipment, converts into a
       * module 03 supplier, and unlocks the RFQ flow. Every other stage is a note about how a
       * conversation is going, which is why they stay with whoever manages principals.
       *
       * **Refused when the permission set is absent**, not skipped. `ActorMeta.permissions` is
       * optional so sweeps and subscribers need not fabricate one, and the acknowledgement check
       * treats absence as "not a person, skip it". That default is wrong here: nothing in this
       * system appoints a principal automatically, so an unauthenticated path reaching this line is
       * a bug, and the safe reading of a missing permission set is no.
       */
      if (!actor.permissions?.has(PRINCIPAL_APPOINT_PERMISSION)) {
        throw new TRPCError({
          code: "FORBIDDEN",
          message:
            `Only the president or the vice-president can appoint a principal. Everything up to ` +
            `${humanStage("agreement_draft")} is yours to move; the appointment itself is theirs.`,
        });
      }

      const missing: string[] = [];
      if (!prospect.distributorAgreementFileId) missing.push("the signed distributor agreement");
      if (!prospect.agreementExpiresAt) missing.push("the agreement's expiry date");

      if (missing.length > 0 && overrideReason.length < 10) {
        throw new TRPCError({
          code: "BAD_REQUEST",
          message:
            `Attach ${missing.join(" and ")} before appointing ${prospect.companyName}. ` +
            `An appointment with no agreement behind it is a claim nobody can check — or, if this ` +
            `supplier is too small to have one, say so in writing and appoint anyway.`,
        });
      }
    } else if (overrideReason.length > 0) {
      // An override on a move that has nothing to override is either a mistake or a misunderstanding
      // of what the field does, and silently ignoring it would teach the wrong lesson.
      throw new TRPCError({
        code: "BAD_REQUEST",
        message:
          "The document requirement only applies to appointing, so there is nothing to set aside here.",
      });
    }

    const overrodeDocuments =
      input.to === "appointed" &&
      overrideReason.length > 0 &&
      (!prospect.distributorAgreementFileId || !prospect.agreementExpiresAt);

    const updated = await tx.principalProspect.update({
      where: { id: prospect.id },
      data: {
        stage: input.to,
        notes: input.reason ? `${prospect.notes ?? ""}\n${input.reason}`.trim() : prospect.notes,
        ...(overrodeDocuments
          ? {
              // On the record as well as in the audit log, for the same reason §4's requirements
              // override is: the audit log is the evidence, this is what the next person to open
              // the prospect reads without having to go looking.
              appointmentOverrideReason: overrideReason,
              appointmentOverrideBy: actor.actorId,
              appointmentOverrideAt: new Date(),
            }
          : {}),
      },
    });

    await writeAuditLog(tx, {
      actorId: actor.actorId,
      actorLabel: actor.actorLabel,
      action: "stage_changed",
      entityType: PRINCIPAL_ENTITY_TYPE,
      entityId: updated.id,
      summary:
        `${updated.companyName}: ${humanStage(prospect.stage)} → ${humanStage(input.to)}` +
        (input.reason ? ` (${input.reason})` : ""),
      diff: { stage: { from: prospect.stage, to: input.to } },
      ip: actor.ip,
      userAgent: actor.userAgent,
      requestId: actor.requestId,
    });

    if (overrodeDocuments) {
      // Its own audit row rather than a clause on the one above: "who appointed this principal
      // without an agreement, and what did they say about it" is a question an ISO 9001 auditor
      // asks on its own, and it should be findable on its own.
      await writeAuditLog(tx, {
        actorId: actor.actorId,
        actorLabel: actor.actorLabel,
        action: "appointment_documents_overridden",
        entityType: PRINCIPAL_ENTITY_TYPE,
        entityId: updated.id,
        summary: `Appointed ${updated.companyName} without the usual documents: ${overrideReason}`,
        ip: actor.ip,
        userAgent: actor.userAgent,
        requestId: actor.requestId,
      });
    }

    const meta = { actorId: actor.actorId, requestId: actor.requestId };
    await emit(
      tx,
      "principal.stage_changed",
      { prospectId: updated.id, from: prospect.stage, to: input.to },
      meta,
    );

    if (input.to === "appointed") {
      // Everything module 03 needs to create the Supplier without re-keying, per §5c. Carried in
      // the payload rather than left for the subscriber to re-read, so the conversion is a function
      // of what was true at the moment of appointment.
      await emit(
        tx,
        "principal.appointed",
        {
          prospectId: updated.id,
          companyName: updated.companyName,
          country: updated.country,
          website: updated.website,
          productLines: updated.productLines,
          contactName: updated.contactName,
          email: updated.email,
          phone: updated.phone,
          exclusivity: updated.exclusivity,
          distributorAgreementFileId: updated.distributorAgreementFileId,
          agreementSignedAt: updated.agreementSignedAt?.toISOString() ?? null,
          agreementExpiresAt: updated.agreementExpiresAt?.toISOString() ?? null,
          priceListFileId: updated.priceListFileId,
          priceListValidUntil: updated.priceListValidUntil?.toISOString() ?? null,
          technicalContactId: updated.technicalContactId,
          isPrincipal: true,
        },
        meta,
      );
    }

    return { stage: updated.stage, appointed: input.to === "appointed" };
  });
}

/**
 * Records the module 03 Supplier this prospect became.
 *
 * Exists now so the subscriber module 03 will write has somewhere to land, and so the "exactly one
 * supplier" rule §10 asks for lives in this module rather than being re-derived over there. Refuses
 * a second call: §10's test is that appointing "creates exactly one supplier", and idempotency is
 * the property that makes a redelivered event safe — module 00's job queue guarantees at-least-once
 * delivery, not exactly-once.
 */
export async function linkPrincipalSupplierService(input: {
  prospectId: string;
  supplierId: string;
}) {
  const prospect = await db.principalProspect.findFirst({
    where: { id: input.prospectId, deletedAt: null },
    select: { id: true, stage: true, supplierId: true, companyName: true },
  });
  if (!prospect) {
    throw new TRPCError({ code: "NOT_FOUND", message: "That prospect no longer exists." });
  }
  if (prospect.stage !== "appointed") {
    throw new TRPCError({
      code: "BAD_REQUEST",
      message: `${prospect.companyName} is not appointed, so it has no supplier record.`,
    });
  }
  if (prospect.supplierId && prospect.supplierId !== input.supplierId) {
    throw new TRPCError({
      code: "BAD_REQUEST",
      message: `${prospect.companyName} is already linked to a different supplier record.`,
    });
  }
  if (prospect.supplierId === input.supplierId) {
    return { ok: true as const, alreadyLinked: true };
  }

  await db.principalProspect.update({
    where: { id: prospect.id },
    data: { supplierId: input.supplierId },
  });
  return { ok: true as const, alreadyLinked: false };
}

// ---- reads --------------------------------------------------------------------------------------

export async function listPrincipalsService(params: { stage?: string; search?: string } = {}) {
  const search = params.search?.trim();
  const rows = await db.principalProspect.findMany({
    where: {
      deletedAt: null,
      ...(params.stage ? { stage: params.stage } : {}),
      ...(search
        ? {
            OR: [
              { companyName: { contains: search, mode: "insensitive" as const } },
              { country: { contains: search, mode: "insensitive" as const } },
              { productLines: { has: search } },
            ],
          }
        : {}),
    },
    orderBy: [{ stage: "asc" }, { companyName: "asc" }],
  });

  const now = new Date();
  return rows.map((row) => ({
    ...row,
    estimatedOpportunity: row.estimatedOpportunity?.toString() ?? null,
    health: assessPrincipal(row, now),
  }));
}

export async function getPrincipalService(prospectId: string) {
  const prospect = await db.principalProspect.findFirst({
    where: { id: prospectId, deletedAt: null },
  });
  if (!prospect) {
    throw new TRPCError({ code: "NOT_FOUND", message: "That prospect no longer exists." });
  }
  return {
    ...prospect,
    estimatedOpportunity: prospect.estimatedOpportunity?.toString() ?? null,
    health: assessPrincipal(prospect),
  };
}

// ---- the nightly expiry sweep -------------------------------------------------------------------

export interface PrincipalExpirySweepResult {
  notified: { prospectId: string; companyName: string; kind: string; daysRemaining: number }[];
  scanned: number;
}

/**
 * Warns the owner before a distributor agreement or a price list lapses.
 *
 * Fires on the exact day a threshold is crossed, matching the accreditation sweep — a daily repeat
 * is how a notification becomes background noise. Two thresholds rather than §5b's three: an
 * agreement renewal is a conversation with one manufacturer, not the multi-week document exercise
 * a customer accreditation is.
 */
const PRINCIPAL_THRESHOLD_DAYS = [PRINCIPAL_EXPIRY_WARNING_DAYS, 14] as const;
const DAY_MS = 86_400_000;

export async function sweepPrincipalExpiries(
  now: Date = new Date(),
): Promise<PrincipalExpirySweepResult> {
  const horizon = new Date(now.getTime() + Math.max(...PRINCIPAL_THRESHOLD_DAYS) * DAY_MS);

  const candidates = await db.principalProspect.findMany({
    where: {
      deletedAt: null,
      // `declined` prospects have no agreement to renew. Everything else might.
      stage: { not: "declined" },
      OR: [
        { agreementExpiresAt: { not: null, lte: horizon } },
        { priceListValidUntil: { not: null, lte: horizon } },
      ],
    },
  });

  const startOfDay = (d: Date) => Math.floor(d.getTime() / DAY_MS);
  const notified: PrincipalExpirySweepResult["notified"] = [];

  for (const prospect of candidates) {
    for (const [kind, at, label] of [
      ["agreement", prospect.agreementExpiresAt, "Distributor agreement"],
      ["price_list", prospect.priceListValidUntil, "Price list"],
    ] as const) {
      if (!at) continue;
      const daysRemaining = startOfDay(at) - startOfDay(now);
      const threshold = PRINCIPAL_THRESHOLD_DAYS.find((t) => t === daysRemaining);
      if (threshold === undefined) continue;

      await notify({
        recipientId: prospect.ownerId,
        type: PRINCIPAL_EXPIRY_NOTIFICATION_TYPE,
        title: `${label} expires in ${threshold} days — ${prospect.companyName}`,
        body:
          kind === "price_list"
            ? `Quotations costed against this price list after ${at.toISOString().slice(0, 10)} ` +
              `will be built on lapsed prices.`
            : `AIES stops being an appointed distributor on ${at.toISOString().slice(0, 10)} ` +
              `unless this is renewed.`,
        entityType: PRINCIPAL_ENTITY_TYPE,
        entityId: prospect.id,
      });

      notified.push({
        prospectId: prospect.id,
        companyName: prospect.companyName,
        kind,
        daysRemaining: threshold,
      });
    }
  }

  return { notified, scanned: candidates.length };
}

export type PrincipalWhere = Prisma.PrincipalProspectWhereInput;
