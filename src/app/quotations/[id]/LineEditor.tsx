"use client";

import { useMemo, useState } from "react";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/layout";
import { Input, Label, Select, Textarea } from "@/components/ui/input";
import { StatusBadge } from "@/components/ui/status-badge";
import {
  computeCosting,
  fromCentavos,
  VAT_MODES,
  type VatMode,
} from "@/server/core/quotation/costing";
import { formatMoney } from "@/lib/format";
import { toastError, toastSuccess } from "@/lib/errors";
import { trpc } from "@/lib/trpc/client";

export interface DraftLine {
  groupLabel: string;
  description: string;
  quantity: string;
  unit: string;
  /**
   * The **supplier's raw figure**, in `costCurrency` — not the cost to AIES after conversion.
   *
   * Carried with its currency and rate so a save round-trips them unchanged. Dropping them here
   * would silently reset every line's rate to 1 on the next save, which for a EUR-priced line means
   * recording a cost sixty-five times too low. docs/DECISIONS.md #32.
   */
  unitCost: string;
  costCurrency: string;
  costFxRate: string;
  /** Blank means "use the quotation's". A typed 0 is a real answer and is kept. */
  fxBufferPct: string;
  markupPct: string;
  unitPrice: string;
  lineDiscountPct: string;
  isOptional: boolean;
}

export const BLANK_LINE: DraftLine = {
  groupLabel: "",
  description: "",
  quantity: "1",
  unit: "pc",
  unitCost: "",
  costCurrency: "PHP",
  costFxRate: "1",
  fxBufferPct: "",
  markupPct: "",
  unitPrice: "",
  lineDiscountPct: "",
  isOptional: false,
};

/**
 * The quote builder (specs/02-quotation.md §4).
 *
 * Totals recompute in the browser through the **same** `computeCosting` the server stores with, so
 * the figure moving under the user's cursor is the figure that will be saved. A builder that
 * approximates and then disagrees with the record is worse than one that shows nothing.
 *
 * **The cost columns only exist for a caller with `finance.view_cost`.** For everybody else the
 * server never sent them, so there is nothing to render and nothing to post back — the service
 * carries the stored costs across by line number instead. That is why this component does not offer
 * reordering to a cost-blind user: line number is the only handle the carry-over has.
 */
