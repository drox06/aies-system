import { NextResponse } from "next/server";
import { auth } from "@/auth";
import { db } from "@/lib/db";
import { renderTcCertificatePdf } from "@/server/core/operations/pdf/render";
import { resolveSessionUser } from "@/server/core/rbac/permissions";

/**
 * §10's Testing & Commissioning Certificate, as a download.
 *
 * A route handler rather than a tRPC procedure, for the same reason as module 02's and 03's: the
 * response is bytes and the browser needs a real download with a filename.
 *
 * `ticket.view` opens it. §10 calls this "a primary billing trigger document" — the people who need
 * to read it are the crew who ran the tests and whoever raises the invoice, and gating it behind
 * sign-off would mean the person who must check the certificate cannot open it.
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
  if (!resolved.permissions.has("ticket.view") && !resolved.permissions.has("ticket.view_all")) {
    return NextResponse.json({ error: "forbidden" }, { status: 403 });
  }

  const record = await db.testingCommissioning.findFirst({
    where: { id, deletedAt: null },
    select: { id: true, number: true },
  });
  if (!record) {
    return NextResponse.json({ error: "not_found" }, { status: 404 });
  }

  const pdf = await renderTcCertificatePdf(record.id);

  return new NextResponse(new Uint8Array(pdf), {
    headers: {
      "Content-Type": "application/pdf",
      "Content-Disposition": `attachment; filename="${record.number}.pdf"`,
      // Never cached: the certificate changes the moment a signature or a punch item lands on it.
      "Cache-Control": "no-store",
    },
  });
}
