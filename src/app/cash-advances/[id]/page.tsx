"use client";

import { use, useState } from "react";
import Link from "next/link";
import { AuditTrail } from "@/components/AuditTrail";
import { Button } from "@/components/ui/button";
import { DateCell, MoneyInput } from "@/components/ui/cells";
import { Input, Label, Select, Textarea } from "@/components/ui/input";
import { Card, PageHeader, RecordLayout } from "@/components/ui/layout";
import { StatusBadge, type StatusTone } from "@/components/ui/status-badge";
import {
  CASH_ADVANCE_CATEGORIES,
  CASH_ADVANCE_ENTITY_TYPE,
  CATEGORY_LABELS,
  RELEASE_METHODS,
  RELEASE_METHOD_LABELS,
  type CashAdvanceCategory,
  type ReleaseMethod,
} from "@/server/core/operations/cash-advance-rules";
import { formatMoney } from "@/lib/format";
import { trpc } from "@/lib/trpc/client";

/**
 * One cash advance (specs/04-operations-projects.md §5).
 *
 * The screen is organised around §5's sequence — request, approve, **release**, liquidate — with
 * release given its own card rather than being folded into the approval. That is not layout
 * preference: §5's complaint is that the gap between a decision and cash in a pocket is invisible,
 * and putting the two acts in one place would hide it again. An approved advance that has not been
 * released shows, prominently, that the crew still has no money.
 *
 * Everything shown here — the standing, the amounts, whether the caller may act — is computed on
 * the server and rendered as sent. The permission checks below decide what is *offered*; the
 * procedures decide what is *allowed*.
 */

const STATUS_TONE: Record<string, StatusTone> = {
  draft: "draft",
  pending_approval: "pending",
  approved: "info",
  rejected: "cancelled",
  released: "active",
  partially_liquidated: "pending",
  liquidated: "approved",
  overdue_liquidation: "failed",
  extended: "pending",
};

const STANDING_TONE: Record<string, StatusTone> = {
  not_released: "draft",
  settled: "approved",
  outstanding: "info",
  extended: "pending",
  late: "failed",
};

const human = (value: string) => value.replace(/_/g, " ");
const pesos = (centavos: number) => (centavos / 100).toFixed(2);

interface BreakdownRow {
  category: string;
  description: string;
  amount: number;
}

