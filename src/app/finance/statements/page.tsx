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
  PAYMENT_METHODS,
  PAYMENT_METHOD_LABELS,
  type PaymentMethod,
} from "@/server/core/finance/invoice-rules";
import { toastError, toastSuccess } from "@/lib/errors";
import { trpc } from "@/lib/trpc/client";

/**
 * §3's two documents, and the money between them.
 *
 * ## What was missing
 *
 * Fourteen finance procedures had no screen calling them, and this section was most of it: raising a
 * statement, issuing it, recording a payment, clearing a cheque. The platform could tell you a
 * milestone was ready to bill and offered no way to bill it; it could tell you a customer owed
 * ₱240,750 at eighty days and offered no way to record their cheque. docs/DECISIONS.md #135.
 *
 * ## Why one screen and not three
 *
 * §3 opens by insisting the two documents are *"not the same record"* — and the way to teach that is
 * to put them where a person can see one produce the other. A statement demands money and creates a
 * receivable; a **service invoice is issued when payment arrives**, and it is the document that
 * triggers VAT. Splitting them across screens would let somebody work here for a year without ever
 * noticing that AIES does not invoice on billing.
 *
 * So: statements down the page, each carrying the invoices it has produced, and the PDC register
 * beside them — because §3.3's warning is that a received cheque is not collected cash, and a
 * register nobody sees is the same as no register.
 */

const STATUS_TONE: Record<string, StatusTone> = {
  draft: "draft",
  pending_approval: "pending",
  issued: "info",
  partially_paid: "pending",
  paid: "approved",
  overdue: "failed",
  cancelled: "draft",
  written_off: "failed",
};

const pesos = (centavos: number) =>
  `₱${(centavos / 100).toLocaleString("en-PH", { minimumFractionDigits: 2 })}`;

type Statement = inferRouterOutputs<AppRouter>["finance"]["statements"][number];

export default function StatementsPage() {
  const statements = trpc.finance.statements.useQuery({});
  const cheques = trpc.finance.pendingCheques.useQuery();

  const drafts = statements.data?.filter((row) => row.status === "draft") ?? [];
  const open =
    statements.data?.filter((row) =>
      ["issued", "partially_paid", "overdue"].includes(row.status),
    ) ?? [];
  const settled =
    statements.data?.filter((row) => ["paid", "cancelled", "written_off"].includes(row.status)) ??
    [];

  function refresh() {
    void statements.refetch();
    void cheques.refetch();
  }

  return (
    <div className="mx-auto max-w-6xl">
      <PageHeader
        title="Billing statements"
        description="What has been asked for, what has been paid, and the service invoices the payments produced."
      />

      {/*
        §3's central fact, said once at the top.

        Not decoration. A billing clerk who believes AIES invoices on billing will create a VAT
        liability on money that has not arrived — the spec opens §3 by naming that as the thing
        getting this wrong causes.
      */}
      <Card className="mt-4 p-3">
        <p className="text-xs text-text-muted">
          A <strong>statement</strong> asks for money and creates a receivable. A{" "}
          <strong>service invoice</strong> is the BIR document, and it is issued{" "}
          <strong>when payment arrives</strong> — never at billing. Recording a payment below is
          what produces one.
        </p>
      </Card>

      {statements.isPending && <p className="mt-4 text-sm text-text-muted">Loading…</p>}
      {statements.error && (
        <Card className="mt-4 p-4">
          <p className="text-sm">{statements.error.message}</p>
        </Card>
      )}

      {cheques.data && cheques.data.length > 0 && (
        <Card className="mt-4 p-4">
          <h2 className="text-sm font-semibold">Cheques not yet cleared</h2>
          <p className="mt-0.5 text-xs text-text-muted">
            §3.3: a received cheque is not collected cash. Nothing here has settled a statement or
            produced an invoice — clearing it is what does that.
          </p>
          <ul className="mt-2 space-y-2">
            {cheques.data.map((cheque) => (
              <li key={cheque.id} className="rounded-md border border-border p-3">
                <div className="flex flex-wrap items-baseline justify-between gap-2">
                  <span className="flex flex-wrap items-baseline gap-2">
                    <span className="tabular font-medium">{cheque.number}</span>
                    <span className="text-sm">{cheque.accountName}</span>
                    {cheque.checkNumber && (
                      <span className="text-xs text-text-muted">cheque {cheque.checkNumber}</span>
                    )}
                  </span>
                  <span className="tabular font-medium">{pesos(cheque.amount)}</span>
                </div>
                <p className="mt-1 text-xs text-text-muted">
                  Received <DateCell value={cheque.receivedAt} />
                  {cheque.checkDate ? (
                    <>
                      {" · dated "}
                      <DateCell value={cheque.checkDate} />
                      {cheque.presentable ? " · can be presented" : " · post-dated, not yet due"}
                    </>
                  ) : (
                    " · no cheque date recorded"
                  )}
                </p>
                <ChequeActions id={cheque.id} number={cheque.number} onDone={refresh} />
              </li>
            ))}
          </ul>
        </Card>
      )}

      <Section
        title="Drafts"
        blurb="Raised and not yet sent. A draft asks nobody for anything — issuing it is what does."
        rows={drafts}
        empty="No drafts. Raise one from Ready to bill."
        onChanged={refresh}
      />
      <Section
        title="Open"
        blurb="Issued and not fully paid."
        rows={open}
        empty="Nothing is outstanding."
        onChanged={refresh}
      />
      <Section
        title="Settled and cancelled"
        blurb="Paid, cancelled or written off. Cancelled statements are kept, never deleted."
        rows={settled}
        empty="Nothing here yet."
        onChanged={refresh}
      />
    </div>
  );
}

