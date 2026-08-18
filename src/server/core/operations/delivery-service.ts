import { TRPCError } from "@trpc/server";
import { Prisma } from "@prisma/client";
import { db } from "@/lib/db";
import { writeAuditLog } from "@/server/core/audit/audit";
import type { ActorMeta } from "@/server/core/crm/account-service";
import { emit } from "@/server/core/events/emit";
import { notify } from "@/server/core/notify/notify";
import { registerNotificationType } from "@/server/core/notify/registry";
import { allocateNumber } from "@/server/core/numbering/numbering";
import { registerFileAccessChecker } from "@/server/core/storage/access";
import { formatAddress } from "@/lib/address";
import { BUSINESS_DAY_MS, businessMsBetween } from "@/server/core/calendar/business-days";
import {
  DELIVERY_FLOW_ENTITY_TYPE,
  DELIVERY_RECEIPT_DOCUMENT_TYPE,
  DELIVERY_RECEIPT_ENTITY_TYPE,
  canComplete,
  canLeaveForSite,
  checkAttempt,
  readAttempts,
  statusAfterAttempt,
  unsignedStanding,
  type AttemptFailureCause,
  type DeliveryAttempt,
  type DeliveryMode,
} from "./delivery-rules";

/**
 * The delivery lane (specs/04-operations-projects.md §13) and the document it executes against
 * (specs/03-order-procurement.md §7).
 *
 * ## Why both halves live in one service
 *
 * §7 draws the boundary — module 03 owns the DR document, module 04 owns the execution — and the
 * boundary is real in the *models*. It is not real in the *transaction*: requesting a DR creates it,
 * signing it completes the flow, and splitting those across two services would mean two writes that
 * have to agree and eventually would not. So the models keep the boundary and the service crosses it
 * deliberately, in one place, rather than the coupling being spread across both modules.
 *
 * This pair has been mutually blocked since module 03: §7 gates a DR on a delivery ticket, and §13
 * gates movement on a DR. Neither could be built without the other.
 */

export const UNSIGNED_DR_NOTIFICATION_TYPE = "delivery.dr_unsigned_overdue";

registerNotificationType({
  key: UNSIGNED_DR_NOTIFICATION_TYPE,
  label: "A delivered order has no signed receipt",
  // In-app only while `notify_email` has no handler (docs/DECISIONS.md #10).
  defaultChannels: { inApp: true, email: false, digest: false },
});

registerFileAccessChecker(DELIVERY_RECEIPT_ENTITY_TYPE, async (user) => {
  return user.permissions.has("ticket.view") || user.permissions.has("ticket.view_all");
});

registerFileAccessChecker(DELIVERY_FLOW_ENTITY_TYPE, async (user) => {
  return user.permissions.has("ticket.view") || user.permissions.has("ticket.view_all");
});

async function loadFlow(ticketId: string) {
  const flow = await db.deliveryTicketFlow.findFirst({
    where: { ticketId, deletedAt: null },
  });
  if (!flow) {
    throw new TRPCError({
      code: "NOT_FOUND",
      message: "This ticket has no delivery lane. Start one before recording against it.",
    });
  }
  return flow;
}

// ---- starting the lane ----------------------------------------------------------------------------

/**
 * Opens the delivery lane for a delivery ticket.
 *
 * §13: "The mode is chosen when the ticket is generated and can be changed until dispatch." So this
 * takes the mode and `setDeliveryModeService` guards the change window.
 */