export default function CashAdvancePage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = use(params);
  const advance = trpc.operations.getCashAdvance.useQuery({ cashAdvanceId: id });
  const me = trpc.system.whoami.useQuery(undefined, { retry: false });

  if (advance.isPending) return <p className="text-sm text-text-muted">Loading…</p>;
  if (advance.error) {
    return (
      <Card className="p-4">
        <p className="text-sm">{advance.error.message}</p>
      </Card>
    );
  }

  const data = advance.data;
  const permissions = me.data?.permissions ?? [];
  const breakdown = (Array.isArray(data.breakdown)
    ? data.breakdown
    : []) as unknown as BreakdownRow[];
  const refresh = () => void advance.refetch();

  return (
    <div className="mx-auto max-w-7xl">
      <PageHeader
        title={data.number}
        description={data.purpose}
        actions={
          <div className="flex flex-wrap items-center gap-2">
            <StatusBadge tone={STATUS_TONE[data.status] ?? "draft"}>
              <span className="capitalize">{human(data.status)}</span>
            </StatusBadge>
            <StatusBadge tone={STANDING_TONE[data.standing.state] ?? "draft"}>
              <span className="capitalize">{human(data.standing.state)}</span>
            </StatusBadge>
          </div>
        }
      />

      <RecordLayout
        aside={
          <div className="space-y-4">
            <Card className="p-4">
              <h2 className="text-sm font-semibold">The money</h2>
              <dl className="mt-2 space-y-1 text-sm">
                <Row label="Requested" value={formatMoney(data.amountRequested)} />
                {data.amountApproved && (
                  <Row label="Released" value={formatMoney(data.amountApproved)} />
                )}
                {data.amountLiquidated && (
                  <Row label="Receipted" value={formatMoney(data.amountLiquidated)} />
                )}
                {data.amountReturned && Number(data.amountReturned) > 0 && (
                  <Row label="Returned" value={formatMoney(data.amountReturned)} />
                )}
                {data.amountReimbursed && Number(data.amountReimbursed) > 0 && (
                  <Row label="Reimbursable" value={formatMoney(data.amountReimbursed)} />
                )}
                <Row label="Needed by" value={<DateCell value={data.neededBy} />} />
                {data.releaseMethod && (
                  <Row
                    label="Released by"
                    value={RELEASE_METHOD_LABELS[data.releaseMethod as ReleaseMethod]}
                  />
                )}
              </dl>
            </Card>

            <Card className="p-4">
              <h2 className="text-sm font-semibold">Liquidation</h2>
              <p className="mt-1 text-sm">{data.standing.message}</p>
              {data.standing.dueAt && (
                <p className="mt-1 text-xs text-text-muted">
                  Deadline in force: <DateCell value={data.standing.dueAt} />
                  {data.standing.extensionReason ? " (extended)" : ""}
                </p>
              )}
              <p className="mt-2 text-xs text-text-muted">
                Three working days after the job ends, counted on the Philippine working calendar.
              </p>
            </Card>

            {data.ticket && (
              <Card className="p-4">
                <h2 className="text-sm font-semibold">Against</h2>
                <Link
                  href={`/tickets/${data.ticket.id}`}
                  className="tabular mt-1 block text-sm text-blue-600 underline underline-offset-2"
                >
                  {data.ticket.number}
                </Link>
                <p className="text-xs text-text-muted">{data.ticket.title}</p>
              </Card>
            )}
          </div>
        }
      >
        <div className="space-y-4">
          <Card className="p-4">
            <h2 className="text-sm font-semibold">What the money is for</h2>
            <table className="mt-2 w-full text-sm">
              <tbody>
                {breakdown.map((line, index) => (
                  <tr key={index} className="border-b border-border last:border-0">
                    <td className="py-1.5 pr-3">
                      <span className="font-medium">
                        {CATEGORY_LABELS[line.category as CashAdvanceCategory] ?? line.category}
                      </span>
                      {line.description && (
                        <span className="text-text-muted"> — {line.description}</span>
                      )}
                    </td>
                    <td className="tabular py-1.5 text-right">{formatMoney(pesos(line.amount))}</td>
                  </tr>
                ))}
              </tbody>
            </table>
            {data.requestedFor.length > 0 && (
              <p className="mt-2 text-xs text-text-muted">
                Covers {data.requestedFor.length} crew member(s) on one advance, as §5 intends.
              </p>
            )}
          </Card>

          {data.status === "pending_approval" && permissions.includes("cash_advance.approve") && (
            <DecideCard cashAdvanceId={data.id} onDone={refresh} />
          )}

          {data.status === "approved" && (
            <ReleaseCard
              cashAdvanceId={data.id}
              approved={data.amountApproved ?? data.amountRequested}
              canRelease={permissions.includes("cash_advance.release")}
              onDone={refresh}
            />
          )}

          {(data.status === "released" ||
            data.status === "partially_liquidated" ||
            data.status === "overdue_liquidation" ||
            data.status === "extended") && (
            <>
              <LiquidateCard cashAdvanceId={data.id} onDone={refresh} />
              <ExtensionCard
                cashAdvanceId={data.id}
                pending={data.pendingExtension}
                canDecide={permissions.includes("cash_advance.approve_extension")}
                onDone={refresh}
              />
            </>
          )}

          {data.liquidations.length > 0 && (
            <Card className="p-4">
              <h2 className="text-sm font-semibold">Receipts filed</h2>
              <ul className="mt-2 space-y-2 text-sm">
                {data.liquidations.map((liq) => (
                  <li key={liq.id} className="rounded-md border border-border p-2.5">
                    <div className="flex items-baseline justify-between gap-3">
                      <span>
                        <DateCell value={liq.submittedAt} withTime />
                      </span>
                      <span className="tabular font-medium">{formatMoney(liq.totalSpent)}</span>
                    </div>
                    {Number(liq.balanceReturned) > 0 && (
                      <p className="text-xs text-text-muted">
                        {formatMoney(liq.balanceReturned)} handed back
                      </p>
                    )}
                    {liq.remarks && <p className="mt-1 text-xs text-text-muted">{liq.remarks}</p>}
                  </li>
                ))}
              </ul>
            </Card>
          )}

          {data.rejectionReason && (
            <Card className="p-4">
              <h2 className="text-sm font-semibold">Sent back</h2>
              <p className="mt-1 text-sm">{data.rejectionReason}</p>
            </Card>
          )}

          <Card className="p-4">
            <h2 className="text-sm font-semibold">History</h2>
            <div className="mt-2">
              <AuditTrail entityType={CASH_ADVANCE_ENTITY_TYPE} entityId={data.id} />
            </div>
          </Card>
        </div>
      </RecordLayout>
    </div>
  );
}

