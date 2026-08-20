import { NextResponse } from "next/server";
import { auth } from "@/auth";
import { resolveSessionUser } from "@/server/core/rbac/permissions";
import { renderServiceInvoicePdf } from "@/server/core/finance/pdf/render";
import { db } from "@/lib/db";

/**
 * §3's service invoice as a PDF — the document the customer actually needs.
 *
 * A route handler rather than a tRPC procedure for the same reason the quotation's is: the response
 * is bytes, and tRPC would base64 them through a JSON envelope for no benefit.
 *
 * ## Gated on reading finance, not on issuing
 *
 * `finance.view` rather than `payment.record`. Issuing an invoice is the heavy act and is already
 * behind the heavier permission; **reading one back** is what somebody does when a customer rings
 * asking for a copy, and making that require the permission to create BIR documents would push
 * people to forward each other PDFs by email instead — which is how a superseded copy ends up
 * being the one the customer files.
 *
 * ## Cancelled invoices still render
 *
 * §3: cancelled invoices are retained and marked, never deleted. The document prints with the
 * cancellation across it, because BIR expects every number in the series to be accountable and a
 * refusal here would leave AIES unable to show what a number was used for.
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

  const invoice = await db.serviceInvoice.findFirst({
    where: { id },
    select: { number: true },
  });
  if (!invoice) {
    return NextResponse.json({ error: "not found" }, { status: 404 });
  }

  const pdf = await renderServiceInvoicePdf(id);

  return new NextResponse(new Uint8Array(pdf), {
    headers: {
      "Content-Type": "application/pdf",
      // `inline` rather than `attachment`: the commonest reason to open this is to check a figure
      // before telling a customer something, and a download for that is friction.
      "Content-Disposition": `inline; filename="${invoice.number}.pdf"`,
      "Cache-Control": "private, no-store",
    },
  });
}
