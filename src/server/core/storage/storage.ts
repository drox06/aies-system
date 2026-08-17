import { createHash } from "node:crypto";
import type { FileObject } from "@prisma/client";
import sharp from "sharp";
import { db } from "@/lib/db";
import { buildStorageKey, deriveWebKey } from "./paths";
import { isRejectedUpload, maxUploadBytesFor, type UploadCategory } from "./limits";
import { getScanHook } from "./scan-hook";
import { supabaseStorageDriver } from "./supabase-driver";

export class UploadRejectedError extends Error {}

export interface UploadFileInput {
  entityType: string;
  entityId: string;
  uploaderId: string;
  filename: string;
  mimeType: string;
  buffer: Buffer;
  category?: UploadCategory;
}

export async function uploadFile(input: UploadFileInput): Promise<FileObject> {
  if (isRejectedUpload(input.filename, input.mimeType)) {
    throw new UploadRejectedError(
      `File type not allowed: "${input.filename}" (${input.mimeType}).`,
    );
  }

  const maxBytes = maxUploadBytesFor(input.category ?? "default");
  if (input.buffer.byteLength > maxBytes) {
    throw new UploadRejectedError(
      `File exceeds the ${Math.floor(maxBytes / (1024 * 1024))} MB limit for this upload type.`,
    );
  }

  const scan = await getScanHook()(input.buffer, {
    filename: input.filename,
    mimeType: input.mimeType,
  });
  if (!scan.clean) {
    throw new UploadRejectedError(`Upload rejected by scan: ${scan.reason ?? "flagged"}.`);
  }

  const sha256 = createHash("sha256").update(input.buffer).digest("hex");

  // Deduplication by sha256 within an entity (specs/00-foundation.md §7.2).
  const existing = await db.fileObject.findUnique({
    where: {
      entityType_entityId_sha256: {
        entityType: input.entityType,
        entityId: input.entityId,
        sha256,
      },
    },
  });
  if (existing && !existing.deletedAt) return existing;

  /**
   * Re-attaching something that was removed brings it back, rather than silently doing nothing.
   *
   * The dedupe above matched on `entityType + entityId + sha256` without regard to `deletedAt`, so a
   * removed file re-uploaded byte-for-byte found its own tombstone and returned it as a success. The
   * upload reported "uploaded", the list filters on `deletedAt: null`, and the file was nowhere —
   * reported by the company on 2026-08-18, minutes after the first deployment.
   *
   * Reviving is safe because removal is soft: `removeEntityFileService` leaves the bytes in the
   * bucket and keeps the sha256 precisely so the record of what was attached survives. The object is
   * still there, so clearing the tombstone is enough — no second copy, and the original upload date
   * is preserved, which is the honest answer to "when was this attached".
   */
  if (existing) {
    return db.fileObject.update({
      where: { id: existing.id },
      data: { deletedAt: null },
    });
  }

  const storageKey = buildStorageKey(input.entityType, input.entityId, input.filename);
  await supabaseStorageDriver.upload(storageKey, input.buffer, input.mimeType);

  // Field photos from phones are often 8 MB and must not be served raw over a plant's LTE
  // connection (specs/00-foundation.md §7.2) — generate a smaller derivative for image uploads.
  let webDerivativeKey: string | null = null;
  if (input.mimeType.startsWith("image/")) {
    try {
      const derivative = await sharp(input.buffer)
        .resize({ width: 1600, withoutEnlargement: true })
        .jpeg({ quality: 82 })
        .toBuffer();
      webDerivativeKey = deriveWebKey(storageKey);
      await supabaseStorageDriver.upload(webDerivativeKey, derivative, "image/jpeg");
    } catch {
      // Not every image/* mime is a raster sharp can decode (e.g. some odd camera formats) —
      // the original is still safely stored; the derivative is a nice-to-have, not load-bearing.
      webDerivativeKey = null;
    }
  }

  return db.fileObject.create({
    data: {
      entityType: input.entityType,
      entityId: input.entityId,
      storageKey,
      webDerivativeKey,
      filename: input.filename,
      mimeType: input.mimeType,
      size: input.buffer.byteLength,
      sha256,
      uploaderId: input.uploaderId,
    },
  });
}

export async function getFileDownloadUrl(
  file: Pick<FileObject, "storageKey" | "webDerivativeKey" | "filename">,
  variant: "original" | "web" = "original",
  ttlSeconds = 60,
  /** Serve as an attachment under the original filename rather than inline in the browser. */
  asAttachment = false,
): Promise<string> {
  const key = variant === "web" && file.webDerivativeKey ? file.webDerivativeKey : file.storageKey;
  return supabaseStorageDriver.createSignedUrl(
    key,
    ttlSeconds,
    asAttachment ? file.filename : undefined,
  );
}
