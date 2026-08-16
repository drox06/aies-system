"use client";

import * as Dialog from "@radix-ui/react-dialog";
import Link from "next/link";
import { useEffect, useState } from "react";
import { ActivityFeed } from "@/components/ActivityFeed";
import { Attachments } from "@/components/ui/attachments";
import { Button } from "@/components/ui/button";
import { DateCell } from "@/components/ui/cells";
import { FileDropzone } from "@/components/ui/file-dropzone";
import { Input, Label, Select, Textarea } from "@/components/ui/input";
import { ConfirmDialog } from "@/components/ui/confirm-dialog";
import { StatusBadge } from "@/components/ui/status-badge";
import {
  EXCLUSIVITY_TERMS,
  humanStage,
  PRINCIPAL_APPOINT_PERMISSION,
  PRINCIPAL_ENTITY_TYPE,
  PRINCIPAL_STAGES,
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
  const [overrideOpen, setOverrideOpen] = useState(false);
  const [overrideReason, setOverrideReason] = useState("");

  const [correctionStage, setCorrectionStage] = useState("");
  const [correctionReason, setCorrectionReason] = useState("");
  const [confirmDelete, setConfirmDelete] = useState(false);

  const whoami = trpc.system.whoami.useQuery();
  const permissions = whoami.data?.permissions ?? [];
  const mayAppoint = permissions.includes(PRINCIPAL_APPOINT_PERMISSION);
  /** The President alone — see the crm manifest. */
  const mayCorrect = permissions.includes("principal.correct");

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
  const overrideStage = trpc.crm.overridePrincipalStage.useMutation({ onSuccess: refresh });
  const remove = trpc.crm.deletePrincipal.useMutation();

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
                  // §5c's conversion now exists and runs off `principal.appointed`, so this state
                  // means the job has not drained yet — or failed. Still shown rather than hidden:
                  // a principal with no supplier record cannot be bought from.
                  <StatusBadge tone="pending">Supplier record not created yet</StatusBadge>
                )}
                {data.supplierId && (
                  <Link
                    href="/suppliers"
                    className="text-xs text-blue-600 underline underline-offset-2"
                  >
                    Supplier record
                  </Link>
                )}
              </div>

              {stages.length > 0 && (
                <div className="mt-3 flex flex-wrap gap-2">
                  {stages
                    // The appointment is EA's and KJ's. Hidden rather than shown-and-refused for
                    // everyone else: a button that always errors teaches people to distrust the
                    // buttons that work.
                    .filter((stage) => stage !== "appointed" || mayAppoint)
                    .map((stage) => (
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

                  {stages.includes("appointed") && !mayAppoint && (
                    <p className="w-full text-xs text-text-muted">
                      This prospect is ready to appoint. Only the president or the vice-president
                      can do that — everything up to the agreement draft is yours.
                    </p>
                  )}
                </div>
              )}

              {/* §5c's document rule, and the company's exception to it. Offered only to the two
                  people who can appoint at all, and only when the documents really are missing. */}
              {mayAppoint &&
                stages.includes("appointed") &&
                (!data.distributorAgreementFileId || !data.agreementExpiresAt) && (
                  <div className="mt-2 rounded-md border border-warning/40 bg-warning/5 p-3">
                    {!overrideOpen ? (
                      <div className="flex flex-wrap items-center justify-between gap-2">
                        <p className="text-xs">
                          No signed agreement is on file, so appointing is blocked. Small suppliers
                          sometimes have none.
                        </p>
                        <Button variant="ghost" size="sm" onClick={() => setOverrideOpen(true)}>
                          Appoint without one…
                        </Button>
                      </div>
                    ) : (
                      <div className="space-y-2">
                        <Label htmlFor="pp-override">Why is no agreement needed here?</Label>
                        <Textarea
                          id="pp-override"
                          rows={2}
                          value={overrideReason}
                          onChange={(e) => setOverrideReason(e.target.value)}
                          placeholder="Small local fabricator, single-order relationship, no distributor terms offered."
                        />
                        <p className="text-xs text-text-muted">
                          Recorded on the prospect and in the audit log against your name. An ISO
                          9001 auditor asks this question in exactly these words.
                        </p>
                        <div className="flex gap-2">
                          <Button
                            variant="ghost"
                            size="sm"
                            onClick={() => {
                              setOverrideOpen(false);
                              setOverrideReason("");
                            }}
                          >
                            Cancel
                          </Button>
                          <Button
                            size="sm"
                            disabled={transition.isPending || overrideReason.trim().length < 10}
                            onClick={async () => {
                              try {
                                await transition.mutateAsync({
                                  prospectId,
                                  to: "appointed",
                                  overrideDocuments: overrideReason.trim(),
                                });
                                toastSuccess(`${data.companyName} appointed, override recorded.`);
                                setOverrideOpen(false);
                                setOverrideReason("");
                              } catch (error) {
                                toastError(error);
                              }
                            }}
                          >
                            Appoint anyway
                          </Button>
                        </div>
                      </div>
                    )}
                  </div>
                )}

              {data.appointmentOverrideReason && (
                <p className="mt-2 rounded-md border border-border bg-surface-2 p-2 text-xs">
                  <span className="font-medium">Appointed without the usual documents:</span>{" "}
                  {data.appointmentOverrideReason}
                  {data.appointmentOverrideAt && (
                    <>
                      {" "}
                      (<DateCell value={data.appointmentOverrideAt} />)
                    </>
                  )}
                </p>
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
                  {/* The named document, distinct from anything else attached to the prospect:
                      `distributorAgreementFileId` is what the appointment gate reads, so which file
                      holds that role has to be visible rather than inferred from a filename. */}
                  {data.distributorAgreementFileId ? (
                    <div className="mt-1 flex flex-wrap items-center gap-2 rounded-md border border-border bg-surface-2 p-2">
                      <StatusBadge tone="approved">On file</StatusBadge>
                      <a
                        href={`/api/files/${data.distributorAgreementFileId}`}
                        target="_blank"
                        rel="noreferrer"
                        className="text-sm text-blue-600 hover:underline"
                      >
                        View
                      </a>
                      <a
                        href={`/api/files/${data.distributorAgreementFileId}?download=1`}
                        className="text-sm text-blue-600 hover:underline"
                      >
                        Download
                      </a>
                      {data.agreementSignedAt && (
                        <span className="text-xs text-text-muted">
                          signed <DateCell value={data.agreementSignedAt} />
                        </span>
                      )}
                      <Button
                        variant="ghost"
                        size="sm"
                        className="text-danger"
                        disabled={update.isPending}
                        onClick={async () => {
                          try {
                            await update.mutateAsync({
                              prospectId,
                              distributorAgreementFileId: null,
                            });
                            toastSuccess(
                              "Detached. Appointing is blocked again until one is attached.",
                            );
                          } catch (error) {
                            toastError(error);
                          }
                        }}
                      >
                        Wrong file — detach
                      </Button>
                    </div>
                  ) : (
                    <FileDropzone
                      className="mt-1 p-4"
                      entityType={PRINCIPAL_ENTITY_TYPE}
                      entityId={prospectId}
                      multiple={false}
                      accept=".pdf,image/*,.docx"
                      onUploaded={async (files) => {
                        const file = files[0];
                        if (!file) return;
                        await update.mutateAsync({
                          prospectId,
                          distributorAgreementFileId: file.id,
                        });
                        toastSuccess(`Agreement attached: ${file.filename}.`);
                      }}
                    />
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
                  {data.priceListFileId ? (
                    <div className="mt-1 flex flex-wrap items-center gap-2 rounded-md border border-border bg-surface-2 p-2">
                      <StatusBadge
                        tone={data.health.priceListUnsafeToQuote ? "failed" : "approved"}
                      >
                        {data.health.priceListUnsafeToQuote ? "On file — lapsed" : "On file"}
                      </StatusBadge>
                      <a
                        href={`/api/files/${data.priceListFileId}`}
                        target="_blank"
                        rel="noreferrer"
                        className="text-sm text-blue-600 hover:underline"
                      >
                        View
                      </a>
                      <a
                        href={`/api/files/${data.priceListFileId}?download=1`}
                        className="text-sm text-blue-600 hover:underline"
                      >
                        Download
                      </a>
                      <Button
                        variant="ghost"
                        size="sm"
                        className="text-danger"
                        disabled={update.isPending}
                        onClick={async () => {
                          try {
                            await update.mutateAsync({ prospectId, priceListFileId: null });
                            toastSuccess("Detached.");
                          } catch (error) {
                            toastError(error);
                          }
                        }}
                      >
                        Wrong file — detach
                      </Button>
                    </div>
                  ) : (
                    <FileDropzone
                      className="mt-1 p-4"
                      entityType={PRINCIPAL_ENTITY_TYPE}
                      entityId={prospectId}
                      multiple={false}
                      accept=".pdf,.xlsx,.csv,image/*"
                      onUploaded={async (files) => {
                        const file = files[0];
                        if (!file) return;
                        await update.mutateAsync({ prospectId, priceListFileId: file.id });
                        toastSuccess(`Price list attached: ${file.filename}.`);
                      }}
                    />
                  )}
                </div>
              </section>

              {/* Everything else that has been uploaded against this prospect, including files
                  detached from the two roles above — which is the point. A "wrong file" that is
                  merely unreferenced is invisible and still in the bucket; here it can be seen and
                  actually removed. */}
              <section className="mt-3 rounded-md border border-border p-3">
                <Attachments
                  entityType={PRINCIPAL_ENTITY_TYPE}
                  entityId={prospectId}
                  label="All files on this prospect"
                  hint="Catalogues, correspondence, and anything detached from the two roles above."
                  emptyText="Nothing uploaded yet."
                  compact
                />
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

              {/*
                §5c's stage order has no reverse gear, which is right for the ordinary path and
                leaves a stage entered by mistake permanent. This is the President's way back — and
                out. Hidden entirely for everybody else rather than shown and refused: a control that
                always errors teaches people to distrust the ones that work.
              */}
              {mayCorrect && (
                <div className="mt-4 border-t border-border pt-4">
                  <h3 className="text-sm font-semibold">Correct this record</h3>
                  <p className="mt-1 text-xs text-text-muted">
                    Outside the normal stage order. Whatever you write is the only record of why.
                  </p>

                  <div className="mt-2">
                    <Label htmlFor="pp-correct-reason">Reason</Label>
                    <Input
                      id="pp-correct-reason"
                      value={correctionReason}
                      onChange={(e) => setCorrectionReason(e.target.value)}
                      placeholder="Entered at the wrong stage; moving it back to in discussion."
                    />
                  </div>

                  <div className="mt-2 flex flex-wrap items-end gap-2">
                    <div>
                      <Label htmlFor="pp-correct-stage">Set stage to</Label>
                      <Select
                        id="pp-correct-stage"
                        value={correctionStage}
                        onChange={(e) => setCorrectionStage(e.target.value)}
                      >
                        <option value="">Choose…</option>
                        {PRINCIPAL_STAGES.filter((stage) => stage !== data.stage).map((stage) => (
                          <option key={stage} value={stage}>
                            {humanStage(stage)}
                          </option>
                        ))}
                      </Select>
                    </div>
                    <Button
                      size="sm"
                      variant="secondary"
                      disabled={
                        overrideStage.isPending ||
                        correctionStage === "" ||
                        correctionReason.trim().length < 3
                      }
                      onClick={() =>
                        void (async () => {
                          try {
                            await overrideStage.mutateAsync({
                              prospectId,
                              to: correctionStage as (typeof PRINCIPAL_STAGES)[number],
                              reason: correctionReason,
                            });
                            toastSuccess(`Stage set to ${humanStage(correctionStage)}.`);
                            setCorrectionStage("");
                            setCorrectionReason("");
                          } catch (error) {
                            toastError(error);
                          }
                        })()
                      }
                    >
                      Set stage
                    </Button>

                    <Button
                      size="sm"
                      variant="ghost"
                      className="text-red-700"
                      disabled={remove.isPending || correctionReason.trim().length < 3}
                      onClick={() => setConfirmDelete(true)}
                    >
                      Delete prospect
                    </Button>
                  </div>
                  {data.supplierId && (
                    <p className="mt-1.5 text-xs text-text-muted">
                      This prospect has been converted into a supplier, so it cannot be deleted —
                      that would leave the supplier with no record of where it came from. Delete the
                      supplier first.
                    </p>
                  )}
                </div>
              )}

              <ConfirmDialog
                open={confirmDelete}
                onOpenChange={setConfirmDelete}
                title={`Delete ${data.companyName}?`}
                description={`It comes off the pipeline and out of every list. Reason: ${correctionReason}`}
                confirmLabel="Delete"
                destructive
                confirmPhrase={data.companyName}
                isPending={remove.isPending}
                onConfirm={() =>
                  void (async () => {
                    try {
                      await remove.mutateAsync({ prospectId, reason: correctionReason });
                      toastSuccess(`${data.companyName} deleted.`);
                      setConfirmDelete(false);
                      onChanged();
                      onClose();
                    } catch (error) {
                      toastError(error);
                    }
                  })()
                }
              />

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
