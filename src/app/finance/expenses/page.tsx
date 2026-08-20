"use client";

import { useState } from "react";
import type { inferRouterOutputs } from "@trpc/server";
import type { AppRouter } from "@/server/api/root";
import { Button } from "@/components/ui/button";
import { DateCell } from "@/components/ui/cells";
import { Input, Label, Select, Textarea } from "@/components/ui/input";
import { Card, PageHeader } from "@/components/ui/layout";
import { StatusBadge, type StatusTone } from "@/components/ui/status-badge";
import {
  EXPENSE_CATEGORIES,
  EXPENSE_CATEGORY_LABELS,
  type ExpenseCategory,
} from "@/server/core/finance/expense-rules";
import { formatMoney } from "@/lib/format";
import { toastError, toastSuccess } from "@/lib/errors";
import { trpc } from "@/lib/trpc/client";

/**
 * §6's direct expenses — the costs bought in for a job.
 *
 * ## What was missing
 *
 * `Expense` was a table the P&L read and nothing could write. The only direct costs a project could
 * show were ones a seed script had put there — so "Subcontractors: 46,000" on the FIN5 walkthrough
 * was, quite literally, fiction the seed had authored. docs/DECISIONS.md #133.
 *
 * ## Not the same thing as a field expense
 *
 * Module 04's field expense is money a technician spent on site and is claiming back; it belongs to
 * a ticket and its cash advance. This is an invoice AIES received for something bought for the job —
 * a subcontracted crane, a permit, a rental. §6 reads both under different categories, and the two
 * screens are kept apart so the same peso cannot be entered twice.
 */

const STATUS_TONE: Record<string, StatusTone> = {
  draft: "draft",
  submitted: "pending",
  approved: "approved",
  rejected: "failed",
  paid: "info",
};

export default function ExpensesPage() {
  const expenses = trpc.finance.expenses.useQuery({});
  const [open, setOpen] = useState(false);

  const submitted = expenses.data?.filter((row) => row.status === "submitted") ?? [];
  const rest = expenses.data?.filter((row) => row.status !== "submitted") ?? [];

  return (
    <div className="mx-auto max-w-5xl">
      <PageHeader
        title="Expenses"
        description="Costs bought in for a job — subcontractors, rentals, permits — and what they are charged to."
      />

      {open ? (
        <SubmitExpense
          onDone={() => {
            setOpen(false);
            void expenses.refetch();
          }}
          onCancel={() => setOpen(false)}
        />
      ) : (
        <Button className="mt-4" size="sm" onClick={() => setOpen(true)}>
          Record an expense
        </Button>
      )}

      {expenses.isPending && <p className="mt-4 text-sm text-text-muted">Loading…</p>}
      {expenses.error && (
        <Card className="mt-4 p-4">
          <p className="text-sm">{expenses.error.message}</p>
        </Card>
      )}

      {expenses.data && (
        <>
          <Card className="mt-4 p-4">
            <h2 className="text-sm font-semibold">Waiting for a decision</h2>
            <p className="mt-0.5 text-xs text-text-muted">
              Nothing here is on a project&rsquo;s margin yet — §6 counts only approved and paid, so
              a claim nobody has looked at does not make a job look worse.
            </p>
            {submitted.length === 0 ? (
              <p className="mt-2 text-sm">Nothing is waiting.</p>
            ) : (
              <ul className="mt-2 space-y-2">
                {submitted.map((row) => (
                  <li key={row.id} className="rounded-md border border-border p-3">
                    <Row row={row} />
                    <Decide
                      id={row.id}
                      number={row.number}
                      onDone={() => void expenses.refetch()}
                    />
                  </li>
                ))}
              </ul>
            )}
          </Card>

          <Card className="mt-4 p-4">
            <h2 className="text-sm font-semibold">Decided</h2>
            {rest.length === 0 ? (
              <p className="mt-2 text-sm text-text-muted">Nothing has been decided yet.</p>
            ) : (
              <ul className="mt-2 space-y-2">
                {rest.map((row) => (
                  <li key={row.id} className="rounded-md border border-border p-3">
                    <Row row={row} />
                    {row.rejectedReason && (
                      <p className="mt-1 text-xs text-danger">Rejected — {row.rejectedReason}</p>
                    )}
                  </li>
                ))}
              </ul>
            )}
          </Card>
        </>
      )}
    </div>
  );
}

