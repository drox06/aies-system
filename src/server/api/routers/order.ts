import { z } from "zod";
import { p, router, type Context } from "@/server/api/trpc";
import type { ActorMeta } from "@/server/core/crm/account-service";
import {
  listCustomerPosForInquiry,
  recordCustomerPoService,
} from "@/server/core/order/customer-po-service";

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
        inquiryId: z.string(),
        quotationId: z.string().nullish(),
        poNumber: z.string().min(1),
        poDate: z.coerce.date(),
        amount: z.string().min(1),
        currency: z.string().optional(),
        fileId: z.string(),
      }),
    )
    .mutation(({ ctx, input }) => recordCustomerPoService(actorMeta(ctx), input)),

  forInquiry: p("customer_po.view")
    .input(z.object({ inquiryId: z.string() }))
    .query(async ({ input }) => {
      const rows = await listCustomerPosForInquiry(input.inquiryId);
      // Decimal crosses the wire as a string, never through a float — the same rule as every other
      // money field in this build.
      return rows.map((row) => ({ ...row, amount: row.amount.toString() }));
    }),
});
