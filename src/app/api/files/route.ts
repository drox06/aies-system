import { NextResponse } from "next/server";
import { auth } from "@/auth";
import { UploadRejectedError, uploadFile } from "@/server/core/storage/storage";

export const runtime = "nodejs";

// Upload-time write permission is intentionally not checked beyond "must be authenticated" — no
// business entity exists yet whose write-permission this could defer to (mirrors the same gap
// noted on audit.listForEntity). Revisit once module 01+ entities exist to attach files to.
export async function POST(req: Request) {
  const session = await auth();
  if (!session?.user?.id) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }

  const formData = await req.formData();
  const file = formData.get("file");
  const entityType = formData.get("entityType");
  const entityId = formData.get("entityId");
  const category = formData.get("category");

  if (!(file instanceof File) || typeof entityType !== "string" || typeof entityId !== "string") {
    return NextResponse.json({ error: "invalid_request" }, { status: 400 });
  }

  const buffer = Buffer.from(await file.arrayBuffer());

  try {
    const result = await uploadFile({
      entityType,
      entityId,
      uploaderId: session.user.id,
      filename: file.name,
      mimeType: file.type || "application/octet-stream",
      buffer,
      category: category === "operations" ? "operations" : "default",
    });
    return NextResponse.json(result);
  } catch (err) {
    if (err instanceof UploadRejectedError) {
      return NextResponse.json({ error: err.message }, { status: 422 });
    }
    throw err;
  }
}
