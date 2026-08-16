import { TRPCError } from "@trpc/server";
import { db } from "@/lib/db";
import { writeAuditLog } from "@/server/core/audit/audit";
import type { ActorMeta } from "@/server/core/crm/account-service";
import { emit } from "@/server/core/events/emit";
import { allocateNumber } from "@/server/core/numbering/numbering";
import { registerFileAccessChecker } from "@/server/core/storage/access";
import {
  checkReceiptLines,
  inspectionGate,
  procurementStatusFrom,
  receiptStatusFrom,
  supplierPoStatusFromReceipts,
  GOODS_RECEIPT_CREATE_PERMISSION,
  GOODS_RECEIPT_DOCUMENT_TYPE,
  GOODS_RECEIPT_ENTITY_TYPE,
  GOODS_RECEIPT_INSPECT_PERMISSION,
} from "./goods-receipt-rules";

/**
 * Goods receipt (specs/03-order-procurement.md §6).
 *
 * §6 opens with a requirement rather than a description — "**Incoming inspection is required** (ISO
 * 9001 clause 8.4.2…)" — and that shapes the whole flow: a receipt is created as a `draft` while
 * somebody counts what came off the truck, and it cannot be **accepted** until the four checks are
 * done. Nothing reaches the customer's order until then.
 *
 * ## Why acceptance is a separate step from recording
 *
 * The obvious design is one call: type the quantities, save, done. It would be wrong here, because
 * the two acts happen at different times and often by different people. The boxes arrive and are
 * counted at the gate; the calibration certificates are checked against them later, sometimes the
 * next day. A single call would force whoever signs for the delivery to also certify the paperwork
 * they have not seen — and the reliable result of that is a tick box that always gets ticked.
 *
 * So: `createGoodsReceiptService` records what arrived, `inspectGoodsReceiptService` records the
 * clause 8.4.2 checks, and `acceptGoodsReceiptService` is what moves the quantities. Only the last
 * of those touches `SalesOrderLine.qtyReceived`.
 */

export { GOODS_RECEIPT_DOCUMENT_TYPE, GOODS_RECEIPT_ENTITY_TYPE } from "./goods-receipt-rules";

/**
 * §6's photographs, and the certificates attached per line.
 *
 * Both are ordinary `FileObject` rows keyed by this entity, rather than §2's sketch of a
 * `photoFileIds String[]` column. The array would be a second attachment mechanism next to the one
 * module 00 already built — and that one brings listing, removal, access control, thumbnails and
 * the `-web` derivative with it. A string array brings none of those and cannot be made to.
 */
registerFileAccessChecker(GOODS_RECEIPT_ENTITY_TYPE, async (user, file) => {
  if (
    !user.permissions.has(GOODS_RECEIPT_CREATE_PERMISSION) &&
    !user.permissions.has(GOODS_RECEIPT_INSPECT_PERMISSION)
  ) {
    return false;
  }
  const receipt = await db.goodsReceipt.findFirst({
    where: { id: file.entityId, deletedAt: null },
  });
  return receipt !== null;
});

// ---- recording what arrived ---------------------------------------------------------------------

export interface ReceiveLineInput {
  supplierPOLineId: string;
  qtyReceived: string;
  qtyAccepted?: string;
  qtyRejected?: string;
  rejectionReason?: string | null;
  serialNumbers?: string[];
  batchNo?: string | null;
  calibrationCertFileId?: string | null;
}

/**
 * Books a delivery in as a draft.
 *
 * Partial receipts are the normal case (§6), so this validates against **what is still owed** on
 * each PO line rather than against the line total: a PO for five that has already had three cannot
 * take another five, and the message says how many it can take.
 */
