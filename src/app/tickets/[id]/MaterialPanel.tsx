"use client";

import { useState } from "react";
import Link from "next/link";
import { Button } from "@/components/ui/button";
import { DateCell } from "@/components/ui/cells";
import { Input, Label, Select } from "@/components/ui/input";
import { Card } from "@/components/ui/layout";
import { StatusBadge, type StatusTone } from "@/components/ui/status-badge";
import {
  ITEM_TYPES,
  ITEM_TYPE_LABELS,
  SOURCES,
  SOURCE_LABELS,
  type ItemType,
  type Source,
} from "@/server/core/operations/material-request-rules";
import { trpc } from "@/lib/trpc/client";

/**
 * §1's Gate 2 on the ticket — the flowchart's Y / N/A / N diamond.
 *
 * All three answers are offered here, because §7 insists all three are real and that the middle one
 * is a decision rather than an omission: "`N/A` is a legitimate, recorded answer — **not a skipped
 * step**. The record shows someone decided."
 *
 * So an unanswered ticket says so and blocks, rather than quietly reading as "nothing needed". A
 * gate that waves through the case nobody has looked at prevents exactly nothing.
 */

const GATE_TONE: Record<string, StatusTone> = {
  undecided: "pending",
  not_required: "draft",
  satisfied: "approved",
  blocked: "failed",
};

export function MaterialPanel({
  ticketId,
  projectId,
  methodologyId,
}: {
  ticketId: string;
  projectId: string | null;
  /** When a method statement exists, its tools and materials seed the request (§6.2). */
  methodologyId: string | null;
}) {
  const gate = trpc.operations.materialGate.useQuery({ ticketId });
  const me = trpc.system.whoami.useQuery(undefined, { retry: false });
  const [showForm, setShowForm] = useState(false);

  const permissions = me.data?.permissions ?? [];
  const canRaise = permissions.includes("material_request.raise");

  const markNa = trpc.operations.markMaterialsNotApplicable.useMutation({
    onSuccess: () => void gate.refetch(),
  });

  if (gate.isPending) return null;
  if (gate.error) {
    return (
      <Card className="p-4">
        <p className="text-sm">{gate.error.message}</p>
      </Card>
    );
  }

  const data = gate.data;

  return (
    <Card className="p-4">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <h2 className="text-sm font-semibold">Materials</h2>
        <StatusBadge tone={GATE_TONE[data.state] ?? "draft"}>
          {data.state === "not_required"
            ? "Not needed"
            : data.state === "satisfied"
              ? "Issued"
              : data.state === "undecided"
                ? "Unanswered"
                : "Mobilisation blocked"}
        </StatusBadge>
      </div>

      <p className="mt-1 text-sm text-text-muted">{data.message}</p>

      {data.requests.length > 0 && (
        <ul className="mt-2 space-y-1.5 text-sm">
          {data.requests.map((request) => (
            <li key={request.id} className="flex flex-wrap items-baseline justify-between gap-2">
              <Link
                href={`/material-requests/${request.id}`}
                className="tabular text-blue-600 underline underline-offset-2"
              >
                {request.number}
              </Link>
              <span className="text-xs text-text-muted capitalize">
                {request.status.replace(/_/g, " ")}
              </span>
            </li>
          ))}
        </ul>
      )}

      {canRaise && data.state === "undecided" && !showForm && (
        <div className="mt-3 flex flex-wrap gap-2">
          <Button variant="secondary" size="sm" onClick={() => setShowForm(true)}>
            Raise a material request
          </Button>
          {/* The N/A answer, offered as plainly as the Y answer — it is a decision, not a skip. */}
          <Button
            variant="ghost"
            size="sm"
            disabled={markNa.isPending}
            onClick={() => markNa.mutate({ ticketId })}
          >
            This ticket needs no materials
          </Button>
        </div>
      )}

      {markNa.error && <p className="mt-2 text-sm text-danger">{markNa.error.message}</p>}

      {showForm && (
        <RequestForm
          ticketId={ticketId}
          projectId={projectId}
          methodologyId={methodologyId}
          onDone={() => {
            setShowForm(false);
            void gate.refetch();
          }}
          onCancel={() => setShowForm(false)}
        />
      )}
    </Card>
  );
}

