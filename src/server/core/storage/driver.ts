// specs/00-foundation.md §7.2: "keep the driver swappable so a future self-host does not touch
// call sites." Only src/server/core/storage/supabase-driver.ts implements this today — see
// docs/DECISIONS.md for why the filesystem-driver alternative isn't built yet.
export interface StorageDriver {
  upload(key: string, body: Buffer, contentType: string): Promise<void>;
  /**
   * A short-lived URL for one stored object.
   *
   * `downloadAs` asks the storage service to serve the object as an attachment under that filename.
   * Without it a browser shows a PDF or a photograph inline, which is the right default for
   * *looking* at a site photo and the wrong one for saving it — so the caller decides, per click,
   * rather than the driver deciding once for everybody.
   */
  createSignedUrl(key: string, expiresInSeconds: number, downloadAs?: string): Promise<string>;
  remove(key: string): Promise<void>;
}
