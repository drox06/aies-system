import { NextResponse } from "next/server";
import { auth } from "@/auth";
import { db } from "@/lib/db";
import { renderServiceReportPdf } from "@/server/core/operations/pdf/render";
import { resolveSessionUser } from "@/server/core/rbac/permissions";

/**
 * §12's service report, as a download — so it can be printed and signed.
 *
 * `ticket.view` or `ticket.view_all`, matching `close-out-service.ts`'s own file-access checker for
 * `SERVICE_REPORT_ENTITY_TYPE`.
 *
 * App-authored reports only. One written on the customer's own form and uploaded already signed
 * (`externalDocument`) already exists as that document — `renderServiceReportPdf` refuses those with
 * a message pointing at the upload instead of generating a second, redundant PDF.
 *
 * A draft downloads too, watermarked — the same "print before it's finished being reviewed" case the
 * close-out pack and method statement PDFs already allow.
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

  const report = await db.serviceReport.findFirst({
    where: { id, deletedAt: null },
    select: { id: true, number: true, externalDocument: true },
  });
  if (!report) {
    return NextResponse.json({ error: "not_found" }, { status: 404 });
  }
  if (report.externalDocument) {
    return NextResponse.json(
      { error: "external_document", message: "This report was uploaded already signed." },
      { status: 400 },
    );
  }

  const pdf = await renderServiceReportPdf(report.id);

  return new NextResponse(new Uint8Array(pdf), {
    headers: {
      "Content-Type": "application/pdf",
      "Content-Disposition": `inline; filename="${report.number}.pdf"`,
      "Cache-Control": "no-store",
    },
  });
}
