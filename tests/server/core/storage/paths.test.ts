import { describe, expect, it } from "vitest";
import { buildStorageKey, deriveWebKey, sanitizeFilename } from "@/server/core/storage/paths";

describe("sanitizeFilename", () => {
  it("strips a Unix-style path traversal attempt down to a safe leaf name", () => {
    expect(sanitizeFilename("../../../etc/passwd")).toBe("passwd");
  });

  it("strips a Windows-style path traversal attempt down to a safe leaf name", () => {
    expect(sanitizeFilename("..\\..\\Windows\\System32\\config")).toBe("config");
  });

  it("replaces characters outside the safe set", () => {
    expect(sanitizeFilename("report (final)!.pdf")).toBe("report__final__.pdf");
  });

  it("never produces an empty string", () => {
    expect(sanitizeFilename("../../")).not.toBe("");
    expect(sanitizeFilename("")).toBe("file");
  });
});

describe("buildStorageKey", () => {
  it("never contains a raw traversal sequence even when given a malicious filename", () => {
    const key = buildStorageKey("comment", "c1", "../../../etc/passwd", new Date("2026-08-15"));
    expect(key).not.toContain("..");
    expect(key).toMatch(/^comment\/2026\/08\/c1\/[0-9a-f-]{36}-passwd$/);
  });

  it("scopes the key by entityType/yyyy/mm/entityId", () => {
    const key = buildStorageKey("quotation", "q42", "photo.jpg", new Date("2026-03-05"));
    expect(key.startsWith("quotation/2026/03/q42/")).toBe(true);
  });
});

describe("deriveWebKey", () => {
  it("suffixes the leaf name with -web.jpg, preserving the directory", () => {
    expect(deriveWebKey("comment/2026/08/c1/uuid-photo.png")).toBe(
      "comment/2026/08/c1/uuid-photo-web.jpg",
    );
  });
});
