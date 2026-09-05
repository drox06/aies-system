"use client";

import { useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/layout";
import { Input, Label, Select, Textarea } from "@/components/ui/input";
import { toastError, toastSuccess } from "@/lib/errors";
import { trpc } from "@/lib/trpc/client";
import {
  CLAUSE_PREFIXES,
  deliveryClause,
  leadTimeClause,
  paymentTermsClause,
  replaceClause,
  validityClause,
  warrantyClause,
} from "@/server/core/quotation/terms";

/**
 * §7's terms and conditions, plus the five commercial fields a quotation is actually quoted on.
 *
 * The clauses are per-quotation rather than global: a quotation is a contract, so the terms it
 * carries have to be the ones that were on it, not whichever set the company is using by the time
 * somebody reprints it.
 *
 * A block of structured fields sat above these until 2026-08-16 and was removed at the company's
 * request, because it printed the same fact twice — a summary value, and the same value again inside
 * a numbered clause, two copies somebody had to keep in step by hand. Removing it also silently
 * removed the only way to set `paymentTermsId`, which is what a sales order's billing plan is
 * generated from — nothing caught that until a real order couldn't be billed (docs/DECISIONS.md
 * #150, finding 2). The five pickers below fix both problems at once: each one *writes* its clause
 * rather than duplicating it, so there is exactly one copy of the fact, and the clause is simply how
 * it is displayed. A clause stays freely editable afterward — changing the picker again just
 * regenerates it from the template, and always wins when used.
 *
 * Editable only while the quotation is a draft, like everything else on the record (§5).
 */

/** `<input type="date">` wants `YYYY-MM-DD`; `validUntil` arrives as either a `Date` or an ISO
 *  string depending on the caller, so this normalises rather than assuming one. */
function toDateInputValue(validUntil: Date | string): string {
  const date = typeof validUntil === "string" ? new Date(validUntil) : validUntil;
  return date.toISOString().slice(0, 10);
}

export function TermsPanel({
  quotationId,
  version,
  editable,
  paymentTermsId,
  deliveryTermIncoterm,
  deliveryLeadTime,
  validUntil,
  warrantyTerms,
  termsAndConditions,
  onSaved,
}: {
  quotationId: string;
  version: number;
  editable: boolean;
  paymentTermsId: string | null;
  deliveryTermIncoterm: string | null;
  deliveryLeadTime: string | null;
  /** superjson revives this as a real `Date` on the client, despite `quotation.get`'s own type cast
   *  calling it a string — accept either rather than assume. */
  validUntil: Date | string;
  warrantyTerms: string | null;
  termsAndConditions: string[];
  onSaved: () => void;
}) {
  const [clauses, setClauses] = useState<string[]>(termsAndConditions);
  const [paymentTermId, setPaymentTermId] = useState(paymentTermsId ?? "");
  const [incoterm, setIncoterm] = useState(deliveryTermIncoterm ?? "");
  const [leadTime, setLeadTime] = useState(deliveryLeadTime ?? "");
  const [validUntilDate, setValidUntilDate] = useState(toDateInputValue(validUntil));
  const [warranty, setWarranty] = useState(warrantyTerms ?? "");

  const paymentTerms = trpc.quotation.listPaymentTerms.useQuery();

  // Re-seed from the server after a save, so the panel shows what was stored rather than what was
  // typed — they differ if anything was trimmed or rejected.
  useEffect(() => {
    setClauses(termsAndConditions);
    setPaymentTermId(paymentTermsId ?? "");
    setIncoterm(deliveryTermIncoterm ?? "");
    setLeadTime(deliveryLeadTime ?? "");
    setValidUntilDate(toDateInputValue(validUntil));
    setWarranty(warrantyTerms ?? "");
  }, [
    termsAndConditions,
    paymentTermsId,
    deliveryTermIncoterm,
    deliveryLeadTime,
    validUntil,
    warrantyTerms,
  ]);

  const save = trpc.quotation.updateHeader.useMutation();

  const updateClause = (index: number, value: string) =>
    setClauses((current) => current.map((clause, i) => (i === index ? value : clause)));

  return (
    <Card className="p-4">
      <h2 className="text-sm font-semibold">Quotation terms</h2>
      <p className="mt-0.5 text-xs text-text-muted">
        Each of these writes its own numbered clause below when changed — there is nothing else to
        keep in step.
      </p>

      <div className="mt-2 grid grid-cols-1 gap-x-4 gap-y-3 sm:grid-cols-2">
        <div>
          <Label htmlFor="payment-term">Payment term</Label>
          <Select
            id="payment-term"
            className="mt-1"
            value={paymentTermId}
            disabled={!editable || paymentTerms.isPending}
            onChange={(e) => {
              const id = e.target.value;
              setPaymentTermId(id);
              const term = paymentTerms.data?.find((t) => t.id === id) ?? null;
              setClauses((current) =>
                replaceClause(current, CLAUSE_PREFIXES.paymentTerms, paymentTermsClause(term)),
              );
            }}
          >
            <option value="">Not set</option>
            {paymentTerms.data?.map((term) => (
              <option key={term.id} value={term.id}>
                {term.name}
              </option>
            ))}
          </Select>
          {!paymentTermId && (
            <p className="mt-1 text-xs text-amber-700">
              Nothing on the resulting order can be billed until this is set.
            </p>
          )}
        </div>

        <div>
          <Label htmlFor="quotation-validity">Quotation validity</Label>
          <Input
            id="quotation-validity"
            type="date"
            className="mt-1"
            value={validUntilDate}
            disabled={!editable}
            onChange={(e) => {
              const value = e.target.value;
              setValidUntilDate(value);
              setClauses((current) =>
                replaceClause(current, CLAUSE_PREFIXES.validity, validityClause(value || null)),
              );
            }}
          />
        </div>

        <div>
          <Label htmlFor="delivery-term">Delivery term</Label>
          <Input
            id="delivery-term"
            className="mt-1"
            placeholder="e.g. DDP site, Mandaluyong"
            value={incoterm}
            disabled={!editable}
            onChange={(e) => {
              const value = e.target.value;
              setIncoterm(value);
              setClauses((current) =>
                replaceClause(current, CLAUSE_PREFIXES.delivery, deliveryClause(value || null)),
              );
            }}
          />
        </div>

        <div>
          <Label htmlFor="lead-time">Lead time</Label>
          <Input
            id="lead-time"
            className="mt-1"
            placeholder="e.g. 35-45 working days"
            value={leadTime}
            disabled={!editable}
            onChange={(e) => {
              const value = e.target.value;
              setLeadTime(value);
              setClauses((current) =>
                replaceClause(current, CLAUSE_PREFIXES.leadTime, leadTimeClause(value || null)),
              );
            }}
          />
        </div>

        <div>
          <Label htmlFor="warranty">Warranty</Label>
          <Input
            id="warranty"
            className="mt-1"
            placeholder="e.g. 1 year"
            value={warranty}
            disabled={!editable}
            onChange={(e) => {
              const value = e.target.value;
              setWarranty(value);
              setClauses((current) =>
                replaceClause(current, CLAUSE_PREFIXES.warranty, warrantyClause(value || null)),
              );
            }}
          />
        </div>
      </div>

      <h2 className="mt-5 text-sm font-semibold">Terms and conditions</h2>
      <p className="mt-0.5 text-xs text-text-muted">
        Numbered on the document in this order. Each clause is editable, and they belong to this
        quotation — changing them here does not change any other.
      </p>

      <div className="mt-2 space-y-2">
        {clauses.map((clause, index) => (
          <div key={index} className="flex gap-2">
            <span className="tabular mt-2 w-5 shrink-0 text-xs text-text-muted">{index + 1}</span>
            <Textarea
              aria-label={`Clause ${index + 1}`}
              rows={Math.max(2, Math.ceil(clause.length / 90))}
              className="text-xs"
              value={clause}
              disabled={!editable}
              onChange={(e) => updateClause(index, e.target.value)}
            />
            {editable && (
              <Button
                variant="ghost"
                size="sm"
                className="mt-1 shrink-0"
                aria-label={`Remove clause ${index + 1}`}
                onClick={() => setClauses((current) => current.filter((_, i) => i !== index))}
              >
                ×
              </Button>
            )}
          </div>
        ))}
      </div>

      {editable && (
        <div className="mt-3 flex flex-wrap gap-2">
          <Button variant="ghost" size="sm" onClick={() => setClauses((c) => [...c, ""])}>
            Add clause
          </Button>
          <Button
            size="sm"
            disabled={save.isPending}
            onClick={async () => {
              try {
                await save.mutateAsync({
                  quotationId,
                  version,
                  paymentTermsId: paymentTermId || null,
                  deliveryTermIncoterm: incoterm.trim() || null,
                  deliveryLeadTime: leadTime.trim() || null,
                  // `validUntil` is a required column — an emptied date field leaves it unchanged
                  // rather than sending a null the database would refuse.
                  validUntil: validUntilDate ? new Date(validUntilDate) : undefined,
                  warrantyTerms: warranty.trim() || null,
                  // Blank clauses dropped rather than printed as an empty numbered line.
                  termsAndConditions: clauses.map((c) => c.trim()).filter((c) => c.length > 0),
                });
                toastSuccess("Terms saved.");
                onSaved();
              } catch (error) {
                toastError(error);
              }
            }}
          >
            {save.isPending ? "Saving…" : "Save terms"}
          </Button>
        </div>
      )}
    </Card>
  );
}