export async function startDeliveryFlowService(
  actor: ActorMeta,
  input: { ticketId: string; mode?: DeliveryMode },
) {
  const ticket = await db.ticket.findFirst({
    where: { id: input.ticketId, deletedAt: null },
    select: { id: true, number: true, type: true },
  });
  if (!ticket) {
    throw new TRPCError({ code: "NOT_FOUND", message: "That ticket no longer exists." });
  }
  if (ticket.type !== "delivery") {
    throw new TRPCError({
      code: "BAD_REQUEST",
      message:
        `${ticket.number} is a ${ticket.type.replace(/_/g, " ")} ticket. §13's lane is for delivery ` +
        `tickets only — they never enter the project lane, and the reverse holds too.`,
    });
  }

  const existing = await db.deliveryTicketFlow.findUnique({ where: { ticketId: ticket.id } });
  if (existing) return existing;

  return db.$transaction(async (tx) => {
    const created = await tx.deliveryTicketFlow.create({
      data: {
        ticketId: ticket.id,
        mode: input.mode ?? "own_vehicle",
        drRequestedAt: new Date(),
        drRequestedById: actor.actorId,
        status: "dr_requested",
      },
    });

    await writeAuditLog(tx, {
      actorId: actor.actorId,
      actorLabel: actor.actorLabel,
      action: "delivery_dr_requested",
      entityType: DELIVERY_FLOW_ENTITY_TYPE,
      entityId: created.id,
      summary: `Delivery receipt requested for ${ticket.number} (${created.mode.replace(/_/g, " ")}).`,
      ip: actor.ip,
      userAgent: actor.userAgent,
      requestId: actor.requestId,
    });

    return created;
  });
}

/** §13: the mode "can be changed until dispatch" — after that it has consequences in the world. */
export async function setDeliveryModeService(
  actor: ActorMeta,
  input: { ticketId: string; mode: DeliveryMode },
) {
  const flow = await loadFlow(input.ticketId);

  if (flow.mobilizedAt || flow.bookedAt) {
    throw new TRPCError({
      code: "BAD_REQUEST",
      message: flow.mobilizedAt
        ? "The crew has already left. Changing the mode now would rewrite what actually happened."
        : "The shipment is already booked with the courier. Cancel the booking first.",
    });
  }

  return db.deliveryTicketFlow.update({
    where: { id: flow.id },
    data: { mode: input.mode, version: { increment: 1 } },
  });
}

// ---- module 03 §7: the document -------------------------------------------------------------------

/**
 * Issues the delivery receipt.
 *
 * §7: "A DR is never issued without a ticket to execute it — the flowchart's `DR REQ` box is a real
 * gate and prevents DRs floating around unassigned." That is why this takes a ticket rather than a
 * sales order, and why there is no screen in module 03 that creates one.
 */
export async function issueDeliveryReceiptService(
  actor: ActorMeta,
  input: {
    ticketId: string;
    salesOrderId: string;
    lines: { salesOrderLineId: string; description: string; quantity: string; unit: string }[];
    siteId?: string | null;
  },
) {
  const flow = await loadFlow(input.ticketId);
  if (flow.deliveryReceiptId) {
    throw new TRPCError({
      code: "BAD_REQUEST",
      message: "This delivery already has a receipt. Partial deliveries need their own ticket.",
    });
  }
  if (input.lines.length === 0) {
    throw new TRPCError({
      code: "BAD_REQUEST",
      message: "A delivery receipt with no lines is a piece of paper with nothing to sign for.",
    });
  }

  const order = await db.salesOrder.findFirst({
    where: { id: input.salesOrderId, deletedAt: null },
    select: { id: true, number: true, accountId: true, siteId: true },
  });
  if (!order) {
    throw new TRPCError({ code: "NOT_FOUND", message: "That sales order no longer exists." });
  }

  const number = await allocateNumber(DELIVERY_RECEIPT_DOCUMENT_TYPE);
  const now = new Date();

  return db.$transaction(async (tx) => {
    const receipt = await tx.deliveryReceipt.create({
      data: {
        number,
        salesOrderId: order.id,
        ticketId: input.ticketId,
        accountId: order.accountId,
        siteId: input.siteId ?? order.siteId,
        status: "issued",
        issuedAt: now,
        issuedById: actor.actorId,
        lines: {
          create: input.lines.map((line, index) => ({
            salesOrderLineId: line.salesOrderLineId,
            lineNo: index + 1,
            description: line.description,
            quantity: line.quantity,
            unit: line.unit,
          })),
        },
      },
    });

    await tx.deliveryTicketFlow.update({
      where: { id: flow.id },
      data: {
        deliveryReceiptId: receipt.id,
        drIssuedAt: now,
        drIssuedById: actor.actorId,
        status: "dr_issued",
        version: { increment: 1 },
      },
    });

    await writeAuditLog(tx, {
      actorId: actor.actorId,
      actorLabel: actor.actorLabel,
      action: "issued",
      entityType: DELIVERY_RECEIPT_ENTITY_TYPE,
      entityId: receipt.id,
      summary: `${number} issued against ${order.number}, ${input.lines.length} line(s).`,
      ip: actor.ip,
      userAgent: actor.userAgent,
      requestId: actor.requestId,
    });

    return receipt;
  });
}

