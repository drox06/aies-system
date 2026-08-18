import { NextResponse } from "next/server";
import { auth } from "@/auth";
import { db } from "@/lib/db";
import { renderMethodStatementPdf } from "@/server/core/operations/pdf/render";
import { resolveSessionUser } from "@/server/core/rbac/permissions";

/**
 * §6.2's method statement, as a download.
 *
 * A route handler rather than a tRPC procedure, for the same reason as every other document in this
 * platform: the response is bytes and the browser needs a real download with a filename.
 *
 * ## Who can open it
 *
 * `methodology.view` or `ticket.view`. The audience is deliberately wide: §6.2 exists so the client
 * approves the method before work starts, which means somebody has to be able to produce the file
 * and send it. Gating it behind the permission to *prepare* a method statement would leave whoever
 * handles the client unable to send the thing the client has to approve.
 *
 * Drafts are downloadable on purpose, and print with a DRAFT mark. Internal review of a method
 * statement often happens on paper or over email, and a reviewer who cannot get a copy reviews
 * nothing — the mark on the page is what stops a draft being mistaken for an agreed method.
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

  const allowed =
    resolved.permissions.has("methodology.view") ||
    resolved.permissions.has("methodology.prepare") ||
    resolved.permissions.has("ticket.view") ||
    resolved.permissions.has("ticket.view_all");
  if (!allowed) {
    return NextResponse.json({ error: "forbidden" }, { status: 403 });
  }

  const record = await db.methodology.findFirst({
    where: { id, deletedAt: null },
    select: { id: true, number: true, revision: true },
  });
  if (!record) {
    return NextResponse.json({ error: "not_found" }, { status: 404 });
  }

  const pdf = await renderMethodStatementPdf(record.id);

  return new NextResponse(new Uint8Array(pdf), {
    headers: {
      "Content-Type": "application/pdf",
      // `inline` so it opens in the browser's viewer first — the common case is reading it before
      // deciding whether to send it, and forcing a download for that puts a file in Downloads that
      // nobody wanted.
      "Content-Disposition": `inline; filename="${record.number}-R${record.revision}.pdf"`,
      "Cache-Control": "no-store",
    },
  });
}
