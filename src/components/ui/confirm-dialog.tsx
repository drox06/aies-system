"use client";

import * as Dialog from "@radix-ui/react-dialog";
import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";

/**
 * Confirmation before an irreversible action.
 *
 * `confirmPhrase` exists because Spec.md §6.3's worry — someone misclicking on "a cancelled
 * invoice, a deleted quotation revision" — is not solved by a dialog people dismiss reflexively.
 * For genuinely unrecoverable actions the caller can require the record's number to be typed,
 * which makes the confirmation an actual decision rather than a second click in the same place.
 */
export function ConfirmDialog({
  open,
  onOpenChange,
  title,
  description,
  confirmLabel = "Confirm",
  destructive = false,
  confirmPhrase,
  onConfirm,
  isPending = false,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  title: string;
  description?: string;
  confirmLabel?: string;
  destructive?: boolean;
  confirmPhrase?: string;
  onConfirm: () => void | Promise<void>;
  isPending?: boolean;
}) {
  const [typed, setTyped] = useState("");
  const satisfied = !confirmPhrase || typed.trim() === confirmPhrase;

  return (
    <Dialog.Root
      open={open}
      onOpenChange={(next) => {
        if (!next) setTyped("");
        onOpenChange(next);
      }}
    >
      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 z-50 bg-navy-900/40" />
        <Dialog.Content className="fixed top-1/2 left-1/2 z-50 w-[min(28rem,calc(100vw-2rem))] -translate-x-1/2 -translate-y-1/2 rounded-md border border-border bg-surface p-5 shadow-xl">
          <Dialog.Title className="text-base font-semibold">{title}</Dialog.Title>
          {description && (
            <Dialog.Description className="mt-2 text-sm text-text-muted">
              {description}
            </Dialog.Description>
          )}

          {confirmPhrase && (
            <label className="mt-4 block text-sm">
              Type <strong>{confirmPhrase}</strong> to confirm
              <Input
                className="mt-1"
                value={typed}
                onChange={(e) => setTyped(e.target.value)}
                autoComplete="off"
              />
            </label>
          )}

          <div className="mt-5 flex justify-end gap-2">
            <Dialog.Close asChild>
              <Button variant="secondary" disabled={isPending}>
                Cancel
              </Button>
            </Dialog.Close>
            <Button
              variant={destructive ? "destructive" : "primary"}
              disabled={!satisfied || isPending}
              onClick={() => void onConfirm()}
            >
              {isPending ? "Working..." : confirmLabel}
            </Button>
          </div>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
