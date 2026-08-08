import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import type { StorageDriver } from "./driver";

export const STORAGE_BUCKET = process.env.SUPABASE_STORAGE_BUCKET ?? "aies-files";

let cachedClient: SupabaseClient | undefined;

function client(): SupabaseClient {
  if (cachedClient) return cachedClient;

  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) {
    throw new Error("SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY are not configured.");
  }

  // Service-role key server-side only — this must never reach the client bundle. RLS is
  // bypassed deliberately: our own tRPC/route-handler permission checks are the authorization
  // layer, not Supabase Row Level Security (we don't use Supabase Auth at all — see Spec.md
  // §3's "Auth.js... not tied to Supabase Auth, so self-hosting stays possible").
  cachedClient = createClient(url, key, { auth: { persistSession: false } });
  return cachedClient;
}

export const supabaseStorageDriver: StorageDriver = {
  async upload(key, body, contentType) {
    const { error } = await client()
      .storage.from(STORAGE_BUCKET)
      .upload(key, body, { contentType, upsert: false });
    if (error) throw error;
  },

  async createSignedUrl(key, expiresInSeconds) {
    const { data, error } = await client()
      .storage.from(STORAGE_BUCKET)
      .createSignedUrl(key, expiresInSeconds);
    if (error || !data) throw error ?? new Error("No signed URL returned.");
    return data.signedUrl;
  },

  async remove(key) {
    const { error } = await client().storage.from(STORAGE_BUCKET).remove([key]);
    if (error) throw error;
  },
};

/** Idempotent — safe to call on every boot/deploy, not just once. */
export async function ensureBucketExists(): Promise<void> {
  const c = client();
  const { data: buckets, error } = await c.storage.listBuckets();
  if (error) throw error;

  if (buckets.some((bucket) => bucket.name === STORAGE_BUCKET)) return;

  const { error: createError } = await c.storage.createBucket(STORAGE_BUCKET, { public: false });
  if (createError) throw createError;
}
