"use client";

import { useState } from "react";
import { Attachments } from "@/components/ui/attachments";
import { Button } from "@/components/ui/button";
import { DateCell } from "@/components/ui/cells";
import { Input, Label, Select } from "@/components/ui/input";
import { Card } from "@/components/ui/layout";
import { StatusBadge, type StatusTone } from "@/components/ui/status-badge";
import {
  EXPENSE_CATEGORIES,
  EXPENSE_CATEGORY_LABELS,
  FIELD_EXPENSE_ENTITY_TYPE,
  RECEIPT_REQUIRED_ABOVE,
  checkExpense,
  checkHours,
  type ExpenseCategory,
} from "@/server/core/operations/timesheet-rules";
import { trpc } from "@/lib/trpc/client";

/**
 * §16's hours and field spend, on the ticket.
 *
 * The four hour buckets are four fields rather than one total plus a picker, because that is what
 * they are: §8's standby is a separate fact the platform argues about, and a form that made somebody
 * choose one type per row would lose the day that was six hours of work and two of waiting.
 *
 * The same `checkHours` and `checkExpense` run here and at the service, so a refusal reads the same
 * in both places and nobody is surprised at submit.
 */

const TONE: Record<string, StatusTone> = {
  draft: "draft",
  submitted: "pending",
  approved: "approved",
  rejected: "failed",
  reimbursed: "approved",
};

const pesos = (centavos: number) =>
  `₱${(centavos / 100).toLocaleString("en-PH", { minimumFractionDigits: 2 })}`;

