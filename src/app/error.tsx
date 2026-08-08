"use client";

import { useEffect, useMemo } from "react";
import { Button } from "@/components/ui/button";
import { shortRequestId } from "@/lib/errors";

/**
 * specs/00-foundation.md §8: the error boundary for anything a component throws during render.
 *
 * Next.js gives every server-side error a `digest` and logs the real stack on the server — that
 * digest is the request id here, so what the user reads on screen is the same token an admin can
 * grep for. Client-side errors have no digest, so one is generated per mount purely so the user
 * still has something concrete to quote; it is logged to the console with the error so the two
 * can be joined from a browser log.
 */
export default function ErrorBoundary({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  const reference = useMemo(() => error.digest ?? crypto.randomUUID(), [error.digest]);

  useEffect(() => {
    console.error(`[error-boundary] ${reference}`, error);
  }, [error, reference]);

  return (
    <div className="mx-auto flex max-w-lg flex-col items-start gap-4 py-16">
      <h1 className="text-xl">Something went wrong</h1>
      <p className="text-sm text-text-muted">
        The page could not be displayed. Nothing you had already saved has been lost.
      </p>
      <p className="text-sm">
        Quote this reference to an administrator:{" "}
        <code className="rounded border border-border bg-surface-2 px-1.5 py-0.5 font-mono text-sm">
          {shortRequestId(reference)}
        </code>
      </p>
      <div className="flex gap-2">
        <Button onClick={reset}>Try again</Button>
        <Button variant="secondary" onClick={() => (window.location.href = "/")}>
          Go home
        </Button>
      </div>
    </div>
  );
}
