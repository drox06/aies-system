"use client";

import { Suspense, useRef, useState } from "react";
import { signIn } from "next-auth/react";
import { useRouter, useSearchParams } from "next/navigation";

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
    <main style={{ maxWidth: 360, margin: "4rem auto", fontFamily: "system-ui" }}>
      <h1>AIES Operations Platform</h1>
      <form onSubmit={handleSubmit}>
        <div style={{ marginBottom: 12 }}>
          <label htmlFor="email">Email</label>
          <input
            id="email"
            type="email"
            required
            autoComplete="username"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            disabled={needsTotp}
            style={{ display: "block", width: "100%" }}
          />
        </div>
        <div style={{ marginBottom: 12 }}>
          <label htmlFor="password">Password</label>
          <input
            id="password"
            type="password"
            required
            autoComplete="current-password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            disabled={needsTotp}
            style={{ display: "block", width: "100%" }}
          />
        </div>
        {needsTotp && (
          <div style={{ marginBottom: 12 }}>
            <label htmlFor="totpCode">Authenticator code</label>
            <input
              id="totpCode"
              type="text"
              inputMode="numeric"
              autoComplete="one-time-code"
              required
              value={totpCode}
              onChange={(e) => setTotpCode(e.target.value)}
              style={{ display: "block", width: "100%" }}
            />
          </div>
        )}
        {error && <p style={{ color: "#B3261E" }}>{error}</p>}
        <button type="submit" disabled={submitting}>
          {submitting ? "Signing in..." : needsTotp ? "Verify" : "Sign in"}
        </button>
      </form>
    </main>
  );
}
