"use client";

import { DateCell } from "@/components/ui/cells";
import { Card } from "@/components/ui/layout";
import { StatusBadge, type StatusTone } from "@/components/ui/status-badge";
import { trpc } from "@/lib/trpc/client";

/**
 * §5's reconciliation, built from §16's field expenses.
 *
 * ## What was missing
 *
 * `advanceLiquidationService` computed all of this and had no caller. An advance could be released
 * and liquidated, and **nobody could see whether the money balanced** — which is the entire question
 * a liquidation exists to answer. docs/DECISIONS.md #135's triage.
 *
 * ## Why the outstanding figure may be negative
 *
 * The service allows it deliberately, and so does this. A technician who spent more than they were
 * given is **owed the difference** — common on a job that ran long — and clamping the figure at zero
 * would hide a debt the company owes its own staff. A negative number here is not an error state; it
 * is the company being told to reimburse somebody.
 *
 * ## Why the expenses are listed rather than summed
 *
 * §5 asks the liquidation to be *checkable*. A single total tells a reviewer the arithmetic is
 * consistent and nothing about whether the spend was reasonable, and the reviewer's job is the
 * second question. Unapproved lines are marked, because they do not count towards the liquidation
 * yet — a claim is not a cost.
 */

const EXPENSE_TONE: Record<string, StatusTone> = {
  draft: "draft",
  submitted: "pending",
  approved: "approved",
  rejected: "failed",
  reimbursed: "info",
};

const pesos = (centavos: number) =>
  `₱${(centavos / 100).toLocaleString("en-PH", { minimumFractionDigits: 2 })}`;

export function LiquidationPanel({ cashAdvanceId }: { cashAdvanceId: string }) {
  const query = trpc.operations.advanceLiquidation.useQuery({ cashAdvanceId }, { retry: false });

  // Absent rather than erroring: somebody without the register permission should not be told a
  // reconciliation exists and is being withheld.
  if (query.error || query.isPending || !query.data) return null;

  const { expenses, standing } = query.data;

  return (
    <Card className="mt-4 p-4">
      <h2 className="text-sm font-semibold">What it was spent on</h2>
      <p className="mt-0.5 text-xs text-text-muted">
        Built from the field expenses charged to this advance — §16 records them where they
        happened, so nobody retypes a pile of receipts.
      </p>

      <div className="mt-3 grid gap-3 sm:grid-cols-3">
        <Figure label="Released" value={pesos(standing.released)} />
        <Figure label="Spent and approved" value={pesos(standing.liquidated)} />
        {/*
          The number the whole panel exists for, and it is allowed to be negative.

          Positive means the technician still holds company money. Negative means they are out of
          pocket and AIES owes them. Both are ordinary; only zero means the loop is closed.
        */}
        <Figure
          label={standing.outstanding < 0 ? "AIES owes them" : "Still to account for"}
          value={pesos(Math.abs(standing.outstanding))}
          tone={
            standing.outstanding === 0 ? "approved" : standing.outstanding < 0 ? "info" : "pending"
          }
        />
      </div>

      {standing.overspent && (
        <p className="mt-2 text-xs text-text-muted">
          They spent more than they were given. That difference is a reimbursement, not a shortfall.
        </p>
      )}

      {expenses.length === 0 ? (
        <p className="mt-3 text-sm">
          Nothing has been charged to this advance yet. Until something is, the whole of it is still
          outstanding.
        </p>
      ) : (
        <ul className="mt-3 space-y-1.5">
          {expenses.map((expense) => (
            <li
              key={expense.id}
              className="flex flex-wrap items-baseline justify-between gap-2 rounded-md border border-border p-2.5 text-sm"
            >
              <span className="min-w-0">
                <span>{expense.description}</span>
                <span className="block text-xs text-text-muted">
                  <DateCell value={expense.date} /> · {expense.category}
                </span>
              </span>
              <span className="flex items-center gap-2">
                <StatusBadge tone={EXPENSE_TONE[expense.status] ?? "draft"}>
                  {expense.status}
                </StatusBadge>
                <span className="tabular font-medium">{pesos(expense.amount)}</span>
              </span>
            </li>
          ))}
        </ul>
      )}

      {/*
        `pending` is what the rules layer already computes for exactly this: spend that has been
        claimed and not yet approved. Reading it rather than re-deriving from the rows means the
        warning and the figures can never disagree.
      */}
      {standing.pending > 0 && (
        <p className="mt-2 text-xs text-amber-700">
          {pesos(standing.pending)} is still waiting on a decision and does not count towards the
          liquidation until it is approved. A claim is not a cost.
        </p>
      )}
    </Card>
  );
}

function Figure({ label, value, tone }: { label: string; value: string; tone?: StatusTone }) {
  return (
    <div className="rounded-md border border-border p-2.5">
      <p className="text-xs text-text-muted">{label}</p>
      <p
        className={`tabular mt-0.5 text-lg font-semibold ${tone === "pending" ? "text-amber-700" : ""}`}
      >
        {value}
      </p>
    </div>
  );
}
