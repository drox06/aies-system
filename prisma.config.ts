import path from "node:path";
import { defineConfig } from "prisma/config";

try {
  // .env is optional in CI/production, where real env vars are supplied directly.
  process.loadEnvFile(".env");
} catch {
  // ignore missing .env
}

export default defineConfig({
  schema: path.join("prisma", "schema"),
  migrations: {
    seed: "tsx prisma/seed.ts",
  },
});
