import { NextResponse } from "next/server";
import { auth } from "@/auth";
import { db } from "@/lib/db";
import { canAccessFile } from "@/server/core/storage/access";
// Populates the file-access registries. Without it this route is its own bundle on Vercel,
// the registries are empty, and every file becomes downloadable only by its uploader.
import { FILE_CHECKERS_REGISTERED } from "@/server/core/storage/register-checkers";

import { getFileDownloadUrl } from "@/server/core/storage/storage";
import type { AuthedUser } from "@/server/core/rbac/types";

export const runtime = "nodejs";

// Referenced, not merely imported: a bare side-effect import is exactly the line a tidy-up removes,
// and removing it makes every file downloadable only by its uploader. See register-checkers.ts.
void FILE_CHECKERS_REGISTERED;

// specs/00-foundation.md §7.2: "Downloads always go through /api/files/[id], which checks
// permission server-side and then issues a short-lived signed URL. Never a public bucket, never
// a guessable path."
export async function GET(req: Request, context: { params: Promise<{ id: string }> }) {
  const { id } = await context.params;
  const session = await auth();
  if (!session?.user?.id) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }

  const file = await db.fileObject.findUnique({ where: { id } });
  if (!file || file.deletedAt) {
    return NextResponse.json({ error: "not_found" }, { status: 404 });
  }

  const user: AuthedUser = {
    id: session.user.id,
    email: session.user.email ?? "",
    name: session.user.name ?? "",
    roleKeys: session.user.roleKeys,
    permissions: new Set(session.user.permissions),
  };

  if (!(await canAccessFile(user, file))) {
    return NextResponse.json({ error: "forbidden" }, { status: 403 });
  }

  const params = new URL(req.url).searchParams;
  const variant = params.get("variant") === "web" ? "web" : "original";
  // Inline by default so a photograph can be looked at without saving it, and an attachment on
  // request so it can be saved without a right-click — the two are different actions and the page
  // offers both.
  const asAttachment = params.get("download") === "1";
  const signedUrl = await getFileDownloadUrl(file, variant, 60, asAttachment);

  return NextResponse.redirect(signedUrl);
}