/** §5: the Vice President, with the President taking over after 4 working hours. */
function DecideCard({ cashAdvanceId, onDone }: { cashAdvanceId: string; onDone: () => void }) {
  const [reason, setReason] = useState("");
  const decide = trpc.operations.decideCashAdvance.useMutation({
    onSuccess: () => {
      setReason("");
      onDone();
    },
  });

  return (
    <Card className="p-4">
      <h2 className="text-sm font-semibold">Your decision</h2>
      <p className="mt-1 text-xs text-text-muted">
        A crew is standing by, which is why this escalates to the President after four working hours
        rather than the usual twenty-four.
      </p>
      <div className="mt-2">
        <Label htmlFor="ca-reason">Reason (required to send back)</Label>
        <Textarea
          id="ca-reason"
          rows={2}
          value={reason}
          onChange={(e) => setReason(e.target.value)}
        />
      </div>
      {decide.error && <p className="mt-2 text-sm text-danger">{decide.error.message}</p>}
      <div className="mt-3 flex gap-2">
        <Button
          disabled={decide.isPending}
          onClick={() => decide.mutate({ cashAdvanceId, decision: "approved", reason })}
        >
          Approve
        </Button>
        <Button
          variant="secondary"
          disabled={decide.isPending || reason.trim().length === 0}
          onClick={() => decide.mutate({ cashAdvanceId, decision: "rejected", reason })}
        >
          Send back
        </Button>
      </div>
    </Card>
  );
}

/**
 * The release, deliberately its own step.
 *
 * Shown to everybody, actionable only by `cash_advance.release`. Somebody without the permission
 * still needs to see that the money is sitting unreleased — that is the state §5 says nobody can
 * currently see, and hiding the card from them would recreate the problem.
 */
function ReleaseCard({
  cashAdvanceId,
  approved,
  canRelease,
  onDone,
}: {
  cashAdvanceId: string;
  approved: string;
  canRelease: boolean;
  onDone: () => void;
}) {
  const [method, setMethod] = useState<ReleaseMethod>("cash");
  const [amount, setAmount] = useState<number | null>(Number(approved));
  const release = trpc.operations.releaseCashAdvance.useMutation({ onSuccess: onDone });

  return (
    <Card className="border-blue-300 bg-blue-50/40 p-4">
      <h2 className="text-sm font-semibold">Approved — the money has not been handed over</h2>
      <p className="mt-1 text-sm text-text-muted">
        Mobilisation waits on release, not on approval. Until this is recorded, the crew has nothing
        in hand.
      </p>

      {canRelease ? (
        <>
          <div className="mt-3 grid gap-3 sm:grid-cols-2">
            <div>
              <Label htmlFor="release-method">How</Label>
              <Select
                id="release-method"
                value={method}
                onChange={(e) => setMethod(e.target.value as ReleaseMethod)}
              >
                {RELEASE_METHODS.map((entry) => (
                  <option key={entry} value={entry}>
                    {RELEASE_METHOD_LABELS[entry]}
                  </option>
                ))}
              </Select>
            </div>
            <div>
              <Label htmlFor="release-amount">How much</Label>
              <MoneyInput id="release-amount" value={amount} onValueChange={setAmount} />
            </div>
          </div>
          {release.error && <p className="mt-2 text-sm text-danger">{release.error.message}</p>}
          <Button
            className="mt-3"
            disabled={release.isPending || !amount || amount <= 0}
            onClick={() =>
              release.mutate({
                cashAdvanceId,
                method,
                amountCentavos: Math.round((amount ?? 0) * 100),
              })
            }
          >
            Record the release
          </Button>
        </>
      ) : (
        <p className="mt-2 text-xs text-text-muted">
          Finance or the Admin Manager records the handover.
        </p>
      )}
    </Card>
  );
}