function RequestForm({
  ticketId,
  projectId,
  methodologyId,
  onDone,
  onCancel,
}: {
  ticketId: string;
  projectId: string | null;
  methodologyId: string | null;
  onDone: () => void;
  onCancel: () => void;
}) {
  const [neededBy, setNeededBy] = useState("");
  const [seedFromMethod, setSeedFromMethod] = useState(!!methodologyId);
  const [lines, setLines] = useState<
    { itemType: ItemType; description: string; quantity: number; unit: string; source: Source }[]
  >([{ itemType: "consumable", description: "", quantity: 1, unit: "pc", source: "stock" }]);

  const stock = trpc.operations.listStock.useQuery({});
  const create = trpc.operations.createMaterialRequest.useMutation({ onSuccess: onDone });

  return (
    <div className="mt-3 space-y-3 rounded-md border border-border p-3">
      {methodologyId && (
        <label className="flex items-start gap-2 text-sm">
          <input
            type="checkbox"
            className="mt-1"
            checked={seedFromMethod}
            onChange={(e) => setSeedFromMethod(e.target.checked)}
          />
          <span>
            Start from the method statement
            <span className="mt-0.5 block text-xs text-text-muted">
              {/* §6.2: "Nobody should type the same list twice." */}
              Its tools and materials come across as lines. Correct them here rather than typing the
              same list a second time.
            </span>
          </span>
        </label>
      )}

      <div>
        <Label htmlFor="mr-needed">Needed by</Label>
        <Input
          id="mr-needed"
          type="date"
          value={neededBy}
          onChange={(e) => setNeededBy(e.target.value)}
        />
      </div>

      <div className="space-y-2">
        {lines.map((line, index) => (
          <div key={index} className="grid gap-2 sm:grid-cols-[8rem_1fr_5rem_5rem_9rem]">
            <Select
              aria-label="Type"
              value={line.itemType}
              onChange={(e) => update(index, { itemType: e.target.value as ItemType })}
            >
              {ITEM_TYPES.map((type) => (
                <option key={type} value={type}>
                  {ITEM_TYPE_LABELS[type]}
                </option>
              ))}
            </Select>
            <Input
              aria-label="What"
              placeholder="DN100 gasket set"
              value={line.description}
              onChange={(e) => update(index, { description: e.target.value })}
            />
            <Input
              aria-label="Quantity"
              type="number"
              min={0}
              step="any"
              value={line.quantity}
              onChange={(e) => update(index, { quantity: Number(e.target.value) })}
            />
            <Input
              aria-label="Unit"
              value={line.unit}
              onChange={(e) => update(index, { unit: e.target.value })}
            />
            <Select
              aria-label="Source"
              value={line.source}
              onChange={(e) => update(index, { source: e.target.value as Source })}
            >
              {SOURCES.map((source) => (
                <option key={source} value={source}>
                  {SOURCE_LABELS[source]}
                </option>
              ))}
            </Select>
          </div>
        ))}
      </div>

      <div className="flex flex-wrap items-center justify-between gap-2">
        <Button
          variant="ghost"
          size="sm"
          onClick={() =>
            setLines([
              ...lines,
              { itemType: "consumable", description: "", quantity: 1, unit: "pc", source: "stock" },
            ])
          }
        >
          Add a line
        </Button>
        <p className="text-xs text-text-muted">
          {/* §7's fan-out, said before somebody picks the source rather than after. */}
          Anything marked <strong>needs buying</strong> goes to procurement, and the ticket waits on
          it.
        </p>
      </div>

      {stock.data && stock.data.length === 0 && (
        <p className="text-xs text-text-muted">
          The store has no items yet. Lines can still be raised — add stock under Store when there
          is any to draw against.
        </p>
      )}

      {create.error && <p className="text-sm text-danger">{create.error.message}</p>}

      <div className="flex gap-2">
        <Button
          size="sm"
          disabled={
            create.isPending ||
            (!seedFromMethod && lines.every((line) => line.description.trim() === ""))
          }
          onClick={() =>
            create.mutate({
              ticketId,
              projectId,
              neededBy: neededBy ? new Date(neededBy) : null,
              fromMethodologyId: seedFromMethod ? methodologyId : null,
              lines: lines.filter((line) => line.description.trim()),
            })
          }
        >
          Raise it
        </Button>
        <Button variant="ghost" size="sm" onClick={onCancel}>
          Cancel
        </Button>
      </div>
    </div>
  );

  function update(
    index: number,
    patch: Partial<{
      itemType: ItemType;
      description: string;
      quantity: number;
      unit: string;
      source: Source;
    }>,
  ) {
    setLines(lines.map((line, i) => (i === index ? { ...line, ...patch } : line)));
  }
}

/** Shown on the store screen; exported here so the tone map has one home. */
export function MaterialDueCell({ value }: { value: Date | string | null }) {
  if (!value) return <span className="text-xs text-text-muted">—</span>;
  return <DateCell value={value} />;
}
