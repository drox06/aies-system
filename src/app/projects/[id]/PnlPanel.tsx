"use client";

import { Card } from "@/components/ui/layout";
import { StatusBadge } from "@/components/ui/status-badge";
import { formatMoney } from "@/lib/format";
import { trpc } from "@/lib/trpc/client";

/**
 * §6's project P&L — what the job was sold for, what it actually cost, and the gap.
 *
 * §6 says why this exists in one sentence: *"The gap between quoted margin and actual margin is the
 * single most useful number the platform can give management, because today it is unknowable."* So
 * the variance leads, and everything else on the panel is there to make it arguable.
 *
 * ## Why the caveats are as prominent as the figures
 *
 * A margin computed over timesheets with no cost rate, or stock issued with no purchase cost, is
 * **flattering** — the missing costs all push the same way. A screen that showed 34% without saying
 * "eleven days have no rate" would be worse than one that showed nothing, because somebody would act
 * on it.
 *
 * That is the same principle as the readiness list refusing to call an unknown gate a pass, and as
 * §11's equipment with no warranty window not being equipment out of warranty. **An absence is not a
 * zero**, and a number that quietly treats it as one is the most dangerous thing a report can do.
 *
 * ## Gated on `pnl.view`
 *
 * Labour cost over hours is close enough to somebody's pay that this cannot be an ordinary report.
 * The panel is absent rather than empty for anybody without it.
 */
