"use client";

import { Card } from "@/components/ui/layout";
import { StatusBadge } from "@/components/ui/status-badge";
import { formatMoney } from "@/lib/format";

/**
 * §4's margin panel, gated on `finance.view_cost`.
 *
 * **Everything here is a figure the server sent.** Nothing is recomputed in the browser, and that
 * is a security property rather than a style preference: `getQuotationService` strips cost and
 * margin for callers without the permission, and a panel that recalculated them from prices would
 * hand back precisely what the API refused to send. Spec.md §4.3 puts the enforcement in the
 * service layer for exactly this reason.
 *
 * So this component takes optional fields and renders nothing when they are absent, rather than
 * defaulting them to zero. A margin of "0%" on a quotation nobody has costed is a lie the VP would
 * act on.
 */
export function MarginPanel({
  currency,
  totalCost,
  marginAmount,
  marginPct,
  stale,
}: {
  currency: string;
  totalCost?: string;
  marginAmount?: string;
  marginPct?: string;
  /** True when lines have been edited but not yet saved, so these figures describe the last save. */
  stale: boolean;
}) {
  // The permission gate expressed as data: no cost fields arrived, so there is no panel.
  if (totalCost === undefined || marginAmount === undefined) return null;

  const pct = marginPct === undefined ? null : Number(marginPct);
  const tone = pct === null ? "draft" : pct < 0 ? "failed" : pct < 15 ? "pending" : "approved";

  return (
    <Card className="p-4">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <h2 className="text-sm font-semibold">Margin</h2>
        {stale ? (
          // Saying so beats showing a figure that silently describes something else.
          <StatusBadge tone="draft">As last saved</StatusBadge>
        ) : (
          pct !== null && <StatusBadge tone={tone}>{pct.toFixed(1)}%</StatusBadge>
        )}
      </div>

      <dl className="mt-2 space-y-1 text-sm">
        <div className="flex justify-between gap-4">
          <dt className="text-text-muted">Total cost</dt>
          <dd className="tabular">{formatMoney(totalCost, currency)}</dd>
        </div>
        <div className="flex justify-between gap-4">
          <dt className="text-text-muted">Gross margin</dt>
          <dd className="tabular font-medium">{formatMoney(marginAmount, currency)}</dd>
        </div>
      </dl>

      {pct !== null && pct < 15 && (
        <p className="mt-2 rounded border border-border bg-surface-2 p-2 text-xs">
          Below the 15% floor. Sending it needs <code>quotation.override_margin_floor</code>, which
          only the president and vice-president hold.
        </p>
      )}

      <p className="mt-2 text-xs text-text-muted">
        Cost and margin are visible to you because you hold <code>finance.view_cost</code>. They are
        stripped from the API response for everyone else, not merely hidden.
      </p>
    </Card>
  );
}
