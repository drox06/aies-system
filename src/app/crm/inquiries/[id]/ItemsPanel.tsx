"use client";

import { useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/layout";
import { Input, Label, Select, Textarea } from "@/components/ui/input";
import { SERVICE_TYPES, type ServiceType } from "@/server/core/crm/inquiry-lifecycle";
import { toastError, toastSuccess } from "@/lib/errors";
import { trpc } from "@/lib/trpc/client";
import type { InquiryDetail } from "./types";

/**
 * What the customer asked for, as an editable table.
 *
 * ## Why this replaced a read-only list
 *
 * The line items could only be typed once, on the quick-create form, and never touched again — so
 * the moment the customer rang back to say "make that four, not two", the correction had nowhere to
 * live except the description box or somebody's memory. Raised by the company on 2026-08-19,
 * alongside the more consequential half of the same complaint: these lines now **carry across into
 * the quotation draft** (see `createDraftForInquiry`), so a line typed sloppily here is a line the
 * estimator inherits.
 *
 * ## Why the rows expand
 *
 * Six fields per line, and four of them are usually blank. Putting all six in one row gives every
 * line a horizontal scrollbar and shrinks the description — the one field that is always filled in
 * and always the longest — to about eight characters. So each row shows what somebody scanning the
 * list needs (description, quantity, what kind of work it is) and opens to reveal the rest.
 *
 * A row stays open once opened, per line, for as long as the panel is mounted. Collapsing a row the
 * moment you click away from it is how you lose the model number you were halfway through typing.
 *
 * ## Why it saves as a whole table
 *
 * `setInquiryItems` replaces the lines wholesale and renumbers them, so there is one Save for the
 * panel rather than one per row. That matches how people work through a list of parts — top to
 * bottom, then done — and it means a deletion is not a separate round-trip.
 */

interface DraftItem {
  description: string;
  quantity: string;
  unit: string;
  manufacturer: string;
  modelNumber: string;
  /** "" is "not decided yet" — see the option of that name. Typed, so the save cannot post junk. */
  serviceType: ServiceType | "";
  notes: string;
}

const BLANK: DraftItem = {
  description: "",
  quantity: "1",
  unit: "pc",
  manufacturer: "",
  modelNumber: "",
  serviceType: "",
  notes: "",
};

/** The service types, in the words a salesperson uses rather than the enum's. */
const SERVICE_LABELS: Record<string, string> = {
  supply: "Supply",
  installation: "Installation",
  commissioning: "Commissioning",
  calibration: "Calibration",
  pm: "Preventive maintenance",
  corrective: "Corrective / troubleshooting",
  inspection: "Site inspection",
};

function toDraft(item: InquiryDetail["items"][number]): DraftItem {
  return {
    description: item.description,
    quantity: String(item.quantity),
    unit: item.unit,
    manufacturer: item.manufacturer ?? "",
    modelNumber: item.modelNumber ?? "",
    serviceType: (item.serviceType ?? "") as ServiceType | "",
    notes: item.notes ?? "",
  };
}

export function ItemsPanel({ inquiry }: { inquiry: InquiryDetail }) {
  const utils = trpc.useUtils();
  const [items, setItems] = useState<DraftItem[]>(inquiry.items.map(toDraft));
  const [expanded, setExpanded] = useState<Set<number>>(new Set());

  useEffect(() => {
    setItems(inquiry.items.map(toDraft));
  }, [inquiry.items]);

  const save = trpc.crm.setInquiryItems.useMutation({
    onSuccess: () => {
      toastSuccess("Line items saved.");
      void utils.crm.getInquiry.invalidate({ inquiryId: inquiry.id });
    },
    onError: toastError,
  });

  function update(index: number, patch: Partial<DraftItem>) {
    setItems((current) => current.map((item, i) => (i === index ? { ...item, ...patch } : item)));
  }

  function remove(index: number) {
    setItems((current) => current.filter((_, i) => i !== index));
    // The open set is keyed by position, and removing a line shifts every position after it. Rather
    // than renumber the set, close everything: a wrongly-open row is confusing, a closed one is not.
    setExpanded(new Set());
  }

  function toggle(index: number) {
    setExpanded((current) => {
      const next = new Set(current);
      if (next.has(index)) next.delete(index);
      else next.add(index);
      return next;
    });
  }

  /*
    A line with no description is not a line.

    Everything else may be blank — plenty of enquiries arrive as "two of these, datasheet to follow"
    — but a row with nothing in the description carries no information at all, and saving it would
    put an empty line on the quotation draft this feeds. Dropped quietly on save, and counted on
    screen so nobody wonders where their row went.
  */
  const describable = items.filter((item) => item.description.trim().length > 0);
  const blankRows = items.length - describable.length;

  return (
    <Card className="p-4">
      <div className="flex items-center justify-between gap-2">
        <h2 className="text-sm font-semibold">What they asked for</h2>
        <span className="text-xs text-text-muted">
          {items.length === 0
            ? "No lines yet"
            : `${items.length} line${items.length === 1 ? "" : "s"}`}
        </span>
      </div>

      <p className="mt-1 text-xs text-text-muted">
        These lines start the quotation, so what is typed here is what the estimator prices.
      </p>

      {items.length > 0 && (
        <div className="mt-3 space-y-2">
          {items.map((item, index) => {
            const open = expanded.has(index);
            return (
              <div key={index} className="rounded border border-border">
                <div className="flex flex-wrap items-end gap-2 p-2">
                  <span className="tabular pb-2 text-xs text-text-muted">{index + 1}</span>

                  <div className="min-w-[16rem] flex-1">
                    <Label htmlFor={`item-${index}-description`}>Description</Label>
                    <Input
                      id={`item-${index}-description`}
                      value={item.description}
                      placeholder="What they asked for, in their own words"
                      onChange={(e) => update(index, { description: e.target.value })}
                    />
                  </div>

                  <div className="w-24">
                    <Label htmlFor={`item-${index}-quantity`}>Qty</Label>
                    <Input
                      id={`item-${index}-quantity`}
                      type="number"
                      min={0}
                      step="any"
                      className="text-right font-semibold"
                      value={item.quantity}
                      onChange={(e) => update(index, { quantity: e.target.value })}
                    />
                  </div>

                  <div className="w-20">
                    <Label htmlFor={`item-${index}-unit`}>Unit</Label>
                    <Input
                      id={`item-${index}-unit`}
                      value={item.unit}
                      onChange={(e) => update(index, { unit: e.target.value })}
                    />
                  </div>

                  <div className="w-52">
                    <Label htmlFor={`item-${index}-service`}>Kind of work</Label>
                    <Select
                      id={`item-${index}-service`}
                      value={item.serviceType}
                      onChange={(e) =>
                        update(index, { serviceType: e.target.value as ServiceType | "" })
                      }
                    >
                      {/*
                        Blank is allowed and blank has a cost: the service type decides which §4
                        requirements checklist this inquiry has to answer. An enquiry often arrives
                        before anyone knows, so it is not forced — but until it is set, the checklist
                        below has nothing to ask.
                      */}
                      <option value="">Not decided yet</option>
                      {SERVICE_TYPES.map((type) => (
                        <option key={type} value={type}>
                          {SERVICE_LABELS[type] ?? type}
                        </option>
                      ))}
                    </Select>
                  </div>

                  <div className="flex items-center gap-1 pb-0.5">
                    <Button
                      variant="ghost"
                      size="sm"
                      aria-expanded={open}
                      onClick={() => toggle(index)}
                    >
                      {open ? "Less" : "More"}
                    </Button>
                    <Button
                      variant="ghost"
                      size="sm"
                      aria-label={`Remove line ${index + 1}`}
                      onClick={() => remove(index)}
                    >
                      Remove
                    </Button>
                  </div>
                </div>

                {open && (
                  <div className="grid gap-2 border-t border-border p-2 sm:grid-cols-2">
                    <div>
                      <Label htmlFor={`item-${index}-manufacturer`}>Make</Label>
                      <Input
                        id={`item-${index}-manufacturer`}
                        value={item.manufacturer}
                        onChange={(e) => update(index, { manufacturer: e.target.value })}
                      />
                    </div>
                    <div>
                      <Label htmlFor={`item-${index}-model`}>Model or part number</Label>
                      <Input
                        id={`item-${index}-model`}
                        value={item.modelNumber}
                        onChange={(e) => update(index, { modelNumber: e.target.value })}
                      />
                    </div>
                    <div className="sm:col-span-2">
                      <Label htmlFor={`item-${index}-notes`}>Notes</Label>
                      <Textarea
                        id={`item-${index}-notes`}
                        rows={2}
                        value={item.notes}
                        placeholder="Anything about this line the estimator needs to know."
                        onChange={(e) => update(index, { notes: e.target.value })}
                      />
                    </div>
                  </div>
                )}
              </div>
            );
          })}
        </div>
      )}

      <div className="mt-3 flex flex-wrap items-center gap-2">
        <Button
          variant="secondary"
          onClick={() => {
            setItems((current) => [...current, { ...BLANK }]);
            setExpanded(new Set());
          }}
        >
          + Add a line
        </Button>
        <Button
          onClick={() =>
            save.mutate({
              inquiryId: inquiry.id,
              items: describable.map((item) => ({
                description: item.description.trim(),
                quantity: item.quantity.trim() || "1",
                unit: item.unit.trim() || "pc",
                manufacturer: item.manufacturer.trim() || null,
                modelNumber: item.modelNumber.trim() || null,
                serviceType: item.serviceType === "" ? null : item.serviceType,
                notes: item.notes.trim() || null,
              })),
            })
          }
          disabled={save.isPending}
        >
          {save.isPending ? "Saving…" : "Save line items"}
        </Button>
        {blankRows > 0 && (
          <span className="text-xs text-text-muted">
            {blankRows} empty {blankRows === 1 ? "line" : "lines"} will not be saved.
          </span>
        )}
      </div>
    </Card>
  );
}
