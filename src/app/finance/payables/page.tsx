"use client";

import { useState } from "react";
import { DateCell } from "@/components/ui/cells";
import { Button } from "@/components/ui/button";
import { Input, Label } from "@/components/ui/input";
import { Card, PageHeader } from "@/components/ui/layout";
import { StatusBadge, type StatusTone } from "@/components/ui/status-badge";
import { AGEING_BUCKETS, type AgeingBucket } from "@/server/core/finance/payables-rules";
import { formatMoney } from "@/lib/format";
import { toastError, toastSuccess } from "@/lib/errors";
import { trpc } from "@/lib/trpc/client";

/**
 * §7's payables — what AIES owes, how late it is, and which bills disagree with their orders.
 *
 * Ordered by due date rather than by amount, because the question a payables list answers is *what is
 * about to be late*. A large invoice due next month is not more urgent than a small one that was due
 * last week, and sorting by value puts them the wrong way round.
 *
 * The ageing buckets deliberately mirror §5's receivables. Same buckets on both sides means "we are
 * owed 400,000 at 60 days and we owe 300,000 at 60 days" is a comparison somebody can make at a
 * glance, which is most of the reason to age a payables list at all.
 */

const AGEING_LABELS: Record<AgeingBucket, string> = {
  not_due: "Not due",
  "1-30": "1–30 days",
  "31-60": "31–60 days",
  "61-90": "61–90 days",
  "90+": "Over 90 days",
};

const AGEING_TONE: Record<AgeingBucket, StatusTone> = {
  not_due: "draft",
  "1-30": "pending",
  "31-60": "pending",
  "61-90": "failed",
  "90+": "failed",
};

const STATUS_TONE: Record<string, StatusTone> = {
  draft: "draft",
  matched: "approved",
  disputed: "failed",
  approved: "info",
  paid: "approved",
};

export default function PayablesPage() {
  const payables = trpc.finance.payables.useQuery({});
  const data = payables.data;

  return (
    <div className="mx-auto max-w-6xl">
      <PageHeader
        title="Payables"
        description="Supplier bills, aged, with the ones that disagree with their orders called out."
      />

      {payables.isPending && <p className="mt-4 text-sm text-text-muted">Loading…</p>}
      {payables.error && (
        <Card className="mt-4 p-4">
          <p className="text-sm">{payables.error.message}</p>
        </Card>
      )}

      {data && (
        <>
          <div className="mt-4 grid gap-3 sm:grid-cols-3">
            <Card className="p-3">
              <p className="text-xs text-text-muted">Owed</p>
              <p className="tabular mt-0.5 text-lg font-semibold">
                {formatMoney(data.total, "PHP")}
              </p>
            </Card>
            <Card className="p-3">
              <p className="text-xs text-text-muted">Bills open</p>
              <p className="tabular mt-0.5 text-lg font-semibold">{data.rows.length}</p>
            </Card>
            <Card className="p-3">
              <p className="text-xs text-text-muted">Disputed</p>
              {/*
                Shown even at zero, like the release queue's late count. A figure that disappears when
                it is good is one nobody learns to read — and this is the number that means AIES is
                about to pay for something it did not order or did not receive.
              */}
              <p
                className={`tabular mt-0.5 text-lg font-semibold ${
                  data.disputedCount > 0 ? "text-danger" : ""
                }`}
              >
                {data.disputedCount}
              </p>
            </Card>
          </div>

          <Card className="mt-4 p-3">
            <h2 className="text-sm font-semibold">By age</h2>
            <div className="mt-2 flex flex-wrap gap-3">
              {AGEING_BUCKETS.map((bucket) => (
                <span key={bucket} className="text-sm">
                  <span className="text-xs text-text-muted">{AGEING_LABELS[bucket]}</span>{" "}
                  <span className="tabular font-medium">
                    {formatMoney(String(data.byAgeing[bucket] ?? 0), "PHP")}
                  </span>
                </span>
              ))}
            </div>
          </Card>

          {data.rows.length === 0 ? (
            <Card className="mt-4 p-4">
              <p className="text-sm">No supplier bills are outstanding.</p>
            </Card>
          ) : (
            <ul className="mt-4 space-y-2">
              {data.rows.map((row) => (
                <li key={row.id} className="rounded-md border border-border p-3">
                  <div className="flex flex-wrap items-baseline justify-between gap-2">
                    <span className="flex flex-wrap items-baseline gap-2">
                      <span className="tabular font-medium">{row.number}</span>
                      <span className="text-sm">{row.supplier?.name ?? "unknown supplier"}</span>
                      <span className="text-xs text-text-muted">their ref {row.supplierRef}</span>
                    </span>
                    <span className="flex items-center gap-2">
                      <StatusBadge tone={AGEING_TONE[row.ageing as AgeingBucket] ?? "draft"}>
                        {AGEING_LABELS[row.ageing as AgeingBucket] ?? row.ageing}
                      </StatusBadge>
                      <StatusBadge tone={STATUS_TONE[row.status] ?? "draft"}>
                        {row.status}
                      </StatusBadge>
                      <span className="tabular font-medium">
                        {formatMoney(row.amount, row.currency)}
                      </span>
                    </span>
                  </div>

                  <p className="mt-1 text-xs text-text-muted">
                    Invoiced <DateCell value={row.invoiceDate} />
                    {row.dueDate ? (
                      <>
                        {" · due "}
                        <DateCell value={row.dueDate} />
                      </>
                    ) : (
                      " · no due date stated"
                    )}
                    {row.supplierPO ? ` · ${row.supplierPO.number}` : " · no purchase order"}
                  </p>

                  {/*
                    The findings in words, not a flag.

                    "Disputed" tells somebody to look; it does not tell them what to say when they
                    ring the supplier. Each finding names what was expected, what arrived, and which
                    conversation it is — a price rise and goods that never came look identical until
                    somebody writes them down separately.
                  */}
                  {row.findings.length > 0 && (
                    <ul className="mt-2 space-y-1 rounded border-2 border-amber-400 bg-amber-50 p-2 text-xs text-amber-900">
                      {row.findings.map((finding, index) => (
                        <li key={index}>{finding.note}</li>
                      ))}
                    </ul>
                  )}

                  {row.disputeOverrideReason && (
                    <p className="mt-1 text-xs text-text-muted">
                      Approved despite the findings — {row.disputeOverrideReason}
                    </p>
                  )}

                  {(row.status === "matched" || row.status === "disputed") && (
                    <ApproveBill
                      id={row.id}
                      number={row.number}
                      disputed={row.status === "disputed"}
                      onDone={() => void payables.refetch()}
                    />
                  )}
                </li>
              ))}
            </ul>
          )}
        </>
      )}
    </div>
  );
}

