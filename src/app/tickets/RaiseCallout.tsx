"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { Button } from "@/components/ui/button";
import { Input, Label, Select, Textarea } from "@/components/ui/input";
import { Card } from "@/components/ui/layout";
import {
  AFTER_SALES_SUBTYPES,
  TICKET_PRIORITIES,
  TICKET_TYPES,
} from "@/server/core/operations/ticket-rules";
import { toastError, toastSuccess } from "@/lib/errors";
import { trpc } from "@/lib/trpc/client";

/**
 * §4's standalone ticket — work that did not arrive through a sales order.
 *
 * ## What was missing
 *
 * `createStandaloneTicketService` existed, was tested, and had no caller. Every ticket in the
 * platform had to descend from a sales order, so **a customer ringing about a broken pump could not
 * be given a ticket at all**. For a company whose after-sales work is a real revenue line, that is
 * not a gap in a screen; it is a category of work the system refused to acknowledge.
 * docs/DECISIONS.md #135's triage.
 *
 * ## Why the justification is required and not a nicety
 *
 * §4 makes every other ticket answerable to an order — the order says why the work is happening and
 * who agreed to pay. A standalone ticket has neither, so the justification **is** its authorisation:
 * it is the sentence somebody reads in six months asking why AIES sent two people to Bataan. The
 * service demands at least a few words; the form says why rather than just enforcing it.
 *
 * ## Billable defaults to true, and says so
 *
 * A callout is chargeable unless somebody decides otherwise — warranty and goodwill are the
 * exceptions, not the rule. Defaulting the other way would quietly give work away, and §11's
 * warranty rules already exist to decide the exceptions properly.
 */
export function RaiseCallout({ onRaised }: { onRaised: () => void }) {
  const router = useRouter();
  const [open, setOpen] = useState(false);

  const accounts = trpc.crm.listAccounts.useQuery({}, { enabled: open });

  const [accountId, setAccountId] = useState("");
  const [type, setType] = useState<string>("after_sales");
  const [subType, setSubType] = useState<string>("");
  const [priority, setPriority] = useState<string>("normal");
  const [title, setTitle] = useState("");
  const [scopeOfWork, setScopeOfWork] = useState("");
  const [justification, setJustification] = useState("");
  const [billable, setBillable] = useState(true);
  const [requiredBy, setRequiredBy] = useState("");

  const create = trpc.operations.createStandaloneTicket.useMutation({
    onSuccess: (ticket) => {
      toastSuccess(`${ticket.number} raised.`);
      setOpen(false);
      onRaised();
      router.push(`/tickets/${ticket.id}`);
    },
    onError: toastError,
  });

  if (!open) {
    return (
      <Button size="sm" onClick={() => setOpen(true)}>
        Raise a callout
      </Button>
    );
  }

  const canSubmit =
    accountId !== "" &&
    title.trim().length > 0 &&
    scopeOfWork.trim().length > 0 &&
    justification.trim().length >= 3;

  return (
    <Card className="mt-4 p-4">
      <h2 className="text-sm font-semibold">Raise a callout</h2>
      <p className="mt-0.5 text-xs text-text-muted">
        Work that did not come from a sales order — a customer rings, something has broken.
        Everything else on this screen descends from an order; this is the one that does not.
      </p>

      <div className="mt-3 grid gap-3 sm:grid-cols-2">
        <div className="sm:col-span-2">
          <Label htmlFor="rc-account">Customer</Label>
          <Select
            id="rc-account"
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
          <Label htmlFor="rc-type">Kind of work</Label>
          <Select id="rc-type" value={type} onChange={(event) => setType(event.target.value)}>
            {TICKET_TYPES.map((value) => (
              <option key={value} value={value}>
                {value.replace(/_/g, " ")}
              </option>
            ))}
          </Select>
        </div>

        <div>
          <Label htmlFor="rc-sub">What kind of after-sales</Label>
          <Select
            id="rc-sub"
            value={subType}
            onChange={(event) => setSubType(event.target.value)}
            disabled={type !== "after_sales"}
          >
            <option value="">Not applicable</option>
            {AFTER_SALES_SUBTYPES.map((value) => (
              <option key={value} value={value}>
                {value.replace(/_/g, " ")}
              </option>
            ))}
          </Select>
        </div>

        <div className="sm:col-span-2">
          <Label htmlFor="rc-title">What is wrong</Label>
          <Input
            id="rc-title"
            value={title}
            placeholder="CV-1101 passing, plant cannot hold pressure"
            onChange={(event) => setTitle(event.target.value)}
          />
        </div>

        <div className="sm:col-span-2">
          <Label htmlFor="rc-scope">What AIES will do</Label>
          <Textarea
            id="rc-scope"
            rows={2}
            value={scopeOfWork}
            onChange={(event) => setScopeOfWork(event.target.value)}
          />
        </div>

        <div className="sm:col-span-2">
          <Label htmlFor="rc-why">Why this is being raised without an order</Label>
          <Textarea
            id="rc-why"
            rows={2}
            value={justification}
            placeholder="Customer rang at 07:00, plant down. Verbal go-ahead from Engr. Cruz; PO to follow."
            onChange={(event) => setJustification(event.target.value)}
          />
          <p className="mt-1 text-xs text-text-muted">
            Every other ticket is answerable to a sales order, which says who agreed to pay. This
            one has none, so these words are its authorisation — and what somebody reads in six
            months asking why AIES sent two people out.
          </p>
        </div>

        <div>
          <Label htmlFor="rc-priority">Priority</Label>
          <Select
            id="rc-priority"
            value={priority}
            onChange={(event) => setPriority(event.target.value)}
          >
            {TICKET_PRIORITIES.map((value) => (
              <option key={value} value={value}>
                {value}
              </option>
            ))}
          </Select>
        </div>

        <div>
          <Label htmlFor="rc-by">Needed by</Label>
          <Input
            id="rc-by"
            type="date"
            value={requiredBy}
            onChange={(event) => setRequiredBy(event.target.value)}
          />
        </div>

        <div className="sm:col-span-2">
          <label className="flex items-center gap-2 text-sm">
            <input
              type="checkbox"
              checked={billable}
              onChange={(event) => setBillable(event.target.checked)}
            />
            Chargeable to the customer
          </label>
          <p className="mt-1 text-xs text-text-muted">
            {billable
              ? "The default. Warranty and goodwill are the exceptions, and defaulting the other way gives work away quietly."
              : "Not chargeable — say why in the justification, because this is the company absorbing the cost."}
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
              type: type as (typeof TICKET_TYPES)[number],
              subType:
                type === "after_sales" && subType !== ""
                  ? (subType as (typeof AFTER_SALES_SUBTYPES)[number])
                  : null,
              priority: priority as (typeof TICKET_PRIORITIES)[number],
              title: title.trim(),
              scopeOfWork: scopeOfWork.trim(),
              justification: justification.trim(),
              billable,
              requiredByDate: requiredBy === "" ? null : new Date(requiredBy),
            })
          }
        >
          {create.isPending ? "Raising…" : "Raise it"}
        </Button>
        <Button variant="ghost" size="sm" onClick={() => setOpen(false)}>
          Discard
        </Button>
      </div>
    </Card>
  );
}
