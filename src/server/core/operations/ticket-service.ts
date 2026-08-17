import { TRPCError } from "@trpc/server";
import { db } from "@/lib/db";
import { writeAuditLog } from "@/server/core/audit/audit";
import type { ActorMeta } from "@/server/core/crm/account-service";
import { emit } from "@/server/core/events/emit";
import { allocateNumber } from "@/server/core/numbering/numbering";
import type { AuthedUser } from "@/server/core/rbac/types";
import {
  proposeTickets,
  ticketNeedsProject,
  uncoveredLines,
  type ProposalLine,
  type TicketType,
  PROJECT_DOCUMENT_TYPE,
  TICKET_DOCUMENT_TYPE,
  TICKET_ENTITY_TYPE,
} from "./ticket-rules";

/**
 * Tickets and projects (specs/04-operations-projects.md §2, §3, §4).
 *
 * ## The one rule this file is organised around
 *
 * §4: "The system **proposes** tickets… Operations **confirms or edits** the proposed set before
 * generation. **Do not auto-generate silently — one PO can legitimately be one ticket or eight, and
 * only a human knows which.**"
 *
 * So there are two functions where there could have been one. `proposeTicketsForSalesOrderService`
 * reads and writes nothing; `generateTicketsService` takes a set somebody has looked at. There is
 * deliberately **no subscriber** to `sales_order.created` — the events are already flowing and the
 * routing is mechanical, which is exactly what makes the shortcut tempting. A wrong ticket set is
 * not a wrong record; it is a crew at the wrong site on the wrong day.
 */

export { PROJECT_ENTITY_TYPE, TICKET_ENTITY_TYPE } from "./ticket-rules";

// ---- the proposal -------------------------------------------------------------------------------

/**
 * What §4 would propose for a sales order, computed fresh and stored nowhere.
 *
 * Also reports which tickets already exist for the order, because the question on screen is never
 * "what would you propose" in isolation — it is "what is left". Generating twice is the mistake this
 * prevents, and it is easy to make when the proposal looks the same both times.
 */
export async function proposeTicketsForSalesOrderService(salesOrderId: string) {
  const order = await db.salesOrder.findFirst({
    where: { id: salesOrderId, deletedAt: null },
    include: {
      lines: { orderBy: { lineNo: "asc" } },
      account: { select: { id: true, name: true } },
      tickets: {
        where: { deletedAt: null },
        select: { id: true, number: true, type: true, title: true, status: true },
      },
    },
  });
  if (!order) {
    throw new TRPCError({ code: "NOT_FOUND", message: "That sales order no longer exists." });
  }

  const lines: ProposalLine[] = order.lines.map((line) => ({
    salesOrderLineId: line.id,
    lineNo: line.lineNo,
    description: line.description,
    requiresExecution: line.requiresExecution,
    itemType: line.itemType,
  }));

  const alreadyCovered = await db.ticketSalesOrderLine.findMany({
    where: { ticket: { salesOrderId: order.id, deletedAt: null } },
    select: { salesOrderLineId: true },
  });
  const covered = new Set(alreadyCovered.map((row) => row.salesOrderLineId));

  return {
    salesOrderId: order.id,
    salesOrderNumber: order.number,
    accountName: order.account.name,
    siteId: order.siteId,
    lines: lines.map((line) => ({ ...line, alreadyCovered: covered.has(line.salesOrderLineId) })),
    // The proposal covers only what nothing covers yet, so opening this screen a second time
    // proposes the remainder rather than a duplicate of what was already generated.
    proposed: proposeTickets({
      lines: lines.filter((line) => !covered.has(line.salesOrderLineId)),
      reference: order.number,
    }),
    existingTickets: order.tickets,
  };
}

// ---- generation, from a set somebody confirmed --------------------------------------------------

export interface ConfirmedTicket {
  type: TicketType;
  subType?: string | null;
  priority?: string;
  title: string;
  scopeOfWork: string;
  specialInstructions?: string | null;
  salesOrderLineIds: string[];
  requiredByDate?: Date | null;
  assignedLeadId?: string | null;
}

