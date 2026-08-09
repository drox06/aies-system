import { TRPCError } from "@trpc/server";
import type { Prisma } from "@prisma/client";
import { db } from "@/lib/db";
import { businessMsBetween } from "@/server/core/calendar/business-days";
import { writeAuditLog } from "@/server/core/audit/audit";
import type { ActorMeta } from "@/server/core/crm/account-service";
import {
  assessInquirySla,
  checkTransition,
  humanStatus,
  INQUIRY_SOURCES,
  LOST_REASONS,
  type InquiryStatus,
} from "@/server/core/crm/inquiry-lifecycle";
import {
  assessRequirements,
  SEED_REQUIREMENT_TEMPLATES,
  type CompletenessResult,
  type RequirementTemplateDef,
} from "@/server/core/crm/requirements";
import { emit } from "@/server/core/events/emit";
import { allocateNumber } from "@/server/core/numbering/numbering";
import { indexEntity } from "@/server/core/search/index-service";

/**
 * Inquiry writes (specs/01-crm-inquiry.md §§2–4).
 *
 * Out of the router for the reason established in module 00 session 3: a router module pulls in
 * Auth.js, which cannot load outside the Next.js runtime, so anything defined there is untestable.
 */

export const INQUIRY_ENTITY_TYPE = "Inquiry";

// ---- scoping ------------------------------------------------------------------------------------

/**
 * §10: "Record scoping: salesperson A cannot read salesperson B's inquiry without `crm.view_all`."
 *
 * A `where` fragment, not a post-filter, for the same reason as accounts: filtering after the query
 * pages wrongly and still fetches rows the user may not read.
 */
export function inquiryScopeWhere(user: {
  id: string;
  permissions: ReadonlySet<string>;
}): Prisma.InquiryWhereInput {
  if (user.permissions.has("crm.view_all")) return {};

  // Owning the inquiry is the main route in. The second is §5's inspection request: a technician
  // sent to a plant has to be able to read the inquiry to see the questions the visit must answer
  // and the site's access constraints. Without this the assignment notification links to a record
  // the recipient cannot open, which is worse than not notifying them at all.
  //
  // Deliberately not limited to *open* inspections. Completing one would otherwise revoke access
  // to the record the technician had just written findings on, and looking back at your own past
  // site visit is legitimate. Deleted requests do not count.
  return {
    OR: [
      { ownerId: user.id },
      { inspections: { some: { assignedToId: user.id, deletedAt: null } } },
    ],
  };
}

// ---- templates ----------------------------------------------------------------------------------

/**
 * The active templates, falling back to the seeded definitions when the table is empty.
 *
 * The fallback is not laziness: it means the completeness gate behaves identically on a database
 * that has been seeded and one that has not, so a fresh environment cannot accidentally let every
 * inquiry through the gate because a seed step was skipped. A gate that silently opens is worse
 * than one that is absent, because everyone assumes it is working.
 */
export async function loadRequirementTemplates(): Promise<RequirementTemplateDef[]> {
  const rows = await db.requirementTemplate.findMany({ where: { isActive: true } });
  if (rows.length === 0) return SEED_REQUIREMENT_TEMPLATES;
  return rows.map((row) => ({
    serviceType: row.serviceType as RequirementTemplateDef["serviceType"],
    label: row.label,
    // Through `unknown` because the column is `Json`: Prisma types it as JsonValue, which cannot
    // narrow to a field array without saying so. The shape is enforced by the router's Zod schema
    // on the way in, which is the only path that writes it.
    fields: (row.fields ?? []) as unknown as RequirementTemplateDef["fields"],
  }));
}

export async function listRequirementTemplatesService(): Promise<RequirementTemplateDef[]> {
  return loadRequirementTemplates();
}