// ---- §13.1: own vehicle ----------------------------------------------------------------------------

/** §13.1 step 3. Its own crew and vehicle, separate from project mobilisation. */
export async function mobilizeDeliveryService(
  actor: ActorMeta,
  input: { ticketId: string; vehicleRef?: string | null; driverName?: string | null },
) {
  const flow = await loadFlow(input.ticketId);

  const gate = canLeaveForSite(flow);
  if (!gate.ok) {
    throw new TRPCError({ code: "BAD_REQUEST", message: gate.errors.join(" ") });
  }

  return db.deliveryTicketFlow.update({
    where: { id: flow.id },
    data: {
      mobilizedAt: new Date(),
      vehicleRef: input.vehicleRef ?? null,
      driverName: input.driverName ?? null,
      status: "mobilized",
      version: { increment: 1 },
    },
  });
}

export interface LogAttemptInput {
  ticketId: string;
  contactPersonSought?: string | null;
  contactReached: boolean;
  itemDelivered: boolean;
  drSigned: boolean;
  failureReason?: AttemptFailureCause | null;
  photoFileIds?: string[];
  geo?: { lat: number; lng: number } | null;
  notes?: string | null;
  /** Captured when the goods are handed over and signed for. */
  recipientName?: string | null;
  recipientPosition?: string | null;
  signatureFileId?: string | null;
}

/**
 * §13.1 steps 4-7, as one act, because that is how it happens: the driver arrives, looks for the
 * contact, and either hands the goods over or does not.
 *
 * Each attempt is appended rather than replacing the last. §20 asks for "three logged attempts with
 * causes" from a delivery that eventually succeeded — the history *is* the deliverable, and a field
 * that only holds the latest visit answers none of §13.3's questions.
 */
