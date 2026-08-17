import { NextResponse } from "next/server";
import { auth } from "@/auth";
import { db } from "@/lib/db";
import { renderCloseOutPackPdf } from "@/server/core/operations/pdf/render";
import { resolveSessionUser } from "@/server/core/rbac/permissions";

/**
 * §12's close-out pack, as a download.
 *
 * `project.view` opens it. The pack is the handover document and a provisional copy is exactly what
 * a project manager needs while the blockers are still being cleared — it prints its own banner
 * saying so, rather than being withheld until the project closes.
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
  if (!resolved.permissions.has("project.view") && !resolved.permissions.has("project.manage")) {
    return NextResponse.json({ error: "forbidden" }, { status: 403 });
  }

  const project = await db.project.findFirst({
    where: { id, deletedAt: null },
    select: { id: true, code: true },
  });
  if (!project) {
    return NextResponse.json({ error: "not_found" }, { status: 404 });
  }

  const pdf = await renderCloseOutPackPdf(project.id);

  return new NextResponse(new Uint8Array(pdf), {
    headers: {
      "Content-Type": "application/pdf",
      "Content-Disposition": `attachment; filename="${project.code}-close-out-pack.pdf"`,
      "Cache-Control": "no-store",
    },
  });
}