/**
 * Creates the tickets operations confirmed, and one project for the execution ones.
 *
 * §2: "A single PO can generate several tickets, and several tickets can roll up to one project."
 * So a project is created **per generation**, not per ticket — three visits to the same site for the
 * same order share a schedule, a team and a close-out pack, and making three projects would give
 * them three of each. A delivery ticket never joins it (§1: "It is not a step inside a project").
 */
export async function generateTicketsService(
  actor: ActorMeta,
  input: { salesOrderId: string; tickets: ConfirmedTicket[] },
) {
  if (input.tickets.length === 0) {
    throw new TRPCError({
      code: "BAD_REQUEST",
      message: "Confirm at least one ticket, or leave the order without any.",
    });
  }

  const order = await db.salesOrder.findFirst({
    where: { id: input.salesOrderId, deletedAt: null },
    include: { lines: true, account: { select: { id: true, name: true } } },
  });
  if (!order) {
    throw new TRPCError({ code: "NOT_FOUND", message: "That sales order no longer exists." });
  }

  const lineIds = new Set(order.lines.map((line) => line.id));
  for (const ticket of input.tickets) {
    for (const lineId of ticket.salesOrderLineIds) {
      if (!lineIds.has(lineId)) {
        throw new TRPCError({
          code: "BAD_REQUEST",
          message: `A line on "${ticket.title}" does not belong to ${order.number}.`,
        });
      }
    }
    if (ticket.type === "delivery" && ticket.subType) {
      throw new TRPCError({
        code: "BAD_REQUEST",
        message: "A delivery ticket has no sub-type — those belong to after-sales work.",
      });
    }
  }

  // A line already covered by a live ticket must not be covered twice: §4 wants the link accurate
  // "so fulfilment counters and billing milestones stay accurate", and two tickets claiming one line
  // would bill it twice.
  const alreadyCovered = await db.ticketSalesOrderLine.findMany({
    where: {
      ticket: { salesOrderId: order.id, deletedAt: null },
      salesOrderLineId: { in: input.tickets.flatMap((ticket) => ticket.salesOrderLineIds) },
    },
    include: { ticket: { select: { number: true } } },
  });
  if (alreadyCovered.length > 0) {
    const numbers = [...new Set(alreadyCovered.map((row) => row.ticket.number))].join(", ");
    throw new TRPCError({
      code: "BAD_REQUEST",
      message:
        `Some of those lines are already covered by ${numbers}. Generating again would put the ` +
        `same work on two tickets and bill it twice — reload the page to see what is left.`,
    });
  }

  const needsProject = input.tickets.some((ticket) => ticketNeedsProject(ticket.type));

  // Numbers outside the transaction, as everywhere else in this build: `allocateNumber` commits its
  // own increment, so a rolled-back generation leaves a gap rather than reusing a number.
  const projectCode = needsProject ? await allocateNumber(PROJECT_DOCUMENT_TYPE) : null;
  const numbers: string[] = [];
  for (let i = 0; i < input.tickets.length; i++) {
    numbers.push(await allocateNumber(TICKET_DOCUMENT_TYPE));
  }

  const created = await db.$transaction(async (tx) => {
    const project = projectCode
      ? await tx.project.create({
          data: {
            code: projectCode,
            salesOrderId: order.id,
            accountId: order.accountId,
            siteId: order.siteId,
            name: `${order.account.name} — ${order.number}`,
            scopeOfWork: input.tickets
              .filter((ticket) => ticketNeedsProject(ticket.type))
              .map((ticket) => ticket.scopeOfWork)
              .join("\n\n"),
            status: "planning",
            // Permission-gated on the way out (Spec.md §4.3). Carried from the order so module 09's
            // budget-versus-actual has a contract value to compare against from day one.
            contractValue: order.total,
            budgetCost: order.totalCost,
            plannedEnd: order.requiredByDate,
          },
        })
      : null;

    const tickets = [];
    for (const [index, confirmed] of input.tickets.entries()) {
      const ticket = await tx.ticket.create({
        data: {
          number: numbers[index]!,
          salesOrderId: order.id,
          customerPOId: order.customerPOId,
          accountId: order.accountId,
          siteId: order.siteId,
          type: confirmed.type,
          subType: confirmed.subType ?? null,
          priority: confirmed.priority ?? "normal",
          title: confirmed.title,
          scopeOfWork: confirmed.scopeOfWork,
          specialInstructions: confirmed.specialInstructions ?? null,
          status: "generated",
          // Null for a delivery ticket, always — §1's lane, not a step inside a project.
          projectId: ticketNeedsProject(confirmed.type) ? (project?.id ?? null) : null,
          raisedById: actor.actorId,
          assignedLeadId: confirmed.assignedLeadId ?? null,
          requiredByDate: confirmed.requiredByDate ?? order.requiredByDate,
          lines: {
            create: confirmed.salesOrderLineIds.map((salesOrderLineId) => ({ salesOrderLineId })),
          },
        },
        include: { lines: true },
      });
      tickets.push(ticket);

      await writeAuditLog(tx, {
        actorId: actor.actorId,
        actorLabel: actor.actorLabel,
        action: "create",
        entityType: TICKET_ENTITY_TYPE,
        entityId: ticket.id,
        summary:
          `Generated ${ticket.number} (${confirmed.type.replace(/_/g, " ")}) from ${order.number}: ` +
          `${confirmed.title}, covering ${confirmed.salesOrderLineIds.length} line(s)` +
          (project ? `, on project ${project.code}` : ""),
        ip: actor.ip,
        userAgent: actor.userAgent,
        requestId: actor.requestId,
      });
    }

    await emit(
      tx,
      "ticket.generated",
      {
        salesOrderId: order.id,
        projectId: project?.id ?? null,
        tickets: tickets.map((ticket) => ({
          ticketId: ticket.id,
          number: ticket.number,
          type: ticket.type,
          salesOrderLineIds: ticket.lines.map((line) => line.salesOrderLineId),
        })),
      },
      { actorId: actor.actorId, requestId: actor.requestId },
    );

    // §1's execution lane is what this order is now waiting on. `in_execution` is one of §2's
    // sales-order statuses in module 03's schema; the workstream column is what module 03 keeps
    // separate, so only that moves.
    if (needsProject) {
      await tx.salesOrder.update({
        where: { id: order.id },
        data: { executionStatus: "pending", version: { increment: 1 } },
      });
    }

    return { project, tickets };
  });

  return created;
}