/** §4: "editable in settings". Admin-gated at the router. */
export async function upsertRequirementTemplateService(
  actor: ActorMeta,
  input: { serviceType: string; label: string; fields: unknown; isActive?: boolean },
) {
  return db.$transaction(async (tx) => {
    const template = await tx.requirementTemplate.upsert({
      where: { serviceType: input.serviceType },
      update: {
        label: input.label,
        fields: input.fields as Prisma.InputJsonValue,
        isActive: input.isActive ?? true,
      },
      create: {
        serviceType: input.serviceType,
        label: input.label,
        fields: input.fields as Prisma.InputJsonValue,
        isActive: input.isActive ?? true,
      },
    });

    await writeAuditLog(tx, {
      actorId: actor.actorId,
      actorLabel: actor.actorLabel,
      action: "update",
      entityType: "RequirementTemplate",
      entityId: template.id,
      summary: `Updated the ${template.label} requirements template`,
      ip: actor.ip,
      userAgent: actor.userAgent,
      requestId: actor.requestId,
    });

    return template;
  });
}

// ---- completeness -------------------------------------------------------------------------------

interface CompletenessSubject {
  requirements: Prisma.JsonValue;
  items: { serviceType: string | null }[];
  requirementsOverrideReason: string | null;
}

export interface CompletenessView extends CompletenessResult {
  /** True when the §4 gate would let this inquiry move to `quoting`. */
  satisfied: boolean;
  overrideReason: string | null;
}

export async function assessInquiryCompleteness(
  inquiry: CompletenessSubject,
  templates?: readonly RequirementTemplateDef[],
): Promise<CompletenessView> {
  const loaded = templates ?? (await loadRequirementTemplates());
  const serviceTypes = inquiry.items
    .map((item) => item.serviceType)
    .filter((value): value is string => Boolean(value));

  const result = assessRequirements(
    loaded,
    serviceTypes,
    (inquiry.requirements ?? {}) as Record<string, unknown>,
  );

  return {
    ...result,
    // An override already recorded keeps the gate open. §4 asks for "or the user explicitly
    // overrides with a reason (logged)", not for the override to be re-entered on every attempt.
    satisfied: result.complete || inquiry.requirementsOverrideReason !== null,
    overrideReason: inquiry.requirementsOverrideReason,
  };
}

// ---- create / update ----------------------------------------------------------------------------

export interface InquiryItemInput {
  description: string;
  quantity?: string;
  unit?: string;
  manufacturer?: string | null;
  modelNumber?: string | null;
  serviceType?: string | null;
  specifications?: unknown;
  notes?: string | null;
}

export interface CreateInquiryInput {
  subject: string;
  description?: string | null;
  accountId?: string | null;
  siteId?: string | null;
  contactId?: string | null;
  source?: string;
  sourceRef?: string | null;
  receivedAt?: Date | null;
  industry?: string | null;
  estimatedValue?: string | null;
  currency?: string;
  requiredByDate?: Date | null;
  requirements?: Record<string, unknown>;
  ownerId?: string | null;
  items?: InquiryItemInput[];
}

/**
 * §8: "Make the manual quick-create form genuinely fast: it is now the only way inquiries enter the
 * system." So `subject` is the only required field. Everything else — account, items, requirements —
 * can be filled in afterwards, because the alternative is a salesperson on a phone call abandoning
 * the form and writing the inquiry on paper, which is the failure this module exists to remove.
 */
