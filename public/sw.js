/*
 * Offline shell cache. specs/00-foundation.md §8: "Offline shell caching now; module 04 adds
 * offline data sync."
 *
 * Scope is deliberately narrow. This caches the brand assets and serves a small offline notice for
 * navigations that fail with no network. It does NOT cache API responses, HTML pages, or anything
 * behind auth:
 *
 *  - Stale ERP data shown as if current is worse than an honest "you are offline". A technician
 *    acting on yesterday's cached material request is a real operational error.
 *  - Cached authenticated HTML survives sign-out and would be served to whoever holds the device
 *    next, on an app that is on the public internet (Spec.md §7.4).
 *
 * Module 04 introduces deliberate offline data sync with its own conflict rules. That is the place
 * for it, not here.
 */

const CACHE = "aies-shell-v1";
const PRECACHE = ["/brand/aies-mark.svg", "/brand/aies-logo-mono-white.svg", "/brand/icon-192.png"];

self.addEventListener("install", (event) => {
  event.waitUntil(
    caches
      .open(CACHE)
      // Individually, so one missing asset does not fail the whole install.
      .then((cache) => Promise.allSettled(PRECACHE.map((url) => cache.add(url))))
      .then(() => self.skipWaiting()),
  );
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim()),
  );
});

self.addEventListener("fetch", (event) => {
  const { request } = event;
  if (request.method !== "GET") return;

  const url = new URL(request.url);
  if (url.origin !== self.location.origin) return;
  // Never touch auth or API traffic.
  if (url.pathname.startsWith("/api/")) return;

  // Brand assets: cache-first. They are immutable between `npm run brand` runs.
  if (url.pathname.startsWith("/brand/")) {
    event.respondWith(
      caches.match(request).then(
        (hit) =>
          hit ??
          fetch(request).then((res) => {
            if (res.ok) {
              const copy = res.clone();
              void caches.open(CACHE).then((c) => c.put(request, copy));
            }
            return res;
          }),
      ),
    );
    return;
  }

  // Navigations: network-only, with an offline notice as the fallback. No cached HTML.
  if (request.mode === "navigate") {
    event.respondWith(
      fetch(request).catch(
        () =>
          new Response(
            `<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">` +
              `<title>Offline — AIES</title>` +
              `<body style="font-family:system-ui;margin:0;display:grid;place-items:center;height:100dvh;background:#F5F7FA;color:#0F1B2A">` +
              `<div style="text-align:center;padding:2rem">` +
              `<img src="/brand/aies-mark.svg" width="64" height="64" alt="">` +
              `<h1 style="font-size:1.125rem;margin:1rem 0 .5rem">You are offline</h1>` +
              `<p style="color:#5A6B7D;margin:0">This page needs a connection. It will load once you are back online.</p>` +
              `</div></body>`,
            { status: 503, headers: { "Content-Type": "text/html; charset=utf-8" } },
          ),
      ),
    );
  }
});
