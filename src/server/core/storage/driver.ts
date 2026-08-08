// specs/00-foundation.md §7.2: "keep the driver swappable so a future self-host does not touch
// call sites." Only src/server/core/storage/supabase-driver.ts implements this today — see
// docs/DECISIONS.md for why the filesystem-driver alternative isn't built yet.
export interface StorageDriver {
  upload(key: string, body: Buffer, contentType: string): Promise<void>;
  createSignedUrl(key: string, expiresInSeconds: number): Promise<string>;
  remove(key: string): Promise<void>;
}
