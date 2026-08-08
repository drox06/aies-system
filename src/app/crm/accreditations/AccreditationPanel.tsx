"use client";

import { useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import { Input, Label, Select } from "@/components/ui/input";
import { toastError, toastSuccess } from "@/lib/errors";
import {
  parseRequirements,
  type AccreditationRequirement,
} from "@/server/core/crm/accreditation-rules";
import { trpc } from "@/lib/trpc/client";
import { cn } from "@/lib/utils";

/**
 * The per-customer accreditation checklist (specs/01-crm-inquiry.md §5b).
 *
 * The expiry field on each row is the important one. §5b: "a mayor's permit expires annually and
 * quietly invalidates an accreditation. Track expiry **per document**, not just per accreditation."
 * The server derives the record's real status from these dates, so an expired required document
 * shows the whole accreditation as expired even while its stored status still says accredited.
 */

const STATUSES = [
  "not_started",
  "preparing",
  "submitted",
  "under_review",
  "accredited",
  "rejected",
  "expired",
  "renewal_due",
] as const;

/** YYYY-MM-DD for <input type="date">, which cannot read an ISO timestamp. */
function toDateInput(value: string | null | undefined): string {
  if (!value) return "";
  const d = new Date(value);
  return Number.isNaN(d.getTime()) ? "" : d.toISOString().slice(0, 10);
}

export function AccreditationPanel({
  accountId,
  onChanged,
}: {
  accountId: string;
  onChanged: () => void;
}) {
  const record = trpc.crm.getAccreditation.useQuery({ accountId });

  const [status, setStatus] = useState("preparing");
  const [reference, setReference] = useState("");
  const [portalUrl, setPortalUrl] = useState("");
  const [expiresAt, setExpiresAt] = useState("");
  const [rejectionReason, setRejectionReason] = useState("");
  const [notes, setNotes] = useState("");
  const [requirements, setRequirements] = useState<AccreditationRequirement[]>([]);
  const [newDocument, setNewDocument] = useState("");

  useEffect(() => {
    const r = record.data;
    if (!r) return;
    setStatus(r.status);
    setReference(r.referenceNumber ?? "");
    setPortalUrl(r.customerPortalUrl ?? "");
    setExpiresAt(toDateInput(r.expiresAt?.toISOString() ?? null));
    setRejectionReason(r.rejectionReason ?? "");
    setNotes(r.notes ?? "");
    // Validated, not cast: the column is JSONB, so its contents are `unknown` as far as the client
    // is concerned. parseRequirements returns [] for anything malformed rather than letting a bad
    // row render as blanks that quietly overwrite good data on save.
    setRequirements(parseRequirements(r.requirements));
  }, [record.data]);

  const start = trpc.crm.startAccreditation.useMutation({
    onSuccess: () => {
      void record.refetch();
      onChanged();
      toastSuccess("Accreditation started.");
    },
    onError: toastError,
  });

  const update = trpc.crm.updateAccreditation.useMutation({
    onSuccess: () => {
      void record.refetch();
      onChanged();
      toastSuccess("Accreditation saved.");
    },
    onError: toastError,
  });

  if (record.isPending) return <p className="text-sm text-text-muted">Loading...</p>;

  if (!record.data) {
    return (
      <div className="flex flex-col items-start gap-2">
        <p className="text-sm text-text-muted">
          No accreditation record for this customer yet. Starting one seeds the standard Philippine
          document checklist, which you can then edit per customer.
        </p>
        <Button size="sm" disabled={start.isPending} onClick={() => start.mutate({ accountId })}>
          {start.isPending ? "Starting..." : "Start accreditation"}
        </Button>
      </div>
    );
  }

  const id = record.data.id;

  function patchRequirement(index: number, patch: Partial<AccreditationRequirement>) {
    setRequirements((prev) => prev.map((r, i) => (i === index ? { ...r, ...patch } : r)));
  }

  function save() {
    update.mutate({
      accreditationId: id,
      status: status as (typeof STATUSES)[number],
      referenceNumber: reference || null,
      customerPortalUrl: portalUrl || null,
      // Date inputs give a bare date; send it as an ISO instant so the server stores UTC.
      expiresAt: expiresAt ? new Date(`${expiresAt}T00:00:00.000Z`).toISOString() : null,
      rejectionReason: rejectionReason || null,
      notes: notes || null,
      requirements: requirements.map((r) => ({
        document: r.document,
        required: r.required,
        providedFileId: r.providedFileId ?? null,
        submittedAt: r.submittedAt ?? null,
        acceptedAt: r.acceptedAt ?? null,
        expiresAt: r.expiresAt
          ? new Date(`${toDateInput(r.expiresAt)}T00:00:00.000Z`).toISOString()
          : null,
        notes: r.notes ?? null,
      })),
    });
  }

  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-wrap gap-3">
        <div className="flex min-w-40 flex-1 flex-col gap-1.5">
          <Label htmlFor={`st-${id}`}>Status</Label>
          <Select id={`st-${id}`} value={status} onChange={(e) => setStatus(e.target.value)}>
            {STATUSES.map((s) => (
              <option key={s} value={s}>
                {s.replace(/_/g, " ")}
              </option>
            ))}
          </Select>
        </div>
        <div className="flex min-w-40 flex-1 flex-col gap-1.5">
          <Label htmlFor={`ref-${id}`}>Customer reference no.</Label>
          <Input
            id={`ref-${id}`}
            value={reference}
            onChange={(e) => setReference(e.target.value)}
          />
        </div>
        <div className="flex min-w-40 flex-1 flex-col gap-1.5">
          <Label htmlFor={`exp-${id}`}>Accreditation expires</Label>
          <Input
            id={`exp-${id}`}
            type="date"
            value={expiresAt}
            onChange={(e) => setExpiresAt(e.target.value)}
          />
        </div>
      </div>

      <div className="flex flex-col gap-1.5">
        <Label htmlFor={`url-${id}`}>Customer portal URL</Label>
        <Input
          id={`url-${id}`}
          value={portalUrl}
          onChange={(e) => setPortalUrl(e.target.value)}
          placeholder="Where renewals are uploaded"
        />
      </div>

      {status === "rejected" && (
        <div className="flex flex-col gap-1.5">
          <Label htmlFor={`rej-${id}`}>Rejection reason (required)</Label>
          <Input
            id={`rej-${id}`}
            value={rejectionReason}
            onChange={(e) => setRejectionReason(e.target.value)}
          />
        </div>
      )}

      <div>
        <p className="mb-2 text-sm font-medium">Document checklist</p>
        <div className="overflow-x-auto rounded-md border border-border">
          <table className="w-full border-collapse text-table">
            <thead className="bg-surface-2">
              <tr>
                {["Document", "Required", "Submitted", "Accepted", "Expires", ""].map((h) => (
                  <th key={h} className="px-3 py-2 text-left font-medium text-text-muted">
                    {h}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {requirements.map((r, i) => {
                const expiry = r.expiresAt ? new Date(r.expiresAt) : null;
                const lapsed = expiry !== null && expiry.getTime() < Date.now();
                return (
                  <tr key={`${r.document}-${i}`} className="border-t border-border">
                    <td className="px-3 py-1.5">{r.document}</td>
                    <td className="px-3 py-1.5">
                      <input
                        type="checkbox"
                        checked={r.required}
                        aria-label={`${r.document} is required`}
                        onChange={(e) => patchRequirement(i, { required: e.target.checked })}
                      />
                    </td>
                    <td className="px-3 py-1.5">
                      <Input
                        type="date"
                        className="h-8 w-36"
                        aria-label={`${r.document} submitted`}
                        value={toDateInput(r.submittedAt)}
                        onChange={(e) =>
                          patchRequirement(i, {
                            submittedAt: e.target.value
                              ? new Date(`${e.target.value}T00:00:00.000Z`).toISOString()
                              : null,
                          })
                        }
                      />
                    </td>
                    <td className="px-3 py-1.5">
                      <Input
                        type="date"
                        className="h-8 w-36"
                        aria-label={`${r.document} accepted`}
                        value={toDateInput(r.acceptedAt)}
                        onChange={(e) =>
                          patchRequirement(i, {
                            acceptedAt: e.target.value
                              ? new Date(`${e.target.value}T00:00:00.000Z`).toISOString()
                              : null,
                          })
                        }
                      />
                    </td>
                    <td className="px-3 py-1.5">
                      <Input
                        type="date"
                        className={cn("h-8 w-36", lapsed && r.required && "border-danger")}
                        aria-label={`${r.document} expires`}
                        value={toDateInput(r.expiresAt)}
                        onChange={(e) =>
                          patchRequirement(i, {
                            expiresAt: e.target.value
                              ? new Date(`${e.target.value}T00:00:00.000Z`).toISOString()
                              : null,
                          })
                        }
                      />
                    </td>
                    <td className="px-3 py-1.5 text-right">
                      <Button
                        variant="ghost"
                        size="sm"
                        className="text-danger"
                        onClick={() =>
                          setRequirements((prev) => prev.filter((_, idx) => idx !== i))
                        }
                      >
                        Remove
                      </Button>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>

        {/* §5b: "Seed a template and let PD add per-account items", because every customer asks for
            a slightly different set. */}
        <div className="mt-2 flex flex-wrap items-end gap-2">
          <div className="flex min-w-56 flex-1 flex-col gap-1.5">
            <Label htmlFor={`new-${id}`}>Add a document this customer asks for</Label>
            <Input
              id={`new-${id}`}
              value={newDocument}
              onChange={(e) => setNewDocument(e.target.value)}
              placeholder="e.g. Contractor's all-risk insurance"
            />
          </div>
          <Button
            variant="secondary"
            disabled={newDocument.trim().length === 0}
            onClick={() => {
              setRequirements((prev) => [
                ...prev,
                {
                  document: newDocument.trim(),
                  required: true,
                  providedFileId: null,
                  submittedAt: null,
                  acceptedAt: null,
                  expiresAt: null,
                  notes: null,
                },
              ]);
              setNewDocument("");
            }}
          >
            Add
          </Button>
        </div>
      </div>

      <div className="flex flex-col gap-1.5">
        <Label htmlFor={`notes-${id}`}>Notes</Label>
        <Input id={`notes-${id}`} value={notes} onChange={(e) => setNotes(e.target.value)} />
      </div>

      <div className="flex justify-end">
        <Button onClick={save} disabled={update.isPending}>
          {update.isPending ? "Saving..." : "Save accreditation"}
        </Button>
      </div>
    </div>
  );
}