/** Inferred from the router rather than restated, so a shape change here is a type error, not a
 *  screen that silently reads a field the server stopped sending. */
type ExpenseRow = inferRouterOutputs<AppRouter>["finance"]["expenses"][number];

function Row({ row }: { row: ExpenseRow }) {
  return (
    <>
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <span className="flex flex-wrap items-baseline gap-2">
          <span className="tabular font-medium">{row.number}</span>
          <span className="text-sm">
            {EXPENSE_CATEGORY_LABELS[row.category as ExpenseCategory] ?? row.category}
          </span>
          {row.vendorName && <span className="text-xs text-text-muted">{row.vendorName}</span>}
        </span>
        <span className="flex items-center gap-2">
          <StatusBadge tone={STATUS_TONE[row.status] ?? "draft"}>{row.status}</StatusBadge>
          <span className="tabular font-medium">{formatMoney(row.amount, row.currency)}</span>
        </span>
      </div>
      <p className="mt-1 text-sm">{row.description}</p>
      <p className="mt-0.5 text-xs text-text-muted">
        <DateCell value={row.expenseDate} /> · submitted by {row.submittedBy} ·{" "}
        {/* What it is charged to, always shown — an expense against nothing is the failure this
            screen's validation exists to prevent, so its answer belongs on every row. */}
        {row.project
          ? `${row.project.code} — ${row.project.name}`
          : row.salesOrder
            ? row.salesOrder.number
            : "charged to nothing"}
      </p>
    </>
  );
}

function Decide({ id, number, onDone }: { id: string; number: string; onDone: () => void }) {
  const [rejecting, setRejecting] = useState(false);
  const [reason, setReason] = useState("");

  const decide = trpc.finance.decideExpense.useMutation({
    onSuccess: (result) => {
      toastSuccess(
        result.status === "approved"
          ? `${number} approved — it now counts against the job.`
          : `${number} rejected.`,
      );
      setRejecting(false);
      setReason("");
      onDone();
    },
    onError: toastError,
  });

  if (rejecting) {
    return (
      <div className="mt-2 rounded-md border border-border p-2.5">
        <Label htmlFor={`ex-why-${id}`}>Why it is being rejected</Label>
        <Input
          id={`ex-why-${id}`}
          value={reason}
          placeholder="Already claimed on the cash advance liquidation for this ticket."
          onChange={(event) => setReason(event.target.value)}
        />
        <div className="mt-2 flex gap-2">
          <Button
            size="sm"
            disabled={decide.isPending || reason.trim().length < 5}
            onClick={() => decide.mutate({ id, approve: false, reason: reason.trim() })}
          >
            Reject it
          </Button>
          <Button variant="ghost" size="sm" onClick={() => setRejecting(false)}>
            Discard
          </Button>
        </div>
      </div>
    );
  }

  return (
    <div className="mt-2 flex gap-2">
      <Button
        variant="secondary"
        size="sm"
        disabled={decide.isPending}
        onClick={() => decide.mutate({ id, approve: true })}
      >
        Approve
      </Button>
      <Button variant="ghost" size="sm" onClick={() => setRejecting(true)}>
        Reject…
      </Button>
    </div>
  );
}