export function PnlPanel({ projectId }: { projectId: string }) {
  const pnl = trpc.finance.projectPnl.useQuery({ projectId }, { retry: false });

  // Absent, not erroring: somebody without `pnl.view` should not be told a P&L exists and is being
  // withheld — the panel simply is not part of their screen.
  if (pnl.error || pnl.isPending) return null;

  const data = pnl.data;
  const currency = "PHP";

  const variance = data.marginVariancePts;
  const varianceTone = variance < -5 ? "failed" : variance < 0 ? "pending" : "approved";

  const caveats: string[] = [];
  if (data.caveats.noContractValue) {
    caveats.push(
      "No sales order is linked to this project, so there is no contract value to measure against. " +
        "The margin below is not meaningful.",
    );
  }
  if (data.caveats.daysWithNoRate > 0) {
    caveats.push(
      `${data.caveats.daysWithNoRate} approved timesheet day${
        data.caveats.daysWithNoRate === 1 ? "" : "s"
      } have no cost rate on file, so that labour is missing from the cost — the margin is flattered by it.`,
    );
  }
  if (data.caveats.uncostedStockIssues > 0) {
    caveats.push(
      `${data.caveats.uncostedStockIssues} stock issue${
        data.caveats.uncostedStockIssues === 1 ? "" : "s"
      } have no last purchase cost recorded, so those materials are missing from the cost.`,
    );
  }

  return (
    <Card className="p-4">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <h2 className="text-sm font-semibold">Profitability</h2>
        {!data.noCostsYet && !data.caveats.noContractValue && (
          <StatusBadge tone={varianceTone}>
            {variance >= 0 ? "+" : ""}
            {variance.toFixed(1)} pts against quoted
          </StatusBadge>
        )}
      </div>

      {data.noCostsYet ? (
        <p className="mt-1 text-sm text-text-muted">
          Nothing has been costed against this project yet. A margin computed now would read 100%,
          which is why it is not shown.
        </p>
      ) : (
        <>
          <div className="mt-3 grid gap-3 sm:grid-cols-3">
            <Figure
              label="Contract value"
              value={formatMoney(String(data.contractValue), currency)}
            />
            <Figure label="Quoted cost" value={formatMoney(String(data.quotedCost), currency)} />
            <Figure label="Actual cost" value={formatMoney(String(data.actualCost), currency)} />
          </div>

          <div className="mt-2 grid gap-3 sm:grid-cols-2">
            <Figure
              label="Quoted margin"
              value={`${formatMoney(String(data.quotedMargin), currency)} · ${data.quotedMarginPct.toFixed(1)}%`}
            />
            <Figure
              label="Actual margin"
              value={`${formatMoney(String(data.actualMargin), currency)} · ${data.actualMarginPct.toFixed(1)}%`}
              strong
            />
          </div>

          <table className="mt-3 w-full text-sm">
            <thead>
              <tr className="border-b border-border text-left text-xs text-text-muted">
                <th className="py-1 font-medium">Cost</th>
                <th className="py-1 text-right font-medium">Amount</th>
                <th className="py-1 text-right font-medium">Share</th>
              </tr>
            </thead>
            <tbody>
              {data.byCategory.map((row) => (
                <tr key={row.category} className="border-b border-border last:border-0">
                  <td className="py-1.5">{row.label}</td>
                  <td className="tabular py-1.5 text-right">
                    {formatMoney(String(row.amount), currency)}
                  </td>
                  <td className="tabular py-1.5 text-right text-text-muted">
                    {row.pctOfCost.toFixed(0)}%
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </>
      )}

      {/*
        §6: rework "should be reportable on its own, not buried in project cost".

        Shown as a count of failed rounds rather than a peso figure. What a failed QA round costs is
        the crew going back, and those hours are already counted under labour and travel; splitting
        them out needs a link from a timesheet to the round that caused it, which module 04 does not
        record. A count somebody can defend beats a figure nobody can.
      */}
      {data.caveats.failedQaRounds > 0 && (
        <p className="mt-3 rounded border border-border bg-surface-2 p-2 text-xs">
          <span className="font-medium">
            {data.caveats.failedQaRounds} failed QA round
            {data.caveats.failedQaRounds === 1 ? "" : "s"}
          </span>{" "}
          on this project. The rework hours are inside labour and travel above — this is the count,
          because nobody can yet say which hours belonged to which round.
        </p>
      )}

      {/*
        Cash out and not yet accounted for.

        Its own block, above the caveats and worded differently, because it is a different kind of
        unknown. The caveats below say *this cost is missing and cannot be priced*. This says *this
        cost is coming, and here is exactly what the margin becomes when it lands* — which is
        actionable in a way "eleven days have no rate" is not.

        The company found the need for it on 2026-08-20: ₱24,000 released that morning against a job
        reading 22.41% against a 21.01% quote, with nothing to say that liquidating it takes the job
        to 18.6% — from above its estimate to below it. Doing that arithmetic for the reader is the
        difference between a warning somebody reads and one they skip.
      */}
      {data.caveats.advancesOutstanding > 0 && (
        <div className="mt-3 rounded border-2 border-amber-500 bg-amber-50 p-2.5">
          <p className="text-xs font-semibold text-amber-900">Money out, not yet accounted for</p>
          <p className="mt-1 text-xs text-amber-900">
            <span className="tabular font-semibold">
              {formatMoney(data.caveats.advancedNotLiquidated.toFixed(2), currency)}
            </span>{" "}
            of cash advances {data.caveats.advancesOutstanding === 1 ? "has" : "have"} been released
            and not liquidated. That is <strong>not a cost yet</strong> — only approved liquidation
            lines post — so the figures above do not include it.
            {data.caveats.marginPctIfLiquidated !== null && (
              <>
                {" "}
                If {data.caveats.advancesOutstanding === 1 ? "it liquidates" : "they liquidate"} in
                full, the margin becomes{" "}
                <strong className="tabular">
                  {data.caveats.marginPctIfLiquidated.toFixed(1)}%
                </strong>
                .
              </>
            )}
          </p>
          {data.caveats.earliestLiquidationDue && (
            <p className="mt-1 text-xs text-amber-900">
              Liquidation due from{" "}
              {new Date(data.caveats.earliestLiquidationDue).toLocaleDateString("en-PH", {
                day: "numeric",
                month: "short",
                year: "numeric",
              })}
              .
            </p>
          )}
        </div>
      )}

      {caveats.length > 0 && (
        <div className="mt-3 rounded border-2 border-amber-400 bg-amber-50 p-2.5">
          <p className="text-xs font-semibold text-amber-900">What this figure does not know</p>
          <ul className="mt-1 space-y-0.5 text-xs text-amber-900">
            {caveats.map((line) => (
              <li key={line}>{line}</li>
            ))}
          </ul>
        </div>
      )}
    </Card>
  );
}

function Figure({ label, value, strong }: { label: string; value: string; strong?: boolean }) {
  return (
    <div className="rounded-md border border-border p-2.5">
      <p className="text-xs text-text-muted">{label}</p>
      <p className={`tabular mt-0.5 ${strong ? "text-lg font-semibold" : "text-sm font-medium"}`}>
        {value}
      </p>
    </div>
  );
}
