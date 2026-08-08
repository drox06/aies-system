import { NextResponse } from "next/server";
import { sweepAccreditationRenewals } from "@/server/core/crm/accreditation-renewal";

/**
 * Once daily. specs/00-foundation.md §9.1 asks for `/api/cron/nightly`; this is the first thing
 * that needs it — specs/01-crm-inquiry.md §5b's accreditation renewal reminders.
 *
 * Runs the sweeps directly rather than enqueuing jobs. The queue exists to make *event-driven* work
 * survive a crash mid-handler; a daily sweep is idempotent by construction (it only fires on the
 * exact day a threshold is crossed) and simply runs again tomorrow, so a job row would add a moving
 * part without adding a guarantee.
 *
 * Auth matches /api/cron/drain: Vercel signs cron requests with a bearer token, enforced only when
 * CRON_SECRET is set so local testing needs no configuration.
 */
export async function POST(request: Request) {
  const cronSecret = process.env.CRON_SECRET;
  if (cronSecret) {
    const authHeader = request.headers.get("authorization");
    if (authHeader !== `Bearer ${cronSecret}`) {
      return NextResponse.json({ error: "unauthorized" }, { status: 401 });
    }
  }

  // Each sweep is caught individually: one failing must not stop the others, and a nightly job that
  // dies halfway leaves no trace of what it did or did not do.
  const results: Record<string, unknown> = {};
  try {
    results.accreditationRenewals = await sweepAccreditationRenewals();
  } catch (error) {
    console.error("[cron/nightly] accreditation renewal sweep failed:", error);
    results.accreditationRenewals = { error: String(error) };
  }

  return NextResponse.json(results);
}
