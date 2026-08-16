"use client";

import { useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/layout";
import { Textarea } from "@/components/ui/input";
import { toastError, toastSuccess } from "@/lib/errors";
import { trpc } from "@/lib/trpc/client";

/**
 * §7's terms and conditions.
 *
 * The clauses are per-quotation rather than global: a quotation is a contract, so the terms it
 * carries have to be the ones that were on it, not whichever set the company is using by the time
 * somebody reprints it.
 *
 * A block of four structured fields — delivery lead time, delivery term, payment terms, warranty —
 * sat above these until 2026-08-16 and was removed at the company's request. It duplicated clauses
 * the default set already carries word for word (LEAD TIME, PAYMENT TERMS, WARRANTY, DELIVERY in
 * terms.ts), so the document said each of them twice and two copies had to be kept in step.
 *
 * Editable only while the quotation is a draft, like everything else on the record (§5).
 */
export function TermsPanel({
  quotationId,
  version,
  editable,
  termsAndConditions,
  onSaved,
}: {
  quotationId: string;
  version: number;
  editable: boolean;
  termsAndConditions: string[];
  onSaved: () => void;
}) {
  const [clauses, setClauses] = useState<string[]>(termsAndConditions);

  // Re-seed from the server after a save, so the panel shows what was stored rather than what was
  // typed — they differ if anything was trimmed or rejected.
  useEffect(() => {
    setClauses(termsAndConditions);
  }, [termsAndConditions]);

  const save = trpc.quotation.updateHeader.useMutation();

  const updateClause = (index: number, value: string) =>
    setClauses((current) => current.map((clause, i) => (i === index ? value : clause)));

  return (
    <Card className="p-4">
      {/*
        The four structured fields that used to live here — delivery lead time, delivery term,
        payment terms and warranty — were removed on 2026-08-16 at the company's request.
        DEFAULT_TERMS_AND_CONDITIONS in terms.ts already carries LEAD TIME, PAYMENT TERMS, WARRANTY
        and DELIVERY as numbered clauses, with the same words, so the quotation stated every one of
        them twice and somebody had to keep the two copies in step.

        The columns are still on the model and are not written by this screen: nothing was migrated
        away, so restoring the block is a UI change if the company ever wants it back.
      */}
      <h2 className="text-sm font-semibold">Terms and conditions</h2>
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
                  // The four commercial-terms fields are deliberately not sent: this screen no
                  // longer edits them, and writing back stale state would be a silent edit.
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
