"use client";

import { useEffect, useState } from "react";

/**
 * A panel that folds away, remembering whether you left it open.
 *
 * ## Why the ticket needed this
 *
 * A ticket carries thirteen panels — schedule, cash advance, inspection, method statement,
 * materials, mobilisation, progress, checklists, hours, QA, commissioning, service report, delivery.
 * Every one of them earns its place at some point in the job, and none of them earns it *today*. The
 * result was a page somebody scrolls past to reach the two things they came for.
 *
 * ## Collapsed by default, and the choice sticks
 *
 * Per panel, per browser, in `localStorage`. Somebody who works the cash advance every morning opens
 * it once and finds it open tomorrow; somebody who never touches commissioning never sees it again.
 *
 * The alternative — remembering server-side, per user — is a settings table and a round trip for a
 * preference that does not matter enough to survive changing machines. This is the cheap version
 * that is right almost always.
 *
 * ## What it deliberately does not do
 *
 * It does not hide whether a panel needs attention. That would need each panel to report a summary —
 * "two gates red", "nothing outstanding" — which is a real change to thirteen components rather than
 * a wrapper. Worth doing; not done here, and recorded rather than half-built, because a header that
 * says nothing is honest while a header that guesses is not.
 */
export function CollapsiblePanel({
  title,
  storageKey,
  defaultOpen = false,
  children,
}: {
  title: string;
  /** Stable across renders and unique per panel. Namespaced by the caller. */
  storageKey: string;
  defaultOpen?: boolean;
  children: React.ReactNode;
}) {
  const [open, setOpen] = useState(defaultOpen);
  /**
   * Read on mount rather than during render.
   *
   * `localStorage` does not exist on the server, and reading it while rendering would make the first
   * client paint disagree with the server's HTML — React calls that a hydration mismatch and it
   * shows up as a flash, or worse as a panel that opens itself.
   */
  useEffect(() => {
    const stored = window.localStorage.getItem(`panel:${storageKey}`);
    if (stored !== null) setOpen(stored === "open");
  }, [storageKey]);

  function toggle() {
    setOpen((current) => {
      const next = !current;
      window.localStorage.setItem(`panel:${storageKey}`, next ? "open" : "closed");
      return next;
    });
  }

  return (
    <section className="rounded-lg border border-border bg-surface">
      <button
        type="button"
        onClick={toggle}
        aria-expanded={open}
        className="flex w-full items-center gap-2 px-4 py-3 text-left hover:bg-surface-2"
      >
        {/* A caret rather than a plus/minus: it says "there is more below" rather than "add". */}
        <span
          aria-hidden
          className={`text-text-muted transition-transform ${open ? "rotate-90" : ""}`}
        >
          ›
        </span>
        <span className="text-sm font-semibold">{title}</span>
      </button>

      {/*
        Unmounted rather than hidden with CSS. Each of these panels runs its own queries, and a
        collapsed ticket that still fetched thirteen panels' worth of data would be slower than the
        page this replaces — which would defeat the point entirely.
      */}
      {open && <div className="border-t border-border px-4 py-3">{children}</div>}
    </section>
  );
}