export function HoursPanel({ ticketId }: { ticketId: string }) {
  const hours = trpc.operations.ticketHours.useQuery({ ticketId });
  const expenses = trpc.operations.listExpenses.useQuery({ ticketId });
  const me = trpc.system.whoami.useQuery(undefined, { retry: false });
  const utils = trpc.useUtils();

  const canRecord = (me.data?.permissions ?? []).includes("ticket.execute");

  const refresh = () => {
    void utils.operations.ticketHours.invalidate({ ticketId });
    void utils.operations.listExpenses.invalidate({ ticketId });
  };

  const saveHours = trpc.operations.saveTimesheet.useMutation({ onSuccess: refresh });
  const saveExpense = trpc.operations.saveExpense.useMutation({ onSuccess: refresh });
  const submitHours = trpc.operations.submitTimesheets.useMutation({ onSuccess: refresh });
  const submitExpenses = trpc.operations.submitExpenses.useMutation({
    onSuccess: (result) => {
      // A partial submit is the normal case, so what did NOT go has to be visible. Silently
      // submitting four of five is how somebody discovers in payroll that one never went.
      setBlocked(result.blocked);
      refresh();
    },
  });

  /** Which saved expense has its receipt drawer open. */
  const [receiptFor, setReceiptFor] = useState<string | null>(null);
  /** Rows the last submit would not take, and why. Kept until the next submit. */
  const [blocked, setBlocked] = useState<{ id: string; description: string; reason: string }[]>([]);

  const today = new Date().toISOString().slice(0, 10);
  const [date, setDate] = useState(today);
  const [regular, setRegular] = useState("8");
  const [overtime, setOvertime] = useState("0");
  const [travel, setTravel] = useState("0");
  const [standby, setStandby] = useState("0");
  const [activity, setActivity] = useState("");

  const [expenseDate, setExpenseDate] = useState(today);
  const [category, setCategory] = useState<ExpenseCategory>("fuel");
  const [amount, setAmount] = useState("");
  const [description, setDescription] = useState("");

  if (hours.isPending) return null;

  const draft = {
    regularHours: Number(regular) || 0,
    overtimeHours: Number(overtime) || 0,
    travelHours: Number(travel) || 0,
    standbyHours: Number(standby) || 0,
  };
  const hoursCheck = checkHours(draft);

  const centavos = Math.round((Number(amount) || 0) * 100);
  const expenseCheck = checkExpense({ category, amount: centavos, description });

  const totals = hours.data?.approved;
  const expenseRows = expenses.data ?? [];
  const draftHourIds =
    hours.data?.rows.filter((row) => row.status === "draft").map((r) => r.id) ?? [];
  const draftExpenseIds = expenseRows.filter((row) => row.status === "draft").map((r) => r.id);

  return (
    <Card className="p-4">
      <h2 className="text-sm font-semibold">Hours and spend</h2>

      {totals && totals.total > 0 && (
        <p className="mt-1 text-xs text-text-muted">
          Approved so far: {totals.total}h — {totals.regularHours} regular, {totals.overtimeHours}{" "}
          overtime, {totals.travelHours} travel,{" "}
          <span className={totals.standbyHours > 0 ? "font-medium" : ""}>
            {totals.standbyHours} standby
          </span>
          .
        </p>
      )}

      {/* ---- hours ---- */}
      {canRecord && (
        <div className="mt-3 border-t border-border pt-3">
          <h3 className="text-sm font-medium">Record a day</h3>
          <div className="mt-2 flex flex-wrap items-end gap-2">
            <div className="w-36">
              <Label htmlFor="ts-date">Date</Label>
              <Input
                id="ts-date"
                type="date"
                value={date}
                onChange={(e) => setDate(e.target.value)}
              />
            </div>
            <div className="w-20">
              <Label htmlFor="ts-reg">Regular</Label>
              <Input
                id="ts-reg"
                inputMode="decimal"
                value={regular}
                onChange={(e) => setRegular(e.target.value)}
              />
            </div>
            <div className="w-20">
              <Label htmlFor="ts-ot">Overtime</Label>
              <Input
                id="ts-ot"
                inputMode="decimal"
                value={overtime}
                onChange={(e) => setOvertime(e.target.value)}
              />
            </div>
            <div className="w-20">
              <Label htmlFor="ts-travel">Travel</Label>
              <Input
                id="ts-travel"
                inputMode="decimal"
                value={travel}
                onChange={(e) => setTravel(e.target.value)}
              />
            </div>
            <div className="w-20">
              <Label htmlFor="ts-standby">Standby</Label>
              <Input
                id="ts-standby"
                inputMode="decimal"
                value={standby}
                onChange={(e) => setStandby(e.target.value)}
              />
            </div>
            <div className="min-w-[12rem] flex-1">
              <Label htmlFor="ts-activity">What was done</Label>
              <Input
                id="ts-activity"
                value={activity}
                onChange={(e) => setActivity(e.target.value)}
              />
            </div>
            <Button
              disabled={!hoursCheck.ok || saveHours.isPending}
              onClick={() =>
                saveHours.mutate({
                  ticketId,
                  date: new Date(date),
                  ...draft,
                  activity: activity || null,
                })
              }
            >
              Save
            </Button>
          </div>

          {hoursCheck.errors.length > 0 && (
            <p className="mt-2 text-sm text-danger">{hoursCheck.errors.join(" ")}</p>
          )}
          {/* §8's standby warning shown while the cause can still be recorded on the ticket. */}
          {hoursCheck.warnings.length > 0 && (
            <p className="mt-2 text-sm text-amber-700">{hoursCheck.warnings.join(" ")}</p>
          )}
        </div>
      )}

      {hours.data && hours.data.rows.length > 0 && (
        <ul className="mt-3 space-y-1 text-sm">
          {hours.data.rows.map((row) => (
            <li key={row.id} className="flex flex-wrap items-baseline justify-between gap-2">
              <span>
                <DateCell value={row.date} /> — {row.regularHours + row.overtimeHours}h
                {row.standbyHours > 0 && `, ${row.standbyHours}h standby`}
                {row.activity ? ` · ${row.activity}` : ""}
              </span>
              <StatusBadge tone={TONE[row.status] ?? "draft"}>{row.status}</StatusBadge>
            </li>
          ))}
        </ul>
      )}

      {draftHourIds.length > 0 && (
        <Button
          variant="secondary"
          size="sm"
          className="mt-2"
          disabled={submitHours.isPending}
          onClick={() => submitHours.mutate({ ids: draftHourIds })}
        >
          Submit {draftHourIds.length} day{draftHourIds.length === 1 ? "" : "s"} for approval
        </Button>
      )}

      {/* ---- expenses ---- */}
      {canRecord && (
        <div className="mt-4 border-t border-border pt-3">
          <h3 className="text-sm font-medium">Record what was spent</h3>
          <div className="mt-2 flex flex-wrap items-end gap-2">
            <div className="w-36">
              <Label htmlFor="ex-date">Date</Label>
              <Input
                id="ex-date"
                type="date"
                value={expenseDate}
                onChange={(e) => setExpenseDate(e.target.value)}
              />
            </div>
            <div className="w-44">
              <Label htmlFor="ex-cat">Category</Label>
              <Select
                id="ex-cat"
                value={category}
                onChange={(e) => setCategory(e.target.value as ExpenseCategory)}
              >
                {EXPENSE_CATEGORIES.map((option) => (
                  <option key={option} value={option}>
                    {EXPENSE_CATEGORY_LABELS[option]}
                  </option>
                ))}
              </Select>
            </div>
            <div className="w-28">
              <Label htmlFor="ex-amt">Amount (₱)</Label>
              <Input
                id="ex-amt"
                inputMode="decimal"
                value={amount}
                onChange={(e) => setAmount(e.target.value)}
              />
            </div>
            <div className="min-w-[12rem] flex-1">
              <Label htmlFor="ex-desc">What for</Label>
              <Input
                id="ex-desc"
                value={description}
                onChange={(e) => setDescription(e.target.value)}
              />
            </div>
            <Button
              disabled={!expenseCheck.ok || saveExpense.isPending}
              onClick={() =>
                saveExpense.mutate({
                  ticketId,
                  date: new Date(expenseDate),
                  category,
                  amount: centavos,
                  description,
                })
              }
            >
              Save
            </Button>
          </div>

          {expenseCheck.errors.length > 0 && (
            <p className="mt-2 text-sm text-danger">{expenseCheck.errors.join(" ")}</p>
          )}
          {expenseCheck.warnings.length > 0 && (
            <p className="mt-2 text-sm text-text-muted">{expenseCheck.warnings.join(" ")}</p>
          )}
          {centavos > RECEIPT_REQUIRED_ABOVE && (
            <p className="mt-1 text-xs text-text-muted">
              Over {pesos(RECEIPT_REQUIRED_ABOVE)} — save it now, then press{" "}
              <strong>Receipt</strong> on the saved row to attach the photograph. It is recorded
              either way; it cannot be <em>claimed</em> until the receipt is on it.
            </p>
          )}
        </div>
      )}

      {expenseRows.length > 0 && (
        <ul className="mt-3 space-y-1 text-sm">
          {expenseRows.map((row) => (
            <li key={row.id}>
              <div className="flex flex-wrap items-baseline justify-between gap-2">
                <span>
                  <DateCell value={row.date} /> — {pesos(row.amount)} ·{" "}
                  {EXPENSE_CATEGORY_LABELS[row.category as ExpenseCategory] ?? row.category} ·{" "}
                  {row.description}
                  {row.receiptMissing && (
                    <span className="ml-1 text-danger">· receipt needed to claim it</span>
                  )}
                  {!row.receiptMissing && row.receiptCount > 0 && (
                    <span className="ml-1 text-text-muted">· receipt attached</span>
                  )}
                </span>
                <span className="flex items-center gap-2">
                  {canRecord && (
                    <Button
                      variant="ghost"
                      size="sm"
                      onClick={() => setReceiptFor(receiptFor === row.id ? null : row.id)}
                    >
                      Receipt
                    </Button>
                  )}
                  <StatusBadge tone={TONE[row.status] ?? "draft"}>{row.status}</StatusBadge>
                </span>
              </div>

              {/*
                The control the rule always assumed existed. Attached to the saved expense rather
                than to the ticket, so a receipt cannot end up filed against the job in general with
                nothing saying which ₱800 it covers.
              */}
              {receiptFor === row.id && (
                <div className="mt-1 rounded-md border border-border p-2">
                  <Attachments
                    entityType={FIELD_EXPENSE_ENTITY_TYPE}
                    entityId={row.id}
                    label="Receipt"
                    category="operations"
                    canUpload={row.status === "draft" || row.status === "rejected"}
                    onChanged={refresh}
                  />
                  {row.status !== "draft" && row.status !== "rejected" && (
                    <p className="mt-1 text-xs text-text-muted">
                      Already submitted — the receipt on it can be read but not changed.
                    </p>
                  )}
                </div>
              )}
            </li>
          ))}
        </ul>
      )}

      {draftExpenseIds.length > 0 && (
        <Button
          variant="secondary"
          size="sm"
          className="mt-2"
          disabled={submitExpenses.isPending}
          onClick={() => submitExpenses.mutate({ ids: draftExpenseIds })}
        >
          Submit {draftExpenseIds.length} expense{draftExpenseIds.length === 1 ? "" : "s"}
        </Button>
      )}

      {blocked.length > 0 && (
        <div className="mt-2 rounded-md border-2 border-amber-400 bg-amber-50 p-2">
          <p className="text-sm font-semibold text-amber-900">
            {blocked.length === 1 ? "One expense" : `${blocked.length} expenses`} stayed behind
          </p>
          <ul className="mt-1 space-y-1 text-sm text-amber-900">
            {blocked.map((item) => (
              <li key={item.id}>
                <span className="font-medium">{item.description}</span> — {item.reason}
              </li>
            ))}
          </ul>
          <p className="mt-1 text-xs text-amber-900">
            Everything else went. Press <strong>Receipt</strong> on the row above, attach the
            photograph, then submit again.
          </p>
        </div>
      )}

      {(saveHours.error ?? saveExpense.error) && (
        <p className="mt-2 text-sm text-danger">
          {(saveHours.error ?? saveExpense.error)!.message}
        </p>
      )}
    </Card>
  );
}
