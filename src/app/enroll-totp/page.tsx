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

  async function handleConfirm(e: React.FormEvent) {
    e.preventDefault();
    setConfirmError(null);
    try {
      await confirmEnrollment.mutateAsync({ code });
      router.push("/");
      router.refresh();
    } catch (err) {
      setConfirmError(parseError(err).message);
    }
  }

  return (
    <main className="flex min-h-dvh flex-col items-center justify-center bg-navy-800 p-4">
      <div className="w-full max-w-md">
        <div className="mb-8 flex justify-center">
          <Logo variant="mono-white" height={52} />
        </div>

        <div className="rounded-lg border border-border bg-surface p-6 shadow-xl">
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

          {startEnrollment.data && (
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

              {/* There is no recovery-code path in this app, so losing the authenticator means an
                  operator has to run scripts/reset-user-credentials.ts. Saying so here is cheaper
                  than the support conversation later. */}
              <p className="mt-4 rounded-md border border-warning/40 bg-warning/5 p-3 text-xs">
                Save this key somewhere safe before continuing. There are no recovery codes — if you
                lose access to your authenticator, an administrator has to reset the account.
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
