import { NextResponse } from "next/server";
import { auth } from "@/auth";
import { resolveSessionUser } from "@/server/core/rbac/permissions";
import { renderStatementOfAccountPdf } from "@/server/core/finance/pdf/render";
import { db } from "@/lib/db";

/**
 * §3.3/§5's "Statement of account PDF per customer, generated on demand."
 *
 * A route handler, not a tRPC procedure — bytes, not base64-in-JSON, matching every other document
 * PDF in the app.
 *
 * ## Gated on `ar.view`, not `finance.view`
 *
 * This is the AR/collections document — the exact data `finance.receivables` already reads, sliced to
 * one account — so it carries the same gate as that report rather than the wider `finance.view` the
 * per-document PDFs use. Somebody who cannot see receivables should not be able to hand a customer a
 * summary of what they owe.
 *
 * ## Nothing to 304 against
 *
 * There is no stored row and no version to check — every request recomputes from the live open
 * statements, so `Cache-Control: no-store` matters here more than on the numbered documents: two
 * requests an hour apart can legitimately differ.
 */
export const runtime = "nodejs";

export async function GET(_request: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;

  const session = await auth();
  if (!session?.user?.id) {
    return NextResponse.json({ error: "unauthenticated" }, { status: 401 });
  }

  const user = await resolveSessionUser(session.user.id);
  if (!user?.permissions.has("ar.view")) {
    return NextResponse.json({ error: "forbidden" }, { status: 403 });
  }

  const account = await db.customerAccount.findFirst({
    where: { id, deletedAt: null },
    select: { code: true },
  });
  if (!account) {
    return NextResponse.json({ error: "not found" }, { status: 404 });
  }

  const pdf = await renderStatementOfAccountPdf(id);
  const today = new Date().toISOString().slice(0, 10);

  return new NextResponse(new Uint8Array(pdf), {
    headers: {
      "Content-Type": "application/pdf",
      "Content-Disposition": `inline; filename="Statement of account - ${account.code} - ${today}.pdf"`,
      "Cache-Control": "private, no-store",
    },
  });
}
