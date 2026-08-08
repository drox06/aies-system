import type { FileObject } from "@prisma/client";
import type { AuthedUser } from "@/server/core/rbac/types";

export type FileAccessChecker = (user: AuthedUser, file: FileObject) => boolean | Promise<boolean>;

const checkers = new Map<string, FileAccessChecker>();

/** A business module registers how "can this user download this file" is decided for its own
 *  entity type — mirrors src/server/core/rbac/scope.ts's registry pattern. */
export function registerFileAccessChecker(entityType: string, checker: FileAccessChecker): void {
  if (checkers.has(entityType)) {
    throw new Error(`A file access checker is already registered for entity type "${entityType}".`);
  }
  checkers.set(entityType, checker);
}

/** Until a module registers a real checker for its entity type, only the uploader can access the
 *  file — never "no one" (a permission-check bug shouldn't be able to lock out the uploader) and
 *  never "anyone signed in" (Spec.md §7.2: never a public bucket, never a guessable path). */
export async function canAccessFile(user: AuthedUser, file: FileObject): Promise<boolean> {
  const checker = checkers.get(file.entityType);
  if (checker) return checker(user, file);
  return file.uploaderId === user.id;
}

/** Test-only: clears the registry between test files. */
export function __resetFileAccessCheckersForTests(): void {
  checkers.clear();
}
