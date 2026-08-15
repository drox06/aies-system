"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { Button } from "@/components/ui/button";
import { DateCell } from "@/components/ui/cells";
import { Card } from "@/components/ui/layout";
import { Label, Select, Textarea } from "@/components/ui/input";
import { StatusBadge } from "@/components/ui/status-badge";
import { REVISION_REASONS, isRevisable } from "@/server/core/quotation/quotation-lifecycle";
import { formatMoney } from "@/lib/format";
import { toastError, toastSuccess } from "@/lib/errors";
import { trpc } from "@/lib/trpc/client";

/**
 * §5's revision chain and diff.
 *
 * §5 on why the diff exists, and it is not decoration: "Sales needs this in front of them during
 * negotiation calls." So it defaults to comparing the current revision against the one before it —
 * the question being asked on the phone is almost always "what changed since the last one?".
 */
export function RevisionPanel({
  quotationId,
  status,
  revision,
  currency,
  onRevised,
}: {
  quotationId: string;
  status: string;
  revision: number;
  currency: string;
  onRevised: () => void;
}) {
  const router = useRouter();
  const [reviseOpen, setReviseOpen] = useState(false);
  const [reason, setReason] = useState<(typeof REVISION_REASONS)[number]>("price_negotiation");
  const [note, setNote] = useState("");
  const [compareTo, setCompareTo] = useState<string | null>(null);

  const chain = trpc.quotation.revisions.useQuery({ quotationId });
  const revise = trpc.quotation.revise.useMutation();

  const rows = chain.data ?? [];
  const current = rows.find((r) => r.revision === revision);
  const previous = rows.filter((r) => r.revision < revision).at(-1);
  const fromId = compareTo ?? previous?.id ?? null;

  const diff = trpc.quotation.diff.useQuery(
    { fromId: fromId ?? "", toId: current?.id ?? "" },
    { enabled: Boolean(fromId && current) },
  );

  return (
    <Card className="p-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h2 className="text-sm font-semibold">Revisions</h2>
        {isRevisable(status) && (
          // Blue, at the company's request. §5 makes a sent quotation immutable, so once one is out
          // with a customer this is the *only* way to change anything on it — and a ghost button on
          // the one action a screen still permits reads as decoration. Spec.md §6.3 gives blue to
          // "every primary action", which this now plainly is.
          <Button size="sm" onClick={() => setReviseOpen((v) => !v)}>
            {reviseOpen ? "Cancel" : "Revise"}
          </Button>
        )}
      </div>

      {rows.length <= 1 && !reviseOpen && (
        <p className="mt-1 text-sm text-text-muted">
          {isRevisable(status)
            ? "No revisions yet. Revising creates a new draft; this one stays as the customer has it."
            : "No revisions. A quotation can only be revised once the customer has seen it."}
        </p>
      )}

      {rows.length > 1 && (
        <ul className="mt-2 divide-y divide-border text-sm">
          {rows.map((row) => (
            <li key={row.id} className="flex flex-wrap items-center justify-between gap-2 py-2">
              <button
                type="button"
                className="min-w-0 flex-1 text-left hover:underline"
                onClick={() => router.push(`/quotations/${row.id}`)}
              >
                <span className="tabular font-medium">{row.displayNumber}</span>
                {row.revisionReason && (
                  <span className="ml-2 text-xs text-text-muted">
                    {row.revisionReason.replace(/_/g, " ")}
                  </span>
                )}
              </button>
              <span className="tabular text-xs">{formatMoney(row.total, currency)}</span>
              <StatusBadge tone={row.id === current?.id ? "active" : "draft"}>
                {row.status.replace(/_/g, " ")}
              </StatusBadge>
            </li>
          ))}
        </ul>
      )}

      {reviseOpen && (
        <div className="mt-3 rounded border border-border p-3">
          <Label htmlFor="rev-reason">Why is it being revised?</Label>
          <Select
            id="rev-reason"
            value={reason}
            onChange={(e) => setReason(e.target.value as (typeof REVISION_REASONS)[number])}
          >
            {REVISION_REASONS.map((value) => (
              <option key={value} value={value}>
                {value.replace(/_/g, " ")}
              </option>
            ))}
          </Select>
          {/* §5: this is ISO 9001 clause 8.2.4 evidence for a change to requirements, which is why
              the category is a picklist rather than free text somebody has to interpret later. */}
          <p className="mt-0.5 text-xs text-text-muted">
            Recorded against the revision as the ISO 8.2.4 reason for the change.
          </p>

          <div className="mt-2">
            <Label htmlFor="rev-note">Note (optional)</Label>
            <Textarea
              id="rev-note"
              rows={2}
              value={note}
              onChange={(e) => setNote(e.target.value)}
            />
          </div>

          <Button
            size="sm"
            className="mt-2"
            disabled={revise.isPending}
            onClick={async () => {
              try {
                const created = await revise.mutateAsync({
                  quotationId,
                  revisionReason: reason,
                  revisionNote: note || null,
                });
                toastSuccess(`Created ${created.displayNumber}`);
                setReviseOpen(false);
                setNote("");
                onRevised();
                router.push(`/quotations/${created.quotationId}`);
              } catch (error) {
                toastError(error);
              }
            }}
          >
            Create revision
          </Button>
        </div>
      )}

      {rows.length > 1 && fromId && (
        <div className="mt-4 border-t border-border pt-3">
          <div className="flex flex-wrap items-center gap-2">
            <Label htmlFor="diff-from" className="mb-0">
              Compare against
            </Label>
            <Select
              id="diff-from"
              className="w-auto"
              value={fromId}
              onChange={(e) => setCompareTo(e.target.value)}
            >
              {rows
                .filter((r) => r.id !== current?.id)
                .map((row) => (
                  <option key={row.id} value={row.id}>
                    {row.displayNumber}
                  </option>
                ))}
            </Select>
          </div>

          {diff.data && (
            <div className="mt-2 text-sm">
              {diff.data.identical ? (
                // Worth saying out loud rather than showing an empty panel.
                <p className="text-text-muted">Nothing changed between these two.</p>
              ) : (
                <>
                  <ul className="space-y-1">
                    {diff.data.lines
                      .filter((line) => line.kind !== "unchanged")
                      .map((line, index) => (
                        <li key={`${line.description}-${index}`} className="text-xs">
                          <StatusBadge
                            tone={
                              line.kind === "added"
                                ? "approved"
                                : line.kind === "removed"
                                  ? "failed"
                                  : "pending"
                            }
                          >
                            {line.kind}
                          </StatusBadge>{" "}
                          <span className="font-medium">{line.description}</span>
                          {line.changes?.map((change) => (
                            <span key={change.field} className="ml-2 text-text-muted">
                              {change.field}: {change.from} → {change.to}
                            </span>
                          ))}
                        </li>
                      ))}
                  </ul>
                  {diff.data.terms.length > 0 && (
                    <ul className="mt-2 space-y-1 border-t border-border pt-2 text-xs">
                      {diff.data.terms.map((term) => (
                        <li key={term.field}>
                          <span className="font-medium">{term.field}</span>
                          <span className="ml-2 text-text-muted">
                            {term.from ?? "—"} → {term.to ?? "—"}
                          </span>
                        </li>
                      ))}
                    </ul>
                  )}
                </>
              )}
            </div>
          )}
        </div>
      )}

      {current?.sentAt && (
        <p className="mt-3 text-xs text-text-muted">
          Sent <DateCell value={current.sentAt} />
        </p>
      )}
    </Card>
  );
}
