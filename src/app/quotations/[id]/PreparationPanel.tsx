"use client";

import { useEffect, useState } from "react";
import { Attachments } from "@/components/ui/attachments";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/layout";
import { Label, Select, Textarea } from "@/components/ui/input";
import { toastError, toastSuccess } from "@/lib/errors";
import { trpc } from "@/lib/trpc/client";

const QUOTATION_ENTITY_TYPE = "Quotation";

/**
 * docs/DECISIONS.md #198 (company decision, 2026-09-09) — the method statement and the materials
 * list, prepared here instead of authored cold against a ticket that does not exist yet.
 *
 * The estimator already has the scope in front of them; a technician re-deriving "what's the method,
 * what do I need to bring" from a bare ticket weeks later is redoing work that was already done once.
 * Neither field gates anything any more (#197) — once a sales order exists, the ticket shows both
 * read-only, sourced straight from here.
 *
 * Materials priced as real supply lines already live on the quotation's own line table; this is
 * specifically the free-text list of what the crew needs beyond that — consumables, spares, anything
 * worth flagging now rather than guessed at after the PO lands.
 */
export function PreparationPanel({
  quotationId,
  version,
  editable,
  needsMethodStatement,
  methodStatementFileId,
  methodStatementNotes,
  materialsPreparedAtQuoting,
  materialsNotes,
  onSaved,
}: {
  quotationId: string;
  version: number;
  editable: boolean;
  needsMethodStatement: boolean;
  methodStatementFileId: string | null;
  methodStatementNotes: string | null;
  materialsPreparedAtQuoting: boolean;
  materialsNotes: string | null;
  onSaved: () => void;
}) {
  const [needsMethod, setNeedsMethod] = useState(needsMethodStatement);
  const [methodFileId, setMethodFileId] = useState(methodStatementFileId ?? "");
  const [methodNotes, setMethodNotes] = useState(methodStatementNotes ?? "");
  const [needsMaterials, setNeedsMaterials] = useState(materialsPreparedAtQuoting);
  const [materialNotes, setMaterialNotes] = useState(materialsNotes ?? "");

  useEffect(() => {
    setNeedsMethod(needsMethodStatement);
    setMethodFileId(methodStatementFileId ?? "");
    setMethodNotes(methodStatementNotes ?? "");
    setNeedsMaterials(materialsPreparedAtQuoting);
    setMaterialNotes(materialsNotes ?? "");
  }, [
    needsMethodStatement,
    methodStatementFileId,
    methodStatementNotes,
    materialsPreparedAtQuoting,
    materialsNotes,
  ]);

  const files = trpc.files.forEntity.useQuery({
    entityType: QUOTATION_ENTITY_TYPE,
    entityId: quotationId,
  });
  const save = trpc.quotation.updateHeader.useMutation({
    onSuccess: () => {
      toastSuccess("Saved.");
      onSaved();
    },
    onError: toastError,
  });

  return (
    <Card className="p-4">
      <h2 className="text-sm font-semibold">Method statement &amp; materials</h2>
      <p className="mt-0.5 text-xs text-text-muted">
        Prepared here, once — the ticket this quotation eventually produces shows both read-only.
        Neither blocks mobilisation any more.
      </p>

      <div className="mt-3 space-y-4">
        <div>
          <label className="flex items-center gap-1.5 text-sm font-medium">
            <input
              type="checkbox"
              checked={needsMethod}
              disabled={!editable}
              onChange={(e) => setNeedsMethod(e.target.checked)}
            />
            This job needs a method statement
          </label>

          {needsMethod && (
            <div className="mt-2 space-y-2 pl-5">
              <div>
                <Label htmlFor="method-notes">Sequence of work</Label>
                <Textarea
                  id="method-notes"
                  rows={3}
                  disabled={!editable}
                  value={methodNotes}
                  onChange={(e) => setMethodNotes(e.target.value)}
                  placeholder="What AIES does, in order — and explicitly what the customer supplies."
                />
              </div>
              {editable && (
                <Attachments entityType={QUOTATION_ENTITY_TYPE} entityId={quotationId} />
              )}
              <div className="w-72">
                <Label htmlFor="method-file">Prepared or client-approved document</Label>
                <Select
                  id="method-file"
                  value={methodFileId}
                  disabled={!editable}
                  onChange={(e) => setMethodFileId(e.target.value)}
                >
                  <option value="">Choose an attachment…</option>
                  {(files.data ?? []).map((file) => (
                    <option key={file.id} value={file.id}>
                      {file.filename}
                    </option>
                  ))}
                </Select>
              </div>
            </div>
          )}
        </div>

        <div>
          <label className="flex items-center gap-1.5 text-sm font-medium">
            <input
              type="checkbox"
              checked={needsMaterials}
              disabled={!editable}
              onChange={(e) => setNeedsMaterials(e.target.checked)}
            />
            Materials beyond the priced supply lines
          </label>
          {needsMaterials && (
            <div className="mt-2 pl-5">
              <Label htmlFor="material-notes">What the crew needs to bring, and quantities</Label>
              <Textarea
                id="material-notes"
                rows={2}
                disabled={!editable}
                value={materialNotes}
                onChange={(e) => setMaterialNotes(e.target.value)}
                placeholder="Consumables, spares — anything not already a priced line."
              />
              <p className="mt-1 text-xs text-text-muted">
                The actual stock request is raised after the customer&rsquo;s PO is recorded, not
                now — so nothing is committed against a deal that may not close.
              </p>
            </div>
          )}
        </div>
      </div>

      {editable && (
        <Button
          size="sm"
          className="mt-3"
          disabled={save.isPending}
          onClick={() =>
            save.mutate({
              quotationId,
              version,
              needsMethodStatement: needsMethod,
              methodStatementFileId: needsMethod ? methodFileId.trim() || null : null,
              methodStatementNotes: needsMethod ? methodNotes.trim() || null : null,
              materialsPreparedAtQuoting: needsMaterials,
              materialsNotes: needsMaterials ? materialNotes.trim() || null : null,
            })
          }
        >
          {save.isPending ? "Saving…" : "Save"}
        </Button>
      )}
    </Card>
  );
}
