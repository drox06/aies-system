"use client";

import * as Dialog from "@radix-ui/react-dialog";
import { useEffect, useState } from "react";
import { ActivityFeed } from "@/components/ActivityFeed";
import { Button } from "@/components/ui/button";
import { FileDropzone } from "@/components/ui/file-dropzone";
import { Input, Label, Select, Textarea } from "@/components/ui/input";
import { StatusBadge } from "@/components/ui/status-badge";
import {
  EXCLUSIVITY_TERMS,
  humanStage,
  principalStagesFrom,
} from "@/server/core/crm/principal-lifecycle";
import { toastError, toastSuccess } from "@/lib/errors";
import { trpc } from "@/lib/trpc/client";

const asDateInput = (value: string | Date | null | undefined) =>
  value ? new Date(value).toISOString().slice(0, 10) : "";

/**
 * One prospect: its stage, its agreement, its price list, and its history.
 *
 * The agreement and price-list blocks carry §5c's real weight. Both dates drive the nightly expiry
 * sweep and the badges on the board, and the price list is the one module 02 will read before it
 * lets anybody cost a quotation — §5c: "A quotation costed from a lapsed price list is a margin
 * incident waiting to happen."
 */
export function PrincipalPanel({
  prospectId,
  onClose,
  onChanged,
}: {
  prospectId: string;
  onClose: () => void;
  onChanged: () => void;
}) {
  const utils = trpc.useUtils();
  const prospect = trpc.crm.getPrincipal.useQuery({ prospectId });

  const [exclusivity, setExclusivity] = useState<(typeof EXCLUSIVITY_TERMS)[number]>("none");
  const [agreementSignedAt, setAgreementSignedAt] = useState("");
  const [agreementExpiresAt, setAgreementExpiresAt] = useState("");
  const [priceListReceivedAt, setPriceListReceivedAt] = useState("");
  const [priceListValidUntil, setPriceListValidUntil] = useState("");
  const [trainingStatus, setTrainingStatus] = useState("");
  const [nextFollowUpAt, setNextFollowUpAt] = useState("");
  const [notes, setNotes] = useState("");

  useEffect(() => {
    const data = prospect.data;
    if (!data) return;
    setExclusivity(data.exclusivity as (typeof EXCLUSIVITY_TERMS)[number]);
    setAgreementSignedAt(asDateInput(data.agreementSignedAt));
    setAgreementExpiresAt(asDateInput(data.agreementExpiresAt));
    setPriceListReceivedAt(asDateInput(data.priceListReceivedAt));
    setPriceListValidUntil(asDateInput(data.priceListValidUntil));
    setTrainingStatus(data.trainingStatus ?? "");
    setNextFollowUpAt(asDateInput(data.nextFollowUpAt));
    setNotes(data.notes ?? "");
  }, [prospect.data]);

  const refresh = () => {
    void utils.crm.getPrincipal.invalidate({ prospectId });
    void utils.crm.listPrincipals.invalidate();
    onChanged();
  };

  const update = trpc.crm.updatePrincipal.useMutation({ onSuccess: refresh });
  const transition = trpc.crm.transitionPrincipal.useMutation({ onSuccess: refresh });

  const data = prospect.data;
  const stages = data ? principalStagesFrom(data.stage) : [];

  return (
    <Dialog.Root open onOpenChange={(next) => !next && onClose()}>
      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 z-50 bg-navy-900/40" />
        <Dialog.Content className="fixed top-1/2 left-1/2 z-50 max-h-[92dvh] w-[min(46rem,calc(100vw-2rem))] -translate-x-1/2 -translate-y-1/2 overflow-y-auto rounded-md border border-border bg-surface p-5 shadow-xl">
          {!data ? (
            <>
              <Dialog.Title className="text-base font-semibold">Loading…</Dialog.Title>
              <Dialog.Description className="mt-1 text-sm text-text-muted">
                Fetching the prospect.
              </Dialog.Description>
            </>
          ) : (
            <>
              <Dialog.Title className="text-base font-semibold">{data.companyName}</Dialog.Title>
              <Dialog.Description className="mt-1 text-sm text-text-muted">
                {[data.country, data.productLines.join(", ")].filter(Boolean).join(" · ") ||
                  "No country or product lines recorded yet."}
              </Dialog.Description>

              <div className="mt-3 flex flex-wrap items-center gap-2">
                <StatusBadge tone={data.stage === "appointed" ? "approved" : "info"}>
                  <span className="capitalize">{humanStage(data.stage)}</span>
                </StatusBadge>
                {data.health.priceListUnsafeToQuote && (
                  <StatusBadge tone="failed">Price list lapsed — do not cost from it</StatusBadge>
                )}
                {data.health.agreement === "expired" && (
                  <StatusBadge tone="failed">Agreement expired</StatusBadge>
                )}
                {data.stage === "appointed" && !data.supplierId && (
                  // Honest rather than hidden: the conversion §5c describes needs module 03, which
                  // does not exist. Saying so beats a silently missing supplier record.
                  <StatusBadge tone="draft">Supplier record pending module 03</StatusBadge>
                )}
              </div>

              {stages.length > 0 && (
                <div className="mt-3 flex flex-wrap gap-2">
                  {stages.map((stage) => (
                    <Button
                      key={stage}
                      size="sm"
                      variant={stage === "declined" || stage === "dormant" ? "ghost" : "primary"}
                      disabled={transition.isPending}
                      onClick={async () => {
                        try {
                          await transition.mutateAsync({ prospectId, to: stage });
                          toastSuccess(`Moved to ${humanStage(stage)}.`);
                        } catch (error) {
                          // Carries the pipeline's own message — including "attach the signed
                          // distributor agreement before appointing".
                          toastError(error);
                        }
                      }}
                    >
                      {stage === "appointed" ? "Appoint" : humanStage(stage)}
                    </Button>
                  ))}
                </div>
              )}

              <section className="mt-4 rounded-md border border-border p-3">
                <h3 className="text-sm font-semibold">Distributor agreement</h3>
                <div className="mt-2 grid gap-3 sm:grid-cols-3">
                  <div>
                    <Label htmlFor="pp-signed">Signed</Label>
                    <Input
                      id="pp-signed"
                      type="date"
                      value={agreementSignedAt}
                      onChange={(e) => setAgreementSignedAt(e.target.value)}
                    />
                  </div>
                  <div>
                    <Label htmlFor="pp-expires">Expires</Label>
                    <Input
                      id="pp-expires"
                      type="date"
                      value={agreementExpiresAt}
                      onChange={(e) => setAgreementExpiresAt(e.target.value)}
                    />
                  </div>
                  <div>
                    <Label htmlFor="pp-excl">Exclusivity</Label>
                    <Select
                      id="pp-excl"
                      value={exclusivity}
                      onChange={(e) =>
                        setExclusivity(e.target.value as (typeof EXCLUSIVITY_TERMS)[number])
                      }
                    >
                      {EXCLUSIVITY_TERMS.map((term) => (
                        <option key={term} value={term}>
                          {term}
                        </option>
                      ))}
                    </Select>
                  </div>
                </div>
                <div className="mt-2">
                  <Label>Signed agreement</Label>
                  <FileDropzone
                    entityType="PrincipalProspect"
                    entityId={prospectId}
                    onUploaded={async (files) => {
                      const file = files[0];
                      if (!file) return;
                      await update.mutateAsync({
                        prospectId,
                        distributorAgreementFileId: file.id,
                      });
                      toastSuccess("Agreement attached.");
                    }}
                  />
                  {data.distributorAgreementFileId && (
                    <p className="mt-1 text-xs text-text-muted">An agreement is on file.</p>
                  )}
                </div>
              </section>

              <section className="mt-3 rounded-md border border-border p-3">
                <h3 className="text-sm font-semibold">Price list</h3>
                <p className="mt-0.5 text-xs text-text-muted">
                  Module 02 reads this before letting anyone cost a quotation from this principal.
                </p>
                <div className="mt-2 grid gap-3 sm:grid-cols-2">
                  <div>
                    <Label htmlFor="pp-pl-received">Received</Label>
                    <Input
                      id="pp-pl-received"
                      type="date"
                      value={priceListReceivedAt}
                      onChange={(e) => setPriceListReceivedAt(e.target.value)}
                    />
                  </div>
                  <div>
                    <Label htmlFor="pp-pl-until">Valid until</Label>
                    <Input
                      id="pp-pl-until"
                      type="date"
                      value={priceListValidUntil}
                      onChange={(e) => setPriceListValidUntil(e.target.value)}
                    />
                  </div>
                </div>
                <div className="mt-2">
                  <Label>Price list file</Label>
                  <FileDropzone
                    entityType="PrincipalProspect"
                    entityId={prospectId}
                    onUploaded={async (files) => {
                      const file = files[0];
                      if (!file) return;
                      await update.mutateAsync({ prospectId, priceListFileId: file.id });
                      toastSuccess("Price list attached.");
                    }}
                  />
                </div>
              </section>

              <div className="mt-3 grid gap-3 sm:grid-cols-2">
                <div>
                  <Label htmlFor="pp-training">Training status</Label>
                  <Input
                    id="pp-training"
                    value={trainingStatus}
                    onChange={(e) => setTrainingStatus(e.target.value)}
                    placeholder="Product training completed, certification pending…"
                  />
                </div>
                <div>
                  <Label htmlFor="pp-follow">Next follow-up</Label>
                  <Input
                    id="pp-follow"
                    type="date"
                    value={nextFollowUpAt}
                    onChange={(e) => setNextFollowUpAt(e.target.value)}
                  />
                </div>
              </div>

              <div className="mt-3">
                <Label htmlFor="pp-notes">Notes</Label>
                <Textarea
                  id="pp-notes"
                  rows={3}
                  value={notes}
                  onChange={(e) => setNotes(e.target.value)}
                />
              </div>

              <div className="mt-4 flex justify-end gap-2">
                <Button variant="ghost" onClick={onClose}>
                  Close
                </Button>
                <Button
                  disabled={update.isPending}
                  onClick={async () => {
                    try {
                      await update.mutateAsync({
                        prospectId,
                        exclusivity,
                        agreementSignedAt: agreementSignedAt ? new Date(agreementSignedAt) : null,
                        agreementExpiresAt: agreementExpiresAt
                          ? new Date(agreementExpiresAt)
                          : null,
                        priceListReceivedAt: priceListReceivedAt
                          ? new Date(priceListReceivedAt)
                          : null,
                        priceListValidUntil: priceListValidUntil
                          ? new Date(priceListValidUntil)
                          : null,
                        trainingStatus: trainingStatus || null,
                        nextFollowUpAt: nextFollowUpAt ? new Date(nextFollowUpAt) : null,
                        notes: notes || null,
                      });
                      toastSuccess("Saved.");
                    } catch (error) {
                      toastError(error);
                    }
                  }}
                >
                  {update.isPending ? "Saving…" : "Save"}
                </Button>
              </div>

              <div className="mt-4 border-t border-border pt-4">
                <ActivityFeed entityType="PrincipalProspect" entityId={prospectId} />
              </div>
            </>
          )}
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
