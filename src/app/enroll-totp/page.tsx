"use client";

import { useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
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
      setConfirmError(err instanceof Error ? err.message : "Invalid code.");
    }
  }

  return (
    <main style={{ maxWidth: 420, margin: "4rem auto", fontFamily: "system-ui" }}>
      <h1>Set up two-factor authentication</h1>
      <p>
        Every AIES account requires an authenticator app. This is required before you can continue.
      </p>

      {startEnrollment.isPending && <p>Generating your setup code...</p>}
      {startEnrollment.isError && <p style={{ color: "#B3261E" }}>Could not start enrollment.</p>}

      {startEnrollment.data && (
        <>
          {/* eslint-disable-next-line @next/next/no-img-element -- data: URI, not an optimizable remote image */}
          <img
            src={startEnrollment.data.qrCodeDataUrl}
            alt="Scan this QR code in your authenticator app"
            width={220}
            height={220}
          />
          <p>
            Can&apos;t scan? Enter this key manually: <code>{startEnrollment.data.secret}</code>
          </p>

          <form onSubmit={handleConfirm}>
            <label htmlFor="code">Enter the 6-digit code from your app</label>
            <input
              id="code"
              type="text"
              inputMode="numeric"
              required
              value={code}
              onChange={(e) => setCode(e.target.value)}
              style={{ display: "block", width: "100%", marginBottom: 12 }}
            />
            {confirmError && <p style={{ color: "#B3261E" }}>{confirmError}</p>}
            <button type="submit" disabled={confirmEnrollment.isPending}>
              {confirmEnrollment.isPending ? "Verifying..." : "Confirm"}
            </button>
          </form>
        </>
      )}
    </main>
  );
}