function Section({
  title,
  blurb,
  rows,
  empty,
  onChanged,
}: {
  title: string;
  blurb: string;
  rows: Statement[];
  empty: string;
  onChanged: () => void;
}) {
  return (
    <Card className="mt-4 p-4">
      <h2 className="text-sm font-semibold">{title}</h2>
      <p className="mt-0.5 text-xs text-text-muted">{blurb}</p>
      {rows.length === 0 ? (
        <p className="mt-2 text-sm text-text-muted">{empty}</p>
      ) : (
        <ul className="mt-2 space-y-2">
          {rows.map((row) => (
            <li key={row.id} className="rounded-md border border-border p-3">
              <StatementRow row={row} onChanged={onChanged} />
            </li>
          ))}
        </ul>
      )}
    </Card>
  );
}

function StatementRow({ row, onChanged }: { row: Statement; onChanged: () => void }) {
  const [paying, setPaying] = useState(false);
  const [cancelling, setCancelling] = useState(false);
  const [reason, setReason] = useState("");

  const issue = trpc.finance.issueStatement.useMutation({
    onSuccess: () => {
      toastSuccess(`${row.number} issued. It is now a receivable.`);
      onChanged();
    },
    onError: toastError,
  });

  const cancel = trpc.finance.cancelStatement.useMutation({
    onSuccess: () => {
      toastSuccess(`${row.number} cancelled.`);
      setCancelling(false);
      setReason("");
      onChanged();
    },
    onError: toastError,
  });

  return (
    <>
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <span className="flex flex-wrap items-baseline gap-2">
          <span className="tabular font-medium">{row.number}</span>
          <span className="text-sm">{row.accountName}</span>
          <span className="text-xs text-text-muted">{row.type.replace(/_/g, " ")}</span>
        </span>
        <span className="flex items-center gap-2">
          <StatusBadge tone={STATUS_TONE[row.status] ?? "draft"}>
            {row.status.replace(/_/g, " ")}
          </StatusBadge>
          <span className="tabular font-medium">{pesos(row.total)}</span>
        </span>
      </div>

      <p className="mt-1 text-xs text-text-muted">
        Dated <DateCell value={row.statementDate} /> · due <DateCell value={row.dueDate} />
        {row.poReference ? ` · their PO ${row.poReference}` : ""}
        {row.balance !== row.total ? ` · ${pesos(row.amountPaid)} paid` : ""}
      </p>

      {/*
        §3's other document — the one this screen is actually named after. issueStatementService used
        to only flip a status column; there was nothing here a person could open, print or attach to
        an email. docs/DECISIONS.md #181.
      */}
      <p className="mt-1 flex flex-wrap items-baseline gap-x-3 text-xs">
        <a
          href={`/api/billing-statements/${row.id}/pdf`}
          target="_blank"
          rel="noreferrer"
          className={`underline ${row.status === "cancelled" ? "text-danger" : ""}`}
        >
          Download statement PDF
        </a>
        <a
          href={`/api/customer-accounts/${row.accountId}/statement-of-account/pdf`}
          target="_blank"
          rel="noreferrer"
          className="underline text-text-muted"
        >
          {row.accountName}&rsquo;s statement of account
        </a>
      </p>

      {/*
        §3.2's expected net collectible.

        Shown on every withholding customer's statement, because the spec's reason is a human one:
        "so nobody is surprised when less money arrives than the statement said." The gap is the 2307
        the customer owes AIES, which is real money and worthless if never collected.
      */}
      {row.withholds && row.expectedWithholdingAmount > 0 && (
        <p className="mt-1 text-xs">
          Customer withholds <span className="tabular">{pesos(row.expectedWithholdingAmount)}</span>{" "}
          — expect <span className="tabular font-medium">{pesos(row.expectedNetCollectible)}</span>{" "}
          to arrive, plus a 2307.
        </p>
      )}

      {/*
        The BIR document, openable.

        It existed as a number on a row and nothing else — AIES was issuing invoices it could not
        print or send to the customer who needs them. §3.3 says what the PDF must carry; the link is
        what makes it reachable. docs/DECISIONS.md #135.
      */}
      {row.invoices.length > 0 && (
        <p className="mt-1 flex flex-wrap items-baseline gap-x-3 text-xs">
          <span className="text-text-muted">
            Service invoice{row.invoices.length === 1 ? "" : "s"}:
          </span>
          {row.invoices.map((invoice) => (
            <span key={invoice.id} className="flex items-baseline gap-2">
              <a
                href={`/api/service-invoices/${invoice.id}/pdf`}
                target="_blank"
                rel="noreferrer"
                className={`underline ${invoice.status === "cancelled" ? "text-danger" : ""}`}
              >
                {invoice.number}
                {invoice.status === "cancelled" ? " (cancelled)" : ""}
              </a>
              {invoice.status !== "cancelled" && (
                <CancelInvoice invoiceId={invoice.id} number={invoice.number} onDone={onChanged} />
              )}
            </span>
          ))}
        </p>
      )}

      <div className="mt-2 flex flex-wrap gap-2">
        {row.status === "draft" && (
          <Button
            size="sm"
            disabled={issue.isPending}
            onClick={() => issue.mutate({ statementId: row.id })}
          >
            {issue.isPending ? "Issuing…" : "Issue it"}
          </Button>
        )}

        {["issued", "partially_paid", "overdue"].includes(row.status) && !paying && (
          <Button size="sm" onClick={() => setPaying(true)}>
            Record a payment
          </Button>
        )}

        {["draft", "issued"].includes(row.status) && !cancelling && (
          <Button variant="ghost" size="sm" onClick={() => setCancelling(true)}>
            Cancel it…
          </Button>
        )}
      </div>

      {cancelling && (
        <div className="mt-2 rounded-md border border-border p-2.5">
          <Label htmlFor={`bs-cancel-${row.id}`}>Why it is being cancelled</Label>
          <Input
            id={`bs-cancel-${row.id}`}
            value={reason}
            placeholder="Raised against the wrong milestone; replaced by AIESBS-260511."
            onChange={(event) => setReason(event.target.value)}
          />
          <p className="mt-1 text-xs text-text-muted">
            The statement is kept and marked, never deleted — a number that vanishes is one nobody
            can account for.
          </p>
          <div className="mt-2 flex gap-2">
            <Button
              size="sm"
              disabled={cancel.isPending || reason.trim().length < 5}
              onClick={() => cancel.mutate({ statementId: row.id, reason: reason.trim() })}
            >
              Cancel it
            </Button>
            <Button variant="ghost" size="sm" onClick={() => setCancelling(false)}>
              Keep it
            </Button>
          </div>
        </div>
      )}

      {paying && (
        <RecordPayment
          statement={row}
          onDone={() => {
            setPaying(false);
            onChanged();
          }}
          onCancel={() => setPaying(false)}
        />
      )}
    </>
  );
}

