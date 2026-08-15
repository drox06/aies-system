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
});