/**
 * §4's standalone ticket: "a warranty callback, emergency, goodwill visit… with no PO".
 *
 * `billable` defaults false and the justification is required, because that is the whole record of
 * why AIES sent somebody somewhere for nothing. A standalone ticket with no explanation is a cost
 * nobody can account for at the end of the month.
 */
export async function createStandaloneTicketService(
  actor: ActorMeta,
  input: {
    accountId: string;
    siteId?: string | null;
    /// §11's warranty callback links its ticket to the project the original work belongs to, rather
    /// than opening a second one — the callback is part of that job's history, not a new job.
    projectId?: string | null;
    type: TicketType;
    subType?: string | null;
    priority?: string;
    title: string;
    scopeOfWork: string;
    justification: string;
    billable?: boolean;
    requiredByDate?: Date | null;
  },
) {
  const justification = input.justification.trim();
  if (justification.length < 3) {
    throw new TRPCError({
      code: "BAD_REQUEST",
      message:
        "Say why this ticket exists without an order behind it. That sentence is the whole record " +
        "of why somebody was sent.",
    });
  }

  const account = await db.customerAccount.findFirst({
    where: { id: input.accountId, deletedAt: null },
    select: { id: true, name: true },
  });
  if (!account) {
    throw new TRPCError({ code: "NOT_FOUND", message: "That account no longer exists." });
  }

  const number = await allocateNumber(TICKET_DOCUMENT_TYPE);

  return db.$transaction(async (tx) => {
    const ticket = await tx.ticket.create({
      data: {
        number,
        accountId: account.id,
        siteId: input.siteId ?? null,
        projectId: input.projectId ?? null,
        type: input.type,
        subType: input.subType ?? null,
        priority: input.priority ?? "normal",
        title: input.title,
        scopeOfWork: input.scopeOfWork,
        status: "generated",
        raisedById: actor.actorId,
        requiredByDate: input.requiredByDate ?? null,
        billable: input.billable ?? false,
        justification,
      },
    });

    await writeAuditLog(tx, {
      actorId: actor.actorId,
      actorLabel: actor.actorLabel,
      action: "create",
      entityType: TICKET_ENTITY_TYPE,
      entityId: ticket.id,
      summary:
        `Raised ${ticket.number} (${input.type.replace(/_/g, " ")}) for ${account.name} with no ` +
        `order behind it, ${ticket.billable ? "billable" : "not billable"} — ${justification}`,
      ip: actor.ip,
      userAgent: actor.userAgent,
      requestId: actor.requestId,
    });

    return ticket;
  });
}