/** §5's liquidation: receipts, plus the cash actually handed back. */
function LiquidateCard({ cashAdvanceId, onDone }: { cashAdvanceId: string; onDone: () => void }) {
  const [lines, setLines] = useState([blankLine()]);
  const [returned, setReturned] = useState<number | null>(null);
  const [remarks, setRemarks] = useState("");
  const liquidate = trpc.operations.liquidateCashAdvance.useMutation({
    onSuccess: () => {
      setLines([blankLine()]);
      setReturned(null);
      setRemarks("");
      onDone();
    },
  });

  const spent = lines.reduce((sum, line) => sum + (line.amount ?? 0), 0);

  return (
    <Card className="p-4">
      <h2 className="text-sm font-semibold">Liquidate</h2>
      <p className="mt-1 text-xs text-text-muted">
        Receipts, and the cash you are handing back. The advance settles when the two together
        account for what went out — unspent money still in a pocket is not settled.
      </p>

      <div className="mt-3 space-y-2">
        {lines.map((line, index) => (
          <div key={index} className="grid gap-2 sm:grid-cols-[8rem_1fr_9rem_auto]">
            <Select
              aria-label="Category"
              value={line.category}
              onChange={(e) => update(index, { category: e.target.value })}
            >
              {CASH_ADVANCE_CATEGORIES.map((entry) => (
                <option key={entry} value={entry}>
                  {CATEGORY_LABELS[entry]}
                </option>
              ))}
            </Select>
            <Input
              aria-label="Description"
              placeholder="What it was"
              value={line.description}
              onChange={(e) => update(index, { description: e.target.value })}
            />
            <MoneyInput
              aria-label="Amount"
              value={line.amount}
              onValueChange={(value) => update(index, { amount: value })}
            />
            <label className="flex items-center gap-1.5 text-xs whitespace-nowrap text-text-muted">
              <input
                type="checkbox"
                checked={line.hasOfficialReceipt}
                onChange={(e) => update(index, { hasOfficialReceipt: e.target.checked })}
              />
              {/* An official receipt is what makes the cost deductible. A bus ticket is not one,
                  and module 05 has to be able to tell them apart. */}
              OR
            </label>
          </div>
        ))}
      </div>

      <Button
        variant="secondary"
        size="sm"
        className="mt-2"
        onClick={() => setLines([...lines, blankLine()])}
      >
        Add a line
      </Button>

      <div className="mt-3 grid gap-3 sm:grid-cols-2">
        <div>
          <Label htmlFor="returned">Cash handed back</Label>
          <MoneyInput id="returned" value={returned} onValueChange={setReturned} />
        </div>
        <div>
          <Label htmlFor="liq-remarks">Remarks</Label>
          <Input id="liq-remarks" value={remarks} onChange={(e) => setRemarks(e.target.value)} />
        </div>
      </div>

      <p className="mt-2 text-sm text-text-muted">
        Receipts total <span className="tabular font-medium text-text">{spent.toFixed(2)}</span>
      </p>

      {liquidate.error && <p className="mt-2 text-sm text-danger">{liquidate.error.message}</p>}

      <Button
        className="mt-3"
        disabled={liquidate.isPending || spent <= 0}
        onClick={() =>
          liquidate.mutate({
            cashAdvanceId,
            lines: lines
              .filter((line) => (line.amount ?? 0) > 0)
              .map((line) => ({
                date: new Date().toISOString().slice(0, 10),
                category: line.category as CashAdvanceCategory,
                description: line.description,
                amount: Math.round((line.amount ?? 0) * 100),
                hasOfficialReceipt: line.hasOfficialReceipt,
              })),
            amountReturnedCentavos: Math.round((returned ?? 0) * 100),
            remarks: remarks || undefined,
          })
        }
      >
        File these receipts
      </Button>
    </Card>
  );

  function update(index: number, patch: Partial<ReturnType<typeof blankLine>>) {
    setLines(lines.map((line, i) => (i === index ? { ...line, ...patch } : line)));
  }
}