export async function logDeliveryAttemptService(actor: ActorMeta, input: LogAttemptInput) {
  const flow = await loadFlow(input.ticketId);

  const gate = canLeaveForSite(flow);
  if (!gate.ok) {
    throw new TRPCError({ code: "BAD_REQUEST", message: gate.errors.join(" ") });
  }

  const check = checkAttempt({
    itemDelivered: input.itemDelivered,
    drSigned: input.drSigned,
    failureReason: input.failureReason,
    contactReached: input.contactReached,
  });
  if (!check.ok) {
    throw new TRPCError({ code: "BAD_REQUEST", message: check.errors.join(" ") });
  }

  const attempts = readAttempts(flow.attempts);
  const now = new Date();
  const attempt: DeliveryAttempt = {
    attemptNo: attempts.length + 1,
    at: now.toISOString(),
    contactPersonSought: input.contactPersonSought ?? null,
    contactReached: input.contactReached,
    itemDelivered: input.itemDelivered,
    drSigned: input.drSigned,
    failureReason: input.failureReason ?? null,
    photoFileIds: input.photoFileIds ?? [],
    geo: input.geo ?? null,
    notes: input.notes ?? null,
  };

  const status = statusAfterAttempt(input);

  const result = await db.$transaction(async (tx) => {
    const updated = await tx.deliveryTicketFlow.update({
      where: { id: flow.id },
      data: {
        attempts: [...attempts, attempt] as unknown as Prisma.InputJsonValue,
        status,
        // Set once, on the visit that actually handed the goods over. The gap between this and
        // `completedAt` is the billing risk the escalation measures.
        ...(input.itemDelivered && !flow.deliveredAt ? { deliveredAt: now } : {}),
        version: { increment: 1 },
      },
    });

    if (flow.deliveryReceiptId && input.itemDelivered) {
      await tx.deliveryReceipt.update({
        where: { id: flow.deliveryReceiptId },
        data: {
          status: input.drSigned ? "acknowledged" : "delivered",
          deliveredAt: now,
          ...(input.drSigned
            ? {
                signedAt: now,
                recipientName: input.recipientName ?? null,
                recipientPosition: input.recipientPosition ?? null,
                signatureFileId: input.signatureFileId ?? null,
              }
            : {}),
          version: { increment: 1 },
        },
      });
    }

    await writeAuditLog(tx, {
      actorId: actor.actorId,
      actorLabel: actor.actorLabel,
      action: input.itemDelivered ? "delivery_attempt_succeeded" : "delivery_attempt_failed",
      entityType: DELIVERY_FLOW_ENTITY_TYPE,
      entityId: flow.id,
      summary:
        `Attempt ${attempt.attemptNo}: ` +
        (input.itemDelivered
          ? input.drSigned
            ? `delivered and signed by ${input.recipientName ?? "the recipient"}.`
            : "delivered, not signed for — billing is blocked until the signature arrives."
          : `failed (${input.failureReason?.replace(/_/g, " ")}).`),
      ip: actor.ip,
      userAgent: actor.userAgent,
      requestId: actor.requestId,
    });

    /**
     * §18 lists `delivery.attempt_failed`. Emitted per failure rather than per delivery, because
     * §13.3 counts attempts, not journeys.
     */
    if (!input.itemDelivered) {
      await emit(
        tx,
        "delivery.attempt_failed",
        {
          deliveryFlowId: flow.id,
          ticketId: flow.ticketId,
          attemptNo: attempt.attemptNo,
          failureReason: input.failureReason,
          contactReached: input.contactReached,
        },
        { actorId: actor.actorId },
      );
    }

    return updated;
  });

  return { status, attemptNo: attempt.attemptNo, warnings: check.warnings, flow: result };
}

// ---- §13.2: courier ---------------------------------------------------------------------------------

export async function bookCourierService(
  actor: ActorMeta,
  input: {
    ticketId: string;
    courierName: string;
    waybillNumber: string;
    trackingUrl?: string | null;
    freightCost?: number | null;
    insuredValue?: number | null;
  },
) {
  const flow = await loadFlow(input.ticketId);

  if (flow.mode !== "courier") {
    throw new TRPCError({
      code: "BAD_REQUEST",
      message: "This delivery is set to own vehicle. Change the mode before booking a courier.",
    });
  }

  const gate = canLeaveForSite(flow);
  if (!gate.ok) {
    throw new TRPCError({ code: "BAD_REQUEST", message: gate.errors.join(" ") });
  }

  return db.$transaction(async (tx) => {
    const updated = await tx.deliveryTicketFlow.update({
      where: { id: flow.id },
      data: {
        courierName: input.courierName,
        waybillNumber: input.waybillNumber,
        trackingUrl: input.trackingUrl ?? null,
        freightCost: input.freightCost ?? null,
        insuredValue: input.insuredValue ?? null,
        bookedAt: new Date(),
        status: "in_transit",
        version: { increment: 1 },
      },
    });

    await writeAuditLog(tx, {
      actorId: actor.actorId,
      actorLabel: actor.actorLabel,
      action: "courier_booked",
      entityType: DELIVERY_FLOW_ENTITY_TYPE,
      entityId: flow.id,
      summary: `Booked with ${input.courierName}, waybill ${input.waybillNumber}.`,
      ip: actor.ip,
      userAgent: actor.userAgent,
      requestId: actor.requestId,
    });

    return updated;
  });
}

/**
 * Records the courier's proof of delivery.
 *
 * **This does not complete the ticket**, and that is §13.2 step 5 rather than an oversight. The
 * status it produces is `delivered_unsigned` — the same billing-risk state an own-vehicle delivery
 * reaches when nobody signs, escalating on the same clock. A courier POD says a box arrived; a signed
 * DR says the customer accepted these goods against this order.
 */