/**
 * §3.1 — recording the money, which issues the BIR document.
 *
 * The spec calls this "a transaction that produces a BIR document, not a bookkeeping note", and the
 * form is shaped to make that visible rather than surprising: the invoice is named as an outcome
 * before the button is pressed, and the withholding field carries the expected figure so a mismatch
 * is noticed at the moment of entry rather than at year end.
 *
 * A cheque is different, and says so: it settles nothing until it clears.
 */
function RecordPayment({
  statement,
  onDone,
  onCancel,
}: {
  statement: Statement;
  onDone: () => void;
  onCancel: () => void;
}) {
  const [method, setMethod] = useState<PaymentMethod>("bank_transfer");
  const [amount, setAmount] = useState((statement.expectedNetCollectible / 100).toFixed(2));
  const [receivedAt, setReceivedAt] = useState(() => new Date().toISOString().slice(0, 10));
  const [reference, setReference] = useState("");
  const [checkNumber, setCheckNumber] = useState("");
  const [checkDate, setCheckDate] = useState("");
  const [withholding, setWithholding] = useState(
    statement.withholds ? (statement.expectedWithholdingAmount / 100).toFixed(2) : "",
  );
  const [notes, setNotes] = useState("");

  const record = trpc.finance.recordPayment.useMutation({
    onSuccess: (result) => {
      /*
        Told what actually happened, read from the result rather than inferred from the method.

        The first version of this branched on `method === "check"` and looked for a field called
        `invoiceNumber` that does not exist — the service returns `serviceInvoiceNumber` — so it
        would have said "Payment recorded." and never named the BIR document it had just issued.
        Reading the result means the message stays true if §3's rules about when an invoice is
        issued ever change.
      */
      if (result.serviceInvoiceNumber) {
        toastSuccess(
          `${result.paymentNumber} recorded. Service invoice ${result.serviceInvoiceNumber} issued.`,
        );
      } else {
        toastSuccess(
          `${result.paymentNumber} recorded. No service invoice yet — the money is not collected ` +
            `until the cheque clears, and it is in the register above.`,
        );
      }
      onDone();
    },
    onError: toastError,
  });

  const isCheque = method === "check";
  const parsed = Number(amount);
  const canSubmit =
    Number.isFinite(parsed) &&
    parsed > 0 &&
    receivedAt !== "" &&
    reference.trim().length > 0 &&
    (!isCheque || checkNumber.trim().length > 0);

  const expectedWithholding = statement.expectedWithholdingAmount / 100;
  const enteredWithholding = Number(withholding || 0);
  const withholdingMismatch =
    statement.withholds && Math.abs(enteredWithholding - expectedWithholding) > 0.005;

  return (
    <div className="mt-2 rounded-md border border-border p-3">
      <h3 className="text-sm font-semibold">Record a payment against {statement.number}</h3>
      <p className="mt-0.5 text-xs text-text-muted">
        {isCheque
          ? "A cheque goes to the register until it clears. No invoice is issued yet — §3.3."
          : "This issues a service invoice, numbered from the BIR sequence, and settles the statement."}
      </p>

      <div className="mt-3 grid gap-3 sm:grid-cols-2">
        <div>
          <Label htmlFor={`pm-method-${statement.id}`}>How it arrived</Label>
          <Select
            id={`pm-method-${statement.id}`}
            value={method}
            onChange={(event) => setMethod(event.target.value as PaymentMethod)}
          >
            {PAYMENT_METHODS.map((value) => (
              <option key={value} value={value}>
                {PAYMENT_METHOD_LABELS[value]}
              </option>
            ))}
          </Select>
        </div>

        <div>
          <Label htmlFor={`pm-amount-${statement.id}`}>Amount received</Label>
          <Input
            id={`pm-amount-${statement.id}`}
            type="number"
            step="0.01"
            min="0"
            value={amount}
            onChange={(event) => setAmount(event.target.value)}
          />
          {statement.withholds && (
            <p className="mt-1 text-xs text-text-muted">
              Pre-filled with the expected net after withholding, not the statement total.
            </p>
          )}
        </div>

        <div>
          <Label htmlFor={`pm-date-${statement.id}`}>Date received</Label>
          <Input
            id={`pm-date-${statement.id}`}
            type="date"
            value={receivedAt}
            onChange={(event) => setReceivedAt(event.target.value)}
          />
        </div>

        <div>
          <Label htmlFor={`pm-ref-${statement.id}`}>Reference</Label>
          <Input
            id={`pm-ref-${statement.id}`}
            value={reference}
            placeholder="BDO deposit slip 4471902"
            onChange={(event) => setReference(event.target.value)}
          />
        </div>

        {isCheque && (
          <>
            <div>
              <Label htmlFor={`pm-cheque-${statement.id}`}>Cheque number</Label>
              <Input
                id={`pm-cheque-${statement.id}`}
                value={checkNumber}
                onChange={(event) => setCheckNumber(event.target.value)}
              />
            </div>
            <div>
              <Label htmlFor={`pm-chequedate-${statement.id}`}>Cheque date</Label>
              <Input
                id={`pm-chequedate-${statement.id}`}
                type="date"
                value={checkDate}
                onChange={(event) => setCheckDate(event.target.value)}
              />
              <p className="mt-1 text-xs text-text-muted">
                A post-dated cheque is normal here. It sits in the register until this date passes
                and it clears.
              </p>
            </div>
          </>
        )}

        {statement.withholds && (
          <div className="sm:col-span-2">
            <Label htmlFor={`pm-ewt-${statement.id}`}>Tax withheld by the customer</Label>
            <Input
              id={`pm-ewt-${statement.id}`}
              type="number"
              step="0.01"
              min="0"
              value={withholding}
              onChange={(event) => setWithholding(event.target.value)}
            />
            {/*
              §3.2: the system "checks it against the expected figure and flags a mismatch rather
              than accepting it silently." Flagged, not refused — customers do withhold at rates
              nobody told AIES about, and refusing would stop a real payment being recorded.
            */}
            {withholdingMismatch && (
              <p className="mt-1 text-xs text-amber-700">
                Expected {pesos(statement.expectedWithholdingAmount)} at the account&rsquo;s rate.
                Recording a different figure is fine — check the 2307 says the same, because that is
                what AIES claims against income tax.
              </p>
            )}
            <p className="mt-1 text-xs text-text-muted">
              Withheld tax is money AIES only gets back with the 2307. It appears in the outstanding
              2307 register until the form arrives.
            </p>
          </div>
        )}

        <div className="sm:col-span-2">
          <Label htmlFor={`pm-notes-${statement.id}`}>Notes</Label>
          <Textarea
            id={`pm-notes-${statement.id}`}
            rows={2}
            value={notes}
            onChange={(event) => setNotes(event.target.value)}
          />
        </div>
      </div>

      <div className="mt-3 flex gap-2">
        <Button
          size="sm"
          disabled={!canSubmit || record.isPending}
          onClick={() =>
            record.mutate({
              accountId: statement.accountId,
              receivedAt: new Date(receivedAt),
              method,
              amount: Math.round(parsed * 100),
              reference: reference.trim(),
              checkNumber: isCheque ? checkNumber.trim() : null,
              checkDate: isCheque && checkDate !== "" ? new Date(checkDate) : null,
              withholdingTaxAmount:
                withholding.trim() === "" ? undefined : Math.round(Number(withholding) * 100),
              notes: notes.trim() === "" ? null : notes.trim(),
              allocations: [{ billingStatementId: statement.id, amount: Math.round(parsed * 100) }],
            })
          }
        >
          {record.isPending ? "Recording…" : isCheque ? "Record the cheque" : "Record it"}
        </Button>
        <Button variant="ghost" size="sm" onClick={onCancel}>
          Discard
        </Button>
      </div>
    </div>
  );
}

