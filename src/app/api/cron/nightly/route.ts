import { NextResponse } from "next/server";
import {
  sweepAccreditationRenewals,
  sweepStalledRenewals,
} from "@/server/core/crm/accreditation-renewal";
import { sweepInquirySla } from "@/server/core/crm/inquiry-sla";
import { sweepPrincipalExpiries } from "@/server/core/crm/principal-service";
import { sweepQuotationExpiries } from "@/server/core/quotation/expiry-service";
import { sweepQuotationsToArchive } from "@/server/core/quotation/archive-service";
import { sweepOverdueRfqs } from "@/server/core/quotation/rfq-service";
import { sweepUnsentDownloads } from "@/server/core/quotation/send-service";
import { sweepOverdueLiquidationsService } from "@/server/core/operations/cash-advance-service";
import {
  sweepDormantAccounts,
  sweepFollowUps,
  sweepSilentQuotations,
} from "@/server/core/crm/pipeline-service";

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

  try {
    results.stalledRenewals = await sweepStalledRenewals();
  } catch (error) {
    console.error("[cron/nightly] stalled renewal sweep failed:", error);
    results.stalledRenewals = { error: String(error) };
  }

  // specs/01-crm-inquiry.md §3's acknowledgement SLA. Nightly rather than hourly on purpose: the
  // deadline is a whole business day, so an escalation that arrives the next morning is on time,
  // and an hourly sweep would only add 23 chances to send a duplicate.
  try {
    results.inquirySla = await sweepInquirySla();
  } catch (error) {
    console.error("[cron/nightly] inquiry SLA sweep failed:", error);
    results.inquirySla = { error: String(error) };
  }

  // specs/01-crm-inquiry.md §5c's distributor-agreement and price-list expiries.
  try {
    results.principalExpiries = await sweepPrincipalExpiries();
  } catch (error) {
    console.error("[cron/nightly] principal expiry sweep failed:", error);
    results.principalExpiries = { error: String(error) };
  }

  // specs/01-crm-inquiry.md §6's follow-up engine. One notification per owner, not per record.
  try {
    results.followUps = await sweepFollowUps();
  } catch (error) {
    console.error("[cron/nightly] follow-up sweep failed:", error);
    results.followUps = { error: String(error) };
  }

  // specs/02-quotation.md §7, as adapted: the app cannot watch an outbound email, so a downloaded
  // quotation that was never confirmed sent is chased rather than assumed.
  try {
    results.unsentDownloads = await sweepUnsentDownloads();
  } catch (error) {
    console.error("[cron/nightly] unsent download sweep failed:", error);
    results.unsentDownloads = { error: String(error) };
  }

  // specs/02-quotation.md §7's auto-expire, plus the seven-day warning that is the half anybody can
  // still act on.
  try {
    results.quotationExpiries = await sweepQuotationExpiries();
  } catch (error) {
    console.error("[cron/nightly] quotation expiry sweep failed:", error);
    results.quotationExpiries = { error: String(error) };
  }

  // specs/02-quotation.md §3.3: "Overdue RFQs (past `dueBy`) surface in a dashboard list and notify
  // the owner." Nothing can be costed until the supplier answers.
  try {
    results.overdueRfqs = await sweepOverdueRfqs();
  } catch (error) {
    console.error("[cron/nightly] overdue RFQ sweep failed:", error);
    results.overdueRfqs = { error: String(error) };
  }

  // The company's seven-day rule: a quotation that went out and has heard nothing back.
  try {
    results.silentQuotations = await sweepSilentQuotations();
  } catch (error) {
    console.error("[cron/nightly] silent quotation sweep failed:", error);
    results.silentQuotations = { error: String(error) };
  }

  // The company's 500-day rule. Changes account status, so it runs last: everything above only
  // sends notifications, and a sweep that writes should not be able to take a read-only one down
  // with it.
  try {
    results.dormantAccounts = await sweepDormantAccounts();
  } catch (error) {
    console.error("[cron/nightly] dormancy sweep failed:", error);
    results.dormantAccounts = { error: String(error) };
  }

  // specs/02-quotation.md, at the company's request: a quotation whose purchase order arrived
  // fourteen days ago is finished sales work and comes off the working list.
  try {
    results.archivedQuotations = await sweepQuotationsToArchive();
  } catch (error) {
    console.error("[cron/nightly] quotation archive sweep failed:", error);
    results.archivedQuotations = { error: String(error) };
  }

  // specs/04-operations-projects.md §5: "Overdue liquidation blocks that person from requesting a
  // new advance." The block reads a status, so something has to write it — this is that something.
  // Quiet on repeat: an advance already marked overdue produces no second event and no second
  // notification, so a fortnight of lateness is not a fortnight of identical messages.
  try {
    results.overdueLiquidations = await sweepOverdueLiquidationsService();
  } catch (error) {
    console.error("[cron/nightly] overdue liquidation sweep failed:", error);
    results.overdueLiquidations = { error: String(error) };
  }

  return NextResponse.json(results);
}
