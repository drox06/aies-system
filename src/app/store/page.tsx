"use client";

import { useState } from "react";
import Link from "next/link";
import { Button } from "@/components/ui/button";
import { DateCell } from "@/components/ui/cells";
import { Input, Label } from "@/components/ui/input";
import { Card, EmptyState, PageHeader } from "@/components/ui/layout";
import { StatusBadge } from "@/components/ui/status-badge";
import { toastError, toastSuccess } from "@/lib/errors";
import { trpc } from "@/lib/trpc/client";

/**
 * §7's store: what is on the shelf, and what is out with somebody.
 *
 * The custody tab is the reason this screen exists rather than the stock tab. §7: "Unreturned tools
 * appear on an outstanding-custody list per technician. **Tools disappear otherwise; this is
 * universal.**" A stock count nobody chases is a number; a list of who has what is a conversation.
 *
 * There is deliberately no value anywhere on this page. §7: "Track quantity and custody, not
 * weighted-average cost." A cost column here would invite somebody to total it.
 */

const TABS = [
  { key: "custody", label: "Out with somebody", hint: "Tools and instruments not yet returned" },
  { key: "stock", label: "On the shelf", hint: "What the store holds" },
] as const;

type Tab = (typeof TABS)[number]["key"];

export default function StorePage() {
  const [tab, setTab] = useState<Tab>("custody");

  return (
    <div className="mx-auto max-w-7xl">
      <PageHeader
        title="Store"
        description="What is on the shelf, and what is out with somebody."
      />

      <div className="mb-4 flex flex-wrap gap-2">
        {TABS.map((entry) => (
          <button
            key={entry.key}
            type="button"
            title={entry.hint}
            onClick={() => setTab(entry.key)}
            className={
              tab === entry.key
                ? "rounded-md border border-blue-600 bg-blue-600 px-3 py-1.5 text-sm font-medium text-text-invert"
                : "rounded-md border border-border bg-surface px-3 py-1.5 text-sm hover:bg-surface-2"
            }
          >
            {entry.label}
          </button>
        ))}
      </div>

      {tab === "custody" ? <Custody /> : <Stock />}
    </div>
  );
}

