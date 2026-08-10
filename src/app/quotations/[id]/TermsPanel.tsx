"use client";

import { useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/layout";
import { Input, Label, Textarea } from "@/components/ui/input";
import { toastError, toastSuccess } from "@/lib/errors";
import { trpc } from "@/lib/trpc/client";

/**
 * §7's commercial terms and standard terms and conditions, both editable.
 *
 * These print on the quotation and had no input anywhere — the PDF showed "—" against every one of
 * them because nothing could set them. The clauses are per-quotation rather than global: a
 * quotation is a contract, so the terms it carries have to be the ones that were on it, not
 * whichever set the company is using by the time somebody reprints it.
 *
 * Editable only while the quotation is a draft, like everything else on the record (§5).
 */
export function TermsPanel({
  quotationId,
  version,
  editable,
  deliveryLeadTime,
  incoterm,
  paymentTerms,
  warranty,
  termsAndConditions,
  onSaved,
}: {
  quotationId: string;
  version: number;
  editable: boolean;
  deliveryLeadTime: string | null;
  incoterm: string | null;
  paymentTerms: string | null;
  warranty: string | null;
  termsAndConditions: string[];
  onSaved: () => void;
}) {
  const [lead, setLead] = useState(deliveryLeadTime ?? "");
  const [term, setTerm] = useState(incoterm ?? "");
  const [payment, setPayment] = useState(paymentTerms ?? "");
  const [warrantyText, setWarrantyText] = useState(warranty ?? "");
  const [clauses, setClauses] = useState<string[]>(termsAndConditions);

  // Re-seed from the server after a save, so the panel shows what was stored rather than what was
  // typed — they differ if anything was trimmed or rejected.
  useEffect(() => {
    setLead(deliveryLeadTime ?? "");
    setTerm(incoterm ?? "");
    setPayment(paymentTerms ?? "");
    setWarrantyText(warranty ?? "");
    setClauses(termsAndConditions);
  }, [deliveryLeadTime, incoterm, paymentTerms, warranty, termsAndConditions]);

  const save = trpc.quotation.updateHeader.useMutation();

  const updateClause = (index: number, value: string) =>
    setClauses((current) => current.map((clause, i) => (i === index ? value : clause)));

  return (
    <Card className="p-4">
      <h2 className="text-sm font-semibold">Commercial terms</h2>
      <p className="mt-0.5 text-xs text-text-muted">These print on the quotation.</p>

      <div className="mt-3 grid gap-3 sm:grid-cols-2">
        <div>
          <Label htmlFor="t-lead">Delivery lead time</Label>
          <Input
            id="t-lead"
            value={lead}
            disabled={!editable}
            onChange={(e) => setLead(e.target.value)}
            placeholder="35-45 working days from PO and downpayment"
          />
        </div>
        <div>
          <Label htmlFor="t-incoterm">Delivery term</Label>
          <Input
            id="t-incoterm"
            value={term}
            disabled={!editable}
            onChange={(e) => setTerm(e.target.value)}
            placeholder="DDP site, Mandaluyong"
          />
        </div>
        <div>
          <Label htmlFor="t-payment">Payment terms</Label>
          <Input
            id="t-payment"
            value={payment}
            disabled={!editable}
            onChange={(e) => setPayment(e.target.value)}
            placeholder="100% Advance payment"
          />
        </div>
        <div>
          <Label htmlFor="t-warranty">Warranty</Label>
          <Input
            id="t-warranty"
            value={warrantyText}
            disabled={!editable}
            onChange={(e) => setWarrantyText(e.target.value)}
            placeholder="1 year warranty after completion of works"
          />
        </div>
      </div>

      <h3 className="mt-5 text-sm font-semibold">Terms and conditions</h3>
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
                  deliveryLeadTime: lead || null,
                  deliveryTermIncoterm: term || null,
                  paymentTermsText: payment || null,
                  warrantyTerms: warrantyText || null,
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
