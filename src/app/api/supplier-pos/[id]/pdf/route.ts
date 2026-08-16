import { NextResponse } from "next/server";
import { auth } from "@/auth";
import { db } from "@/lib/db";
import { renderSupplierPoPdf } from "@/server/core/order/pdf/render";
import { resolveSessionUser } from "@/server/core/rbac/permissions";

/**
 * §5's branded purchase order, as a download.
 *
 * A route handler rather than a tRPC procedure, for the same reason as the quotation's and the
 * RFQ's: the response is bytes and the browser needs a real download with a filename.
 *
 * Either procurement permission opens it. `supplier_po.approve` is included because the VP has to
 * read the document they are approving, and sending them to ask procurement for a copy is how an
 * approval becomes a rubber stamp.
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
  if (
    !resolved.permissions.has("supplier_po.create") &&
    !resolved.permissions.has("supplier_po.approve")
  ) {
    return NextResponse.json({ error: "forbidden" }, { status: 403 });
  }

  const po = await db.supplierPO.findFirst({
    where: { id, deletedAt: null },
    select: { id: true, number: true },
  });
  if (!po) {
    return NextResponse.json({ error: "not_found" }, { status: 404 });
  }

  const pdf = await renderSupplierPoPdf(po.id);

  return new NextResponse(new Uint8Array(pdf), {
    headers: {
      "Content-Type": "application/pdf",
      "Content-Disposition": `attachment; filename="${po.number}.pdf"`,
      // Never cached: an approved PO's document changes the moment the approver's name lands on it.
      "Cache-Control": "no-store",
    },
  });
}