export function LineEditor({
  quotationId,
  version,
  currency,
  canSeeCost,
  editable,
  initialLines,
  initialDiscount,
  initialVatMode,
  initialFxBuffer,
  onSaved,
}: {
  quotationId: string;
  version: number;
  currency: string;
  canSeeCost: boolean;
  editable: boolean;
  initialLines: DraftLine[];
  initialDiscount: string;
  initialVatMode: VatMode;
  initialFxBuffer: string;
  onSaved: () => void;
}) {
  const [lines, setLines] = useState<DraftLine[]>(
    initialLines.length > 0 ? initialLines : [{ ...BLANK_LINE }],
  );
  const [headerDiscount, setHeaderDiscount] = useState(initialDiscount);
  const [vatMode, setVatMode] = useState<VatMode>(initialVatMode);
  const [fxBufferPct, setFxBufferPct] = useState(initialFxBuffer);

  const save = trpc.quotation.saveLines.useMutation();

  /**
   * Live totals.
   *
   * When the caller cannot see cost, the cost inputs are empty strings and the engine reads them as
   * zero — so the *prices* and the total are right, and the margin is meaningless. That is exactly
   * why the margin panel is not rendered in that case: showing a computed 100% would be worse than
   * showing nothing, and the real figures are on the server where they belong.
   */
  const costing = useMemo(
    () =>
      computeCosting({
        lines: lines.map((line) => ({
          quantity: line.quantity || "0",
          unitCost: line.unitCost || "0",
          costCurrency: line.costCurrency || "PHP",
          costFxRate: line.costFxRate || "1",
          fxBufferPct: line.fxBufferPct ?? "",
          markupPct: line.markupPct === "" ? null : line.markupPct,
          unitPrice: line.unitPrice || "0",
          lineDiscountPct: line.lineDiscountPct === "" ? null : line.lineDiscountPct,
          isOptional: line.isOptional,
        })),
        headerDiscount: headerDiscount || "0",
        vatMode,
        fxBufferPct: fxBufferPct || "0",
      }),
    [lines, headerDiscount, vatMode, fxBufferPct],
  );

  const update = (index: number, patch: Partial<DraftLine>) =>
    setLines((current) => current.map((line, i) => (i === index ? { ...line, ...patch } : line)));

  return (
    <Card className="p-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h2 className="text-sm font-semibold">Lines</h2>
        {!editable && <StatusBadge tone="draft">Read-only — revise to change it</StatusBadge>}
      </div>

      <div className="mt-3 overflow-x-auto">
        <table className="w-full min-w-[48rem] text-sm">
          <thead>
            <tr className="border-b border-border text-left text-xs text-text-muted">
              <th className="py-1 font-medium">Group</th>
              <th className="py-1 font-medium">Description</th>
              <th className="py-1 text-right font-medium">Qty</th>
              {canSeeCost && <th className="py-1 text-right font-medium">Unit cost</th>}
              {canSeeCost && (
                <th className="py-1 text-right font-medium" title="Blank uses the quotation's">
                  FX buff %
                </th>
              )}
              {canSeeCost && <th className="py-1 text-right font-medium">Markup %</th>}
              <th className="py-1 text-right font-medium">Unit price</th>
              <th className="py-1 text-right font-medium">Disc %</th>
              <th className="py-1 text-right font-medium">Total</th>
              <th className="py-1 text-center font-medium">Opt.</th>
              <th className="py-1" />
            </tr>
          </thead>
          <tbody>
            {lines.map((line, index) => {
              const computed = costing.lines[index];
              const belowFloor = costing.linesBelowFloor.includes(index);
              return (
                <tr key={index} className="border-b border-border last:border-0">
                  <td className="py-1 pr-2">
                    <Input
                      aria-label={`Line ${index + 1} group`}
                      className="w-24"
                      value={line.groupLabel}
                      disabled={!editable}
                      onChange={(e) => update(index, { groupLabel: e.target.value })}
                    />
                  </td>
                  <td className="min-w-[18rem] py-1 pr-2">
                    {/*
                      A textarea rather than a single-line input: a quotation line often carries
                      several entries — a pump with its seal kit and its coupling — and a field that
                      shows twelve characters at a time is one people write badly in.
                    */}
                    <Textarea
                      aria-label={`Line ${index + 1} description`}
                      rows={2}
                      className="min-h-[3.25rem] w-full"
                      value={line.description}
                      disabled={!editable}
                      onChange={(e) => update(index, { description: e.target.value })}
                    />
                  </td>
                  <td className="py-1 pr-2">
                    <Input
                      aria-label={`Line ${index + 1} quantity`}
                      className="w-16 text-right"
                      inputMode="decimal"
                      value={line.quantity}
                      disabled={!editable}
                      onChange={(e) => update(index, { quantity: e.target.value })}
                    />
                  </td>
                  {canSeeCost && (
                    <td className="py-1 pr-2">
                      <Input
                        aria-label={`Line ${index + 1} unit cost`}
                        className="w-24 text-right"
                        inputMode="decimal"
                        value={line.unitCost}
                        disabled={!editable}
                        onChange={(e) => update(index, { unitCost: e.target.value })}
                      />
                    </td>
                  )}
                  {canSeeCost && (
                    <td className="py-1 pr-2">
                      {/*
                        This line's own cushion. Blank inherits the quotation's, which is the common
                        case; a figure here is for the line whose exposure differs — and 0 on a
                        peso-sourced line is the point of the whole field, since a cushion for
                        exchange risk that does not exist only inflates cost and hides margin.
                      */}
                      <Input
                        aria-label={`Line ${index + 1} FX buffer`}
                        className="w-20 text-right"
                        inputMode="decimal"
                        placeholder={fxBufferPct || "0"}
                        value={line.fxBufferPct}
                        disabled={!editable}
                        onChange={(e) => update(index, { fxBufferPct: e.target.value })}
                      />
                    </td>
                  )}
                  {canSeeCost && (
                    <td className="py-1 pr-2">
                      {/* §4's two pricing modes. Typing a markup derives the price; clearing it
                          hands control back to the price field, and the margin becomes implied. */}
                      <Input
                        aria-label={`Line ${index + 1} markup`}
                        className="w-20 text-right"
                        inputMode="decimal"
                        value={line.markupPct}
                        disabled={!editable}
                        onChange={(e) => update(index, { markupPct: e.target.value })}
                      />
                    </td>
                  )}
                  <td className="py-1 pr-2">
                    <Input
                      aria-label={`Line ${index + 1} unit price`}
                      className="w-24 text-right"
                      inputMode="decimal"
                      // Derived and read-only while a markup is set, so the two cannot disagree.
                      value={
                        line.markupPct !== "" && computed
                          ? fromCentavos(computed.unitPrice)
                          : line.unitPrice
                      }
                      disabled={!editable || line.markupPct !== ""}
                      onChange={(e) => update(index, { unitPrice: e.target.value })}
                    />
                  </td>
                  <td className="py-1 pr-2">
                    <Input
                      aria-label={`Line ${index + 1} discount`}
                      className="w-16 text-right"
                      inputMode="decimal"
                      value={line.lineDiscountPct}
                      disabled={!editable}
                      onChange={(e) => update(index, { lineDiscountPct: e.target.value })}
                    />
                  </td>
                  <td className="tabular py-1 pr-2 text-right">
                    <span className={belowFloor ? "text-warning" : undefined}>
                      {computed ? formatMoney(fromCentavos(computed.lineTotal), currency) : "—"}
                    </span>
                  </td>
                  <td className="py-1 text-center">
                    <input
                      type="checkbox"
                      aria-label={`Line ${index + 1} optional`}
                      checked={line.isOptional}
                      disabled={!editable}
                      onChange={(e) => update(index, { isOptional: e.target.checked })}
                    />
                  </td>
                  <td className="py-1 text-right">
                    {editable && lines.length > 1 && (
                      <Button
                        variant="ghost"
                        size="sm"
                        onClick={() => setLines((c) => c.filter((_, i) => i !== index))}
                      >
                        ×
                      </Button>
                    )}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>

      {editable && (
        <Button
          variant="ghost"
          size="sm"
          className="mt-2"
          onClick={() => setLines((current) => [...current, { ...BLANK_LINE }])}
        >
          Add line
        </Button>
      )}

      <div className="mt-4 grid gap-3 border-t border-border pt-3 sm:grid-cols-3">
        <div>
          <Label htmlFor="q-discount">Header discount</Label>
          <Input
            id="q-discount"
            inputMode="decimal"
            value={headerDiscount}
            disabled={!editable}
            onChange={(e) => setHeaderDiscount(e.target.value)}
          />
        </div>
        <div>
          <Label htmlFor="q-vat">VAT</Label>
          <Select
            id="q-vat"
            value={vatMode}
            disabled={!editable}
            onChange={(e) => setVatMode(e.target.value as VatMode)}
          >
            {VAT_MODES.map((mode) => (
              <option key={mode} value={mode}>
                {mode.replace(/_/g, " ")}
              </option>
            ))}
          </Select>
        </div>
        {canSeeCost && (
          <div>
            <Label htmlFor="q-buffer">FX buffer %</Label>
            <Input
              id="q-buffer"
              inputMode="decimal"
              value={fxBufferPct}
              disabled={!editable}
              onChange={(e) => setFxBufferPct(e.target.value)}
            />
            {/* §4: "Show the buffer explicitly — it is a margin decision, not a hidden fudge." */}
            <p className="mt-0.5 text-xs text-text-muted">
              Applied on top of each line&apos;s rate.
            </p>
          </div>
        )}
      </div>

      <dl className="mt-3 ml-auto max-w-xs space-y-1 text-sm">
        <Row label="Subtotal" value={formatMoney(fromCentavos(costing.subtotal), currency)} />
        {costing.discountAmount > 0 && (
          <Row
            label="Discount"
            value={`− ${formatMoney(fromCentavos(costing.discountAmount), currency)}`}
          />
        )}
        {costing.vatAmount > 0 && (
          <Row label="VAT" value={formatMoney(fromCentavos(costing.vatAmount), currency)} />
        )}
        <Row label="Total" value={formatMoney(fromCentavos(costing.total), currency)} emphasis />
      </dl>

      {editable && (
        <div className="mt-4 flex justify-end">
          <Button
            disabled={save.isPending}
            onClick={async () => {
              try {
                await save.mutateAsync({
                  quotationId,
                  version,
                  lines: lines
                    .filter((line) => line.description.trim().length > 0)
                    .map((line) => ({
                      groupLabel: line.groupLabel || null,
                      description: line.description,
                      quantity: line.quantity || "1",
                      unit: line.unit || "pc",
                      // Omitted entirely when the caller cannot see cost, so the service's
                      // carry-over is the only thing that decides them.
                      ...(canSeeCost
                        ? {
                            unitCost: line.unitCost || "0",
                            // Round-tripped unchanged. The builder does not edit these yet, but
                            // dropping them would reset an imported supplier line's rate to 1 —
                            // a EUR cost recorded sixty-five times too low. docs/DECISIONS.md #32.
                            costCurrency: line.costCurrency || "PHP",
                            costFxRate: line.costFxRate || "1",
                            // Blank means "inherit the header's". A typed 0 must survive — a peso
                            // line deliberately carrying no cushion is an answer, and sending null
                            // would silently reapply a cushion for risk it does not have.
                            fxBufferPct: line.fxBufferPct === "" ? null : line.fxBufferPct,
                            markupPct: line.markupPct === "" ? null : line.markupPct,
                          }
                        : {}),
                      unitPrice: line.unitPrice === "" ? null : line.unitPrice,
                      lineDiscountPct: line.lineDiscountPct === "" ? null : line.lineDiscountPct,
                      isOptional: line.isOptional,
                    })),
                  headerDiscount: headerDiscount || "0",
                  vatMode,
                  ...(canSeeCost ? { fxBufferPct: fxBufferPct || "0" } : {}),
                });
                toastSuccess("Saved.");
                onSaved();
              } catch (error) {
                // A CONFLICT means somebody else saved while this was open. The server's message
                // says so; retrying would be the silent overwrite §12 exists to prevent.
                toastError(error);
              }
            }}
          >
            {save.isPending ? "Saving…" : "Save lines"}
          </Button>
        </div>
      )}
    </Card>
  );
}

function Row({ label, value, emphasis }: { label: string; value: string; emphasis?: boolean }) {
  return (
    <div className={`flex justify-between gap-4 ${emphasis ? "border-t border-border pt-1" : ""}`}>
      <dt className={emphasis ? "font-medium" : "text-text-muted"}>{label}</dt>
      <dd className={`tabular ${emphasis ? "font-semibold" : ""}`}>{value}</dd>
    </div>
  );
}
