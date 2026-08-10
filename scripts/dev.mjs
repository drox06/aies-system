/**
 * `npm run dev` — the Next dev server, plus the job-queue drain that Vercel Cron performs in
 * production.
 *
 * ## Why this is a separate process and not `instrumentation.ts`
 *
 * The first attempt put the drain loop in Next's `instrumentation.ts`, guarded by
 * `process.env.NEXT_RUNTIME === "nodejs"`. That guard is a *runtime* check, and Next compiles
 * `instrumentation.ts` for the **edge** runtime as well — so webpack still statically bundled the
 * dynamic `import("@/server/core/jobs/queue")` for edge, where `node:crypto` cannot be resolved:
 *
 *     Module build failed: UnhandledSchemeError: Reading from "node:crypto" is not handled by
 *     plugins (Unhandled scheme).
 *
 * The failure was worse than it sounds. The Node instance still ran, so `[dev-drain]` lines
 * appeared in the terminal and the loop looked healthy, while every page and tRPC call returned
 * 500. A log that says the thing is working while the app is down is the most expensive kind of
 * wrong.
 *
 * A plain HTTP client outside the bundle cannot have that problem: it imports nothing from the app,
 * and it exercises the *same* `/api/cron/drain` endpoint Vercel Cron will call, so the path under
 * test in development is the path that runs in production.
 */
import { spawn } from "node:child_process";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const nextBin = require.resolve("next/dist/bin/next");

const PORT = process.env.PORT ?? "3000";
const DRAIN_INTERVAL_MS = 5_000;

// `node <bin>` rather than the `next` shim: on Windows the shim is a .cmd, which needs shell:true,
// which then swallows signals and leaves the server running after Ctrl-C.
const server = spawn(process.execPath, [nextBin, "dev"], {
  stdio: "inherit",
  env: process.env,
});

let draining = false;
let announced = false;

async function drainOnce() {
  // Skip if the previous call is still in flight: a slow drain must not stack up requests.
  if (draining) return;
  draining = true;
  try {
    const response = await fetch(`http://localhost:${PORT}/api/cron/drain`, { method: "POST" });
    if (!response.ok) return;

    if (!announced) {
      console.log(
        `[dev-drain] draining the job queue every ${DRAIN_INTERVAL_MS / 1000}s — this is what ` +
          `Vercel Cron does in production. Set DISABLE_DEV_DRAIN=1 to turn it off.`,
      );
      announced = true;
    }

    const result = await response.json();
    // Only speak when something happened. A heartbeat every five seconds is noise that trains
    // people to ignore the terminal.
    if (result.relayed > 0 || result.succeeded > 0 || result.dead > 0) {
      console.log(
        `[dev-drain] relayed=${result.relayed} claimed=${result.claimed} ` +
          `succeeded=${result.succeeded} retrying=${result.retrying} dead=${result.dead}`,
      );
    }
  } catch {
    // The server is still starting, or restarting after an edit. Silent by design — the alternative
    // is a wall of connection errors every five seconds during every recompile.
  } finally {
    draining = false;
  }
}

if (process.env.DISABLE_DEV_DRAIN !== "1") {
  const timer = setInterval(() => void drainOnce(), DRAIN_INTERVAL_MS);
  timer.unref();
}

// Take the server down with us, and exit with its code so CI and shells see the truth.
for (const signal of ["SIGINT", "SIGTERM"]) {
  process.on(signal, () => {
    server.kill(signal);
    process.exit(0);
  });
}
server.on("exit", (code) => process.exit(code ?? 0));
