import { db } from "@/lib/db";
import type { TaskEntityType } from "@/server/core/collab/task-rules";

/**
 * What each of §2's trigger events is actually *about*.
 *
 * A template says what work to raise and who for. This says which record the work hangs off, when it
 * is due, and whether the template's condition is satisfied — and it is a separate file because
 * answering those questions means reading the record, which the pure rules must not do.
 *
 * ## Why one event can produce several targets
 *
 * `ticket.generated` fires once for a whole sales order and carries a **list** of tickets, of mixed
 * types. §2 has different work for a project ticket and a delivery ticket, so a resolver returns one
 * target per ticket and each is matched against the conditions separately. An event is not always
 * about one thing.
 *
 * ## Why the condition values are gathered here
 *
 * `methodology.approved` should only raise client-submission work "when the account flag requires
 * it", and that flag is on the methodology, not in the payload. Rather than teach the condition
 * language to query, the resolver reads the record and offers `clientApprovalRequired` as a value
 * the condition can match on. Every derived value is stringified for the same reason: the condition
 * language does string equality and nothing else, on purpose.
 */

export interface TriggerTarget {
  entityType: TaskEntityType;
  entityId: string;
  /** What the template's `condition` is matched against — payload fields plus anything read. */
  conditionValues: Record<string, unknown>;
  /**
   * The dates a task's `dueFrom` can count from.
   *
   * `neededBy` and `liquidationDue` are null when the record has none. A task asking for one it
   * cannot have is raised **undated** rather than dated from the event: §2 gave it that deadline for
   * a reason, and substituting a different one quietly would be inventing a commitment.
   */
  anchors: { event: Date; neededBy?: Date | null; liquidationDue?: Date | null };
  /** The one person the record names, for `assignTo: "record_owner"`. */
  recordOwnerId?: string | null;
  /** The record's own number, for titles that should say which job they are about. */
  reference?: string | null;
}

type Payload = Record<string, unknown>;

const str = (value: unknown): string | null => (typeof value === "string" ? value : null);

export type TriggerResolver = (payload: Payload, occurredAt: Date) => Promise<TriggerTarget[]>;

