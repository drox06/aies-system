try {
  process.loadEnvFile(".env");
} catch {
  // ignore missing .env (CI/production supply real env vars directly)
}

import { ensureBucketExists, STORAGE_BUCKET } from "../src/server/core/storage/supabase-driver";

ensureBucketExists()
  .then(() => {
    console.log("bucket ready:", STORAGE_BUCKET);
  })
  .catch((err: unknown) => {
    console.error(err);
    process.exitCode = 1;
  });