/**
 * Clearing a bill for payment.
 *
 * A matched bill goes through on one press — the check has already been done by the system and
 * asking a person to retype that adds nothing. A **disputed** one demands a written reason, because
 * an invoice that failed its match and was paid anyway is either a discrepancy somebody investigated
 * and accepted or one nobody looked at, and only the words separate the two.
 */
function ApproveBill({
  id,
  number,
  disputed,
  onDone,
}: {
  id: string;
  number: string;
  disputed: boolean;
  onDone: () => void;
}) {
  const [open, setOpen] = useState(false);
  const [reason, setReason] = useState("");

  const approve = trpc.finance.approveSupplierInvoice.useMutation({
    onSuccess: () => {
      toastSuccess(`${number} cleared for payment.`);
      setOpen(false);
      setReason("");
      onDone();
    },
    onError: toastError,
  });

  if (!disputed) {
    return (
      <Button
        variant="secondary"
        size="sm"
        className="mt-2"
        disabled={approve.isPending}
        onClick={() => approve.mutate({ id })}
      >
        Clear for payment
      </Button>
    );
  }

  if (!open) {
    return (
      <Button variant="ghost" size="sm" className="mt-2" onClick={() => setOpen(true)}>
        Approve despite the findings…
      </Button>
    );
  }

  return (
    <div className="mt-2 rounded-md border border-border p-2.5">
      <Label htmlFor={`ap-${id}`}>What was checked, and why it is being paid</Label>
      <Input
        id={`ap-${id}`}
        value={reason}
        placeholder="Freight was agreed by phone on 12 Aug; balance of goods arrived on GRN-260041."
        onChange={(event) => setReason(event.target.value)}
      />
      <div className="mt-2 flex gap-2">
        <Button
          size="sm"
          disabled={approve.isPending || reason.trim().length < 10}
          onClick={() => approve.mutate({ id, overrideReason: reason.trim() })}
        >
          {approve.isPending ? "Approving…" : "Approve it"}
        </Button>
        <Button variant="ghost" size="sm" onClick={() => setOpen(false)}>
          Cancel
        </Button>
      </div>
    </div>
  );
}