export async function createInquiryService(actor: ActorMeta, input: CreateInquiryInput) {
  const subject = input.subject.trim();
  if (subject.length === 0) {
    throw new TRPCError({ code: "BAD_REQUEST", message: "An inquiry needs a subject." });
  }
  if (input.source && !INQUIRY_SOURCES.includes(input.source as (typeof INQUIRY_SOURCES)[number])) {
    throw new TRPCError({ code: "BAD_REQUEST", message: `Unknown source "${input.source}".` });
  }

  // Allocated before the transaction opens — allocateNumber takes no transaction client. Module
  // 00's contract permits gaps and Spec.md §5 says they are "permitted and logged", so a rollback
  // below burns INQ-2608-0042 and the next inquiry is 0043.
  const number = await allocateNumber("inquiry");
  const receivedAt = input.receivedAt ?? new Date();

  const inquiry = await db.$transaction(async (tx) => {
    if (input.accountId) {
      const account = await tx.customerAccount.findFirst({
        where: { id: input.accountId, deletedAt: null },
        select: { id: true },
      });
      if (!account) {
        throw new TRPCError({ code: "BAD_REQUEST", message: "That account does not exist." });
      }
    }

    const created = await tx.inquiry.create({
      data: {
        number,
        subject,
        description: input.description ?? null,
        accountId: input.accountId ?? null,
        siteId: input.siteId ?? null,
        contactId: input.contactId ?? null,
        source: input.source ?? "phone",
        sourceRef: input.sourceRef ?? null,
        receivedAt,
        industry: input.industry ?? null,
        estimatedValue: input.estimatedValue ?? null,
        currency: input.currency ?? "PHP",
        requiredByDate: input.requiredByDate ?? null,
        requirements: (input.requirements ?? {}) as Prisma.InputJsonValue,
        // Unowned inquiries are exactly the ones that get lost, so the creator owns it until
        // somebody with `inquiry.assign` says otherwise.
        ownerId: input.ownerId ?? actor.actorId,
        status: "new",
        items: input.items?.length
          ? {
              create: input.items.map((item, index) => ({
                lineNo: index + 1,
                description: item.description,
                quantity: item.quantity ?? "1",
                unit: item.unit ?? "pc",
                manufacturer: item.manufacturer ?? null,
                modelNumber: item.modelNumber ?? null,
                serviceType: item.serviceType ?? null,
                specifications: (item.specifications ?? undefined) as Prisma.InputJsonValue,
                notes: item.notes ?? null,
              })),
            }
          : undefined,
      },
    });

    await writeAuditLog(tx, {
      actorId: actor.actorId,
      actorLabel: actor.actorLabel,
      action: "create",
      entityType: INQUIRY_ENTITY_TYPE,
      entityId: created.id,
      summary: `Logged inquiry ${created.number} — ${created.subject}`,
      ip: actor.ip,
      userAgent: actor.userAgent,
      requestId: actor.requestId,
    });

    await emit(
      tx,
      "inquiry.created",
      { inquiryId: created.id, number: created.number, accountId: created.accountId },
      { actorId: actor.actorId, requestId: actor.requestId },
    );

    return created;
  });

  await reindexInquiry(inquiry.id);
  return inquiry;
}

/**
 * Keeps the Ctrl+K palette able to find inquiries.
 *
 * Outside the transaction and deliberately non-fatal: the search index is a convenience, and a
 * failed upsert into it must never roll back a logged inquiry. specs/00-foundation.md §7.7 wants
 * this driven by event subscription eventually; calling it directly is the honest interim, and it
 * is one call site to move.
 */
export async function reindexInquiry(inquiryId: string): Promise<void> {
  try {
    const inquiry = await db.inquiry.findUnique({
      where: { id: inquiryId },
      select: {
        id: true,
        number: true,
        subject: true,
        description: true,
        status: true,
        account: { select: { name: true, code: true } },
      },
    });
    if (!inquiry) return;

    await indexEntity({
      entityType: INQUIRY_ENTITY_TYPE,
      entityId: inquiry.id,
      title: `${inquiry.number} — ${inquiry.subject}`,
      body: [inquiry.description, inquiry.account?.name, inquiry.account?.code, inquiry.status]
        .filter(Boolean)
        .join(" "),
      href: `/crm/inquiries/${inquiry.id}`,
    });
  } catch (error) {
    console.error("[crm] failed to index inquiry", inquiryId, error);
  }
}

export interface UpdateInquiryInput {
  inquiryId: string;
  subject?: string;
  description?: string | null;
  accountId?: string | null;
  siteId?: string | null;
  contactId?: string | null;
  source?: string;
  receivedAt?: Date | null;
  industry?: string | null;
  estimatedValue?: string | null;
  requiredByDate?: Date | null;
  nextFollowUpAt?: Date | null;
  qualification?: unknown;
  requirements?: Record<string, unknown>;
}

