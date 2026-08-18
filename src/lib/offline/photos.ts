/**
 * specs/04-operations-projects.md §14: "Photos compressed client-side to ~1600px/80% before
 * queueing."
 *
 * ## Why this happens before the queue rather than on upload
 *
 * The obvious place to compress is the moment of upload. It is the wrong one. A technician
 * photographs twelve things in a plant with no signal; at 4 MB each that is 48 MB sitting in
 * IndexedDB against a quota the browser may be measuring in tens of megabytes, and the eviction that
 * follows takes the queue with it. Compressed at capture, the same twelve are a few hundred
 * kilobytes and the queue survives the afternoon.
 *
 * 1600px on the long edge is the spec's number and a defensible one for the job: it is enough to
 * read a nameplate or a gauge face, which is what these photographs are actually for.
 *
 * ## What is deliberately preserved
 *
 * Nothing is re-encoded if it is already small enough. A supplier's PDF datasheet, a signature PNG
 * with hard edges, and anything that is not a raster image pass through untouched — re-encoding a
 * signature as JPEG at 80% would put ringing artefacts on the one image whose job is to be evidence
 * that somebody signed.
 */

export const MAX_EDGE_PX = 1600;
export const JPEG_QUALITY = 0.8;

export interface CompressedImage {
  blob: Blob;
  filename: string;
  mimeType: string;
  width: number;
  height: number;
  /** Whether this call actually re-encoded, so the caller can say "kept original" honestly. */
  reencoded: boolean;
  originalSize: number;
}

/** JPEG and WebP re-encode cleanly at quality. PNG usually means a screenshot or a signature. */
const RECOMPRESSIBLE = new Set(["image/jpeg", "image/jpg", "image/webp"]);

export async function compressForQueue(file: File): Promise<CompressedImage> {
  const untouched = (reason: string): CompressedImage => {
    void reason;
    return {
      blob: file,
      filename: file.name,
      mimeType: file.type,
      width: 0,
      height: 0,
      reencoded: false,
      originalSize: file.size,
    };
  };

  if (!RECOMPRESSIBLE.has(file.type)) return untouched("not a recompressible raster image");
  if (typeof createImageBitmap === "undefined" || typeof OffscreenCanvas === "undefined") {
    // Old Safari. Queueing the original is worse for quota but never worse for correctness, and a
    // technician on an old phone should still be able to record what they saw.
    return untouched("no OffscreenCanvas in this browser");
  }

  let bitmap: ImageBitmap;
  try {
    bitmap = await createImageBitmap(file);
  } catch {
    // A corrupt or unsupported image. Queue it as-is rather than losing the capture — the server
    // will refuse it if it is genuinely unusable, and that refusal is recorded and shown.
    return untouched("could not be decoded");
  }

  const longest = Math.max(bitmap.width, bitmap.height);
  const scale = longest > MAX_EDGE_PX ? MAX_EDGE_PX / longest : 1;
  const width = Math.round(bitmap.width * scale);
  const height = Math.round(bitmap.height * scale);

  try {
    const canvas = new OffscreenCanvas(width, height);
    const context = canvas.getContext("2d");
    if (!context) return untouched("no 2d context");

    context.drawImage(bitmap, 0, 0, width, height);
    const blob = await canvas.convertToBlob({ type: "image/jpeg", quality: JPEG_QUALITY });

    // Re-encoding can *grow* a file that was already well compressed at a smaller size. Keeping the
    // larger of the two would be a pure loss: bigger and lower quality at once.
    if (blob.size >= file.size && scale === 1) return untouched("re-encoding gained nothing");

    return {
      blob,
      filename: file.name.replace(/\.[^.]+$/, "") + ".jpg",
      mimeType: "image/jpeg",
      width,
      height,
      reencoded: true,
      originalSize: file.size,
    };
  } finally {
    bitmap.close();
  }
}

/** For the queue list: "2.4 MB → 310 KB". */
export function describeSaving(originalSize: number, newSize: number): string {
  const format = (bytes: number) =>
    bytes >= 1_000_000
      ? `${(bytes / 1_000_000).toFixed(1)} MB`
      : `${Math.max(1, Math.round(bytes / 1000))} KB`;
  return `${format(originalSize)} → ${format(newSize)}`;
}
