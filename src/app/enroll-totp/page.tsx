"use client";

import { useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { Logo } from "@/components/brand/Logo";
import { Button } from "@/components/ui/button";
import { Input, Label } from "@/components/ui/input";
import { parseError } from "@/lib/errors";
import { trpc } from "@/lib/trpc/client";

export default function EnrollTotpPage() {
  const router = useRouter();
  const [code, setCode] = useState("");
  const [confirmError, setConfirmError] = useState<string | null>(null);

  const startEnrollment = trpc.auth.startTotpEnrollment.useMutation();
  const startedRef = useRef(false);

  useEffect(() => {
    if (startedRef.current) return;
    startedRef.current = true;
    startEnrollment.mutate();
    // eslint-disable-next-line react-hooks/exhaustive-deps -- fire exactly once on mount
  }, []);

  const confirmEnrollment = trpc.auth.confirmTotpEnrollment.useMutation();

  /**
   * Held in state and shown on this screen, because there is no second chance.
   *
   * The obvious alternative — bounce straight to `/` and put the codes on the account page — cannot
   * work: they are stored as argon2 hashes, so nothing can ever display them again. They are
   * readable for exactly as long as this component holds them.
   */
  const [recoveryCodes, setRecoveryCodes] = useState<string[] | null>(null);
  const [saved, setSaved] = useState(false);

  async function handleConfirm(e: React.FormEvent) {
    e.preventDefault();
    setConfirmError(null);
    try {
      const result = await confirmEnrollment.mutateAsync({ code });
      // Not `router.push` yet — leaving now would take the codes with it.
      setRecoveryCodes(result.recoveryCodes);
    } catch (err) {
      setConfirmError(parseError(err).message);
    }
  }

  return (
    // Matches /login: the full-colour lockup needs a light ground (Spec.md §6.1), and these three
    // screens are one continuous flow, so they must not flip between navy and light.
    <main className="flex min-h-dvh flex-col items-center justify-center bg-bg p-4">
      <div className="w-full max-w-md">
        <div className="mb-7 flex flex-col items-center">
          <Logo variant="primary" height={128} className="h-auto w-full max-w-[19rem]" />
          <span aria-hidden className="mt-4 h-0.5 w-16 rounded-full bg-red-500" />
        </div>

        <div className="rounded-lg border border-border bg-surface p-6 shadow-sm">
          <h1 className="text-lg">Set up two-factor authentication</h1>
          <p className="mt-1 mb-5 text-sm text-text-muted">
            Every AIES account requires an authenticator app. This cannot be skipped.
          </p>

          {startEnrollment.isPending && (
            <p className="text-sm text-text-muted">Generating your setup code...</p>
          )}
          {startEnrollment.isError && (
            <p role="alert" className="text-sm text-danger">
              Could not start enrolment. Reload the page to try again.
            </p>
          )}

          {/* Once the codes exist, they are the only thing on screen. The QR code and the field
              that produced them are done, and leaving them visible invites somebody to treat this
              as a step they have already finished. */}
          {recoveryCodes && (
            <div>
              <p className="rounded-md border border-warning/40 bg-warning/5 p-3 text-sm">
                <span className="font-medium">Write these down before you continue.</span> This is
                the only time they will ever be shown — they are stored hashed, so nobody, including
                an administrator, can look them up again.
              </p>

              <ul className="mt-4 grid grid-cols-2 gap-2">
                {recoveryCodes.map((recoveryCode) => (
                  <li
                    key={recoveryCode}
                    className="tabular rounded border border-border bg-surface-2 p-2 text-center font-mono text-sm"
                  >
                    {recoveryCode}
                  </li>
                ))}
              </ul>

              <div className="mt-4 flex flex-wrap gap-2">
                <Button
                  variant="secondary"
                  onClick={async () => {
                    try {
                      await navigator.clipboard.writeText(recoveryCodes.join("\n"));
                    } catch {
                      // A browser that refuses clipboard access is not a failure worth a dialog —
                      // the codes are on screen and can be typed.
                    }
                  }}
                >
                  Copy all
                </Button>
                <Button
                  variant="secondary"
                  onClick={() => {
                    // A printed copy in the office safe is the intended home for these.
                    window.print();
                  }}
                >
                  Print
                </Button>
              </div>

              <p className="mt-4 text-xs text-text-muted">
                Each code works once. Using one signs you in and removes your authenticator, so you
                will be asked to set it up again straight away — that is deliberate, in case the old
                phone is in somebody else&apos;s hands.
              </p>

              <label className="mt-4 flex items-start gap-2 text-sm">
                <input
                  type="checkbox"
                  className="mt-0.5"
                  checked={saved}
                  onChange={(e) => setSaved(e.target.checked)}
                />
                I have saved these somewhere I can find them without this device.
              </label>

              <Button
                className="mt-3 w-full"
                disabled={!saved}
                onClick={() => {
                  router.push("/");
                  router.refresh();
                }}
              >
                Continue
              </Button>
            </div>
          )}

          {startEnrollment.data && !recoveryCodes && (
            <>
              <div className="flex flex-col items-center gap-3">
                <div className="rounded-md border border-border bg-surface p-2">
                  {/* eslint-disable-next-line @next/next/no-img-element -- data: URI, not an optimizable remote image */}
                  <img
                    src={startEnrollment.data.qrCodeDataUrl}
                    alt="Scan this QR code in your authenticator app"
                    width={200}
                    height={200}
                  />
                </div>

                <details className="w-full text-sm">
                  <summary className="cursor-pointer text-text-muted hover:text-text">
                    Can&apos;t scan? Enter the key manually
                  </summary>
                  <code className="mt-2 block rounded border border-border bg-surface-2 p-2 font-mono text-xs break-all">
                    {startEnrollment.data.secret}
                  </code>
                </details>
              </div>

              <p className="mt-4 rounded-md border border-border bg-surface-2 p-3 text-xs">
                {/* Was a warning that there is no way back. There is one now — see
                    src/server/core/auth/recovery-codes.ts. */}
                Once you confirm, you will be given ten recovery codes. Keep them somewhere you can
                reach without this phone.
              </p>

              <form onSubmit={handleConfirm} className="mt-5 flex flex-col gap-3">
                <div className="flex flex-col gap-1.5">
                  <Label htmlFor="code">Enter the 6-digit code from your app</Label>
                  <Input
                    id="code"
                    type="text"
                    inputMode="numeric"
                    autoComplete="one-time-code"
                    maxLength={6}
                    required
                    autoFocus
                    value={code}
                    onChange={(e) => setCode(e.target.value)}
                    className="tabular text-center text-lg tracking-[0.4em]"
                  />
                </div>

                {confirmError && (
                  <p role="alert" className="text-sm text-danger">
                    {confirmError}
                  </p>
                )}

                <Button type="submit" disabled={confirmEnrollment.isPending} className="w-full">
                  {confirmEnrollment.isPending ? "Verifying..." : "Confirm and continue"}
                </Button>
              </form>
            </>
          )}
        </div>
      </div>
    </main>
  );
}