export async function recordCourierPodService(
  actor: ActorMeta,
  input: {
    ticketId: string;
    courierPodFileId: string;
    courierRecipientName?: string | null;
    deliveredAt?: Date | null;
  },
) {
  const flow = await loadFlow(input.ticketId);
  const now = input.deliveredAt ?? new Date();

  return db.$transaction(async (tx) => {
    const updated = await tx.deliveryTicketFlow.update({
      where: { id: flow.id },
      data: {
        courierPodFileId: input.courierPodFileId,
        courierRecipientName: input.courierRecipientName ?? null,
        courierDeliveredAt: now,
        deliveredAt: flow.deliveredAt ?? now,
        status: "delivered_unsigned",
        version: { increment: 1 },
      },
    });

    if (flow.deliveryReceiptId) {
      await tx.deliveryReceipt.update({
        where: { id: flow.deliveryReceiptId },
        data: { status: "delivered", deliveredAt: now, version: { increment: 1 } },
      });
    }

    await writeAuditLog(tx, {
      actorId: actor.actorId,
      actorLabel: actor.actorLabel,
      action: "courier_pod_recorded",
      entityType: DELIVERY_FLOW_ENTITY_TYPE,
      entityId: flow.id,
      summary:
        `Courier delivered to ${input.courierRecipientName ?? "an unnamed recipient"}. ` +
        `The signed delivery receipt is still outstanding — this does not close the ticket.`,
      ip: actor.ip,
      userAgent: actor.userAgent,
      requestId: actor.requestId,
    });

    return updated;
  });
}

// ---- completion, and the handover to module 03 -------------------------------------------------------

/**
 * Closes the delivery on the signed receipt.
 *
 * §7: "On acknowledgement, `qtyDelivered` increments; when all non-execution lines are delivered,
 * emits `sales_order.goods_delivered` and `delivery.dr_signed`."
 *
 * `goods_delivered` fires **once per order**, guarded by checking the remaining lines rather than by
 * trusting that this is the last delivery — §20 asks for exactly one event across a delivery that
 * took four attempts, and an event emitted per attempt would have satisfied every other assertion.
 */
