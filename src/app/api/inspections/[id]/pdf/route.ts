import { NextResponse } from "next/server";
import { auth } from "@/auth";
import { db } from "@/lib/db";
import { renderSiteInspectionReportPdf } from "@/server/core/operations/pdf/render";
import { canOpenSiteInspection } from "@/server/core/operations/site-inspection-rules";
import { resolveSessionUser } from "@/server/core/rbac/permissions";

/**
 * §6.1's site inspection report, as a download (2026-09-03, the company's own instruction):
 * "once all details in the site inspection is accomplished, create a pdf site inspection report."
 *
 * Generated on demand rather than stored, the same choice every other document in this codebase
 * makes — a stored copy would need its own invalidation the moment somebody corrected a finding
 * after the fact, and this endpoint is already as fast as a stored file would be to serve.
 *
 * "Accomplished" is `inspectionCompleteness`'s own gate, already enforced before "Mark complete"
 * can be pressed — so the report is refused while `status` is still `scheduled` rather than quietly
 * printing a page of blanks for a survey nobody has finished.
 *
 * Access is `canOpenSiteInspection` — the same gate `getInspectionService` enforces for viewing the
 * record itself, widened by name to EA, KJ and DJ on the same instruction: "make it downloadable and
 * online viewing by ea, kj, dj, person who raised the site inspection, and by the person that
 * conducted the inspection."
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

  const inspection = await db.siteInspection.findFirst({
    where: { id, deletedAt: null },
    select: { id: true, number: true, status: true, inspectedByIds: true, requestedById: true },
  });
  if (!inspection) {
    return NextResponse.json({ error: "not_found" }, { status: 404 });
  }

  // Same access rule as the record itself (site-inspection-service.ts's getInspectionService) —
  // whoever attended, whoever asked for it, or EA, KJ and DJ by name.
  if (
    !canOpenSiteInspection(inspection, { id: session.user.id, email: session.user.email ?? "" })
  ) {
    return NextResponse.json({ error: "forbidden" }, { status: 403 });
  }

  if (inspection.status === "scheduled") {
    return NextResponse.json(
      {
        error: "not_ready",
        message: `${inspection.number} has not been marked complete yet — there is nothing to report.`,
      },
      { status: 400 },
    );
  }

  const pdf = await renderSiteInspectionReportPdf(inspection.id);

  return new NextResponse(new Uint8Array(pdf), {
    headers: {
      "Content-Type": "application/pdf",
      "Content-Disposition": `attachment; filename="${inspection.number}.pdf"`,
      "Cache-Control": "no-store",
    },
  });
}
