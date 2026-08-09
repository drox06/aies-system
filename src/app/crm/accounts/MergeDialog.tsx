"use client";

import * as Dialog from "@radix-ui/react-dialog";
import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Label, Select, Textarea } from "@/components/ui/input";
import { toastError, toastSuccess } from "@/lib/errors";
import { trpc } from "@/lib/trpc/client";

/**
 * §7's merge tool.
 *
 * The merge "repoints all child records" and cannot be undone from the UI, so the confirmation
 * shows what will actually move for these two specific accounts rather than a generic warning. A
 * count of six inquiries and two sites is a fact somebody can check against what they expect; "this
 * action is permanent" is not.
 *
 * The accreditation is called out separately because it is the one thing retired rather than moved:
 * a customer either accredits AIES or does not, and the survivor's answer is the true one.
 */
export function MergeDialog({
  open,
  onOpenChange,
  onMerged,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onMerged: () => void;
}) {
  const [survivorId, setSurvivorId] = useState("");
  const [mergedId, setMergedId] = useState("");
  const [reason, setReason] = useState("");

  const accounts = trpc.crm.listAccounts.useQuery({ pageSize: 100 }, { enabled: open });
  const preview = trpc.crm.previewMerge.useQuery(
    { survivorId, mergedId },
    { enabled: open && Boolean(survivorId) && Boolean(mergedId) && survivorId !== mergedId },
  );
  const merge = trpc.crm.mergeAccounts.useMutation();

  const rows = accounts.data?.rows ?? [];
  const sameAccount = Boolean(survivorId) && survivorId === mergedId;

  return (
    <Dialog.Root
      open={open}
      onOpenChange={(next) => {
        if (!next) {
          setSurvivorId("");
          setMergedId("");
          setReason("");
        }
        onOpenChange(next);
      }}
    >
      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 z-50 bg-navy-900/40" />
        <Dialog.Content className="fixed top-1/2 left-1/2 z-50 max-h-[90dvh] w-[min(34rem,calc(100vw-2rem))] -translate-x-1/2 -translate-y-1/2 overflow-y-auto rounded-md border border-border bg-surface p-5 shadow-xl">
          <Dialog.Title className="text-base font-semibold">Merge duplicate accounts</Dialog.Title>
          <Dialog.Description className="mt-1 text-sm text-text-muted">
            Everything on the duplicate moves to the account you keep. This cannot be undone from
            here.
          </Dialog.Description>

          <div className="mt-4 space-y-3">
            <div>
              <Label htmlFor="merge-keep">Account to keep</Label>
              <Select
                id="merge-keep"
                value={survivorId}
                onChange={(e) => setSurvivorId(e.target.value)}
              >
                <option value="">Choose…</option>
                {rows.map((account) => (
                  <option key={account.id} value={account.id}>
                    {account.name} ({account.code})
                  </option>
                ))}
              </Select>
            </div>

            <div>
              <Label htmlFor="merge-dup">Duplicate to merge in</Label>
              <Select id="merge-dup" value={mergedId} onChange={(e) => setMergedId(e.target.value)}>
                <option value="">Choose…</option>
                {rows.map((account) => (
                  <option key={account.id} value={account.id}>
                    {account.name} ({account.code})
                  </option>
                ))}
              </Select>
              {sameAccount && (
                <p className="mt-1 text-xs text-danger">
                  Those are the same account. Pick two different ones.
                </p>
              )}
            </div>

            {preview.data && (
              <div className="rounded border border-border bg-surface-2 p-3 text-sm">
                <p>
                  <span className="font-medium">{preview.data.merged.name}</span> (
                  {preview.data.merged.code}) will be closed, and everything on it moves to{" "}
                  <span className="font-medium">{preview.data.survivor.name}</span> (
                  {preview.data.survivor.code}).
                </p>
                <ul className="mt-2 list-inside list-disc text-xs">
                  <li>{preview.data.counts.inquiries} inquiries</li>
                  <li>{preview.data.counts.contacts} contacts</li>
                  <li>{preview.data.counts.sites} sites</li>
                  <li>{preview.data.counts.activities} logged activities</li>
                  <li>{preview.data.counts.children} sub-accounts</li>
                </ul>
                {preview.data.accreditationsRetired > 0 && (
                  <p className="mt-2 text-xs text-warning">
                    The duplicate&rsquo;s accreditation record will be retired, not moved — the
                    account you keep holds the answer to &ldquo;are we accredited with this
                    customer?&rdquo;
                  </p>
                )}
              </div>
            )}

            <div>
              <Label htmlFor="merge-reason">Reason</Label>
              <Textarea
                id="merge-reason"
                rows={2}
                value={reason}
                onChange={(e) => setReason(e.target.value)}
                placeholder="Recorded on both accounts' audit trails."
              />
            </div>
          </div>

          <div className="mt-4 flex justify-end gap-2">
            <Dialog.Close asChild>
              <Button variant="ghost">Cancel</Button>
            </Dialog.Close>
            <Button
              variant="destructive"
              disabled={merge.isPending || !preview.data}
              onClick={async () => {
                try {
                  const result = await merge.mutateAsync({
                    survivorId,
                    mergedId,
                    reason: reason || null,
                  });
                  toastSuccess(
                    `Merged. Moved ${Object.values(result.moved).reduce((a, b) => a + b, 0)} record(s).`,
                  );
                  onOpenChange(false);
                  onMerged();
                } catch (error) {
                  toastError(error);
                }
              }}
            >
              {merge.isPending ? "Merging…" : "Merge"}
            </Button>
          </div>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