// ---- reads --------------------------------------------------------------------------------------

/**
 * §19: "Technicians are scoped to tickets where they are assigned."
 *
 * Assigned as lead *or* named on the crew — `assignedUserIds` is what a technician's own list reads
 * from, and scoping to the lead alone would hide a job from everybody who is actually going.
 */
function ticketScopeWhere(user: AuthedUser) {
  if (user.permissions.has("ticket.view_all")) return {};
  return {
    OR: [
      { assignedLeadId: user.id },
      { assignedUserIds: { has: user.id } },
      { raisedById: user.id },
    ],
  };
}

export async function listTicketsService(
  user: AuthedUser,
  params: { status?: string; type?: string; salesOrderId?: string; search?: string } = {},
) {
  const search = params.search?.trim();
  const tickets = await db.ticket.findMany({
    where: {
      deletedAt: null,
      ...ticketScopeWhere(user),
      ...(params.status ? { status: params.status } : {}),
      ...(params.type ? { type: params.type } : {}),
      ...(params.salesOrderId ? { salesOrderId: params.salesOrderId } : {}),
      ...(search
        ? {
            OR: [
              { number: { contains: search, mode: "insensitive" as const } },
              { title: { contains: search, mode: "insensitive" as const } },
              { account: { name: { contains: search, mode: "insensitive" as const } } },
            ],
          }
        : {}),
    },
    orderBy: [{ requiredByDate: "asc" }, { raisedAt: "desc" }],
    include: {
      account: { select: { id: true, name: true } },
      site: { select: { id: true, name: true } },
      salesOrder: { select: { id: true, number: true } },
      project: { select: { id: true, code: true } },
      _count: { select: { lines: true } },
    },
  });

  return tickets;
}

export async function getTicketService(user: AuthedUser, ticketId: string) {
  const ticket = await db.ticket.findFirst({
    where: { id: ticketId, deletedAt: null, ...ticketScopeWhere(user) },
    include: {
      account: { select: { id: true, name: true } },
      site: { select: { id: true, name: true, address: true, accessNotes: true } },
      salesOrder: { select: { id: true, number: true } },
      customerPO: { select: { id: true, poNumber: true } },
      project: true,
      lines: true,
    },
  });
  if (!ticket) {
    throw new TRPCError({ code: "NOT_FOUND", message: "That ticket no longer exists." });
  }

  const canSeeCost = user.permissions.has("project.view_cost");
  return {
    ...ticket,
    project: ticket.project
      ? {
          ...ticket.project,
          // §19: technicians "see scope, site data, and their own cash advances — never contract
          // value or margin". Spec.md §4.3's rule, enforced on the way out as everywhere else.
          contractValue: canSeeCost ? ticket.project.contractValue.toString() : null,
          budgetCost: canSeeCost ? ticket.project.budgetCost.toString() : null,
          actualCost: canSeeCost ? ticket.project.actualCost.toString() : null,
        }
      : null,
  };
}

/** What the review screen needs to warn that a confirmed set leaves work uncovered. */
export function uncoveredFrom(
  lines: readonly ProposalLine[],
  confirmed: readonly { salesOrderLineIds: readonly string[] }[],
) {
  return uncoveredLines(lines, confirmed);
}