export async function completeDeliveryService(
  actor: ActorMeta,
  input: {
    ticketId: string;
    recipientName: string;
    recipientPosition?: string | null;
    signatureFileId: string;
  },
) {
  const flow = await loadFlow(input.ticketId);
  if (!flow.deliveryReceiptId) {
    throw new TRPCError({ code: "BAD_REQUEST", message: "No delivery receipt to sign." });
  }
  if (flow.status === "completed") {
    throw new TRPCError({ code: "BAD_REQUEST", message: "This delivery is already complete." });
  }

  const receipt = await db.deliveryReceipt.findUniqueOrThrow({
    where: { id: flow.deliveryReceiptId },
    include: { lines: true, salesOrder: { select: { id: true, number: true } } },
  });

  const gate = canComplete({
    mode: flow.mode,
    courierPodFileId: flow.courierPodFileId,
    // The signature arriving now is what this act supplies.
    drSignedAt: new Date(),
  });
  if (!gate.ok) {
    throw new TRPCError({ code: "BAD_REQUEST", message: gate.errors.join(" ") });
  }

  const now = new Date();

  return db.$transaction(async (tx) => {
    await tx.deliveryReceipt.update({
      where: { id: receipt.id },
      data: {
        status: "acknowledged",
        deliveredAt: receipt.deliveredAt ?? now,
        signedAt: now,
        recipientName: input.recipientName,
        recipientPosition: input.recipientPosition ?? null,
        signatureFileId: input.signatureFileId,
        version: { increment: 1 },
      },
    });

    // §7: on acknowledgement, qtyDelivered increments.
    for (const line of receipt.lines) {
      await tx.salesOrderLine.update({
        where: { id: line.salesOrderLineId },
        data: { qtyDelivered: { increment: line.quantity } },
      });
    }

    const flowUpdate = await tx.deliveryTicketFlow.update({
      where: { id: flow.id },
      data: {
        status: "completed",
        demobilizedAt: flow.mode === "own_vehicle" ? now : null,
        deliveredAt: flow.deliveredAt ?? now,
        completedAt: now,
        finalOutcome: "delivered_and_signed",
        version: { increment: 1 },
      },
    });

    await tx.ticket.update({
      where: { id: flow.ticketId },
      data: { status: "completed", version: { increment: 1 } },
    });

    await writeAuditLog(tx, {
      actorId: actor.actorId,
      actorLabel: actor.actorLabel,
      action: "acknowledged",
      entityType: DELIVERY_RECEIPT_ENTITY_TYPE,
      entityId: receipt.id,
      summary: `${receipt.number} signed by ${input.recipientName}. Delivery complete.`,
      ip: actor.ip,
      userAgent: actor.userAgent,
      requestId: actor.requestId,
    });

    await emit(
      tx,
      "delivery.dr_signed",
      {
        deliveryReceiptId: receipt.id,
        number: receipt.number,
        ticketId: flow.ticketId,
        salesOrderId: receipt.salesOrderId,
        recipientName: input.recipientName,
      },
      { actorId: actor.actorId },
    );

    /**
     * §7's condition: "when all **non-execution** lines are delivered". Lines that need site work are
     * finished by the project lane, not by a van arriving, so counting them here would hold the order
     * open forever.
     */
    const outstanding = await tx.salesOrderLine.count({
      where: {
        salesOrderId: receipt.salesOrderId,
        requiresExecution: false,
        qtyDelivered: { lt: tx.salesOrderLine.fields.qtyOrdered },
      },
    });

    if (outstanding === 0) {
      await emit(
        tx,
        "sales_order.goods_delivered",
        {
          salesOrderId: receipt.salesOrderId,
          salesOrderNumber: receipt.salesOrder.number,
          deliveryReceiptId: receipt.id,
          ticketId: flow.ticketId,
        },
        { actorId: actor.actorId },
      );
    }

    return { flow: flowUpdate, receipt, goodsDelivered: outstanding === 0 };
  });
}

// ---- reading and the escalation sweep ------------------------------------------------------------

/**
 * The lines this ticket is meant to deliver, ready to become DR lines.
 *
 * Prefilled rather than retyped. A delivery receipt whose description does not match the sales order
 * line is a document the customer can sign truthfully and still leave the invoice arguable, and the
 * only reliable way to keep them the same is not to ask anybody to type them twice.
 *
 * Execution lines are excluded here for the same reason §7 excludes them from `goods_delivered`:
 * nothing is handed over on a labour line, and a receipt that lists one invites a signature against
 * work that has not happened.
 */
export async function deliverableLinesForTicketService(ticketId: string) {
  const ticket = await db.ticket.findFirst({
    where: { id: ticketId, deletedAt: null },
    select: { id: true, salesOrderId: true },
  });
  if (!ticket?.salesOrderId) {
    return { salesOrderId: null, salesOrderNumber: null, lines: [] };
  }

  const order = await db.salesOrder.findUnique({
    where: { id: ticket.salesOrderId },
    select: { id: true, number: true },
  });
  if (!order) return { salesOrderId: null, salesOrderNumber: null, lines: [] };

  const links = await db.ticketSalesOrderLine.findMany({
    where: { ticketId },
    select: { salesOrderLineId: true },
  });

  // A delivery ticket raised against specific lines delivers those; one raised against the order as
  // a whole delivers everything deliverable on it. Both happen, and the difference is not an error.
  const orderLines = await db.salesOrderLine.findMany({
    where: {
      salesOrderId: order.id,
      requiresExecution: false,
      ...(links.length > 0 ? { id: { in: links.map((link) => link.salesOrderLineId) } } : {}),
    },
    orderBy: { lineNo: "asc" },
    select: {
      id: true,
      lineNo: true,
      description: true,
      unit: true,
      quantity: true,
      qtyDelivered: true,
    },
  });

  return {
    salesOrderId: order.id,
    salesOrderNumber: order.number,
    lines: orderLines.map((line) => ({
      salesOrderLineId: line.id,
      lineNo: line.lineNo,
      description: line.description,
      unit: line.unit,
      quantity: line.quantity.toString(),
      qtyDelivered: line.qtyDelivered.toString(),
      outstanding: line.quantity.minus(line.qtyDelivered).toString(),
    })),
  };
}