function SubmitExpense({ onDone, onCancel }: { onDone: () => void; onCancel: () => void }) {
  const projects = trpc.finance.chargeableProjects.useQuery();

  const [category, setCategory] = useState<ExpenseCategory>("subcontract");
  const [vendorName, setVendorName] = useState("");
  const [expenseDate, setExpenseDate] = useState(() => new Date().toISOString().slice(0, 10));
  const [amount, setAmount] = useState("");
  const [vatAmount, setVatAmount] = useState("");
  const [description, setDescription] = useState("");
  const [projectId, setProjectId] = useState("");

  const submit = trpc.finance.submitExpense.useMutation({
    onSuccess: (result) => {
      toastSuccess(`${result.number} submitted. It counts against the job once approved.`);
      onDone();
    },
    onError: toastError,
  });

  const parsed = Number(amount);
  const canSubmit =
    projectId !== "" &&
    description.trim().length >= 3 &&
    Number.isFinite(parsed) &&
    parsed > 0 &&
    expenseDate !== "";

  return (
    <Card className="mt-4 p-4">
      <h2 className="text-sm font-semibold">Record an expense</h2>
      <p className="mt-0.5 text-xs text-text-muted">
        Something bought in for a job. Money a technician spent on site and is claiming back is a
        field expense on the ticket instead — recording it here as well would count it twice.
      </p>

      <div className="mt-3 grid gap-3 sm:grid-cols-2">
        <div>
          <Label htmlFor="ex-category">What kind</Label>
          <Select
            id="ex-category"
            value={category}
            onChange={(event) => setCategory(event.target.value as ExpenseCategory)}
          >
            {EXPENSE_CATEGORIES.map((value) => (
              <option key={value} value={value}>
                {EXPENSE_CATEGORY_LABELS[value]}
              </option>
            ))}
          </Select>
        </div>

        <div>
          <Label htmlFor="ex-vendor">Who was paid</Label>
          <Input
            id="ex-vendor"
            value={vendorName}
            placeholder="Mariveles Rigging Services"
            onChange={(event) => setVendorName(event.target.value)}
          />
        </div>

        <div className="sm:col-span-2">
          <Label htmlFor="ex-project">Charged to</Label>
          <Select
            id="ex-project"
            value={projectId}
            onChange={(event) => setProjectId(event.target.value)}
          >
            <option value="">Choose a project…</option>
            {projects.data?.map((project) => (
              <option key={project.id} value={project.id}>
                {project.code} — {project.name}
              </option>
            ))}
          </Select>
          <p className="mt-1 text-xs text-text-muted">
            Required. A cost charged to nothing shows up on no job&rsquo;s margin and makes every
            project look better than it was.
          </p>
        </div>

        <div>
          <Label htmlFor="ex-amount">Amount</Label>
          <Input
            id="ex-amount"
            type="number"
            step="0.01"
            min="0"
            value={amount}
            onChange={(event) => setAmount(event.target.value)}
          />
        </div>

        <div>
          <Label htmlFor="ex-vat">Input VAT</Label>
          <Input
            id="ex-vat"
            type="number"
            step="0.01"
            min="0"
            value={vatAmount}
            onChange={(event) => setVatAmount(event.target.value)}
          />
          <p className="mt-1 text-xs text-text-muted">
            Blank means nobody recorded it — not the same as an invoice with no VAT.
          </p>
        </div>

        <div>
          <Label htmlFor="ex-date">When it was spent</Label>
          <Input
            id="ex-date"
            type="date"
            value={expenseDate}
            onChange={(event) => setExpenseDate(event.target.value)}
          />
        </div>

        <div className="sm:col-span-2">
          <Label htmlFor="ex-desc">What it was for</Label>
          <Textarea
            id="ex-desc"
            rows={2}
            value={description}
            placeholder="Crane and two riggers for the valve lift, 14 August."
            onChange={(event) => setDescription(event.target.value)}
          />
          <p className="mt-1 text-xs text-text-muted">
            A category alone cannot be argued with six months later.
          </p>
        </div>
      </div>

      <div className="mt-3 flex gap-2">
        <Button
          size="sm"
          disabled={!canSubmit || submit.isPending}
          onClick={() =>
            submit.mutate({
              category,
              vendorName: vendorName.trim() === "" ? null : vendorName.trim(),
              expenseDate: new Date(expenseDate),
              amount: parsed,
              vatAmount: vatAmount.trim() === "" ? null : Number(vatAmount),
              description: description.trim(),
              projectId,
            })
          }
        >
          {submit.isPending ? "Submitting…" : "Submit it"}
        </Button>
        <Button variant="ghost" size="sm" onClick={onCancel}>
          Discard
        </Button>
      </div>
    </Card>
  );
}
