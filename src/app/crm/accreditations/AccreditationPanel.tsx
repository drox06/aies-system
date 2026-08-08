"use client";

import { useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import { DateCell } from "@/components/ui/cells";
import { FileDropzone } from "@/components/ui/file-dropzone";
import { Input, Label, Select } from "@/components/ui/input";
import { toastError, toastSuccess } from "@/lib/errors";
import { ACCREDITATION_ENTITY_TYPE } from "@/server/core/crm/accreditation-rules";
import { trpc } from "@/lib/trpc/client";

/**
 * One customer's accreditation (specs/01-crm-inquiry.md §5b).
 *
 * Deliberately just two facts that matter: the certificate the customer issued, and when it
 * expires. The documents AIES submits to *get* accredited are lodged and tracked on the customer's
 * own portal, which is their authoritative home — mirroring them here would be a second copy that
 * drifts. See docs/DECISIONS.md #19.
 *
 * The server derives the real status from the expiry date, so a record still saying `accredited`
 * with a date in the past shows as expired without anyone having to run anything.
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
  const [certificateFileId, setCertificateFileId] = useState<string | null>(null);

  useEffect(() => {
    const r = record.data;
    if (!r) return;
    setStatus(r.status);
    setReference(r.referenceNumber ?? "");
    setPortalUrl(r.customerPortalUrl ?? "");
    setExpiresAt(toDateInput(r.expiresAt?.toISOString() ?? null));
    setRejectionReason(r.rejectionReason ?? "");
    setNotes(r.notes ?? "");
    setCertificateFileId(r.certificateFileId ?? null);
  }, [record.data]);

  const start = trpc.crm.startAccreditation.useMutation({
    onSuccess: () => {
      void record.refetch();
      onChanged();
      toastSuccess("Accreditation started.");
    },
    onError: toastError,
  });

  const acknowledge = trpc.crm.acknowledgeRenewal.useMutation({
    onSuccess: (result) => {
      void record.refetch();
      onChanged();
      // The approval branch is invisible until it happens, so say which one occurred rather than a
      // generic "done".
      if (result.acknowledged) {
        toastSuccess("Renewal acknowledged. The clock starts today.");
      } else {
        toastSuccess(
          `This customer is ${result.accountStatus}, so the president must approve before the renewal starts. Approval requested.`,
        );
      }
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
          No accreditation record for this customer yet. Start one to track the certificate this
          customer issues and when it expires.
        </p>
        <Button size="sm" disabled={start.isPending} onClick={() => start.mutate({ accountId })}>
          {start.isPending ? "Starting..." : "Start accreditation"}
        </Button>
      </div>
    );
  }

  const id = record.data.id;

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
      certificateFileId,
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

      {/* The evidence. §5b treats accreditation as recurring work with a paper trail, and a status
          field with no certificate behind it is an assertion, not a record — which is also what an
          ISO 9001 auditor asks to see. Marking the record `accredited` is blocked server-side until
          both this and the expiry date exist. */}
      <div className="rounded-md border border-border bg-surface-2 p-3">
        <p className="text-sm font-medium">Accreditation certificate</p>
        <p className="mt-0.5 mb-3 text-xs text-text-muted">
          The certificate the customer issued to AIES. Required before this can be marked
          accredited, together with the expiry date above.
        </p>

        {certificateFileId ? (
          <div className="flex flex-wrap items-center gap-2">
            <a
              href={`/api/files/${certificateFileId}`}
              target="_blank"
              rel="noreferrer"
              className="text-sm text-blue-600 hover:underline"
            >
              View certificate
            </a>
            {record.data.certificateUploadedAt && (
              <span className="text-xs text-text-muted">
                uploaded <DateCell value={record.data.certificateUploadedAt} />
              </span>
            )}
            <Button
              variant="ghost"
              size="sm"
              className="text-danger"
              onClick={() => setCertificateFileId(null)}
            >
              Replace
            </Button>
          </div>
        ) : (
          <FileDropzone
            entityType={ACCREDITATION_ENTITY_TYPE}
            entityId={id}
            accept=".pdf,image/*"
            multiple={false}
            onUploaded={(files) => {
              const uploaded = files[0];
              if (uploaded) setCertificateFileId(uploaded.id);
            }}
          />
        )}
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

      <div className="flex flex-col gap-1.5">
        <Label htmlFor={`notes-${id}`}>Notes</Label>
        <Input id={`notes-${id}`} value={notes} onChange={(e) => setNotes(e.target.value)} />
      </div>

      <div className="flex flex-wrap items-center justify-between gap-3 border-t border-border pt-4">
        {/* Acknowledgement is a commitment with a clock attached, so the consequence is stated on
            the button rather than discovered 30 days later. */}
        {record.data.renewalAcknowledgedAt ? (
          <p className="text-sm text-text-muted">
            Renewal acknowledged <DateCell value={record.data.renewalAcknowledgedAt} />. Upload the
            new certificate and its expiry date to close it out.
          </p>
        ) : (
          <div className="flex flex-col items-start gap-1">
            <Button
              variant="secondary"
              disabled={acknowledge.isPending}
              onClick={() => acknowledge.mutate({ accreditationId: id })}
            >
              {acknowledge.isPending ? "Acknowledging..." : "Acknowledge renewal"}
            </Button>
            <span className="text-xs text-text-muted">
              Confirms you are taking this renewal on. The president and vice-president are notified
              if a new certificate is not recorded within 30, 45 and 60 days.
            </span>
          </div>
        )}

        <Button onClick={save} disabled={update.isPending}>
          {update.isPending ? "Saving..." : "Save accreditation"}
        </Button>
      </div>
    </div>
  );
}
