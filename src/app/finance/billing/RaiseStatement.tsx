"use client";

import { useState } from "react";
import Link from "next/link";
import { Button } from "@/components/ui/button";
import { Input, Label } from "@/components/ui/input";
import { toastError, toastSuccess } from "@/lib/errors";
import { trpc } from "@/lib/trpc/client";

/**
 * Billing a milestone — the act "Ready to bill" named and could not perform.
 *
 * The screen listed billable milestones from the day it was built and offered no way to bill one, so
 * §2's whole output was a list somebody had to act on somewhere else, and there was nowhere else.
 * docs/DECISIONS.md #135.
 *
 * ## Why the line is the milestone, and why it is editable
 *
 * §3's statement lines are what the customer reads, and "Mobilisation advance — 20%" is what the
 * contract calls it. So that is the default. It stays editable because the customer's own wording
 * matters more than ours on the document they are being asked to pay: a statement whose description
 * does not match their purchase order is a statement their accounts department queries.
 *
 * ## Raised as a draft, deliberately
 *
 * §3 makes a statement freely cancellable *because* nothing has been declared to anybody yet. The
 * draft step is what makes "freely" true: the figure can be checked before the customer sees it,
 * and withdrawing costs nothing. Issuing it is a separate press, on the statements screen.
 */
export function RaiseStatement({
  milestoneId,
  accountId,
  salesOrderId,
  label,
  amountCentavos,
  dueDate,
  onRaised,
}: {
  milestoneId: string;
  accountId: string;
  salesOrderId: string;
  label: string;
  amountCentavos: number;
  dueDate: Date | string | null;
  onRaised: () => void;
}) {
  const [open, setOpen] = useState(false);
  const [description, setDescription] = useState(label);
  const [poReference, setPoReference] = useState("");
  const [due, setDue] = useState(() =>
    dueDate
      ? new Date(dueDate).toISOString().slice(0, 10)
      : // Thirty days, as a starting point rather than a rule — §2's terms carry the real answer and
        // a milestone without a due date is one nobody set terms on.
        new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10),
  );

  const raise = trpc.finance.raiseStatement.useMutation({
    onSuccess: (result) => {
      toastSuccess(`${result.number} raised as a draft. Issue it when the figure is checked.`);
      setOpen(false);
      onRaised();
    },
    onError: toastError,
  });

  if (!open) {
    return (
      <div className="mt-2 flex items-center gap-2">
        <Button size="sm" onClick={() => setOpen(true)}>
          Raise a statement
        </Button>
        <Link href="/finance/statements" className="text-xs underline">
          Statements
        </Link>
      </div>
    );
  }

  return (
    <div className="mt-2 rounded-md border border-border p-2.5">
      <div className="grid gap-2.5 sm:grid-cols-2">
        <div className="sm:col-span-2">
          <Label htmlFor={`rs-desc-${milestoneId}`}>What the customer will read</Label>
          <Input
            id={`rs-desc-${milestoneId}`}
            value={description}
            onChange={(event) => setDescription(event.target.value)}
          />
          <p className="mt-1 text-xs text-text-muted">
            Their accounts department matches this against their purchase order.
          </p>
        </div>
        <div>
          <Label htmlFor={`rs-po-${milestoneId}`}>Their PO reference</Label>
          <Input
            id={`rs-po-${milestoneId}`}
            value={poReference}
            onChange={(event) => setPoReference(event.target.value)}
          />
        </div>
        <div>
          <Label htmlFor={`rs-due-${milestoneId}`}>Due</Label>
          <Input
            id={`rs-due-${milestoneId}`}
            type="date"
            value={due}
            onChange={(event) => setDue(event.target.value)}
          />
        </div>
      </div>

      <p className="mt-2 text-xs text-text-muted">
        {/* The amount is not editable here. It is the milestone's, and a statement that quietly
            disagrees with the schedule it came from is how a job ends up over- or under-billed. */}
        Amount is the milestone&rsquo;s:{" "}
        <span className="tabular font-medium">
          ₱{(amountCentavos / 100).toLocaleString("en-PH", { minimumFractionDigits: 2 })}
        </span>{" "}
        plus VAT. To bill a different figure, change the milestone.
      </p>

      <div className="mt-2 flex gap-2">
        <Button
          size="sm"
          disabled={raise.isPending || description.trim().length < 3 || due === ""}
          onClick={() =>
            raise.mutate({
              accountId,
              salesOrderId,
              milestoneId,
              type: "progress",
              dueDate: new Date(due),
              poReference: poReference.trim() === "" ? null : poReference.trim(),
              lines: [
                {
                  description: description.trim(),
                  quantity: 1,
                  unitPrice: amountCentavos,
                  vatable: true,
                },
              ],
            })
          }
        >
          {raise.isPending ? "Raising…" : "Raise it as a draft"}
        </Button>
        <Button variant="ghost" size="sm" onClick={() => setOpen(false)}>
          Discard
        </Button>
      </div>
    </div>
  );
}
