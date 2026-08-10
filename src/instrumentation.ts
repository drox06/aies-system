/**
 * Next.js server startup hook.
 *
 * Its only job today is to make **development behave the way production will**: draining the job
 * queue on a timer, the way Vercel Cron drains it every minute once deployed.
 *
 * ## Why this exists
 *
 * Spec.md §3.3 routes every cross-module side effect through the transactional outbox and the job
 * queue, drained by `POST /api/cron/drain`. In production Vercel Cron calls that endpoint. Locally
 * nothing does — so an event was written to `EventOutbox`, relayed nowhere, and the subscriber
 * never ran.
 *
 * The visible symptom was specific and confusing: dragging an inquiry to `quoting` on the pipeline
 * correctly emitted `inquiry.quoting_started`, and the draft quotation module 02 subscribes to that
 * event to create simply never appeared. Both halves worked; nothing joined them. That looks
 * exactly like a broken feature and is actually missing infrastructure, which is the worst kind of
 * bug to chase.
 *
 * ## Why a timer rather than calling the handler inline
 *
 * Calling `createDraftForInquiry` directly from the inquiry transition would be simpler and wrong.
 * Spec.md §3.6 requires cross-module side effects to go through the event bus, and the outbox is
 * what guarantees the event is neither lost nor double-delivered when a transaction rolls back.
 * Bypassing it would make dev work and production diverge, which is how the drain path stops being
 * exercised and quietly rots.
 */

export async function register(): Promise<void> {
  // Only in the Node.js runtime — the Edge runtime has no database access, and this must not run
  // during `next build`, which also evaluates this file.
  if (process.env.NEXT_RUNTIME !== "nodejs") return;
  if (process.env.NODE_ENV !== "development") return;
  // An explicit opt-out, for anyone debugging the queue by hand who does not want a timer racing
  // them for the same rows.
  if (process.env.DISABLE_DEV_DRAIN === "1") return;

  const globalRef = globalThis as typeof globalThis & { __aiesDevDrain?: NodeJS.Timeout };
  // Dev hot-reload re-runs this module. Without the guard every reload would add another timer,
  // and after an afternoon's work the queue would be drained by a dozen racing pollers.
  if (globalRef.__aiesDevDrain) return;

  const { relayOutboxToJobs } = await import("@/server/core/jobs/relay");
  const { drain } = await import("@/server/core/jobs/queue");
  // Side-effect import: registers the "events" queue handler that dispatches to module subscribers.
  await import("@/server/core/jobs/handlers/events");

  const INTERVAL_MS = 5_000;

  const tick = async () => {
    try {
      const relayed = await relayOutboxToJobs();
      const result = await drain();
      if (relayed > 0 || result.succeeded > 0 || result.dead > 0) {
        console.log(
          `[dev-drain] relayed=${relayed} claimed=${result.claimed} ` +
            `succeeded=${result.succeeded} retrying=${result.retrying} dead=${result.dead}`,
        );
      }
    } catch (error) {
      // Never let a transient database blip kill the timer — the pooler drops idle connections and
      // a dead poller would silently take the whole event bus down with it.
      console.error("[dev-drain] failed:", error instanceof Error ? error.message : error);
    }
  };

  const timer = setInterval(() => void tick(), INTERVAL_MS);
  // Do not hold the process open on its own account.
  timer.unref?.();
  globalRef.__aiesDevDrain = timer;

  console.log(
    `[dev-drain] draining the job queue every ${INTERVAL_MS / 1000}s. ` +
      `Vercel Cron does this in production; set DISABLE_DEV_DRAIN=1 to turn it off.`,
  );
}
