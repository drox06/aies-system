import { z } from "zod";
import { p, router, type Context } from "@/server/api/trpc";
import type { ActorMeta } from "@/server/core/crm/account-service";
import {
  listCustomerPosForInquiry,
  listCustomerPosForQuotation,
  recordCustomerPoService,
} from "@/server/core/order/customer-po-service";
import {
  checkCustomerPoService,
  createSalesOrderFromPoService,
  getSalesOrderService,
  listSalesOrdersService,
  verifyCustomerPoService,
} from "@/server/core/order/sales-order-service";
import {
  acceptGoodsReceiptService,
  createGoodsReceiptService,
  getGoodsReceiptService,
  inspectGoodsReceiptService,
  listGoodsReceiptsService,
  outstandingForSupplierPoService,
} from "@/server/core/order/goods-receipt-service";
import { buildSupplierPoEmailText } from "@/server/core/order/pdf/render";
import {
  decideSupplierPoApprovalService,
  getSupplierPoApprovalStateService,
  submitSupplierPoForApprovalService,
} from "@/server/core/order/supplier-po-approval";
import {
  acknowledgeSupplierPoService,
  cancelSupplierPoService,
  createSupplierPosFromSalesOrderService,
  getSupplierPoService,
  listStaleCostsForSalesOrderService,
  listSupplierPosService,
  sendSupplierPoService,
  supplierPoGatesService,
  updateSupplierPoService,
} from "@/server/core/order/supplier-po-service";
import {
  deleteSupplierService,
  getSupplierService,
  listSuppliersService,
  setSupplierApprovalService,
  upsertSupplierService,
} from "@/server/core/order/supplier-service";

/**
 * The line quantities a person read off the customer's PDF.
 *
 * Shared by the check and the verify so the two can never disagree about what was compared — the
 * verify re-runs the check over exactly this input before it records anything.
 */
const PO_CHECK_LINES = z.array(
  z.object({
    lineNo: z.number().int().positive(),
    description: z.string(),
    quantity: z.number(),
  }),
);

/**
 * Module 03's opening act (specs/03-order-procurement.md §1-2): recording the customer's PO.
 *
 * Importing the service here is also what arms two registrations it makes at module scope — the
 * file-access checker for PO scans, and the answer to §3's "does this inquiry have a PO?" gate. The
 * router is the guaranteed entry point, so this import is what makes both real in the running app.
 */

function actorMeta(ctx: Context & { user: { id: string; name: string } }): ActorMeta {
  return {
    actorId: ctx.user.id,
    actorLabel: ctx.user.name,
    ip: ctx.ip,
    userAgent: ctx.userAgent,
    requestId: ctx.requestId,
  };
}