function Custody() {
  const query = trpc.operations.outstandingCustody.useQuery();
  const rows = query.data ?? [];

  if (query.isPending) return <p className="text-sm text-text-muted">Loading…</p>;
  if (query.error) {
    return (
      <Card className="p-4">
        <p className="text-sm">{query.error.message}</p>
      </Card>
    );
  }

  if (rows.length === 0) {
    return (
      <EmptyState
        title="Nothing is out"
        description="Every tool and instrument issued has been returned or written off as consumed."
      />
    );
  }

  return (
    <Card className="overflow-x-auto p-0">
      <table className="w-full text-sm">
        <thead className="border-b border-border bg-surface-muted text-left">
          <tr>
            <Th>What</Th>
            <Th>Against</Th>
            <Th className="text-right">Still out</Th>
            <Th>Due back</Th>
          </tr>
        </thead>
        <tbody>
          {rows.map((row, index) => (
            <tr key={`${row.requestId}-${index}`} className="border-b border-border last:border-0">
              <td className="px-3 py-2">
                {row.description}
                <p className="text-xs text-text-muted capitalize">
                  {row.itemType.replace(/_/g, " ")}
                </p>
              </td>
              <td className="px-3 py-2">
                <Link
                  href={`/material-requests/${row.requestId}`}
                  className="tabular text-blue-600 underline underline-offset-2"
                >
                  {row.number}
                </Link>
                <p className="tabular text-xs text-text-muted">{row.ticket.number}</p>
              </td>
              <td className="tabular px-3 py-2 text-right font-medium">{row.outstanding}</td>
              <td className="px-3 py-2">
                {row.returnDueAt ? (
                  new Date(row.returnDueAt).getTime() < Date.now() ? (
                    <span className="text-xs font-medium text-amber-800">
                      overdue — <DateCell value={row.returnDueAt} />
                    </span>
                  ) : (
                    <DateCell value={row.returnDueAt} />
                  )
                ) : (
                  <span className="text-xs text-text-muted">no date</span>
                )}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </Card>
  );
}

function Stock() {
  const [search, setSearch] = useState("");
  const [showForm, setShowForm] = useState(false);
  const query = trpc.operations.listStock.useQuery({ search: search || undefined });
  const me = trpc.system.whoami.useQuery(undefined, { retry: false });
  const canManage = (me.data?.permissions ?? []).includes("material_request.issue");

  const rows = query.data ?? [];

  return (
    <>
      <div className="mb-3 flex flex-wrap items-end gap-2">
        <div className="grow sm:max-w-xs">
          <Label htmlFor="stock-search">Search</Label>
          <Input
            id="stock-search"
            value={search}
            placeholder="Name or SKU"
            onChange={(e) => setSearch(e.target.value)}
          />
        </div>
        {canManage && !showForm && (
          <Button variant="secondary" size="sm" onClick={() => setShowForm(true)}>
            Add an item
          </Button>
        )}
      </div>

      {showForm && (
        <StockForm
          onDone={() => {
            setShowForm(false);
            void query.refetch();
          }}
          onCancel={() => setShowForm(false)}
        />
      )}

      {query.isPending && <p className="text-sm text-text-muted">Loading…</p>}

      {rows.length === 0 && query.data && (
        <EmptyState
          title="The store is empty"
          description="Add the consumables, tools and instruments the company actually issues."
        />
      )}

      {rows.length > 0 && (
        <Card className="overflow-x-auto p-0">
          <table className="w-full text-sm">
            <thead className="border-b border-border bg-surface-muted text-left">
              <tr>
                <Th>SKU</Th>
                <Th>Name</Th>
                <Th className="text-right">On hand</Th>
                <Th>Where</Th>
                <Th>Calibration</Th>
              </tr>
            </thead>
            <tbody>
              {rows.map((item) => {
                const due = item.calibrationDueAt ? new Date(item.calibrationDueAt) : null;
                const overdue = due !== null && due.getTime() < Date.now();
                const low = Number(item.qtyOnHand) <= Number(item.reorderLevel);
                return (
                  <tr key={item.id} className="border-b border-border last:border-0">
                    <td className="tabular px-3 py-2">{item.sku}</td>
                    <td className="px-3 py-2">
                      {item.name}
                      <p className="text-xs text-text-muted capitalize">{item.category}</p>
                    </td>
                    <td className="tabular px-3 py-2 text-right">
                      {item.qtyOnHand.toString()} {item.unit}
                      {low && <p className="text-xs text-amber-800">at or below reorder level</p>}
                      {/*
                        A physical count, which could not be recorded before 2026-08-20.

                        `upsertStockItem` could edit the item; nothing could correct the quantity, so
                        a store whose figure had drifted stayed wrong and §7's material gate went on
                        deciding against it. docs/DECISIONS.md #135's triage.
                      */}
                      {/*
                        Gated the same way "Add an item" is. Offering a control that will 403 is
                        worse than not offering it: the person learns the system is unreliable
                        rather than that the job is not theirs.
                      */}
                      {canManage && (
                        <AdjustStock
                          id={item.id}
                          name={item.name}
                          unit={item.unit}
                          onHand={item.qtyOnHand.toString()}
                          onDone={() => void query.refetch()}
                        />
                      )}
                    </td>
                    <td className="px-3 py-2 text-xs text-text-muted">{item.location ?? "—"}</td>
                    <td className="px-3 py-2">
                      {due ? (
                        overdue ? (
                          // §7 blocks the draw outright, so the store should see it here first.
                          <StatusBadge tone="failed">overdue</StatusBadge>
                        ) : (
                          <DateCell value={due} />
                        )
                      ) : (
                        <span className="text-xs text-text-muted">n/a</span>
                      )}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </Card>
      )}
    </>
  );
}

function StockForm({ onDone, onCancel }: { onDone: () => void; onCancel: () => void }) {
  const [sku, setSku] = useState("");
  const [name, setName] = useState("");
  const [category, setCategory] = useState("consumable");
  const [unit, setUnit] = useState("pc");
  const [qtyOnHand, setQtyOnHand] = useState("0");
  const [reorderLevel, setReorderLevel] = useState("0");
  const [location, setLocation] = useState("");
  const [calibrationDueAt, setCalibrationDueAt] = useState("");

  const save = trpc.operations.upsertStockItem.useMutation({ onSuccess: onDone });

  return (
    <Card className="mb-4 p-4">
      <h2 className="text-sm font-semibold">Add a stock item</h2>
      <div className="mt-3 grid gap-3 sm:grid-cols-3">
        <div>
          <Label htmlFor="s-sku">SKU</Label>
          <Input id="s-sku" value={sku} onChange={(e) => setSku(e.target.value)} />
        </div>
        <div className="sm:col-span-2">
          <Label htmlFor="s-name">Name</Label>
          <Input id="s-name" value={name} onChange={(e) => setName(e.target.value)} />
        </div>
        <div>
          <Label htmlFor="s-cat">Category</Label>
          <Input id="s-cat" value={category} onChange={(e) => setCategory(e.target.value)} />
        </div>
        <div>
          <Label htmlFor="s-unit">Unit</Label>
          <Input id="s-unit" value={unit} onChange={(e) => setUnit(e.target.value)} />
        </div>
        <div>
          <Label htmlFor="s-loc">Location</Label>
          <Input id="s-loc" value={location} onChange={(e) => setLocation(e.target.value)} />
        </div>
        <div>
          <Label htmlFor="s-qty">On hand</Label>
          <Input
            id="s-qty"
            type="number"
            min={0}
            step="any"
            value={qtyOnHand}
            onChange={(e) => setQtyOnHand(e.target.value)}
          />
        </div>
        <div>
          <Label htmlFor="s-reorder">Reorder level</Label>
          <Input
            id="s-reorder"
            type="number"
            min={0}
            step="any"
            value={reorderLevel}
            onChange={(e) => setReorderLevel(e.target.value)}
          />
        </div>
        <div>
          <Label htmlFor="s-cal">Calibration due</Label>
          <Input
            id="s-cal"
            type="date"
            value={calibrationDueAt}
            onChange={(e) => setCalibrationDueAt(e.target.value)}
          />
          <p className="mt-1 text-xs text-text-muted">
            {/* §7 blocks drawing an instrument past this date. */}
            Instruments only. An instrument with no date here cannot be issued.
          </p>
        </div>
      </div>

      {save.error && <p className="mt-2 text-sm text-danger">{save.error.message}</p>}

      <div className="mt-3 flex gap-2">
        <Button
          size="sm"
          disabled={save.isPending || !sku.trim() || !name.trim()}
          onClick={() =>
            save.mutate({
              sku,
              name,
              category,
              unit,
              qtyOnHand: Number(qtyOnHand) || 0,
              reorderLevel: Number(reorderLevel) || 0,
              location: location || null,
              calibrationDueAt: calibrationDueAt ? new Date(calibrationDueAt) : null,
            })
          }
        >
          Add it
        </Button>
        <Button variant="ghost" size="sm" onClick={onCancel}>
          Cancel
        </Button>
      </div>
    </Card>
  );
}

function Th({ children, className = "" }: { children: React.ReactNode; className?: string }) {
  return (
    <th className={`px-3 py-2 text-xs font-medium text-text-muted ${className}`}>{children}</th>
  );
}

/**
 * Recording a physical count.
 *
 * ## Why a count and not a delta
 *
 * The service takes `countedQty` — what is actually on the shelf — rather than "add 3" or
 * "remove 2". Somebody standing in the store with a clipboard knows how many there are; asking them
 * to work out the difference from a figure they already believe is wrong is asking them to do
 * arithmetic against a number they came to correct. The movement is derived from the gap.
 *
 * ## Why it needs a reason
 *
 * A stock figure that changes with no explanation is indistinguishable from a mistake, and §7's
 * material gate decides whether a job can draw materials from exactly this number. "Annual count",
 * "two found damaged, written off", "issue never recorded" are all different stories, and only the
 * words separate them.
 */
function AdjustStock({
  id,
  name,
  unit,
  onHand,
  onDone,
}: {
  id: string;
  name: string;
  unit: string;
  onHand: string;
  onDone: () => void;
}) {
  const [open, setOpen] = useState(false);
  const [counted, setCounted] = useState(onHand);
  const [reference, setReference] = useState("");

  const adjust = trpc.operations.adjustStock.useMutation({
    onSuccess: () => {
      toastSuccess(`${name} set to ${counted} ${unit}.`);
      setOpen(false);
      setReference("");
      onDone();
    },
    onError: toastError,
  });

  if (!open) {
    return (
      <button
        type="button"
        className="mt-0.5 text-xs text-text-muted underline"
        onClick={() => {
          setCounted(onHand);
          setOpen(true);
        }}
      >
        count
      </button>
    );
  }

  const difference = Number(counted) - Number(onHand);

  return (
    <div className="mt-1 rounded-md border border-border p-2 text-left">
      <Label htmlFor={`ct-${id}`}>Counted on the shelf</Label>
      <Input
        id={`ct-${id}`}
        type="number"
        step="0.001"
        min="0"
        value={counted}
        onChange={(event) => setCounted(event.target.value)}
      />
      {Number.isFinite(difference) && difference !== 0 && (
        <p className="mt-1 text-xs text-amber-700">
          {difference > 0 ? "+" : ""}
          {difference} {unit} against the {onHand} recorded. A movement is written for the
          difference.
        </p>
      )}

      <Label htmlFor={`ctr-${id}`} className="mt-2 block">
        Why it differs
      </Label>
      <Input
        id={`ctr-${id}`}
        value={reference}
        placeholder="Annual count; two found damaged and written off."
        onChange={(event) => setReference(event.target.value)}
      />

      <div className="mt-2 flex gap-2">
        <Button
          size="sm"
          disabled={
            adjust.isPending ||
            counted === "" ||
            !Number.isFinite(Number(counted)) ||
            reference.trim().length < 3
          }
          onClick={() =>
            adjust.mutate({
              stockItemId: id,
              countedQty: Number(counted),
              reference: reference.trim(),
            })
          }
        >
          {adjust.isPending ? "Recording…" : "Record the count"}
        </Button>
        <Button variant="ghost" size="sm" onClick={() => setOpen(false)}>
          Discard
        </Button>
      </div>
    </div>
  );
}