/**
 * Field edits only. `status` is absent by design — it moves through `transitionInquiryService`,
 * which is the only place the §3 diagram is enforced. An `update` that accepted a status would be
 * a second, unguarded door into the same field.
 */
export async function updateInquiryService(actor: ActorMeta, input: UpdateInquiryInput) {
  const inquiry = await db.$transaction(async (tx) => {
    const before = await tx.inquiry.findFirst({
      where: { id: input.inquiryId, deletedAt: null },
      select: {
        id: true,
        number: true,
        subject: true,
        accountId: true,
        ownerId: true,
        receivedAt: true,
        industry: true,
        requiredByDate: true,
      },
    });
    if (!before) {
      throw new TRPCError({ code: "NOT_FOUND", message: "That inquiry no longer exists." });
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

    track("subject", input.subject?.trim());
    track("accountId", input.accountId);
    track("receivedAt", input.receivedAt ?? undefined);
    track("industry", input.industry);
    track("requiredByDate", input.requiredByDate);

    for (const field of [
      "description",
      "siteId",
      "contactId",
      "source",
      "estimatedValue",
      "nextFollowUpAt",
      "qualification",
      "requirements",
    ] as const) {
      if (input[field] !== undefined) data[field] = input[field];
    }

    const updated = await tx.inquiry.update({ where: { id: input.inquiryId }, data });

    await writeAuditLog(tx, {
      actorId: actor.actorId,
      actorLabel: actor.actorLabel,
      action: "update",
      entityType: INQUIRY_ENTITY_TYPE,
      entityId: updated.id,
      summary: `Updated inquiry ${updated.number}`,
      diff: Object.keys(diff).length > 0 ? diff : undefined,
      ip: actor.ip,
      userAgent: actor.userAgent,
      requestId: actor.requestId,
    });

    return updated;
  });

  await reindexInquiry(inquiry.id);
  return inquiry;
}

/** §8's `inquiry.assigned`. Separate from `update` because §9 gates it on its own permission. */
export async function assignInquiryService(
  actor: ActorMeta,
  input: { inquiryId: string; ownerId: string },
) {
  return db.$transaction(async (tx) => {
    const before = await tx.inquiry.findFirst({
      where: { id: input.inquiryId, deletedAt: null },
      select: { id: true, number: true, ownerId: true },
    });
    if (!before) {
      throw new TRPCError({ code: "NOT_FOUND", message: "That inquiry no longer exists." });
    }

    const owner = await tx.user.findFirst({
      where: { id: input.ownerId, isActive: true, deletedAt: null },
      select: { id: true, name: true },
    });
    if (!owner) {
      throw new TRPCError({
        code: "BAD_REQUEST",
        message: "That user cannot own an inquiry — they are inactive or no longer exist.",
      });
    }

    const updated = await tx.inquiry.update({
      where: { id: before.id },
      data: { ownerId: owner.id, assignedAt: new Date() },
    });

    await writeAuditLog(tx, {
      actorId: actor.actorId,
      actorLabel: actor.actorLabel,
      action: "assign",
      entityType: INQUIRY_ENTITY_TYPE,
      entityId: updated.id,
      summary: `Assigned inquiry ${updated.number} to ${owner.name}`,
      diff: { ownerId: { from: before.ownerId, to: owner.id } },
      ip: actor.ip,
      userAgent: actor.userAgent,
      requestId: actor.requestId,
    });

    await emit(
      tx,
      "inquiry.assigned",
      { inquiryId: updated.id, number: updated.number, ownerId: owner.id },
      { actorId: actor.actorId, requestId: actor.requestId },
    );

    return updated;
  });
}

// ---- the state machine --------------------------------------------------------------------------

export interface TransitionInput {
  inquiryId: string;
  to: string;
  lostReason?: string | null;
  lostToCompetitor?: string | null;
  /** Set only by a module reacting to a domain event. Never wired to user input. */
  bySystem?: boolean;
}

/**
 * The one place an inquiry's status changes.
 *
 * §3's rules land here rather than being spread across call sites, because the value of a state
 * machine is that there is exactly one door. Each rule below is one line of §3:
 *   - legal moves come from `ALLOWED_TRANSITIONS`
 *   - `lostReason` is required on `lost`
 *   - moving to `quoting` needs §4's requirements complete, or an override already logged
 *   - `acknowledged` stops the SLA clock; `inspection_required` pauses it and leaving resumes it
 *   - every change writes to the audit log — which is also what puts it in the activity feed, since
 *     module 00's feed merges audit rows for the entity
 */
export async function transitionInquiryService(actor: ActorMeta, input: TransitionInput) {
  const now = new Date();

  const result = await db.$transaction(async (tx) => {
    const inquiry = await tx.inquiry.findFirst({
      where: { id: input.inquiryId, deletedAt: null },
      include: { items: { select: { serviceType: true } } },
    });
    if (!inquiry) {
      throw new TRPCError({ code: "NOT_FOUND", message: "That inquiry no longer exists." });
    }

    const check = checkTransition(inquiry.status, input.to, { bySystem: input.bySystem });
    if (!check.ok) {
      throw new TRPCError({ code: "BAD_REQUEST", message: check.reason! });
    }

    const to = input.to as InquiryStatus;
    const data: Prisma.InquiryUpdateInput = { status: to };

    // §3: "`lostReason` is a required, configurable picklist."
    if (to === "lost") {
      if (!input.lostReason) {
        throw new TRPCError({
          code: "BAD_REQUEST",
          message: "A lost inquiry needs a reason — the pipeline report is worthless without it.",
        });
      }
      if (!LOST_REASONS.includes(input.lostReason as (typeof LOST_REASONS)[number])) {
        throw new TRPCError({
          code: "BAD_REQUEST",
          message: `"${input.lostReason}" is not one of the loss reasons.`,
        });
      }
      data.lostReason = input.lostReason;
      data.lostToCompetitor = input.lostToCompetitor ?? null;
    }

    // §4's gate.
    if (check.definition?.requiresCompleteRequirements) {
      const completeness = await assessInquiryCompleteness(inquiry);
      if (!completeness.satisfied) {
        const missing = completeness.missing.map((m) => m.label).join(", ");
        throw new TRPCError({
          code: "BAD_REQUEST",
          message:
            `${completeness.missing.length} required requirement(s) are unanswered: ${missing}. ` +
            `Answer them, or override with a reason.`,
        });
      }
    }

    // §3's SLA, and §5's pause.
    if (to === "acknowledged" && inquiry.acknowledgedAt === null) {
      data.acknowledgedAt = now;
    }
    if (to === "inspection_required") {
      data.slaPausedAt = now;
    }
    if (inquiry.slaPausedAt && to !== "inspection_required") {
      // Resuming: bank the paused time in *business* milliseconds, so a pause over a weekend gives
      // back only the working part rather than two free days of budget.
      data.slaPausedMs = inquiry.slaPausedMs + businessMsBetween(inquiry.slaPausedAt, now);
      data.slaPausedAt = null;
    }

    const updated = await tx.inquiry.update({ where: { id: inquiry.id }, data });

    await writeAuditLog(tx, {
      actorId: actor.actorId,
      actorLabel: actor.actorLabel,
      action: "status_changed",
      entityType: INQUIRY_ENTITY_TYPE,
      entityId: updated.id,
      summary:
        `${updated.number}: ${humanStatus(inquiry.status)} → ${humanStatus(to)}` +
        (input.lostReason ? ` (${input.lostReason})` : ""),
      diff: { status: { from: inquiry.status, to } },
      ip: actor.ip,
      userAgent: actor.userAgent,
      requestId: actor.requestId,
    });

    const meta = { actorId: actor.actorId, requestId: actor.requestId };
    const payload = { inquiryId: updated.id, number: updated.number, from: inquiry.status, to };

    await emit(tx, "inquiry.status_changed", payload, meta);

    // §8's named events, in addition to the generic one. A subscriber that only cares about
    // acknowledgement should not have to filter every status change to find it.
    if (to === "acknowledged") await emit(tx, "inquiry.acknowledged", payload, meta);
    if (to === "quoting") await emit(tx, "inquiry.quoting_started", payload, meta);
    if (to === "lost") {
      await emit(tx, "inquiry.lost", { ...payload, lostReason: input.lostReason }, meta);
    }

    return updated;
  });

  await reindexInquiry(result.id);
  return result;
}

/**
 * §4: "or the user explicitly overrides with a reason (logged)".
 *
 * Recorded on the record *and* in the audit log. The audit row is the evidence; the field is what
 * the next person to open the inquiry sees, without having to go looking for why a half-answered
 * inquiry was quoted.
 */
export async function overrideRequirementsService(
  actor: ActorMeta,
  input: { inquiryId: string; reason: string },
) {
  const reason = input.reason.trim();
  if (reason.length < 10) {
    throw new TRPCError({
      code: "BAD_REQUEST",
      message: "Give a real reason for overriding the requirements check — at least a sentence.",
    });
  }

  return db.$transaction(async (tx) => {
    const inquiry = await tx.inquiry.findFirst({
      where: { id: input.inquiryId, deletedAt: null },
      select: { id: true, number: true },
    });
    if (!inquiry) {
      throw new TRPCError({ code: "NOT_FOUND", message: "That inquiry no longer exists." });
    }

    const updated = await tx.inquiry.update({
      where: { id: inquiry.id },
      data: {
        requirementsOverrideReason: reason,
        requirementsOverrideBy: actor.actorId,
        requirementsOverrideAt: new Date(),
      },
    });

    await writeAuditLog(tx, {
      actorId: actor.actorId,
      actorLabel: actor.actorLabel,
      action: "requirements_overridden",
      entityType: INQUIRY_ENTITY_TYPE,
      entityId: updated.id,
      summary: `Overrode the requirements check on ${updated.number}: ${reason}`,
      ip: actor.ip,
      userAgent: actor.userAgent,
      requestId: actor.requestId,
    });

    return updated;
  });
}

/** Replaces the inquiry's line items wholesale, renumbering them. */
export async function setInquiryItemsService(
  actor: ActorMeta,
  input: { inquiryId: string; items: InquiryItemInput[] },
) {
  return db.$transaction(async (tx) => {
    const inquiry = await tx.inquiry.findFirst({
      where: { id: input.inquiryId, deletedAt: null },
      select: { id: true, number: true },
    });
    if (!inquiry) {
      throw new TRPCError({ code: "NOT_FOUND", message: "That inquiry no longer exists." });
    }

    // Replace rather than diff: line numbers are positional and a partial update would leave gaps.
    // InquiryItem cascades on inquiry delete and nothing references an item yet, so this is safe —
    // it stops being safe the moment module 02 links a quotation line back to one.
    await tx.inquiryItem.deleteMany({ where: { inquiryId: inquiry.id } });
    await tx.inquiryItem.createMany({
      data: input.items.map((item, index) => ({
        inquiryId: inquiry.id,
        lineNo: index + 1,
        description: item.description,
        quantity: item.quantity ?? "1",
        unit: item.unit ?? "pc",
        manufacturer: item.manufacturer ?? null,
        modelNumber: item.modelNumber ?? null,
        serviceType: item.serviceType ?? null,
        notes: item.notes ?? null,
      })),
    });

    await writeAuditLog(tx, {
      actorId: actor.actorId,
      actorLabel: actor.actorLabel,
      action: "update",
      entityType: INQUIRY_ENTITY_TYPE,
      entityId: inquiry.id,
      summary: `Updated the line items on ${inquiry.number} (${input.items.length} line(s))`,
      ip: actor.ip,
      userAgent: actor.userAgent,
      requestId: actor.requestId,
    });

    return { ok: true as const };
  });
}

// ---- reads --------------------------------------------------------------------------------------

export interface ListInquiriesParams {
  search?: string;
  status?: string;
  ownerId?: string;
  accountId?: string;
  page?: number;
  pageSize?: number;
  sortKey?: string | null;
  sortDir?: "asc" | "desc";
}

/** Allow-list, because the sort key arrives from the query string. */
const SORTABLE = new Set([
  "number",
  "subject",
  "status",
  "receivedAt",
  "createdAt",
  "requiredByDate",
]);

export async function listInquiriesService(
  user: { id: string; permissions: ReadonlySet<string> },
  params: ListInquiriesParams = {},
) {
  const page = Math.max(1, params.page ?? 1);
  const pageSize = Math.min(100, Math.max(1, params.pageSize ?? 25));
  const search = params.search?.trim();

  const where: Prisma.InquiryWhereInput = {
    deletedAt: null,
    ...inquiryScopeWhere(user),
    ...(params.status ? { status: params.status } : {}),
    ...(params.ownerId ? { ownerId: params.ownerId } : {}),
    ...(params.accountId ? { accountId: params.accountId } : {}),
    ...(search
      ? {
          OR: [
            { number: { contains: search, mode: "insensitive" as const } },
            { subject: { contains: search, mode: "insensitive" as const } },
            { account: { name: { contains: search, mode: "insensitive" as const } } },
          ],
        }
      : {}),
  };

  const sortKey = params.sortKey && SORTABLE.has(params.sortKey) ? params.sortKey : "receivedAt";
  const sortDir = params.sortDir === "asc" ? "asc" : "desc";

  const [rows, total] = await Promise.all([
    db.inquiry.findMany({
      where,
      orderBy: { [sortKey]: sortDir },
      skip: (page - 1) * pageSize,
      take: pageSize,
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
        requiredByDate: true,
        ownerId: true,
        account: { select: { id: true, code: true, name: true } },
      },
    }),
    db.inquiry.count({ where }),
  ]);

  const now = new Date();
  return {
    rows: rows.map((row) => ({
      ...row,
      estimatedValue: row.estimatedValue?.toString() ?? null,
      // §6's kanban card wants "a red flag if the SLA is breached", and the list wants the same.
      // Derived per row rather than stored — see assessInquirySla.
      sla: assessInquirySla(row, now),
    })),
    total,
  };
}