export const orderRouter = router({
  /**
   * Records the PO and moves the inquiry out of "Sent".
   *
   * `fileId` refers to an upload already made through `POST /api/files` against entity type
   * `CustomerPO`. Two steps rather than one multipart mutation because tRPC carries JSON, and
   * because the service re-reads the stored file to check it is the one it claims to be — an id in
   * a request body proves nothing on its own.
   */
  recordCustomerPo: p("customer_po.record")
    .input(
      z.object({
        // One of the two. A quotation raised outside the inquiry pipeline still receives POs.
        inquiryId: z.string().nullish(),
        quotationId: z.string().nullish(),
        poNumber: z.string().min(1),
        poDate: z.coerce.date(),
        amount: z.string().min(1),
        currency: z.string().optional(),
        fileId: z.string(),
      }),
    )
    .mutation(({ ctx, input }) => recordCustomerPoService(actorMeta(ctx), input)),

  forQuotation: p("customer_po.view")
    .input(z.object({ quotationId: z.string() }))
    .query(async ({ input }) => {
      const rows = await listCustomerPosForQuotation(input.quotationId);
      return rows.map((row) => ({ ...row, amount: row.amount.toString() }));
    }),

  forInquiry: p("customer_po.view")
    .input(z.object({ inquiryId: z.string() }))
    .query(async ({ input }) => {
      const rows = await listCustomerPosForInquiry(input.inquiryId);
      // Decimal crosses the wire as a string, never through a float — the same rule as every other
      // money field in this build.
      return rows.map((row) => ({ ...row, amount: row.amount.toString() }));
    }),

  // ---- §2's supplier directory ------------------------------------------------------------------

  listSuppliers: p("supplier.manage")
    .input(
      z
        .object({ search: z.string().optional(), principalsOnly: z.boolean().optional() })
        .optional(),
    )
    .query(({ input }) => listSuppliersService(input ?? {})),

  getSupplier: p("supplier.manage")
    .input(z.object({ supplierId: z.string() }))
    .query(({ input }) => getSupplierService(input.supplierId)),

  /**
   * §2: "Make the create/edit form fast and forgiving — it is the only way suppliers get in."
   * `name` is the only required field, and the schema reflects that.
   */
  upsertSupplier: p("supplier.manage")
    .input(
      z.object({
        supplierId: z.string().nullish(),
        name: z.string().min(1),
        isPrincipal: z.boolean().optional(),
        country: z.string().nullish(),
        currency: z.string().optional(),
        contactName: z.string().nullish(),
        email: z.string().email().nullish().or(z.literal("")),
        phone: z.string().nullish(),
        address: z.unknown().optional(),
        paymentTerms: z.string().nullish(),
        leadTimeDaysTypical: z.number().int().positive().nullish(),
        incoterm: z.string().nullish(),
        productLines: z.array(z.string()).optional(),
        rating: z.number().int().min(1).max(5).nullish(),
        notes: z.string().nullish(),
      }),
    )
    .mutation(({ ctx, input }) => upsertSupplierService(actorMeta(ctx), input)),

  /**
   * The President's removal, for the duplicates and typos §2's forgiving form lets in. Refuses
   * while any purchase order or price request still points at the supplier.
   */
  deleteSupplier: p("supplier.delete")
    .input(z.object({ supplierId: z.string(), reason: z.string().min(3).max(500) }))
    .mutation(({ ctx, input }) => deleteSupplierService(actorMeta(ctx), input)),

  /** ISO 9001 clause 8.4. Narrower than `supplier.manage` — see the manifest. */
  setSupplierApproval: p("supplier.approve")
    .input(
      z.object({
        supplierId: z.string(),
        isApproved: z.boolean(),
        approvalExpiry: z.coerce.date().nullish(),
        reason: z.string().min(3),
      }),
    )
    .mutation(({ ctx, input }) => setSupplierApprovalService(actorMeta(ctx), input)),

  // ---- §3 verification and the sales order ------------------------------------------------------

  /**
   * §3's three-way check, run without writing anything.
   *
   * A query, because the findings have to be on screen *before* anybody commits: "Discrepancies are
   * surfaced on screen and must be resolved (accept, or raise a quotation revision) before the
   * sales order is created."
   */
  checkCustomerPo: p("customer_po.view")
    .input(
      z.object({
        customerPOId: z.string(),
        poLines: PO_CHECK_LINES.optional(),
      }),
    )
    .query(({ input }) => checkCustomerPoService(input)),

  verifyCustomerPo: p("customer_po.record")
    .input(
      z.object({
        customerPOId: z.string(),
        poLines: PO_CHECK_LINES.optional(),
        acceptanceNote: z.string().max(1000).nullish(),
      }),
    )
    .mutation(({ ctx, input }) => verifyCustomerPoService(actorMeta(ctx), input)),

  createSalesOrder: p("sales_order.create")
    .input(
      z.object({
        customerPOId: z.string(),
        requiredByDate: z.coerce.date().nullish(),
        ownerId: z.string().nullish(),
      }),
    )
    .mutation(({ ctx, input }) => createSalesOrderFromPoService(actorMeta(ctx), input)),

  listSalesOrders: p("sales_order.view")
    .input(z.object({ search: z.string().optional(), status: z.string().optional() }).optional())
    .query(({ ctx, input }) => listSalesOrdersService(ctx.user, input ?? {})),

  getSalesOrder: p("sales_order.view")
    .input(z.object({ salesOrderId: z.string() }))
    .query(({ ctx, input }) => getSalesOrderService(ctx.user, input.salesOrderId)),

  // ---- §5's supplier PO -------------------------------------------------------------------------

  /**
   * §5: "select lines → group by supplier → generate draft POs." One call, one PO per supplier.
   */
  createSupplierPos: p("supplier_po.create")
    .input(
      z.object({
        salesOrderId: z.string(),
        lines: z.array(
          z.object({
            salesOrderLineId: z.string(),
            supplierId: z.string(),
            unitCost: z.string().optional(),
            quantity: z.string().optional(),
          }),
        ),
        expectedArrivalDate: z.coerce.date().nullish(),
      }),
    )
    .mutation(({ ctx, input }) => createSupplierPosFromSalesOrderService(actorMeta(ctx), input)),

  updateSupplierPo: p("supplier_po.create")
    .input(
      z.object({
        supplierPOId: z.string(),
        // §12's optimistic lock. Required, not optional: an optional version lets a caller opt out
        // of the lock by omitting it.
        version: z.number().int().nonnegative(),
        poDate: z.coerce.date().optional(),
        fxRate: z.string().optional(),
        freight: z.string().optional(),
        duties: z.string().optional(),
        otherCharges: z.string().optional(),
        expectedShipDate: z.coerce.date().nullish(),
        expectedArrivalDate: z.coerce.date().nullish(),
        incoterm: z.string().nullish(),
        shipmentMode: z.enum(["air", "sea", "land", "courier"]).nullish(),
        trackingRef: z.string().nullish(),
        supplierRef: z.string().nullish(),
        notes: z.string().nullish(),
        lines: z
          .array(
            z.object({
              description: z.string().min(1),
              manufacturer: z.string().nullish(),
              modelNumber: z.string().nullish(),
              quantity: z.string(),
              unit: z.string().optional(),
              unitCost: z.string(),
              leadTimeDays: z.number().int().positive().nullish(),
              salesOrderLineId: z.string().nullish(),
            }),
          )
          .optional(),
      }),
    )
    .mutation(({ ctx, input }) => updateSupplierPoService(actorMeta(ctx), input)),

  getSupplierPo: p("supplier_po.create")
    .input(z.object({ supplierPOId: z.string() }))
    .query(({ input }) => getSupplierPoService(input.supplierPOId)),

  listSupplierPos: p("supplier_po.create")
    .input(
      z
        .object({
          salesOrderId: z.string().optional(),
          supplierId: z.string().optional(),
          status: z.string().optional(),
          openOnly: z.boolean().optional(),
          search: z.string().optional(),
        })
        .optional(),
    )
    .query(({ input }) => listSupplierPosService(input ?? {})),

  /** Both gates, evaluated without writing — so the screen agrees with what `send` enforces. */
  supplierPoGates: p("supplier_po.create")
    .input(z.object({ supplierPOId: z.string() }))
    .query(({ input }) => supplierPoGatesService(input.supplierPOId)),

  /** §5's stale-cost warning, reported rather than enforced. */
  staleCostsForSalesOrder: p("supplier_po.create")
    .input(z.object({ salesOrderId: z.string() }))
    .query(({ input }) => listStaleCostsForSalesOrderService(input.salesOrderId)),

  submitSupplierPoForApproval: p("supplier_po.create")
    .input(z.object({ supplierPOId: z.string() }))
    .mutation(({ ctx, input }) => submitSupplierPoForApprovalService(actorMeta(ctx), input)),

  decideSupplierPoApproval: p("supplier_po.approve")
    .input(
      z.object({
        supplierPOId: z.string(),
        decision: z.enum(["approved", "rejected"]),
        comment: z.string().nullish(),
      }),
    )
    .mutation(({ ctx, input }) => decideSupplierPoApprovalService(actorMeta(ctx), ctx.user, input)),

  supplierPoApprovalState: p("supplier_po.create")
    .input(z.object({ supplierPOId: z.string() }))
    .query(({ ctx, input }) => getSupplierPoApprovalStateService(ctx.user, input.supplierPOId)),

  /**
   * §5: "Issue manually… a person sends it and marks it sent." Both gates bite here, and the
   * override reasons are separate because an auditor asks the two questions separately.
   */
  sendSupplierPo: p("supplier_po.create")
    .input(
      z.object({
        supplierPOId: z.string(),
        downpaymentOverrideReason: z.string().nullish(),
        unapprovedSupplierOverrideReason: z.string().nullish(),
      }),
    )
    .mutation(({ ctx, input }) => sendSupplierPoService(actorMeta(ctx), ctx.user, input)),

  acknowledgeSupplierPo: p("supplier_po.create")
    .input(
      z.object({
        supplierPOId: z.string(),
        supplierRef: z.string().nullish(),
        expectedArrivalDate: z.coerce.date().nullish(),
      }),
    )
    .mutation(({ ctx, input }) => acknowledgeSupplierPoService(actorMeta(ctx), input)),

  cancelSupplierPo: p("supplier_po.create")
    .input(z.object({ supplierPOId: z.string(), reason: z.string().min(3) }))
    .mutation(({ ctx, input }) => cancelSupplierPoService(actorMeta(ctx), input)),

  /** §5's second artefact: the draft email a person pastes into their mail client. */
  supplierPoEmailText: p("supplier_po.create")
    .input(z.object({ supplierPOId: z.string() }))
    .query(({ input }) => buildSupplierPoEmailText(input.supplierPOId)),

  // ---- §6's goods receipt -----------------------------------------------------------------------

  /** What is still owed on a PO, per line — the numbers the receiving screen starts from. */
  outstandingForSupplierPo: p("goods_receipt.create")
    .input(z.object({ supplierPOId: z.string() }))
    .query(({ input }) => outstandingForSupplierPoService(input.supplierPOId)),

  createGoodsReceipt: p("goods_receipt.create")
    .input(
      z.object({
        supplierPOId: z.string(),
        receivedAt: z.coerce.date().optional(),
        packingListRef: z.string().nullish(),
        invoiceRef: z.string().nullish(),
        waybillRef: z.string().nullish(),
        lines: z.array(
          z.object({
            supplierPOLineId: z.string(),
            qtyReceived: z.string(),
            qtyAccepted: z.string().optional(),
            qtyRejected: z.string().optional(),
            rejectionReason: z.string().nullish(),
            serialNumbers: z.array(z.string()).optional(),
            batchNo: z.string().nullish(),
            calibrationCertFileId: z.string().nullish(),
          }),
        ),
      }),
    )
    .mutation(({ ctx, input }) => createGoodsReceiptService(actorMeta(ctx), input)),

  /**
   * ISO 9001 clause 8.4.2. Its own permission, narrower than booking goods in — the person who
   * unloaded the crate should not also be the one certifying it.
   */
  inspectGoodsReceipt: p("goods_receipt.inspect")
    .input(
      z.object({
        goodsReceiptId: z.string(),
        version: z.number().int().nonnegative(),
        quantityChecked: z.boolean(),
        damageChecked: z.boolean(),
        documentationChecked: z.boolean(),
        inspectionNotes: z.string().nullish(),
        lines: z
          .array(
            z.object({
              goodsReceiptLineId: z.string(),
              qtyAccepted: z.string(),
              qtyRejected: z.string(),
              rejectionReason: z.string().nullish(),
              serialNumbers: z.array(z.string()).optional(),
              calibrationCertFileId: z.string().nullish(),
            }),
          )
          .optional(),
      }),
    )
    .mutation(({ ctx, input }) => inspectGoodsReceiptService(actorMeta(ctx), input)),

  /** The only call that advances the customer's order. Gated on the inspection being complete. */
  acceptGoodsReceipt: p("goods_receipt.inspect")
    .input(z.object({ goodsReceiptId: z.string() }))
    .mutation(({ ctx, input }) => acceptGoodsReceiptService(actorMeta(ctx), input)),

  getGoodsReceipt: p("goods_receipt.create")
    .input(z.object({ goodsReceiptId: z.string() }))
    .query(({ input }) => getGoodsReceiptService(input.goodsReceiptId)),

  listGoodsReceipts: p("goods_receipt.create")
    .input(
      z.object({
        supplierPOId: z.string().optional(),
        status: z.string().optional(),
        awaitingInspection: z.boolean().optional(),
      }),
    )
    .query(({ input }) => listGoodsReceiptsService(input)),
});
