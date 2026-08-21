import { NextResponse } from "next/server";
import { relayOutboxToJobs } from "@/server/core/jobs/relay";
import { drain } from "@/server/core/jobs/queue";
import { releaseHeldNotifications } from "@/server/core/notify/notify";
import "@/server/core/jobs/handlers/events";

// Hit by Vercel Cron every minute in production (Spec.md §3.3, §9.1). Vercel signs cron requests
// with a bearer token matching CRON_SECRET. Required in production — see the handler.
async function handle(request: Request) {
  const cronSecret = process.env.CRON_SECRET;

  /**
   * Absent in production is a refusal, not a pass.
   *
   * This guard used to be enforced *only* when `CRON_SECRET` was set, so that local testing needed no
   * configuration. Convenient, and it failed open: deploy without the variable and this endpoint is a
   * publicly callable POST that anybody can hammer. Found on 2026-08-18 during the pre-flight for the
   * first real deployment, before it could matter.
   *
   * So the convenience is kept where it belongs — outside production — and its absence in production
   * is loud. A cron that returns 503 gets noticed and fixed; one that runs for anyone does not.
   */
  if (!cronSecret) {
    if (process.env.NODE_ENV === "production") {
      return NextResponse.json({ error: "cron_secret_not_configured" }, { status: 503 });
    }
  } else {
    const authHeader = request.headers.get("authorization");
    if (authHeader !== `Bearer ${cronSecret}`) {
      return NextResponse.json({ error: "unauthorized" }, { status: 401 });
    }
  }

  const relayed = await relayOutboxToJobs();
  const drained = await drain();
  /*
    §7's held notifications, released when their morning arrives.

    Here rather than on its own schedule because this already runs every minute, which makes "the
    morning digest" accurate to the minute with nothing extra to keep in step. A second cron would
    be a second thing to notice had stopped.
  */
  const released = await releaseHeldNotifications();

  return NextResponse.json({ relayed, released, ...drained });
}

/**
 * Exported as **both GET and POST**, and the GET is the one that matters.
 *
 * Vercel Cron invokes a scheduled path with a **GET** request. These routes exported only POST from
 * module 00 session 5 until 2026-08-18, so every minute the drain fired, received 405, and did
 * nothing — while the dashboard showed the cron registered and running. Nothing in typecheck, lint,
 * the suite or a local `curl -X POST` could see it: all four exercise the handler that existed.
 *
 * It took a real deployment and a job sitting `pending` with `attempts: 0` to surface it, which is
 * the argument for deploying before the rest of module 04 rather than after.
 *
 * POST stays for local testing and for the dev server's in-process drain.
 */
export const GET = handle;
export const POST = handle;
