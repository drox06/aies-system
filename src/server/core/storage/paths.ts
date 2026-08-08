import { randomUUID } from "node:crypto";

/**
 * Strips everything but a safe leaf name — the client filename is never trusted as a path
 * component (specs/00-foundation.md §7.2), so this must survive both directory-separator and
 * `..`-traversal attempts regardless of OS.
 */
export function sanitizeFilename(name: string): string {
  const leaf = name.split(/[/\\]/).pop() ?? "";
  const cleaned = leaf
    .replace(/[^a-zA-Z0-9._-]/g, "_")
    .replace(/^\.+/, "")
    .slice(-150);
  return cleaned.length > 0 ? cleaned : "file";
}

export function buildStorageKey(
  entityType: string,
  entityId: string,
  filename: string,
  now: Date = new Date(),
): string {
  const yyyy = String(now.getFullYear());
  const mm = String(now.getMonth() + 1).padStart(2, "0");
  return `${entityType}/${yyyy}/${mm}/${entityId}/${randomUUID()}-${sanitizeFilename(filename)}`;
}

/** The web-sized derivative for an image key lives next to the original, suffixed `-web.jpg`. */
export function deriveWebKey(originalKey: string): string {
  const lastSlash = originalKey.lastIndexOf("/");
  const dir = originalKey.slice(0, lastSlash);
  const name = originalKey.slice(lastSlash + 1);
  const dotIndex = name.lastIndexOf(".");
  const withoutExt = dotIndex > 0 ? name.slice(0, dotIndex) : name;
  return `${dir}/${withoutExt}-web.jpg`;
}
