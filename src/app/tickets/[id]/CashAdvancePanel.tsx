"use client";

import { useState } from "react";
import Link from "next/link";
import { Button } from "@/components/ui/button";
import { MoneyInput } from "@/components/ui/cells";
import { Input, Label, Select, Textarea } from "@/components/ui/input";
import { Card } from "@/components/ui/layout";
import { StatusBadge, type StatusTone } from "@/components/ui/status-badge";
import {
  CASH_ADVANCE_CATEGORIES,
  CATEGORY_LABELS,
  type CashAdvanceCategory,
} from "@/server/core/operations/cash-advance-rules";
import { trpc } from "@/lib/trpc/client";

/**
 * §1's Gate 1, on the ticket where somebody would otherwise discover it too late.
 *
 * §5's whole complaint is that this constraint is "currently invisible to everyone until a
 * technician can't board a bus". So the verdict is at the top of the ticket, in words, whether or
 * not the reader can do anything about it — a coordinator who cannot release money still needs to
 * know the crew has none.
 *
 * The verdict itself comes from `cashAdvanceGate` on the server. Nothing here re-derives it from
 * the advance's status, because §8's mobilisation will ask the same function and two answers to one
 * question is how a screen ends up disagreeing with a block.
 */

const GATE_TONE: Record<string, StatusTone> = {
  not_required: "draft",
  satisfied: "approved",
  blocked: "failed",
};

interface BreakdownRow {
  category: string;
  description: string;
  amount: number | null;
}

export function CashAdvancePanel({ ticketId }: { ticketId: string }) {
  const gate = trpc.operations.cashAdvanceGate.useQuery({ ticketId });
  const advances = trpc.operations.listCashAdvances.useQuery({ ticketId, scope: "all" });
  const me = trpc.system.whoami.useQuery(undefined, { retry: false });
  const [showForm, setShowForm] = useState(false);

  const permissions = me.data?.permissions ?? [];
  const canRequest = permissions.includes("cash_advance.request");
  const canOverride = permissions.includes("operations.override_ca_gate");

  const refresh = () => {
    void gate.refetch();
    void advances.refetch();
  };

  if (gate.isPending) return null;
  if (gate.error) {
    return (
      <Card className="p-4">
        <p className="text-sm">{gate.error.message}</p>
      </Card>
    );
  }

  const data = gate.data;
  const rows = advances.data ?? [];

  return (
    <Card className="p-4">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <h2 className="text-sm font-semibold">Cash advance</h2>
        <StatusBadge tone={GATE_TONE[data.state] ?? "draft"}>
          {data.state === "blocked"
            ? "Mobilisation blocked"
            : data.state === "satisfied"
              ? "Clear"
              : "Not required"}
        </StatusBadge>
      </div>

      <p className="mt-1 text-sm text-text-muted">{data.message}</p>

      {rows.length > 0 && (
        <ul className="mt-3 space-y-1.5 text-sm">
          {rows.map((row) => (
            <li key={row.id} className="flex flex-wrap items-baseline justify-between gap-2">
              <Link
                href={`/cash-advances/${row.id}`}
                className="tabular text-blue-600 underline underline-offset-2"
              >
                {row.number}
              </Link>
              <span className="text-xs text-text-muted capitalize">
                {row.status.replace(/_/g, " ")} · {row.standing.message}
              </span>
            </li>
          ))}
        </ul>
      )}

      {canRequest && !showForm && (
        <Button variant="secondary" size="sm" className="mt-3" onClick={() => setShowForm(true)}>
          Request an advance
        </Button>
      )}

      {showForm && (
        <RequestForm
          ticketId={ticketId}
          onDone={() => {
            setShowForm(false);
            refresh();
          }}
          onCancel={() => setShowForm(false)}
        />
      )}

      {data.blocks && canOverride && <OverrideBlock ticketId={ticketId} onDone={refresh} />}
    </Card>
  );
}

/**
 * §5's request: a purpose, a breakdown by category, who it covers, and when it is needed.
 *
 * The eligibility query runs before the form is usable, so somebody with an overdue liquidation is
 * told why they cannot ask *before* filling in a breakdown rather than after submitting it.
 */
