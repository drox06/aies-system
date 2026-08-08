"use client";

import { useEffect } from "react";

/**
 * Registers public/sw.js.
 *
 * Production only: in development the service worker would serve stale assets straight through
 * Fast Refresh, which produces exactly the kind of "why is my change not showing" confusion that
 * costs an afternoon.
 */
export function ServiceWorker() {
  useEffect(() => {
    if (process.env.NODE_ENV !== "production") return;
    if (!("serviceWorker" in navigator)) return;
    const register = () => void navigator.serviceWorker.register("/sw.js").catch(() => {});
    // After load, so registration never competes with the first paint.
    if (document.readyState === "complete") register();
    else window.addEventListener("load", register, { once: true });
  }, []);

  return null;
}
