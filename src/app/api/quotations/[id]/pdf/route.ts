import { NextResponse } from "next/server";
import { auth } from "@/auth";
import { resolveSessionUser } from "@/server/core/rbac/permissions";
import {
  renderCostingSheetPdf,
  renderCustomerQuotationPdf,
} from "@/server/core/quotation/pdf/render";
import { quotationScopeWhere } from "@/server/core/quotation/quotation-service";
import { recordQuotationDownloadService } from "@/server/core/quotation/send-service";
import { quotationDisplayNumber } from "@/server/core/quotation/quotation-number";
import { db } from "@/lib/db";

/**
 * Renders a quotation as a PDF (specs/02-quotation.md §7).
 *
 * A route handler rather than a tRPC procedure because the response is bytes, not JSON — the
 * browser needs a real download with a filename, and tRPC would base64 it through a JSON envelope
 * for no benefit.
 *
 * **This is where a download is recorded**, not a button in the UI. The fact worth recording is
 * "the bytes left the server"; a button records an intention, which is not the same thing and is
 * easy to fire without ever producing a document.
 *
 * Two variants:
 *   - `customer` (default) — the document that goes to the buyer. Never contains cost.
 *   - `internal` — §7's costing sheet, gated on `finance.view_cost` and watermarked. It does *not*
 *     mark the quotation ready for sending; nobody emails a costing sheet to a customer.
 */
export const runtime = "nodejs";

export async function GET(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;

  const session = await auth();
  if (!session?.user?.id) {
    return NextResponse.json({ error: "unauthenticated" }, { status: 401 });
  }

  // resolveSessionUser returns the permission bundle, not the identity — id and name come from the
  // session, which is where Auth.js already put them.
  const userId = session.user.id;
  const userName = session.user.name ?? userId;
  const resolved = await resolveSessionUser(userId);
  if (!resolved || !resolved.isActive || resolved.deletedAt) {
    return NextResponse.json({ error: "unauthenticated" }, { status: 401 });
  }
  const user = { id: userId, permissions: resolved.permissions as ReadonlySet<string> };

  const url = new URL(request.url);
  const variant = url.searchParams.get("variant") === "internal" ? "internal" : "customer";

  if (!user.permissions.has("quotation.view")) {
    return NextResponse.json({ error: "forbidden" }, { status: 403 });
  }
  // §7's costing sheet is the cost gate in document form. Spec.md §4.3 restricts cost and margin to
  // the president and vice-president, and a PDF is just another serialised response.
  if (variant === "internal" && !user.permissions.has("finance.view_cost")) {
    return NextResponse.json({ error: "forbidden" }, { status: 403 });
  }

  // Record-level scoping applied in the lookup, so an out-of-scope id is indistinguishable from a
  // missing one — the same reasoning as every other read in this codebase.
  const quotation = await db.quotation.findFirst({
    where: { id, deletedAt: null, ...quotationScopeWhere(user) },
    select: { id: true, number: true, revision: true },
  });
  if (!quotation) {
    return NextResponse.json({ error: "not found" }, { status: 404 });
  }

  const label = quotationDisplayNumber(quotation.number, quotation.revision);

  try {
    const buffer =
      variant === "internal"
        ? await renderCostingSheetPdf(quotation.id, userName)
        : await renderCustomerQuotationPdf(quotation.id);

    // Recorded after a successful render: a failed render produced no document, and logging it as
    // downloaded would put a fiction in the audit trail that the send flow then relies on.
    await recordQuotationDownloadService(
      {
        actorId: userId,
        actorLabel: userName,
        ip: request.headers.get("x-forwarded-for"),
        userAgent: request.headers.get("user-agent"),
      },
      { quotationId: quotation.id, variant },
    );

    const filename = variant === "internal" ? `${label}-INTERNAL-costing.pdf` : `${label}.pdf`;

    return new NextResponse(new Uint8Array(buffer), {
      headers: {
        "Content-Type": "application/pdf",
        "Content-Disposition": `attachment; filename="${filename}"`,
        // Never cached: the document must reflect the record as it stands, and a stale quotation
        // served from a cache is one somebody could send to a customer.
        "Cache-Control": "no-store, must-revalidate",
      },
    });
  } catch (error) {
    console.error(`[quotation-pdf] failed to render ${label}:`, error);
    return NextResponse.json({ error: "render failed" }, { status: 500 });
  }
}
