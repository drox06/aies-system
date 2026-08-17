import { NextResponse } from "next/server";
import { auth } from "@/auth";
import { db } from "@/lib/db";
import { renderDailyProgressPdf } from "@/server/core/operations/pdf/render";
import { resolveSessionUser } from "@/server/core/rbac/permissions";

/**
 * §8's daily progress report, as a download.
 *
 * §8 asks for one "where the customer requires them" — so it is generated on demand rather than
 * stored, because the answer changes every day the crew logs another one.
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

  const ticket = await db.ticket.findFirst({
    where: { id, deletedAt: null },
    select: { id: true, number: true },
  });
  if (!ticket) {
    return NextResponse.json({ error: "not_found" }, { status: 404 });
  }

  const pdf = await renderDailyProgressPdf(ticket.id);

  return new NextResponse(new Uint8Array(pdf), {
    headers: {
      "Content-Type": "application/pdf",
      "Content-Disposition": `attachment; filename="${ticket.number}-daily-progress.pdf"`,
      "Cache-Control": "no-store",
    },
  });
}