export async function getInquiryService(
  user: { id: string; permissions: ReadonlySet<string> },
  inquiryId: string,
) {
  // Scope inside the lookup, so an out-of-scope id is indistinguishable from a missing one.
  const inquiry = await db.inquiry.findFirst({
    where: { id: inquiryId, deletedAt: null, ...inquiryScopeWhere(user) },
    include: {
      items: { orderBy: { lineNo: "asc" } },
      account: { select: { id: true, code: true, name: true, status: true } },
      site: { select: { id: true, name: true, accessNotes: true } },
      contact: { select: { id: true, firstName: true, lastName: true, mobile: true, email: true } },
      inspections: { where: { deletedAt: null }, orderBy: { createdAt: "desc" } },
    },
  });
  if (!inquiry) {
    throw new TRPCError({ code: "NOT_FOUND", message: "That inquiry no longer exists." });
  }

  const [completeness, templates] = await Promise.all([
    assessInquiryCompleteness(inquiry),
    loadRequirementTemplates(),
  ]);

  return {
    ...inquiry,
    estimatedValue: inquiry.estimatedValue?.toString() ?? null,
    items: inquiry.items.map((item) => ({ ...item, quantity: item.quantity.toString() })),
    sla: assessInquirySla(inquiry),
    completeness,
    // The templates that apply, so the form can render the questions without a second round-trip.
    templates: templates.filter((t) => completeness.applicableServiceTypes.includes(t.serviceType)),
  };
}