export async function createGoodsReceiptService(
  actor: ActorMeta,
  input: {
    supplierPOId: string;
    lines: ReceiveLineInput[];
    receivedAt?: Date;
    packingListRef?: string | null;
    invoiceRef?: string | null;
    waybillRef?: string | null;
  },
) {
  if (input.lines.length === 0) {
    throw new TRPCError({
      code: "BAD_REQUEST",
      message: "Record what actually arrived — a receipt with no lines is not a receipt.",
    });
  }

  const po = await db.supplierPO.findFirst({
    where: { id: input.supplierPOId, deletedAt: null },
    include: { lines: true, supplier: { select: { name: true } } },
  });
  if (!po) {
    throw new TRPCError({ code: "NOT_FOUND", message: "That supplier PO no longer exists." });
  }
  if (po.status === "draft" || po.status === "pending_approval") {
    // Goods cannot arrive against an order nobody has placed. If they have, the order was placed
    // outside the system and the fix is to record it, not to receive against a draft.
    throw new TRPCError({
      code: "BAD_REQUEST",
      message:
        `${po.number} has not been sent to ${po.supplier.name} yet, so nothing can have arrived ` +
        `against it. If the order was placed another way, record that first.`,
    });
  }
  if (po.status === "cancelled") {
    throw new TRPCError({
      code: "BAD_REQUEST",
      message: `${po.number} was cancelled. Goods arriving against it need an order behind them.`,
    });
  }

  const poLineById = new Map(po.lines.map((line) => [line.id, line]));
  for (const line of input.lines) {
    if (!poLineById.has(line.supplierPOLineId)) {
      throw new TRPCError({
        code: "BAD_REQUEST",
        message: `A line on this receipt does not belong to ${po.number}.`,
      });
    }
  }

  // §11's arithmetic, in the pure rules file so the screen refuses exactly the same things.
  const check = checkReceiptLines(
    input.lines.map((line) => {
      const poLine = poLineById.get(line.supplierPOLineId)!;
      const received = Number(line.qtyReceived);
      return {
        supplierPOLineId: line.supplierPOLineId,
        description: poLine.description,
        qtyOrdered: Number(poLine.quantity),
        qtyAlreadyReceived: Number(poLine.qtyReceived),
        qtyReceived: received,
        // Everything is accepted unless somebody says otherwise. The inspection is where rejection
        // is decided, and defaulting to rejected would make the common case the fiddly one.
        qtyAccepted: line.qtyAccepted !== undefined ? Number(line.qtyAccepted) : received,
        qtyRejected: line.qtyRejected !== undefined ? Number(line.qtyRejected) : 0,
      };
    }),
  );
  if (!check.ok) {
    throw new TRPCError({
      code: "BAD_REQUEST",
      message: check.problems.map((problem) => problem.message).join(" "),
    });
  }

  for (const line of input.lines) {
    const rejected = line.qtyRejected !== undefined ? Number(line.qtyRejected) : 0;
    if (rejected > 0 && (line.rejectionReason?.trim().length ?? 0) < 3) {
      throw new TRPCError({
        code: "BAD_REQUEST",
        message:
          `Say why ${poLineById.get(line.supplierPOLineId)!.description} was rejected. That ` +
          `sentence is what goes to the supplier, and what module 08 raises the NCR from.`,
      });
    }
  }

  const number = await allocateNumber(GOODS_RECEIPT_DOCUMENT_TYPE);

  return db.$transaction(async (tx) => {
    const receipt = await tx.goodsReceipt.create({
      data: {
        number,
        supplierPOId: po.id,
        receivedAt: input.receivedAt ?? new Date(),
        receivedById: actor.actorId,
        status: "draft",
        packingListRef: input.packingListRef ?? null,
        invoiceRef: input.invoiceRef ?? null,
        waybillRef: input.waybillRef ?? null,
        lines: {
          create: input.lines.map((line) => {
            const received = Number(line.qtyReceived);
            return {
              supplierPOLineId: line.supplierPOLineId,
              qtyReceived: line.qtyReceived,
              qtyAccepted: line.qtyAccepted !== undefined ? line.qtyAccepted : received.toString(),
              qtyRejected: line.qtyRejected ?? "0",
              rejectionReason: line.rejectionReason?.trim() || null,
              serialNumbers: line.serialNumbers ?? [],
              batchNo: line.batchNo ?? null,
              calibrationCertFileId: line.calibrationCertFileId ?? null,
            };
          }),
        },
      },
      include: { lines: true },
    });

    await writeAuditLog(tx, {
      actorId: actor.actorId,
      actorLabel: actor.actorLabel,
      action: "create",
      entityType: GOODS_RECEIPT_ENTITY_TYPE,
      entityId: receipt.id,
      summary:
        `Booked in ${receipt.number} against ${po.number} from ${po.supplier.name}: ` +
        `${receipt.lines.length} line(s). Awaiting incoming inspection.`,
      ip: actor.ip,
      userAgent: actor.userAgent,
      requestId: actor.requestId,
    });

    return receipt;
  });
}