/**
 * Clearing or bouncing a cheque.
 *
 * Both are one press and neither is undoable, which is right: they are statements about what the
 * bank did. A bounce needs a reason, because a bounced cheque is a conversation with the customer
 * and "it bounced" is not the start of one.
 */
function ChequeActions({ id, number, onDone }: { id: string; number: string; onDone: () => void }) {
  const [bouncing, setBouncing] = useState(false);
  const [reason, setReason] = useState("");

  const clear = trpc.finance.clearCheque.useMutation({
    onSuccess: () => {
      toastSuccess(`${number} cleared. The statement is settled and the invoice issued.`);
      onDone();
    },
    onError: toastError,
  });

  const bounce = trpc.finance.bounceCheque.useMutation({
    onSuccess: () => {
      toastSuccess(`${number} marked as bounced.`);
      setBouncing(false);
      setReason("");
      onDone();
    },
    onError: toastError,
  });

  if (bouncing) {
    return (
      <div className="mt-2 rounded-md border border-border p-2.5">
        <Label htmlFor={`ch-why-${id}`}>What the bank said</Label>
        <Input
          id={`ch-why-${id}`}
          value={reason}
          placeholder="Returned unpaid — drawer's funds insufficient, 18 Aug."
          onChange={(event) => setReason(event.target.value)}
        />
        <div className="mt-2 flex gap-2">
          <Button
            size="sm"
            disabled={bounce.isPending || reason.trim().length < 5}
            onClick={() => bounce.mutate({ paymentId: id, reason: reason.trim() })}
          >
            Mark it bounced
          </Button>
          <Button variant="ghost" size="sm" onClick={() => setBouncing(false)}>
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
        disabled={clear.isPending}
        onClick={() => clear.mutate({ paymentId: id })}
      >
        {clear.isPending ? "Clearing…" : "It cleared"}
      </Button>
      <Button variant="ghost" size="sm" onClick={() => setBouncing(true)}>
        It bounced…
      </Button>
    </div>
  );
}

/**
 * Voiding a BIR document.
 *
 * ## Why the wording is heavier than everywhere else on this screen
 *
 * A cancelled service invoice is not an undo. §3: *"Cancelled or voided invoices are retained and
 * marked, never deleted or renumbered."* The number stays in the series, the document still prints
 * with the cancellation across it, and the reason becomes AIES's answer if the BIR asks what that
 * number was used for. Everything else here can be corrected; this can only be annotated.
 *
 * Held on `invoice.cancel` — the President and Vice President only — because it is the one act in
 * §3 whose consequences reach outside the company.
 */
function CancelInvoice({
  invoiceId,
  number,
  onDone,
}: {
  invoiceId: string;
  number: string;
  onDone: () => void;
}) {
  const [open, setOpen] = useState(false);
  const [reason, setReason] = useState("");

  const cancel = trpc.finance.cancelInvoice.useMutation({
    onSuccess: () => {
      toastSuccess(`${number} cancelled. It is retained and marked, and still prints.`);
      setOpen(false);
      setReason("");
      onDone();
    },
    onError: toastError,
  });

  if (!open) {
    return (
      <button
        type="button"
        className="text-xs text-text-muted underline"
        onClick={() => setOpen(true)}
      >
        void…
      </button>
    );
  }

  return (
    <span className="mt-1 block w-full rounded-md border border-border p-2.5">
      <Label htmlFor={`ci-${invoiceId}`}>Why {number} is being voided</Label>
      <Input
        id={`ci-${invoiceId}`}
        value={reason}
        placeholder="Issued against the wrong customer; replaced by AIESSI-260201."
        onChange={(event) => setReason(event.target.value)}
      />
      <span className="mt-1 block text-xs text-text-muted">
        The number is not reused and the document still prints, marked. This reason is what AIES
        shows the BIR if they ask what the number was used for.
      </span>
      <span className="mt-2 flex gap-2">
        <Button
          size="sm"
          disabled={cancel.isPending || reason.trim().length < 5}
          onClick={() => cancel.mutate({ serviceInvoiceId: invoiceId, reason: reason.trim() })}
        >
          Void it
        </Button>
        <Button variant="ghost" size="sm" onClick={() => setOpen(false)}>
          Keep it
        </Button>
      </span>
    </span>
  );
}
