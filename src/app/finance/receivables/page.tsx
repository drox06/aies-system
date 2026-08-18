"use client";

import Link from "next/link";
import { DateCell } from "@/components/ui/cells";
import { Card, EmptyState, PageHeader } from "@/components/ui/layout";
import { StatusBadge, type StatusTone } from "@/components/ui/status-badge";
import { AGEING_BUCKETS, type AgeingBucket } from "@/server/core/finance/invoice-rules";
import { trpc } from "@/lib/trpc/client";

/**
 * specs/05-finance-billing.md §5 — what customers owe, aged.
 *
 * ## The one thing this screen must not do
 *
 * §5: ageing runs on **billing statements**, not service invoices, "the invoice only exists once the
 * money is in". A receivables report built from invoices would show a debt of zero however much is
 * owed — the system would look healthiest at precisely the moment it was not. The service enforces
 * it; this note is here so nobody 'fixes' it later.
 *
 * ## Why the expected net collectible is on the row
 *
 * §3.2: statements show it "so nobody is surprised when less money arrives than the statement said".
 * A customer who withholds 2% will always pay less than the balance, and a collections call that
 * demands the full figure from somebody who paid correctly is a call that damages the relationship
 * for no reason.
 */

const BUCKET_LABELS: Readonly<Record<AgeingBucket, string>> = {
  current: "Not yet due",
  "1-30": "1–30 days",
  "31-60": "31–60 days",
  "61-90": "61–90 days",
  "90+": "Over 90 days",
};

/** Older money is worse money. The tone follows the age rather than the amount. */
const BUCKET_TONE: Readonly<Record<AgeingBucket, StatusTone>> = {
  current: "approved",
  "1-30": "pending",
  "31-60": "pending",
  "61-90": "failed",
  "90+": "failed",
};

const pesos = (centavos: number) =>
  `₱${(centavos / 100).toLocaleString("en-PH", { minimumFractionDigits: 2 })}`;

export default function ReceivablesPage() {
  const receivables = trpc.finance.receivables.useQuery();
  const chase = trpc.finance.outstanding2307s.useQuery();

  if (receivables.isPending) {
    return <p className="text-sm text-text-muted">Loading what is owed…</p>;
  }
  if (receivables.error) {
    return <p className="text-sm text-danger">{receivables.error.message}</p>;
  }

  const data = receivables.data!;

  return (
    <div>
      <PageHeader
        title="Receivables"
        description="What customers owe, by how long it has been owed. Aged on the statements that asked for the money — an invoice only exists once it has arrived."
      />

      {data.rows.length === 0 ? (
        <Card className="mt-4 p-4">
          <EmptyState
            title="Nothing is outstanding."
            description="A statement appears here once it has been issued and until it is paid."
          />
        </Card>
      ) : (
        <>
          <div className="mt-4 grid gap-3 sm:grid-cols-5">
            {AGEING_BUCKETS.map((bucket) => (
              <Card key={bucket} className="p-3">
                <p className="text-xs text-text-muted">{BUCKET_LABELS[bucket]}</p>
                <p className="mt-1 tabular text-base font-semibold">
                  {pesos(data.buckets[bucket])}
                </p>
              </Card>
            ))}
          </div>

          <Card className="mt-3 p-3">
            <p className="text-sm">
              <span className="text-text-muted">Total outstanding</span>{" "}
              <span className="tabular font-semibold">{pesos(data.total)}</span>
            </p>
          </Card>

          <div className="mt-4 space-y-2">
            {data.rows.map((row) => (
              <Card key={row.id} className="p-3">
                <div className="flex flex-wrap items-baseline justify-between gap-2">
                  <div className="min-w-0">
                    <p className="font-medium">
                      <span className="tabular">{row.number}</span>
                      <span className="ml-2 text-sm text-text-muted">{row.accountName}</span>
                    </p>
                    <p className="mt-0.5 text-xs text-text-muted">
                      Due <DateCell value={row.dueDate} /> ·{" "}
                      {row.amountPaid > 0
                        ? `${pesos(row.amountPaid)} of ${pesos(row.total)} paid`
                        : pesos(row.total)}
                    </p>
                  </div>
                  <div className="text-right">
                    <p className="tabular font-semibold">{pesos(row.balance)}</p>
                    <StatusBadge tone={BUCKET_TONE[row.bucket]}>
                      {BUCKET_LABELS[row.bucket]}
                    </StatusBadge>
                  </div>
                </div>

                {/* §3.2: less will arrive than the balance says, and that is correct. */}
                {row.withholds && (
                  <p className="mt-2 border-t border-border pt-2 text-xs text-text-muted">
                    This customer withholds — expect {pesos(row.expectedNetCollectible)} against a
                    statement of {pesos(row.total)}, with the difference creditable once their 2307
                    arrives.
                  </p>
                )}
              </Card>
            ))}
          </div>
        </>
      )}

      {/* §3.2's chase list: money already earned and not yet collected. */}
      {chase.data && chase.data.length > 0 && (
        <Card className="mt-6 border-2 border-amber-400 bg-amber-50 p-3">
          <h2 className="text-sm font-semibold text-amber-900">
            {chase.data.length} payment{chase.data.length === 1 ? "" : "s"} with tax withheld and no
            2307 on file
          </h2>
          <p className="mt-1 text-xs text-amber-900">
            Creditable against income tax, and worthless if never collected. Chase them quarterly —
            not at year end, when the customer&rsquo;s accounting staff has changed.
          </p>
          <ul className="mt-2 space-y-1 text-sm text-amber-900">
            {chase.data.map((row) => (
              <li key={row.paymentId} className="flex flex-wrap justify-between gap-2">
                <span>
                  {row.accountName ?? "Unknown"} · <span className="tabular">{row.number}</span>
                </span>
                <span className="tabular">
                  {pesos(row.withholdingTaxAmount)} — {row.daysOutstanding} days
                </span>
              </li>
            ))}
          </ul>
          <p className="mt-2 text-xs text-amber-900">
            <Link href="/finance/billing" className="underline">
              Back to what is ready to bill
            </Link>
          </p>
        </Card>
      )}
    </div>
  );
}
