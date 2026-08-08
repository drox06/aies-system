import { describe, expect, it } from "vitest";
import {
  DEFAULT_MAX_UPLOAD_BYTES,
  OPERATIONS_MAX_UPLOAD_BYTES,
  isRejectedUpload,
  maxUploadBytesFor,
} from "@/server/core/storage/limits";

describe("maxUploadBytesFor", () => {
  it("is 50 MB by default and 200 MB for operations", () => {
    expect(maxUploadBytesFor("default")).toBe(DEFAULT_MAX_UPLOAD_BYTES);
    expect(maxUploadBytesFor("operations")).toBe(OPERATIONS_MAX_UPLOAD_BYTES);
    expect(DEFAULT_MAX_UPLOAD_BYTES).toBe(50 * 1024 * 1024);
    expect(OPERATIONS_MAX_UPLOAD_BYTES).toBe(200 * 1024 * 1024);
  });
});

describe("isRejectedUpload", () => {
  it("rejects known executable extensions regardless of claimed mime type", () => {
    expect(isRejectedUpload("setup.exe", "application/octet-stream")).toBe(true);
    expect(isRejectedUpload("install.MSI", "application/octet-stream")).toBe(true);
    expect(isRejectedUpload("script.sh", "text/plain")).toBe(true);
  });

  it("rejects known executable mime types regardless of extension", () => {
    expect(isRejectedUpload("photo.jpg", "application/x-msdownload")).toBe(true);
  });

  it("allows ordinary document and image uploads", () => {
    expect(isRejectedUpload("report.pdf", "application/pdf")).toBe(false);
    expect(isRejectedUpload("site-photo.jpg", "image/jpeg")).toBe(false);
  });
});