function blankLine() {
  return {
    category: "transport" as string,
    description: "",
    amount: null as number | null,
    hasOfficialReceipt: false,
  };
}

/**
 * §5's extension: a request-and-approve record, never a silent edit of the deadline.
 *
 * The pending request is shown to everyone who can see the advance, because "somebody has asked for
 * more time and nobody has answered" is itself a state worth seeing — it is the difference between
 * late and waiting on the VP.
 */
function ExtensionCard({
  cashAdvanceId,
  pending,
  canDecide,
  onDone,
}: {
  cashAdvanceId: string;
  pending: { reason: string; newDueAt: string } | null;
  canDecide: boolean;
  onDone: () => void;
}) {
  const [reason, setReason] = useState("");
  const [newDueAt, setNewDueAt] = useState("");
  const request = trpc.operations.requestLiquidationExtension.useMutation({
    onSuccess: () => {
      setReason("");
      setNewDueAt("");
      onDone();
    },
  });
  const decide = trpc.operations.decideLiquidationExtension.useMutation({ onSuccess: onDone });

  if (pending) {
    return (
      <Card className="p-4">
        <h2 className="text-sm font-semibold">Extension requested</h2>
        <p className="mt-1 text-sm">
          To {pending.newDueAt.slice(0, 10)} — {pending.reason}
        </p>
        {decide.error && <p className="mt-2 text-sm text-danger">{decide.error.message}</p>}
        {canDecide ? (
          <div className="mt-3 flex gap-2">
            <Button
              disabled={decide.isPending}
              onClick={() => decide.mutate({ cashAdvanceId, decision: "approved" })}
            >
              Grant it
            </Button>
            <Button
              variant="secondary"
              disabled={decide.isPending}
              onClick={() => decide.mutate({ cashAdvanceId, decision: "rejected" })}
            >
              Decline
            </Button>
          </div>
        ) : (
          <p className="mt-2 text-xs text-text-muted">
            Waiting on the Vice President. The deadline has not moved until it is granted.
          </p>
        )}
      </Card>
    );
  }

  return (
    <Card className="p-4">
      <h2 className="text-sm font-semibold">Need more time?</h2>
      <p className="mt-1 text-xs text-text-muted">
        Extensions are granted by the Vice President and stay on the record with their reason. Being
        late blocks you from another advance; a granted extension does not.
      </p>
      <div className="mt-3 grid gap-3 sm:grid-cols-2">
        <div>
          <Label htmlFor="ext-due">New deadline</Label>
          <Input
            id="ext-due"
            type="date"
            value={newDueAt}
            onChange={(e) => setNewDueAt(e.target.value)}
          />
        </div>
        <div>
          <Label htmlFor="ext-reason">Why</Label>
          <Input id="ext-reason" value={reason} onChange={(e) => setReason(e.target.value)} />
        </div>
      </div>
      {request.error && <p className="mt-2 text-sm text-danger">{request.error.message}</p>}
      <Button
        variant="secondary"
        className="mt-3"
        disabled={request.isPending || reason.trim().length < 10 || !newDueAt}
        onClick={() => request.mutate({ cashAdvanceId, reason, newDueAt: new Date(newDueAt) })}
      >
        Ask for an extension
      </Button>
    </Card>
  );
}

function Row({ label, value }: { label: string; value: React.ReactNode }) {
  return (
    <div className="flex items-baseline justify-between gap-3">
      <dt className="text-xs text-text-muted">{label}</dt>
      <dd className="tabular min-w-0 truncate text-right">{value}</dd>
    </div>
  );
}