const resolvers: Record<string, TriggerResolver> = {
  "sales_order.created": async (payload, occurredAt) => {
    const id = str(payload.salesOrderId);
    if (!id) return [];
    return [
      {
        entityType: "SalesOrder",
        entityId: id,
        conditionValues: payload,
        anchors: { event: occurredAt },
        reference: str(payload.number),
      },
    ];
  },

  "ticket.generated": async (payload, occurredAt) => {
    const tickets = Array.isArray(payload.tickets) ? (payload.tickets as Payload[]) : [];
    return tickets
      .filter((ticket) => str(ticket.ticketId))
      .map((ticket) => ({
        entityType: "Ticket" as const,
        entityId: str(ticket.ticketId)!,
        // `ticketType` rather than `type`, so a template's condition reads as what it means and
        // cannot collide with a `type` field on some other event's payload.
        conditionValues: { ...payload, ticketType: ticket.type },
        anchors: { event: occurredAt },
        reference: str(ticket.number),
      }));
  },

  "cash_advance.requested": async (payload, occurredAt) => {
    const id = str(payload.cashAdvanceId);
    if (!id) return [];
    const advance = await db.cashAdvance.findUnique({
      where: { id },
      select: { neededBy: true, requestedById: true, number: true },
    });
    return [
      {
        entityType: "CashAdvance",
        entityId: id,
        conditionValues: payload,
        anchors: { event: occurredAt, neededBy: advance?.neededBy ?? null },
        recordOwnerId: advance?.requestedById ?? null,
        reference: advance?.number ?? str(payload.number),
      },
    ];
  },

  "cash_advance.released": async (payload, occurredAt) => {
    const id = str(payload.cashAdvanceId);
    if (!id) return [];
    const advance = await db.cashAdvance.findUnique({
      where: { id },
      select: { liquidationDueAt: true, requestedById: true, number: true },
    });
    return [
      {
        entityType: "CashAdvance",
        entityId: id,
        conditionValues: payload,
        anchors: { event: occurredAt, liquidationDue: advance?.liquidationDueAt ?? null },
        // The person who asked for the money accounts for it.
        recordOwnerId: advance?.requestedById ?? null,
        reference: advance?.number ?? str(payload.number),
      },
    ];
  },

  "material_request.raised": async (payload, occurredAt) => {
    const id = str(payload.materialRequestId);
    if (!id) return [];
    return [
      {
        entityType: "MaterialRequest",
        entityId: id,
        conditionValues: payload,
        anchors: { event: occurredAt },
        reference: str(payload.number),
      },
    ];
  },

  "material.purchase_required": async (payload, occurredAt) => {
    const id = str(payload.materialRequestId);
    if (!id) return [];
    return [
      {
        entityType: "MaterialRequest",
        entityId: id,
        conditionValues: payload,
        anchors: { event: occurredAt },
        reference: str(payload.number),
      },
    ];
  },

  "methodology.approved": async (payload, occurredAt) => {
    const id = str(payload.methodologyId);
    const ticketId = str(payload.ticketId);
    if (!id) return [];
    const methodology = await db.methodology.findUnique({
      where: { id },
      select: { clientApprovalRequired: true, number: true, ticketId: true },
    });
    const target = ticketId ?? methodology?.ticketId ?? null;
    if (!target) return [];
    return [
      {
        // Hung off the ticket rather than the methodology: a method statement is not one of §2's
        // seven record types, and the person submitting it works from the job.
        entityType: "Ticket",
        entityId: target,
        conditionValues: {
          ...payload,
          clientApprovalRequired: String(methodology?.clientApprovalRequired ?? false),
        },
        anchors: { event: occurredAt },
        reference: methodology?.number ?? str(payload.number),
      },
    ];
  },

  "scope_change.identified": async (payload, occurredAt) => {
    /*
      The inquiry first, then the ticket.

      §2's task is to raise a quotation revision, and a revision is raised against the deal. When the
      inspection came from a ticket rather than an inquiry there is no deal record to point at, and
      the ticket is where somebody would go looking.
    */
    const inquiryId = str(payload.inquiryId);
    const ticketId = str(payload.ticketId);
    if (inquiryId) {
      return [
        {
          entityType: "Inquiry",
          entityId: inquiryId,
          conditionValues: payload,
          anchors: { event: occurredAt },
          reference: str(payload.number),
        },
      ];
    }
    if (!ticketId) return [];
    return [
      {
        entityType: "Ticket",
        entityId: ticketId,
        conditionValues: payload,
        anchors: { event: occurredAt },
        reference: str(payload.number),
      },
    ];
  },

  "qa.failed": async (payload, occurredAt) => {
    const ticketId = str(payload.ticketId);
    if (!ticketId) return [];
    return [
      {
        entityType: "Ticket",
        entityId: ticketId,
        conditionValues: payload,
        anchors: { event: occurredAt },
        reference: str(payload.number),
      },
    ];
  },

  "tc.completed": async (payload, occurredAt) => {
    const ticketId = str(payload.ticketId);
    if (!ticketId) return [];
    return [
      {
        entityType: "Ticket",
        entityId: ticketId,
        conditionValues: payload,
        anchors: { event: occurredAt },
        reference: str(payload.number),
      },
    ];
  },

  "delivery.attempt_failed": async (payload, occurredAt) => {
    const ticketId = str(payload.ticketId);
    if (!ticketId) return [];
    return [
      {
        entityType: "Ticket",
        entityId: ticketId,
        conditionValues: payload,
        anchors: { event: occurredAt },
        reference: null,
      },
    ];
  },

  "project.closed": async (payload, occurredAt) => {
    const projectId = str(payload.projectId);
    if (!projectId) return [];
    return [
      {
        entityType: "Project",
        entityId: projectId,
        conditionValues: payload,
        anchors: { event: occurredAt },
        reference: str(payload.projectCode),
      },
    ];
  },

  "ticket.demobilized": async (payload, occurredAt) => {
    const ticketId = str(payload.ticketId);
    if (!ticketId) return [];
    const ticket = await db.ticket.findUnique({
      where: { id: ticketId },
      select: { assignedLeadId: true, number: true },
    });
    return [
      {
        entityType: "Ticket",
        entityId: ticketId,
        conditionValues: payload,
        anchors: { event: occurredAt },
        // The crew lead took the tools out. Null when the ticket names none, and the template falls
        // back to the technicians.
        recordOwnerId: ticket?.assignedLeadId ?? null,
        reference: ticket?.number ?? null,
      },
    ];
  },
};

export function resolverFor(event: string): TriggerResolver | null {
  return resolvers[event] ?? null;
}

/** Every event a resolver exists for — what the manifest subscribes to, so the two cannot drift. */
export const TRIGGER_EVENTS = Object.keys(resolvers);
