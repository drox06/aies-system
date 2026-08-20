"use client";

import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Input, Label, Select } from "@/components/ui/input";
import { Card } from "@/components/ui/layout";
import { toastError, toastSuccess } from "@/lib/errors";
import { trpc } from "@/lib/trpc/client";

/**
 * §16's maintenance contract — writing one, which could not be done.
 *
 * The screen could list contracts and activate them, and nothing could create one. §16 calls the
 * renewal loop *"where the recurring revenue in this business lives"*, and the loop had no way to
 * start. docs/DECISIONS.md #135's triage.
 *
 * ## Raised as a draft, activated separately
 *
 * `createContract` writes it; `activateContract` starts it running. Two acts because they are two
 * decisions — one is drafting terms, the other is committing AIES to turning up four times a year.
 * The activate button already existed on the list, which is why this only builds the half that was
 * missing rather than a combined form that would have made the existing one redundant.
 *
 * ## The value is optional and the visits are not
 *
 * A contract with no visits per year is not a maintenance contract, so §16 makes that number
 * mandatory — it is what the renewal sweep counts against. The value can genuinely be unknown at
 * drafting: some are priced per visit, and a zero there would be a figure somebody later reports on.
 */
export function NewContract({ onCreated }: { onCreated: () => void }) {
  const [open, setOpen] = useState(false);
  const accounts = trpc.crm.listAccounts.useQuery({}, { enabled: open });

  const [accountId, setAccountId] = useState("");
  const [startDate, setStartDate] = useState(() => new Date().toISOString().slice(0, 10));
  const [endDate, setEndDate] = useState(() => {
    const oneYear = new Date();
    oneYear.setFullYear(oneYear.getFullYear() + 1);
    return oneYear.toISOString().slice(0, 10);
  });
  const [visitsPerYear, setVisitsPerYear] = useState("4");
  const [contractValue, setContractValue] = useState("");

  const create = trpc.operations.createContract.useMutation({
    onSuccess: () => {
      toastSuccess("Contract drafted. Activate it when the customer has signed.");
      setOpen(false);
      setContractValue("");
      onCreated();
    },
    onError: toastError,
  });

  if (!open) {
    return (
      <Button size="sm" onClick={() => setOpen(true)}>
        Write a contract
      </Button>
    );
  }

  const visits = Number(visitsPerYear);
  const canSubmit =
    accountId !== "" &&
    startDate !== "" &&
    endDate !== "" &&
    new Date(endDate) > new Date(startDate) &&
    Number.isInteger(visits) &&
    visits >= 1 &&
    visits <= 52;

  return (
    <Card className="mt-4 p-4">
      <h2 className="text-sm font-semibold">Write a maintenance contract</h2>
      <p className="mt-0.5 text-xs text-text-muted">
        Drafted, not started. Activating it is the separate act that commits AIES to turning up.
      </p>

      <div className="mt-3 grid gap-3 sm:grid-cols-2">
        <div className="sm:col-span-2">
          <Label htmlFor="nc-account">Customer</Label>
          <Select
            id="nc-account"
            value={accountId}
            onChange={(event) => setAccountId(event.target.value)}
          >
            <option value="">Choose a customer…</option>
            {accounts.data?.rows?.map((account) => (
              <option key={account.id} value={account.id}>
                {account.name}
              </option>
            ))}
          </Select>
        </div>

        <div>
          <Label htmlFor="nc-start">Runs from</Label>
          <Input
            id="nc-start"
            type="date"
            value={startDate}
            onChange={(event) => setStartDate(event.target.value)}
          />
        </div>

        <div>
          <Label htmlFor="nc-end">Runs to</Label>
          <Input
            id="nc-end"
            type="date"
            value={endDate}
            onChange={(event) => setEndDate(event.target.value)}
          />
          <p className="mt-1 text-xs text-text-muted">
            The renewal sweep chases from this date. A year ahead by default.
          </p>
        </div>

        <div>
          <Label htmlFor="nc-visits">Visits a year</Label>
          <Input
            id="nc-visits"
            type="number"
            min="1"
            max="52"
            step="1"
            value={visitsPerYear}
            onChange={(event) => setVisitsPerYear(event.target.value)}
          />
          <p className="mt-1 text-xs text-text-muted">
            What the company has promised. It is what the schedule is built from, so it is required.
          </p>
        </div>

        <div>
          <Label htmlFor="nc-value">Contract value</Label>
          <Input
            id="nc-value"
            type="number"
            min="0"
            step="0.01"
            value={contractValue}
            onChange={(event) => setContractValue(event.target.value)}
          />
          <p className="mt-1 text-xs text-text-muted">
            {/*
              Optional and empty rather than zero. Some contracts are priced per visit and have no
              annual figure at drafting; a zero here would be a number somebody later reports on as
              though it meant free.
            */}
            Leave blank if it is priced per visit — blank means unknown, not nothing.
          </p>
        </div>
      </div>

      <div className="mt-3 flex gap-2">
        <Button
          size="sm"
          disabled={!canSubmit || create.isPending}
          onClick={() =>
            create.mutate({
              accountId,
              startDate: new Date(startDate),
              endDate: new Date(endDate),
              visitsPerYear: visits,
              contractValue:
                contractValue.trim() === "" ? undefined : Math.round(Number(contractValue) * 100),
            })
          }
        >
          {create.isPending ? "Drafting…" : "Draft it"}
        </Button>
        <Button variant="ghost" size="sm" onClick={() => setOpen(false)}>
          Discard
        </Button>
      </div>
    </Card>
  );
}
