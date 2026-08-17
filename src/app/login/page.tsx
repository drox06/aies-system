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
  /**
   * Where signing in lands you.
   *
   * `callbackUrl` is set by middleware when somebody is bounced off a page they asked for, and going
   * back there is right — you meant to be there. It is only the *default*, for a plain visit to the
   * login page, that changed on 2026-08-18 at the company's request: My day rather than `/`.
   *
   * `/` is the cross-module summary with no nav entry (docs/DECISIONS.md #78), kept as the seed of
   * DJ's module 09 dashboard. My day is where the sales side actually starts work, so it is the more
   * useful first screen today.
   */
  const requested = searchParams.get("callbackUrl");
  // `/` counts as "no destination", not as a destination. Typing the bare domain is what most people
  // do, and middleware turns that into `?callbackUrl=%2F` — honouring it literally would send
  // everybody to Home and defeat the point of this default.
  const callbackUrl = !requested || requested === "/" ? "/crm/my-day" : requested;

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
    // Light ground, not navy. Spec.md §6.1 forbids the gradient lockup on a coloured background,
    // and §6.2 shows why it is not merely a style rule: the wordmark's "AI" runs navy-900 to
    // blue-600, so on navy it would be navy on navy, and the near-black tagline would disappear
    // outright. Showing the real logo therefore means giving it the surface it was drawn for.
    <main className="flex min-h-dvh flex-col items-center justify-center bg-bg p-4">
      <div className="w-full max-w-sm">
        <div className="mb-7 flex flex-col items-center">
          {/* Sized by width so the lockup scales with the card instead of a fixed pixel height;
              `height` stays as the pre-CSS intrinsic ratio hint that stops layout shifting. */}
          <Logo variant="primary" height={128} className="h-auto w-full max-w-[19rem]" />
          {/* Spec.md §6.4: a 2px red-500 rule under the header is one of the sanctioned uses of
              brand red — identity, not a call to action. */}
          <span aria-hidden className="mt-4 h-0.5 w-16 rounded-full bg-red-500" />
        </div>

        <div className="rounded-lg border border-border bg-surface p-6 shadow-sm">
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
                  // Not `inputMode="numeric"` and no `maxLength` any more: this field also takes a
                  // ten-character recovery code, and a numeric keypad on a phone cannot type one.
                  // The two shapes cannot be confused — six digits versus letters and digits from
                  // an alphabet with no I, L, O or U.
                  autoComplete="one-time-code"
                  required
                  autoFocus
                  value={totpCode}
                  onChange={(e) => setTotpCode(e.target.value)}
                  // Tracking-wide tabular characters: a code is read back off a phone screen or a
                  // printed sheet and re-typed, so they need to be individually countable.
                  className="tabular text-center text-lg tracking-[0.3em]"
                />
                <p className="text-xs text-text-muted">
                  Lost your phone? Type one of your recovery codes here instead. It signs you in
                  once, then asks you to set up a new authenticator.
                </p>
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

        <p className="mt-6 text-center text-xs text-text-muted">
          Authorised users only. All activity is logged.
        </p>
      </div>
    </main>
  );
}
