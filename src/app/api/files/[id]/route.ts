import { NextResponse } from "next/server";
import { auth } from "@/auth";
import { db } from "@/lib/db";
import { canAccessFile } from "@/server/core/storage/access";
import { getFileDownloadUrl } from "@/server/core/storage/storage";
import type { AuthedUser } from "@/server/core/rbac/types";

export const runtime = "nodejs";

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

  const variant = new URL(req.url).searchParams.get("variant") === "web" ? "web" : "original";
  const signedUrl = await getFileDownloadUrl(file, variant, 60);

  return NextResponse.redirect(signedUrl);
}
