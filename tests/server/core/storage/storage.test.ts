import { createHash, randomUUID } from "node:crypto";
import { afterEach, describe, expect, it } from "vitest";
import { db } from "@/lib/db";
import { DEFAULT_MAX_UPLOAD_BYTES } from "@/server/core/storage/limits";
import { getFileDownloadUrl, UploadRejectedError, uploadFile } from "@/server/core/storage/storage";
import { supabaseStorageDriver } from "@/server/core/storage/supabase-driver";

// Integration tests against the real Supabase Storage bucket (aies-files) — not mocked, per this
// project's established pattern (docs/DECISIONS.md #1) of testing against the real dev resources.

const entityType = `test_entity_${randomUUID().replace(/-/g, "")}`;
const createdFileIds: string[] = [];
const uploadedKeys: string[] = [];

afterEach(async () => {
  if (createdFileIds.length > 0) {
    await db.fileObject.deleteMany({ where: { id: { in: createdFileIds } } });
    createdFileIds.length = 0;
  }
  for (const key of uploadedKeys) {
    await supabaseStorageDriver.remove(key).catch(() => {});
  }
  uploadedKeys.length = 0;
});

describe("uploadFile", () => {
  it("stores a file and the returned signed URL actually serves the same bytes", async () => {
    const content = Buffer.from(`hello world ${randomUUID()}`);
    const result = await uploadFile({
      entityType,
      entityId: "e1",
      uploaderId: "u1",
      filename: "notes.txt",
      mimeType: "text/plain",
      buffer: content,
    });
    createdFileIds.push(result.id);
    uploadedKeys.push(result.storageKey);

    expect(result.sha256).toBe(createHash("sha256").update(content).digest("hex"));

    const url = await getFileDownloadUrl(result, "original", 60);
    const response = await fetch(url);
    const downloaded = Buffer.from(await response.arrayBuffer());
    expect(downloaded.equals(content)).toBe(true);
  }, 30_000);

  it("deduplicates by sha256 within the same entity — no second row, no second upload", async () => {
    const content = Buffer.from(`dedup test ${randomUUID()}`);
    const first = await uploadFile({
      entityType,
      entityId: "e2",
      uploaderId: "u1",
      filename: "a.txt",
      mimeType: "text/plain",
      buffer: content,
    });
    createdFileIds.push(first.id);
    uploadedKeys.push(first.storageKey);

    const second = await uploadFile({
      entityType,
      entityId: "e2",
      uploaderId: "u2",
      filename: "b.txt", // different filename, same bytes
      mimeType: "text/plain",
      buffer: content,
    });

    expect(second.id).toBe(first.id);

    const rows = await db.fileObject.findMany({ where: { entityType, entityId: "e2" } });
    expect(rows).toHaveLength(1);
  }, 30_000);

  /**
   * Reported by the company on 2026-08-18, minutes after the first deployment: a PDF was attached,
   * removed, then attached again — the upload reported success and the file was nowhere.
   *
   * The dedupe matched on sha256 without regard to `deletedAt`, so the second upload found its own
   * tombstone and returned it. The list filters removed rows, so the file existed and was invisible.
   * Nothing in the suite caught it because no test had ever removed a file and re-attached it.
   */
  it("brings a removed file back when the same bytes are attached again", async () => {
    const content = Buffer.from(`revive test ${randomUUID()}`);
    const first = await uploadFile({
      entityType,
      entityId: "e-revive",
      uploaderId: "u1",
      filename: "report.txt",
      mimeType: "text/plain",
      buffer: content,
    });
    createdFileIds.push(first.id);
    uploadedKeys.push(first.storageKey);

    await db.fileObject.update({
      where: { id: first.id },
      data: { deletedAt: new Date() },
    });

    const again = await uploadFile({
      entityType,
      entityId: "e-revive",
      uploaderId: "u1",
      filename: "report.txt",
      mimeType: "text/plain",
      buffer: content,
    });

    // Same row revived rather than a second copy — the bytes never left the bucket.
    expect(again.id).toBe(first.id);
    expect(again.deletedAt).toBeNull();

    const rows = await db.fileObject.findMany({
      where: { entityType, entityId: "e-revive", deletedAt: null },
    });
    expect(rows).toHaveLength(1);
  }, 30_000);

  it("does not deduplicate the same content across different entities", async () => {
    const content = Buffer.from(`cross entity ${randomUUID()}`);
    const a = await uploadFile({
      entityType,
      entityId: "e3a",
      uploaderId: "u1",
      filename: "x.txt",
      mimeType: "text/plain",
      buffer: content,
    });
    createdFileIds.push(a.id);
    uploadedKeys.push(a.storageKey);

    const b = await uploadFile({
      entityType,
      entityId: "e3b",
      uploaderId: "u1",
      filename: "x.txt",
      mimeType: "text/plain",
      buffer: content,
    });
    createdFileIds.push(b.id);
    uploadedKeys.push(b.storageKey);

    expect(a.id).not.toBe(b.id);
  }, 30_000);

  it("rejects an executable upload without creating a FileObject or touching storage", async () => {
    await expect(
      uploadFile({
        entityType,
        entityId: "e4",
        uploaderId: "u1",
        filename: "setup.exe",
        mimeType: "application/octet-stream",
        buffer: Buffer.from("MZ"),
      }),
    ).rejects.toThrow(UploadRejectedError);

    const rows = await db.fileObject.findMany({ where: { entityType, entityId: "e4" } });
    expect(rows).toHaveLength(0);
  }, 30_000);

  it("rejects a file over the size limit for its category before ever touching storage", async () => {
    const oversized = Buffer.alloc(DEFAULT_MAX_UPLOAD_BYTES + 1);

    await expect(
      uploadFile({
        entityType,
        entityId: "e5",
        uploaderId: "u1",
        filename: "big.bin",
        mimeType: "application/octet-stream",
        buffer: oversized,
        category: "default",
      }),
    ).rejects.toThrow(UploadRejectedError);

    const rows = await db.fileObject.findMany({ where: { entityType, entityId: "e5" } });
    expect(rows).toHaveLength(0);
  }, 30_000);

  it("generates a web derivative for image uploads", async () => {
    // A minimal valid 1x1 PNG.
    const png = Buffer.from(
      "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=",
      "base64",
    );

    const result = await uploadFile({
      entityType,
      entityId: "e6",
      uploaderId: "u1",
      filename: "pixel.png",
      mimeType: "image/png",
      buffer: png,
    });
    createdFileIds.push(result.id);
    uploadedKeys.push(result.storageKey);
    if (result.webDerivativeKey) uploadedKeys.push(result.webDerivativeKey);

    expect(result.webDerivativeKey).not.toBeNull();
    expect(result.webDerivativeKey).toMatch(/-web\.jpg$/);
  }, 30_000);
});