function RequestForm({
  ticketId,
  onDone,
  onCancel,
}: {
  ticketId: string;
  onDone: () => void;
  onCancel: () => void;
}) {
  const eligibility = trpc.operations.cashAdvanceEligibility.useQuery();
  const [purpose, setPurpose] = useState("");
  const [neededBy, setNeededBy] = useState("");
  const [lines, setLines] = useState<BreakdownRow[]>([
    { category: "transport", description: "", amount: null },
  ]);
  const request = trpc.operations.requestCashAdvance.useMutation({ onSuccess: onDone });

  const total = lines.reduce((sum, line) => sum + (line.amount ?? 0), 0);

  if (eligibility.data && !eligibility.data.allowed) {
    return (
      <div className="mt-3 rounded-md border border-amber-300 bg-amber-50 p-3 text-sm text-amber-900">
        {eligibility.data.message}
      </div>
    );
  }

  return (
    <div className="mt-3 space-y-3 rounded-md border border-border p-3">
      <div className="grid gap-3 sm:grid-cols-2">
        <div>
          <Label htmlFor="ca-purpose">What it is for</Label>
          <Textarea
            id="ca-purpose"
            rows={2}
            value={purpose}
            onChange={(e) => setPurpose(e.target.value)}
          />
        </div>
        <div>
          <Label htmlFor="ca-needed">Needed by</Label>
          <Input
            id="ca-needed"
            type="date"
            value={neededBy}
            onChange={(e) => setNeededBy(e.target.value)}
          />
          <p className="mt-1 text-xs text-text-muted">
            When the crew needs it in hand — not when they leave.
          </p>
        </div>
      </div>

      <div className="space-y-2">
        {lines.map((line, index) => (
          <div key={index} className="grid gap-2 sm:grid-cols-[9rem_1fr_9rem]">
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
              aria-label="Detail"
              placeholder="Detail"
              value={line.description}
              onChange={(e) => update(index, { description: e.target.value })}
            />
            <MoneyInput
              aria-label="Amount"
              value={line.amount}
              onValueChange={(value) => update(index, { amount: value })}
            />
          </div>
        ))}
      </div>

      <div className="flex flex-wrap items-center justify-between gap-2">
        <Button
          variant="ghost"
          size="sm"
          onClick={() => setLines([...lines, { category: "meals", description: "", amount: null }])}
        >
          Add a category
        </Button>
        <p className="tabular text-sm font-medium">₱{total.toFixed(2)}</p>
      </div>

      {request.error && <p className="text-sm text-danger">{request.error.message}</p>}

      <div className="flex gap-2">
        <Button
          size="sm"
          disabled={request.isPending || total <= 0 || purpose.trim().length < 3 || !neededBy}
          onClick={() =>
            request.mutate({
              ticketId,
              requestedFor: [],
              purpose,
              breakdown: lines
                .filter((line) => (line.amount ?? 0) > 0)
                .map((line) => ({
                  category: line.category as CashAdvanceCategory,
                  description: line.description,
                  amount: Math.round((line.amount ?? 0) * 100),
                })),
              neededBy: new Date(neededBy),
              submit: true,
            })
          }
        >
          Send to the Vice President
        </Button>
        <Button variant="ghost" size="sm" onClick={onCancel}>
          Cancel
        </Button>
      </div>
      <p className="text-xs text-text-muted">
        Escalates to the President after four working hours — the shortest window in the system,
        because a crew is standing by.
      </p>
    </div>
  );

  function update(index: number, patch: Partial<BreakdownRow>) {
    setLines(lines.map((line, i) => (i === index ? { ...line, ...patch } : line)));
  }
}

/** §19's `operations.override_ca_gate`. The reason is the whole point of having it. */
function OverrideBlock({ ticketId, onDone }: { ticketId: string; onDone: () => void }) {
  const [open, setOpen] = useState(false);
  const [reason, setReason] = useState("");
  const override = trpc.operations.overrideCashAdvanceGate.useMutation({
    onSuccess: () => {
      setOpen(false);
      setReason("");
      onDone();
    },
  });

  if (!open) {
    return (
      <Button variant="ghost" size="sm" className="mt-3" onClick={() => setOpen(true)}>
        Mobilise anyway
      </Button>
    );
  }

  return (
    <div className="mt-3 rounded-md border border-amber-300 bg-amber-50 p-3">
      <p className="text-sm text-amber-900">
        This sends a crew to site without money in hand. Say why — an officer will read this later.
      </p>
      <Textarea
        className="mt-2"
        rows={2}
        value={reason}
        onChange={(e) => setReason(e.target.value)}
      />
      {override.error && <p className="mt-2 text-sm text-danger">{override.error.message}</p>}
      <div className="mt-2 flex gap-2">
        <Button
          size="sm"
          variant="destructive"
          disabled={override.isPending || reason.trim().length < 10}
          onClick={() => override.mutate({ ticketId, reason })}
        >
          Override the gate
        </Button>
        <Button variant="ghost" size="sm" onClick={() => setOpen(false)}>
          Cancel
        </Button>
      </div>
    </div>
  );
}
