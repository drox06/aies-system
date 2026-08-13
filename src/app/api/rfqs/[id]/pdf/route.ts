import { NextResponse } from "next/server";
import { auth } from "@/auth";
import { db } from "@/lib/db";
import { renderRfqPdf } from "@/server/core/quotation/pdf/render";
import { resolveSessionUser } from "@/server/core/rbac/permissions";

/**
 * §3.2's "download PDF" action.
 *
 * A route handler rather than a tRPC procedure, for the same reason as the quotation's: the response
 * is bytes and the browser needs a real download with a filename.
 *
 * **No download is recorded here**, unlike the quotation route. That record exists because §7's
 * issuance turns on it — "downloaded by X, ready for sending" is a step in a process. An RFQ has its
 * own explicit `markRfqSent`, so a download is just somebody looking at the document, and counting
 * it would put noise in a trail whose value is that it is not noisy.
 */
export const runtime = "nodejs";

export async function GET(_request: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;

  const session = await auth();
  if (!session?.user?.id) {
    return NextResponse.json({ error: "unauthenticated" }, { status: 401 });
  }

  const resolved = await resolveSessionUser(session.user.id);
  if (!resolved || !resolved.isActive || resolved.deletedAt) {
    return NextResponse.json({ error: "unauthenticated" }, { status: 401 });
  }
  // Same gate as raising one: §3 puts supplier pricing with PD and the two officers.
  if (!resolved.permissions.has("supplier_rfq.manage")) {
    return NextResponse.json({ error: "forbidden" }, { status: 403 });
  }

  const rfq = await db.supplierQuoteRequest.findFirst({
    where: { id, deletedAt: null },
    select: { id: true, number: true },
  });
  if (!rfq) {
    return NextResponse.json({ error: "not_found" }, { status: 404 });
  }

  const pdf = await renderRfqPdf(rfq.id);

  return new NextResponse(new Uint8Array(pdf), {
    headers: {
      "Content-Type": "application/pdf",
      "Content-Disposition": `attachment; filename="${rfq.number}.pdf"`,
      // Never cached: an RFQ redrafted after a line changed must not come back from a proxy.
      "Cache-Control": "no-store",
    },
  });
}
