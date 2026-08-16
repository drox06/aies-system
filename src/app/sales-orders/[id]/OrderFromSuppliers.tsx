"use client";

import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/layout";
import { Input, Label, Select } from "@/components/ui/input";
import { StatusBadge } from "@/components/ui/status-badge";
import { toastError, toastSuccess } from "@/lib/errors";
import { trpc } from "@/lib/trpc/client";

/**
 * §5: "Created from a sales order: select lines → group by supplier → generate draft POs."
 *
 * The grouping is the point. One order routinely sources the meter from Germany, the valves locally
 * and the freight from a forwarder, so the screen lets a buyer assign a supplier **per line** and
 * then raises one PO per distinct supplier in a single pass. Making somebody repeat the exercise
 * once per vendor is how the third line gets forgotten.
 *
 * The stale-cost warning sits above the table rather than beside a line, because §5 asks for it
 * "prominently" and the consequence is not about one line: "the margin in the sales order was based
 * on a stale cost."
 */
export function OrderFromSuppliers({
  salesOrderId,
  lines,
  onOrdered,
}: {
  salesOrderId: string;
  lines: {
    id: string;
    lineNo: number;
    description: string;
    quantity: string;
    unitCost: string | null;
  }[];
  onOrdered: () => void;
}) {
  const utils = trpc.useUtils();
  const [assignments, setAssignments] = useState<Record<string, string>>({});
  const [expectedArrival, setExpectedArrival] = useState("");

  const suppliers = trpc.order.listSuppliers.useQuery({}, { retry: false });
  const stale = trpc.order.staleCostsForSalesOrder.useQuery({ salesOrderId }, { retry: false });
  const create = trpc.order.createSupplierPos.useMutation();

  // Permission-gated on the server; the whole panel disappears rather than erroring for anybody
  // without `supplier_po.create`.
  if (suppliers.error || stale.error) return null;

  const chosen = Object.entries(assignments).filter(([, supplierId]) => supplierId !== "");
  const distinctSuppliers = new Set(chosen.map(([, supplierId]) => supplierId)).size;

  async function submit() {
    try {
      const created = await create.mutateAsync({
        salesOrderId,
        lines: chosen.map(([salesOrderLineId, supplierId]) => ({ salesOrderLineId, supplierId })),
        expectedArrivalDate: expectedArrival ? new Date(expectedArrival) : null,
      });
      toastSuccess(
        created.length === 1
          ? `${created[0]!.number} drafted to ${created[0]!.supplierName}.`
          : `${created.length} draft POs raised, one per supplier.`,
      );
      setAssignments({});
      void utils.order.listSupplierPos.invalidate();
      onOrdered();
    } catch (error) {
      toastError(error);
    }
  }

  return (
    <Card className="p-4">
      <h2 className="text-sm font-semibold">Order from suppliers</h2>
      <p className="mt-1 text-xs text-text-muted">
        Choose who supplies each line. One draft PO is raised per supplier.
      </p>

      {(stale.data ?? []).length > 0 && (
        <div className="mt-3 rounded-md border border-amber-300 bg-amber-50 p-2.5 text-xs text-amber-900">
          <p className="font-medium">Some costs came from supplier quotes that have expired.</p>
          <ul className="mt-1 space-y-0.5">
            {(stale.data ?? []).map((row) => (
              <li key={row.salesOrderLineId}>
                Line {row.lineNo} — {row.description}: {row.supplierName}&rsquo;s price on{" "}
                {row.rfqNumber} lapsed on {new Date(row.validUntil).toISOString().slice(0, 10)}.
              </li>
            ))}
          </ul>
          <p className="mt-1">
            The margin on this order was worked out from those costs. Re-check the price before
            committing.
          </p>
        </div>
      )}

      <div className="mt-3 space-y-1.5">
        {lines.map((line) => (
          <div key={line.id} className="flex flex-wrap items-center gap-2">
            <span className="tabular w-6 text-right text-xs text-text-muted">{line.lineNo}</span>
            <span className="min-w-0 flex-1 truncate text-sm">{line.description}</span>
            <span className="text-xs text-text-muted">{line.quantity}</span>
            <Select
              aria-label={`Supplier for line ${line.lineNo}`}
              className="w-56"
              value={assignments[line.id] ?? ""}
              onChange={(e) =>
                setAssignments((current) => ({ ...current, [line.id]: e.target.value }))
              }
            >
              <option value="">Not ordering this line</option>
              {(suppliers.data ?? []).map((supplier) => (
                <option key={supplier.id} value={supplier.id}>
                  {supplier.name}
                  {supplier.isApproved ? "" : " (not approved)"}
                </option>
              ))}
            </Select>
          </div>
        ))}
      </div>

      <div className="mt-3 flex flex-wrap items-end gap-3">
        <div className="max-w-xs">
          <Label htmlFor="so-arrival">Wanted here by</Label>
          <Input
            id="so-arrival"
            type="date"
            value={expectedArrival}
            onChange={(e) => setExpectedArrival(e.target.value)}
          />
        </div>
        <Button onClick={() => void submit()} disabled={create.isPending || chosen.length === 0}>
          {create.isPending
            ? "Raising…"
            : distinctSuppliers > 1
              ? `Raise ${distinctSuppliers} draft POs`
              : "Raise draft PO"}
        </Button>
        {chosen.length > 0 && (
          <StatusBadge tone="info">
            {chosen.length} line(s) to {distinctSuppliers} supplier(s)
          </StatusBadge>
        )}
      </div>

      <p className="mt-2 text-xs text-text-muted">
        A draft commits nothing. The Vice President approves it, and both gates — the
        customer&rsquo;s downpayment and the supplier&rsquo;s clause 8.4 approval — are checked when
        it is sent.
      </p>
    </Card>
  );
}
