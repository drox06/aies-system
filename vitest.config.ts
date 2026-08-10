import path from "node:path";
import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    include: ["tests/**/*.test.ts"],
    setupFiles: ["tests/setup.ts"],
    // Several tests hit the real (Supabase, ap-southeast-1) dev database over the transaction
    // pooler rather than mocking Prisma; the default 5s timeout is too tight for that round trip.
    testTimeout: 20_000,
    // Vitest defaults to one worker process per test file, each opening its own PrismaClient —
    // against Supabase's free-tier pooler connection limit that reliably exhausts the pool and
    // produces spurious "Can't reach database server" failures. Fixed observed cause, not a
    // hedge: single-file-at-a-time keeps this suite under one connection at rest.
    fileParallelism: false,
  },
  // The PDF documents are .tsx. Next compiles them with the automatic JSX runtime; Vitest's own
  // esbuild transform defaults to the classic one, which expects a React global and fails with
  // "React is not defined" at render time rather than at compile time.
  esbuild: { jsx: "automatic" },
  resolve: {
    alias: {
      "@": path.resolve(__dirname, "./src"),
    },
  },
});