// ---- §6's incoming inspection -------------------------------------------------------------------

/**
 * Records the clause 8.4.2 checks, and can revise what was accepted while doing so.
 *
 * The inspection is where rejection is actually decided — the person at the gate counts, the person
 * with the datasheet judges — so this takes optional line revisions rather than making somebody go
 * back and edit the receipt first.
 *
 * `photosAttached` is **counted, not claimed**. A tick box asking "did you take photos?" is a tick
 * box that gets ticked; this reads the stored files. It is then frozen on the record, so a photo
 * deleted next year cannot retroactively invalidate an inspection that really happened.
 */
export async function inspectGoodsReceiptService(
  actor: ActorMeta,
  input: {
    goodsReceiptId: string;
    version: number;
    quantityChecked: boolean;
    damageChecked: boolean;
    documentationChecked: boolean;
    inspectionNotes?: string | null;
    lines?: {
      goodsReceiptLineId: string;
      qtyAccepted: string;
      qtyRejected: string;
      rejectionReason?: string | null;
      serialNumbers?: string[];
      calibrationCertFileId?: string | null;
    }[];
  },
) {
  const receipt = await db.goodsReceipt.findFirst({
    where: { id: input.goodsReceiptId, deletedAt: null },
    include: { lines: { include: { supplierPOLine: true } }, supplierPO: true },
  });
  if (!receipt) {
    throw new TRPCError({ code: "NOT_FOUND", message: "That goods receipt no longer exists." });
  }
  if (receipt.version !== input.version) {
    throw new TRPCError({
      code: "CONFLICT",
      message: `${receipt.number} was changed by somebody else while you were inspecting it. Reload it.`,
    });
  }
  if (receipt.status === "accepted" || receipt.status === "partially_rejected") {
    throw new TRPCError({
      code: "BAD_REQUEST",
      message:
        `${receipt.number} has already been accepted and its quantities are on the sales order. ` +
        `Book a correction in as its own receipt rather than rewriting this one.`,
    });
  }

  const lineById = new Map(receipt.lines.map((line) => [line.id, line]));
  for (const revision of input.lines ?? []) {
    if (!lineById.has(revision.goodsReceiptLineId)) {
      throw new TRPCError({
        code: "BAD_REQUEST",
        message: `A line on this inspection does not belong to ${receipt.number}.`,
      });
    }
  }
  const revisionById = new Map(
    (input.lines ?? []).map((revision) => [revision.goodsReceiptLineId, revision]),
  );

  const check = checkReceiptLines(
    receipt.lines.map((line) => {
      const revision = revisionById.get(line.id);
      return {
        supplierPOLineId: line.supplierPOLineId,
        description: line.supplierPOLine.description,
        qtyOrdered: Number(line.supplierPOLine.quantity),
        // This receipt's own quantity is not "already received" against itself.
        qtyAlreadyReceived: Number(line.supplierPOLine.qtyReceived),
        qtyReceived: Number(line.qtyReceived),
        qtyAccepted: revision ? Number(revision.qtyAccepted) : Number(line.qtyAccepted),
        qtyRejected: revision ? Number(revision.qtyRejected) : Number(line.qtyRejected),
      };
    }),
  );
  if (!check.ok) {
    throw new TRPCError({
      code: "BAD_REQUEST",
      message: check.problems.map((problem) => problem.message).join(" "),
    });
  }

  for (const line of receipt.lines) {
    const revision = revisionById.get(line.id);
    const rejected = revision ? Number(revision.qtyRejected) : Number(line.qtyRejected);
    const reason = revision ? revision.rejectionReason : line.rejectionReason;
    if (rejected > 0 && (reason?.trim().length ?? 0) < 3) {
      throw new TRPCError({
        code: "BAD_REQUEST",
        message: `Say why ${line.supplierPOLine.description} was rejected.`,
      });
    }
  }

  // Counted from the stored files, never claimed on a form.
  const photoCount = await db.fileObject.count({
    where: {
      entityType: GOODS_RECEIPT_ENTITY_TYPE,
      entityId: receipt.id,
      deletedAt: null,
      mimeType: { startsWith: "image/" },
    },
  });

  const gate = inspectionGate({
    quantityChecked: input.quantityChecked,
    damageChecked: input.damageChecked,
    documentationChecked: input.documentationChecked,
    photosAttached: photoCount > 0,
  });

  return db.$transaction(async (tx) => {
    for (const revision of input.lines ?? []) {
      await tx.goodsReceiptLine.update({
        where: { id: revision.goodsReceiptLineId },
        data: {
          qtyAccepted: revision.qtyAccepted,
          qtyRejected: revision.qtyRejected,
          rejectionReason: revision.rejectionReason?.trim() || null,
          ...(revision.serialNumbers !== undefined
            ? { serialNumbers: revision.serialNumbers }
            : {}),
          ...(revision.calibrationCertFileId !== undefined
            ? { calibrationCertFileId: revision.calibrationCertFileId }
            : {}),
        },
      });
    }

    const updated = await tx.goodsReceipt.update({
      where: { id: receipt.id },
      data: {
        quantityChecked: input.quantityChecked,
        damageChecked: input.damageChecked,
        documentationChecked: input.documentationChecked,
        photosAttached: photoCount > 0,
        inspectionNotes: input.inspectionNotes ?? null,
        inspectedById: actor.actorId,
        inspectedAt: new Date(),
        // `inspected` means the checks were recorded, not that they all passed. The gate decides
        // whether it can go on to be accepted.
        status: gate.complete ? "inspected" : "draft",
        version: { increment: 1 },
      },
      include: { lines: true },
    });

    await writeAuditLog(tx, {
      actorId: actor.actorId,
      actorLabel: actor.actorLabel,
      action: "inspected",
      entityType: GOODS_RECEIPT_ENTITY_TYPE,
      entityId: receipt.id,
      summary:
        `Incoming inspection on ${receipt.number} (ISO 9001 clause 8.4.2): ` +
        (gate.complete ? "all four checks done" : `outstanding — ${gate.missing.join(", ")}`) +
        (input.inspectionNotes ? `. ${input.inspectionNotes}` : ""),
      ip: actor.ip,
      userAgent: actor.userAgent,
      requestId: actor.requestId,
    });

    return { ...updated, gate };
  });
}

