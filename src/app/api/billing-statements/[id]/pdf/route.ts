import { NextResponse } from "next/server";
import { auth } from "@/auth";
import { resolveSessionUser } from "@/server/core/rbac/permissions";
import { renderBillingStatementPdf } from "@/server/core/finance/pdf/render";
import { db } from "@/lib/db";

/**
 * §3's billing statement as a PDF — the document that actually asks the customer for money.
 *
 * A route handler rather than a tRPC procedure for the same reason `service-invoices/[id]/pdf` is:
 * the response is bytes, and tRPC would base64 them through a JSON envelope for no benefit.
 *
 * ## Gated on reading finance, matching the invoice route
 *
 * `finance.view` rather than `billing_statement.create`/`billing_statement.issue`. Somebody checking
 * a figure before a call, or re-fetching a copy to resend, is not raising or issuing anything — the
 * same reasoning the service-invoice route already applies.
 *
 * ## Draft and cancelled both render
 *
 * A draft renders watermarked, because finance may want to preview it before issuing. A cancelled
 * statement renders marked, for the same accountability reason a cancelled invoice does — it is kept,
 * not deleted, so it has to remain producible.
 */
export const runtime = "nodejs";

export async function GET(_request: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;

  const session = await auth();
  if (!session?.user?.id) {
    return NextResponse.json({ error: "unauthenticated" }, { status: 401 });
  }

  const user = await resolveSessionUser(session.user.id);
  if (!user?.permissions.has("finance.view")) {
    return NextResponse.json({ error: "forbidden" }, { status: 403 });
  }

  const statement = await db.billingStatement.findFirst({
    where: { id, deletedAt: null },
    select: { number: true },
  });
  if (!statement) {
    return NextResponse.json({ error: "not found" }, { status: 404 });
  }

  const pdf = await renderBillingStatementPdf(id);

  return new NextResponse(new Uint8Array(pdf), {
    headers: {
      "Content-Type": "application/pdf",
      // `inline`, matching every other document PDF in the app: the commonest reason to open this
      // is to check a figure before telling a customer something.
      "Content-Disposition": `inline; filename="${statement.number}.pdf"`,
      "Cache-Control": "private, no-store",
    },
  });
}
