import { NextResponse } from "next/server";
import { relayOutboxToJobs } from "@/server/core/jobs/relay";
import { drain } from "@/server/core/jobs/queue";
import "@/server/core/jobs/handlers/events";

// Hit by Vercel Cron every minute in production (Spec.md §3.3, §9.1). Vercel signs cron requests
// with a bearer token matching CRON_SECRET — enforced only when that env var is set, so local
// dev/testing doesn't need it configured.
export async function POST(request: Request) {
  const cronSecret = process.env.CRON_SECRET;
  if (cronSecret) {
    const authHeader = request.headers.get("authorization");
    if (authHeader !== `Bearer ${cronSecret}`) {
      return NextResponse.json({ error: "unauthorized" }, { status: 401 });
    }
  }

  const relayed = await relayOutboxToJobs();
  const drained = await drain();

  return NextResponse.json({ relayed, ...drained });
}