// ---- acceptance, which is what moves the quantities ---------------------------------------------

/**
 * Accepts an inspected receipt, and this is the only thing that advances fulfilment.
 *
 * Everything before this is bookkeeping about a delivery; this is where the customer's order learns
 * that some of what it is owed has arrived. So it is the one place the clause 8.4.2 gate is
 * enforced, and it moves three things in one transaction:
 *
 *  1. `SupplierPOLine.qtyReceived` — accepted quantities only.
 *  2. `SalesOrderLine.qtyReceived` — for lines the PO was raised against.
 *  3. The supplier PO's status, and the sales order's procurement workstream, both **derived** from
 *     the quantities rather than set by hand.
 *
 * §6 sends rejections to module 08 as an NCR. Module 08 does not exist, so `goods.rejected` is
 * emitted with everything the NCR will need and the reason is on the line. Inventing an NCR model
 * here would give module 08 something to reconcile rather than something to build.
 */
export async function acceptGoodsReceiptService(
  actor: ActorMeta,
  input: { goodsReceiptId: string },
) {
  const receipt = await db.goodsReceipt.findFirst({
    where: { id: input.goodsReceiptId, deletedAt: null },
    include: {
      lines: { include: { supplierPOLine: true } },
      supplierPO: { include: { lines: true, supplier: { select: { name: true } } } },
    },
  });
  if (!receipt) {
    throw new TRPCError({ code: "NOT_FOUND", message: "That goods receipt no longer exists." });
  }
  if (receipt.status !== "inspected") {
    if (receipt.status === "draft") {
      const gate = inspectionGate(receipt);
      throw new TRPCError({ code: "BAD_REQUEST", message: gate.message });
    }
    throw new TRPCError({
      code: "BAD_REQUEST",
      message: `${receipt.number} is ${receipt.status.replace(/_/g, " ")}, so it cannot be accepted again.`,
    });
  }

  const status = receiptStatusFrom(
    receipt.lines.map((line) => ({
      qtyAccepted: Number(line.qtyAccepted),
      qtyRejected: Number(line.qtyRejected),
    })),
  );

  const acceptedByPoLineId = new Map<string, number>();
  for (const line of receipt.lines) {
    acceptedByPoLineId.set(
      line.supplierPOLineId,
      (acceptedByPoLineId.get(line.supplierPOLineId) ?? 0) + Number(line.qtyAccepted),
    );
  }

  const rejected = receipt.lines.filter((line) => Number(line.qtyRejected) > 0);

  const result = await db.$transaction(async (tx) => {
    // 1. The supplier PO's own lines.
    for (const [supplierPOLineId, accepted] of acceptedByPoLineId) {
      if (accepted === 0) continue;
      await tx.supplierPOLine.update({
        where: { id: supplierPOLineId },
        data: { qtyReceived: { increment: accepted } },
      });
    }

    // 2. The customer's order, for lines this PO was raised against. A PO line with no
    //    `salesOrderLineId` is stock or a module 04 material request — real, and not part of any
    //    customer's fulfilment.
    const salesOrderIds = new Set<string>();
    for (const line of receipt.lines) {
      const accepted = Number(line.qtyAccepted);
      if (accepted === 0) continue;
      const salesOrderLineId = line.supplierPOLine.salesOrderLineId;
      if (!salesOrderLineId) continue;

      const salesOrderLine = await tx.salesOrderLine.update({
        where: { id: salesOrderLineId },
        data: { qtyReceived: { increment: accepted }, status: "received" },
      });
      salesOrderIds.add(salesOrderLine.salesOrderId);
    }

    // 3. Derived statuses, never hand-set.
    const poLines = await tx.supplierPOLine.findMany({
      where: { supplierPOId: receipt.supplierPOId },
    });
    const poStatus = supplierPoStatusFromReceipts(
      poLines.map((line) => ({
        quantity: Number(line.quantity),
        qtyReceived: Number(line.qtyReceived),
      })),
      receipt.supplierPO.status,
    );
    await tx.supplierPO.update({
      where: { id: receipt.supplierPOId },
      data: { status: poStatus, version: { increment: 1 } },
    });

    for (const salesOrderId of salesOrderIds) {
      const siblings = await tx.supplierPO.findMany({
        where: { salesOrderId, deletedAt: null },
        select: { status: true },
      });
      await tx.salesOrder.update({
        where: { id: salesOrderId },
        data: {
          procurementStatus: procurementStatusFrom(siblings.map((sibling) => sibling.status)),
          version: { increment: 1 },
        },
      });
    }

    const updated = await tx.goodsReceipt.update({
      where: { id: receipt.id },
      data: { status, version: { increment: 1 } },
      include: { lines: true },
    });

    await writeAuditLog(tx, {
      actorId: actor.actorId,
      actorLabel: actor.actorLabel,
      action: "accepted",
      entityType: GOODS_RECEIPT_ENTITY_TYPE,
      entityId: receipt.id,
      summary:
        `Accepted ${receipt.number} against ${receipt.supplierPO.number} — ` +
        `${status.replace(/_/g, " ")}` +
        (rejected.length > 0
          ? `. Rejected: ${rejected
              .map(
                (line) =>
                  `${line.supplierPOLine.description} ×${line.qtyRejected.toString()} (${line.rejectionReason})`,
              )
              .join("; ")}`
          : "") +
        `. ${receipt.supplierPO.number} is now ${poStatus.replace(/_/g, " ")}.`,
      ip: actor.ip,
      userAgent: actor.userAgent,
      requestId: actor.requestId,
    });

    await emit(
      tx,
      "goods.received",
      {
        goodsReceiptId: receipt.id,
        number: receipt.number,
        supplierPOId: receipt.supplierPOId,
        supplierPoStatus: poStatus,
        // Per line, and carrying the serial numbers, because §6 says these "become the
        // installed-equipment register in module 04". A summary would make module 04 re-read the
        // receipt, and the register is about *which units*, not how many.
        lines: receipt.lines.map((line) => ({
          goodsReceiptLineId: line.id,
          supplierPOLineId: line.supplierPOLineId,
          salesOrderLineId: line.supplierPOLine.salesOrderLineId,
          description: line.supplierPOLine.description,
          qtyAccepted: line.qtyAccepted.toString(),
          serialNumbers: line.serialNumbers,
          batchNo: line.batchNo,
        })),
      },
      { actorId: actor.actorId, requestId: actor.requestId },
    );

    if (rejected.length > 0) {
      await emit(
        tx,
        "goods.rejected",
        {
          goodsReceiptId: receipt.id,
          number: receipt.number,
          supplierPOId: receipt.supplierPOId,
          supplierId: receipt.supplierPO.supplierId,
          // Everything module 08's NCR needs, so raising one later is a read of this event rather
          // than an archaeology exercise across three tables.
          lines: rejected.map((line) => ({
            goodsReceiptLineId: line.id,
            description: line.supplierPOLine.description,
            qtyRejected: line.qtyRejected.toString(),
            reason: line.rejectionReason,
          })),
        },
        { actorId: actor.actorId, requestId: actor.requestId },
      );
    }

    return updated;
  });

  return result;
}