/**
 * §14's delivery mode: "today's drops", and nothing else.
 *
 * Scoped to flows that are actually still moving. A completed delivery is not a drop, and a driver
 * scrolling past yesterday's finished work to find this morning's is the reason §14 asks for a
 * *stripped-down* screen rather than the ticket list with bigger buttons.
 *
 * Deliberately not scoped to the caller's assignments. Delivery crews swap runs, a driver covers for
 * somebody who called in sick, and a screen that shows an empty list because the dispatcher never
 * reassigned the ticket is worse than useless at 7am in a yard. `delivery.execute` is the gate that
 * matters here; §19's per-technician scoping is about *project* tickets, where the confidentiality
 * argument is real.
 */
export async function todaysDropsService() {
  const flows = await db.deliveryTicketFlow.findMany({
    where: {
      deletedAt: null,
      status: { in: ["dr_issued", "mobilized", "attempting", "in_transit", "delivered_unsigned"] },
    },
    orderBy: [{ status: "asc" }, { createdAt: "asc" }],
    take: 100,
    select: {
      id: true,
      ticketId: true,
      mode: true,
      status: true,
      deliveredAt: true,
      drIssuedAt: true,
      attempts: true,
      courierName: true,
      waybillNumber: true,
      deliveryReceiptId: true,
      ticket: {
        select: {
          id: true,
          number: true,
          title: true,
          account: { select: { name: true } },
          site: { select: { name: true, address: true, accessNotes: true } },
        },
      },
    },
  });

  const receiptIds = flows.map((flow) => flow.deliveryReceiptId).filter((id): id is string => !!id);
  const receipts = receiptIds.length
    ? await db.deliveryReceipt.findMany({
        where: { id: { in: receiptIds } },
        select: {
          id: true,
          number: true,
          lines: { select: { description: true, quantity: true, unit: true } },
        },
      })
    : [];
  const byId = new Map(receipts.map((receipt) => [receipt.id, receipt]));

  /**
   * Deliveries that exist but are not drops yet, because the delivery receipt has not been issued.
   *
   * Reported so the screen can tell a driver **why** it is empty. "No deliveries are waiting to go
   * out" was a true sentence about this query and a false one about the world — the company looked
   * at an empty screen while a delivery sat one step upstream, and had no way to tell an idle day
   * from a broken app. The distinction costs one count.
   */
  const awaitingReceipt = await db.deliveryTicketFlow.count({
    where: { deletedAt: null, status: "dr_requested" },
  });

  const drops = flows.map((flow) => {
    const attempts = readAttempts(flow.attempts);
    const receipt = flow.deliveryReceiptId ? byId.get(flow.deliveryReceiptId) : null;
    return {
      flowId: flow.id,
      ticketId: flow.ticketId,
      ticketNumber: flow.ticket.number,
      title: flow.ticket.title,
      customer: flow.ticket.account?.name ?? null,
      siteName: flow.ticket.site?.name ?? null,
      // The two things a driver needs before setting off, and the two most often missing.
      address: formatAddress(flow.ticket.site?.address),
      accessNotes: flow.ticket.site?.accessNotes ?? null,
      mode: flow.mode,
      status: flow.status,
      receiptNumber: receipt?.number ?? null,
      // Decimal and Json do not cross to a client component. Serialised here rather than at the
      // screen, so one place decides what a quantity looks like.
      lines: (receipt?.lines ?? []).map((line) => ({
        description: line.description,
        quantity: line.quantity.toString(),
        unit: line.unit,
      })),
      attemptCount: attempts.length,
      lastFailure:
        (attempts.filter((entry) => !entry.itemDelivered).at(-1)?.failureReason as
          AttemptFailureCause | undefined) ?? null,
      courierName: flow.courierName,
      waybillNumber: flow.waybillNumber,
    };
  });

  return { drops, awaitingReceipt };
}

