import type { FileObject } from "@prisma/client";
import { afterEach, describe, expect, it } from "vitest";
import {
  __resetFileAccessCheckersForTests,
  canAccessFile,
  registerFileAccessChecker,
} from "@/server/core/storage/access";
import type { AuthedUser } from "@/server/core/rbac/types";

function user(id: string): AuthedUser {
  return { id, email: `${id}@test`, name: id, roleKeys: [], permissions: new Set() };
}

function file(overrides: Partial<FileObject> = {}): FileObject {
  return {
    id: "f1",
    entityType: "comment",
    entityId: "c1",
    storageKey: "k",
    webDerivativeKey: null,
    filename: "a.png",
    mimeType: "image/png",
    size: 1,
    sha256: "abc",
    uploaderId: "uploader1",
    createdAt: new Date(),
    deletedAt: null,
    ...overrides,
  };
}

afterEach(() => {
  __resetFileAccessCheckersForTests();
});

describe("canAccessFile", () => {
  it("defaults to allowing only the uploader when no checker is registered for the entity type", async () => {
    const f = file();
    expect(await canAccessFile(user("uploader1"), f)).toBe(true);
    expect(await canAccessFile(user("someone-else"), f)).toBe(false);
  });

  it("defers to a registered checker for that entity type", async () => {
    registerFileAccessChecker("comment", (u) => u.id === "uploader1" || u.id === "teammate");
    const f = file();

    expect(await canAccessFile(user("teammate"), f)).toBe(true);
    expect(await canAccessFile(user("stranger"), f)).toBe(false);
  });

  it("throws when a second checker is registered for the same entity type", () => {
    registerFileAccessChecker("comment", () => true);
    expect(() => registerFileAccessChecker("comment", () => false)).toThrow(/already registered/);
  });
});
