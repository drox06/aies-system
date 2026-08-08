"use client";

import { Suspense, useRef, useState } from "react";
import { signIn } from "next-auth/react";
import { useRouter, useSearchParams } from "next/navigation";
import { Logo } from "@/components/brand/Logo";
import { Button } from "@/components/ui/button";
import { Input, Label } from "@/components/ui/input";

const ERROR_MESSAGES: Record<string, string> = {
  invalid_credentials: "Incorrect email or password.",
  account_locked: "Too many failed attempts. Try again in a few minutes.",
  invalid_totp: "Incorrect authenticator code.",
};

export default function LoginPage() {
  return (
    <Suspense>
      <LoginForm />
    </Suspense>
  );
}

function LoginForm() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const callbackUrl = searchParams.get("callbackUrl") ?? "/";

  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [totpCode, setTotpCode] = useState("");
  const [needsTotp, setNeedsTotp] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  // A boolean ref rather than just the `submitting` state, checked synchronously: two submit
  // events that both fire before the first state update commits would otherwise both pass a
  // `disabled={submitting}` check.
  const submittingRef = useRef(false);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (submittingRef.current) return;
    submittingRef.current = true;
    setError(null);
    setSubmitting(true);

    const result = await signIn("credentials", {
      email,
      password,
      // Auth.js's client encodes this via `new URLSearchParams(...)`, which stringifies
      // `undefined` as the literal text "undefined" rather than omitting the key — that string
      // is truthy server-side, so `totpCode` must be a real empty string, never `undefined`, or
      // src/auth.ts's `!totpCode` check for "was a code even provided" silently never fires.
      totpCode: needsTotp ? totpCode : "",
      redirect: false,
    });

    submittingRef.current = false;
    setSubmitting(false);

    // Auth.js's `error` field is just the generic error type ("CredentialsSignin") — the
    // specific reason is in `code`, which is what our custom CredentialsSignin subclasses in
    // src/auth.ts set (see node_modules/@auth/core/errors.js's CredentialsSignin doc comment).
    if (result?.code === "totp_required") {
      setNeedsTotp(true);
      return;
    }

    if (result?.error) {
      setError((result.code && ERROR_MESSAGES[result.code]) ?? "Sign-in failed.");
      return;
    }

    router.push(callbackUrl);
    router.refresh();
  }

  return (
    // Spec.md §6.4: navy-800 is the brand's chrome colour. A full-bleed navy field with the
    // mono-white lockup is the one screen where the brand should be unmistakable, since it is the
    // only page an unauthenticated visitor ever sees.
    <main className="flex min-h-dvh flex-col items-center justify-center bg-navy-800 p-4">
      <div className="w-full max-w-sm">
        <div className="mb-8 flex justify-center">
          <Logo variant="mono-white" height={52} />
        </div>

        <div className="rounded-lg border border-border bg-surface p-6 shadow-xl">
          <h1 className="text-lg">Sign in</h1>
          <p className="mt-1 mb-5 text-sm text-text-muted">
            {needsTotp
              ? "Enter the 6-digit code from your authenticator app."
              : "Use your AIES account."}
          </p>

          <form onSubmit={handleSubmit} className="flex flex-col gap-4">
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="email">Email</Label>
              <Input
                id="email"
                type="email"
                required
                autoComplete="username"
                autoFocus
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                disabled={needsTotp}
              />
            </div>

            <div className="flex flex-col gap-1.5">
              <Label htmlFor="password">Password</Label>
              <Input
                id="password"
                type="password"
                required
                autoComplete="current-password"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                disabled={needsTotp}
              />
            </div>

            {needsTotp && (
              <div className="flex flex-col gap-1.5">
                <Label htmlFor="totpCode">Authenticator code</Label>
                <Input
                  id="totpCode"
                  type="text"
                  inputMode="numeric"
                  autoComplete="one-time-code"
                  maxLength={6}
                  required
                  autoFocus
                  value={totpCode}
                  onChange={(e) => setTotpCode(e.target.value)}
                  // Tracking-wide tabular digits: a 6-digit code is read back off a phone screen
                  // and re-typed, so the characters need to be individually countable.
                  className="tabular text-center text-lg tracking-[0.4em]"
                />
              </div>
            )}

            {error && (
              <p role="alert" className="text-sm text-danger">
                {error}
              </p>
            )}

            <Button type="submit" disabled={submitting} className="mt-1 w-full">
              {submitting ? "Signing in..." : needsTotp ? "Verify" : "Sign in"}
            </Button>
          </form>
        </div>

        <p className="mt-6 text-center text-xs text-white/50">AIES Electromechanical Corporation</p>
      </div>
    </main>
  );
}
