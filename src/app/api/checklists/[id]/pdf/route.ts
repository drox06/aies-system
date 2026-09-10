import { NextResponse } from "next/server";
import { auth } from "@/auth";
import { db } from "@/lib/db";
import { renderChecklistResponsePdf } from "@/server/core/operations/pdf/render";
import { resolveSessionUser } from "@/server/core/rbac/permissions";

/**
 * §15's filled-in checklist, as a download — so it can be printed and signed.
 *
 * Same audience as the checklist itself: `ticket.view` or `ticket.view_all`, matching
 * `checklist-service.ts`'s own file-access checker for `CHECKLIST_RESPONSE_ENTITY_TYPE`.
 *
 * A draft downloads too, with its own DRAFT mark — a technician reviewing an in-progress checklist
 * on paper before signing it off is the normal case, not an edge one.
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

  const response = await db.checklistResponse.findFirst({
    where: { id, deletedAt: null },
    select: { id: true, templateKey: true, templateVersion: true },
  });
  if (!response) {
    return NextResponse.json({ error: "not_found" }, { status: 404 });
  }

  const pdf = await renderChecklistResponsePdf(response.id);

  return new NextResponse(new Uint8Array(pdf), {
    headers: {
      "Content-Type": "application/pdf",
      "Content-Disposition": `inline; filename="${response.templateKey}-v${response.templateVersion}-${response.id.slice(-8)}.pdf"`,
      "Cache-Control": "no-store",
    },
  });
}