// ---- reads --------------------------------------------------------------------------------------

export async function getGoodsReceiptService(goodsReceiptId: string) {
  const receipt = await db.goodsReceipt.findFirst({
    where: { id: goodsReceiptId, deletedAt: null },
    include: {
      lines: { include: { supplierPOLine: true }, orderBy: { createdAt: "asc" } },
      supplierPO: {
        select: {
          id: true,
          number: true,
          currency: true,
          supplier: { select: { id: true, name: true } },
          salesOrder: { select: { id: true, number: true } },
        },
      },
    },
  });
  if (!receipt) {
    throw new TRPCError({ code: "NOT_FOUND", message: "That goods receipt no longer exists." });
  }

  return {
    ...receipt,
    gate: inspectionGate(receipt),
    lines: receipt.lines.map((line) => ({
      ...line,
      qtyReceived: line.qtyReceived.toString(),
      qtyAccepted: line.qtyAccepted.toString(),
      qtyRejected: line.qtyRejected.toString(),
      description: line.supplierPOLine.description,
      qtyOrdered: line.supplierPOLine.quantity.toString(),
      unit: line.supplierPOLine.unit,
      supplierPOLine: undefined,
    })),
  };
}

export async function listGoodsReceiptsService(params: { supplierPOId?: string; status?: string }) {
  const receipts = await db.goodsReceipt.findMany({
    where: {
      deletedAt: null,
      ...(params.supplierPOId ? { supplierPOId: params.supplierPOId } : {}),
      ...(params.status ? { status: params.status } : {}),
    },
    orderBy: { receivedAt: "desc" },
    include: {
      supplierPO: { select: { id: true, number: true, supplier: { select: { name: true } } } },
      _count: { select: { lines: true } },
    },
  });

  return receipts.map((receipt) => ({
    ...receipt,
    gate: inspectionGate(receipt),
  }));
}

/**
 * What is still owed on a supplier PO, per line — the numbers the receiving screen starts from.
 *
 * §8's inventory posture in one query: "Track quantities on hand only as `qtyReceived − qtyDelivered`
 * per sales order line." No perpetual inventory, no valuation, no stock locations. This is the whole
 * of it, and building more would be exactly the speculative inventory module §8 says not to build.
 */
export async function outstandingForSupplierPoService(supplierPOId: string) {
  const po = await db.supplierPO.findFirst({
    where: { id: supplierPOId, deletedAt: null },
    include: { lines: { orderBy: { lineNo: "asc" } } },
  });
  if (!po) {
    throw new TRPCError({ code: "NOT_FOUND", message: "That supplier PO no longer exists." });
  }

  return po.lines.map((line) => ({
    supplierPOLineId: line.id,
    lineNo: line.lineNo,
    description: line.description,
    unit: line.unit,
    qtyOrdered: line.quantity.toString(),
    qtyReceived: line.qtyReceived.toString(),
    qtyOutstanding: (Number(line.quantity) - Number(line.qtyReceived)).toFixed(3),
  }));
}
