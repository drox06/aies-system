"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { Logo } from "@/components/brand/Logo";
import { Button } from "@/components/ui/button";
import { Input, Label } from "@/components/ui/input";
import { parseError } from "@/lib/errors";
import { trpc } from "@/lib/trpc/client";

export default function ChangePasswordPage() {
  const router = useRouter();
  const [currentPassword, setCurrentPassword] = useState("");
  const [newPassword, setNewPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");
  const [error, setError] = useState<string | null>(null);

  const changePassword = trpc.auth.changePassword.useMutation();

  // Checked client-side purely so the mismatch is caught before a round-trip; the server owns the
  // real rules (12 characters, zxcvbn score >= 3).
  const mismatch = confirmPassword.length > 0 && newPassword !== confirmPassword;

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    if (newPassword !== confirmPassword) {
      setError("The two passwords do not match.");
      return;
    }
    try {
      await changePassword.mutateAsync({ currentPassword, newPassword });
      router.push("/");
      router.refresh();
    } catch (err) {
      setError(parseError(err).message);
    }
  }

  return (
    // Matches /login: the full-colour lockup needs a light ground (Spec.md §6.1), and these three
    // screens are one continuous flow, so they must not flip between navy and light.
    <main className="flex min-h-dvh flex-col items-center justify-center bg-bg p-4">
      <div className="w-full max-w-sm">
        <div className="mb-7 flex flex-col items-center">
          <Logo variant="primary" height={128} className="h-auto w-full max-w-[19rem]" />
          <span aria-hidden className="mt-4 h-0.5 w-16 rounded-full bg-red-500" />
        </div>

        <div className="rounded-lg border border-border bg-surface p-6 shadow-sm">
          <h1 className="text-lg">Set a new password</h1>
          <p className="mt-1 mb-5 text-sm text-text-muted">
            Your account has a temporary password. Choose a new one to continue.
          </p>

          <form onSubmit={handleSubmit} className="flex flex-col gap-4">
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="currentPassword">Current (temporary) password</Label>
              <Input
                id="currentPassword"
                type="password"
                required
                autoComplete="current-password"
                autoFocus
                value={currentPassword}
                onChange={(e) => setCurrentPassword(e.target.value)}
              />
            </div>

            <div className="flex flex-col gap-1.5">
              <Label htmlFor="newPassword">New password</Label>
              <Input
                id="newPassword"
                type="password"
                required
                autoComplete="new-password"
                value={newPassword}
                onChange={(e) => setNewPassword(e.target.value)}
              />
              <p className="text-xs text-text-muted">
                At least 12 characters, and strong enough to pass a breach/strength check — a long
                passphrase of a few unrelated words works better than a short complex one.
              </p>
            </div>

            <div className="flex flex-col gap-1.5">
              <Label htmlFor="confirmPassword">Confirm new password</Label>
              <Input
                id="confirmPassword"
                type="password"
                required
                autoComplete="new-password"
                aria-invalid={mismatch}
                value={confirmPassword}
                onChange={(e) => setConfirmPassword(e.target.value)}
              />
              {mismatch && <p className="text-xs text-danger">The two passwords do not match.</p>}
            </div>

            {error && (
              <p role="alert" className="text-sm text-danger">
                {error}
              </p>
            )}

            <Button type="submit" disabled={changePassword.isPending} className="mt-1 w-full">
              {changePassword.isPending ? "Saving..." : "Save and continue"}
            </Button>
          </form>
        </div>
      </div>
    </main>
  );
}