export async function getDeliveryFlowService(ticketId: string) {
  const flow = await db.deliveryTicketFlow.findFirst({
    where: { ticketId, deletedAt: null },
  });
  if (!flow) return null;

  const receipt = flow.deliveryReceiptId
    ? await db.deliveryReceipt.findUnique({
        where: { id: flow.deliveryReceiptId },
        include: { lines: { orderBy: { lineNo: "asc" } } },
      })
    : null;

  return { ...flow, attempts: readAttempts(flow.attempts), receipt };
}

/**
 * §13: a delivery that happened but was never signed for.
 *
 * The state this chases is the expensive one. The goods are gone, the customer has them, and AIES
 * cannot invoice — so unlike most sweeps here, doing nothing has a running cost rather than a
 * compliance one. It fires once per flow: `unsignedEscalatedAt` is the marker, and a nightly job
 * that renotified every night would be filtered into a rule within a week.
 *
 * Courier and own-vehicle deliveries land here by the same door. §13.2 makes a POD produce
 * `delivered_unsigned` precisely so the clock that chases a missing signature does not have to know
 * how the box travelled.
 */
export async function sweepUnsignedDeliveryReceipts() {
  const flows = await db.deliveryTicketFlow.findMany({
    where: {
      deletedAt: null,
      status: "delivered_unsigned",
      deliveredAt: { not: null },
      unsignedEscalatedAt: null,
    },
    select: {
      id: true,
      ticketId: true,
      deliveredAt: true,
      mode: true,
      deliveryReceiptId: true,
      driverName: true,
      drIssuedById: true,
      drRequestedById: true,
      ticket: { select: { number: true } },
    },
  });

  const now = new Date();
  let escalated = 0;

  for (const flow of flows) {
    const workingDaysSince = Math.floor(
      businessMsBetween(flow.deliveredAt!, now) / BUSINESS_DAY_MS,
    );
    const standing = unsignedStanding({ deliveredAt: flow.deliveredAt, workingDaysSince });
    if (!standing.overdue) continue;

    await db.$transaction(async (tx) => {
      await tx.deliveryTicketFlow.update({
        where: { id: flow.id },
        data: { unsignedEscalatedAt: now, version: { increment: 1 } },
      });

      await emit(
        tx,
        "delivery.dr_unsigned_overdue",
        {
          deliveryFlowId: flow.id,
          ticketId: flow.ticketId,
          ticketNumber: flow.ticket.number,
          deliveryReceiptId: flow.deliveryReceiptId,
          mode: flow.mode,
          deliveredAt: flow.deliveredAt,
          workingDaysSince,
          message: standing.message,
        },
        {},
      );
    });

    // The event is the record; this is the part somebody sees. The person who issued the DR is the
    // one who cannot bill without it back, so the chase lands with them; whoever requested it is the
    // fallback for a flow that never reached issue.
    //
    // Not the driver: `driverName` is free text, deliberately, because a hired driver has no account
    // here. A notification needs a user, and inventing one from a name would be a guess.
    const recipientId = flow.drIssuedById ?? flow.drRequestedById;
    if (recipientId) {
      try {
        await notify({
          recipientId,
          type: UNSIGNED_DR_NOTIFICATION_TYPE,
          title: `${flow.ticket.number} was delivered ${workingDaysSince} working days ago and is still unsigned`,
          body: standing.message,
          entityType: DELIVERY_FLOW_ENTITY_TYPE,
          entityId: flow.id,
        });
      } catch (error) {
        console.error("[operations] failed to notify about an unsigned DR", flow.id, error);
      }
    }

    escalated += 1;
  }

  return { checked: flows.length, escalated };
}
