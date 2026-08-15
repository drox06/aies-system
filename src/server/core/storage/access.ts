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

// ---- removing one -------------------------------------------------------------------------------

const managers = new Map<string, FileAccessChecker>();

/**
 * How "may this user *remove* this file" is decided for an entity type.
 *
 * A second registry rather than a flag on the first, because reading and removing are different
 * questions with different answers. The president can read every accreditation certificate in the
 * company; that is not a reason for them to be able to delete one out from under the Admin Manager
 * who is accountable for it — and more to the point, the read checkers already written are all
 * permission-based, so folding removal into them would silently hand deletion to everyone who can
 * look.
 */
export function registerFileManageChecker(entityType: string, checker: FileAccessChecker): void {
  if (managers.has(entityType)) {
    throw new Error(`A file manage checker is already registered for entity type "${entityType}".`);
  }
  managers.set(entityType, checker);
}

/**
 * Whether this user may remove this file.
 *
 * The default is **the uploader only**, and it is deliberately narrower than the read default's
 * reasoning: somebody who attached the wrong scan a minute ago should be able to take it back
 * without an administrator, and nobody else should be able to remove evidence from a record they
 * happen to be able to read.
 */
export async function canManageFile(user: AuthedUser, file: FileObject): Promise<boolean> {
  const checker = managers.get(file.entityType);
  if (checker) return checker(user, file);
  return file.uploaderId === user.id;
}

/** Test-only: clears the registry between test files. */
export function __resetFileAccessCheckersForTests(): void {
  checkers.clear();
  managers.clear();
}
