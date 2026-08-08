// specs/00-foundation.md §7.2: "Upload limits: 50 MB default, 200 MB for operations (site
// video)." Callers state the category explicitly (rather than this guessing from entityType
// strings future modules haven't defined yet).
export type UploadCategory = "default" | "operations";

export const DEFAULT_MAX_UPLOAD_BYTES = 50 * 1024 * 1024;
export const OPERATIONS_MAX_UPLOAD_BYTES = 200 * 1024 * 1024;

export function maxUploadBytesFor(category: UploadCategory): number {
  return category === "operations" ? OPERATIONS_MAX_UPLOAD_BYTES : DEFAULT_MAX_UPLOAD_BYTES;
}

const REJECTED_EXTENSIONS = new Set([
  ".exe",
  ".bat",
  ".cmd",
  ".com",
  ".msi",
  ".sh",
  ".ps1",
  ".vbs",
  ".scr",
  ".dll",
  ".jar",
  ".app",
]);

const REJECTED_MIME_TYPES = new Set([
  "application/x-msdownload",
  "application/x-executable",
  "application/x-sh",
  "application/x-bat",
  "application/vnd.microsoft.portable-executable",
]);

export function isRejectedUpload(filename: string, mimeType: string): boolean {
  const dotIndex = filename.lastIndexOf(".");
  const ext = dotIndex >= 0 ? filename.slice(dotIndex).toLowerCase() : "";
  return REJECTED_EXTENSIONS.has(ext) || REJECTED_MIME_TYPES.has(mimeType.toLowerCase());
}
