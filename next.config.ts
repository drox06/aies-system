import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  reactStrictMode: true,

  /**
   * Where build output goes. Defaults to `.next`, which is what Vercel and `next start` expect —
   * `NEXT_DIST_DIR` is only ever set locally, so production behaviour is unchanged.
   *
   * It exists because a verification `next build` and a running `next dev` cannot share one output
   * directory: the two formats are incompatible, and the second one to touch `.next` leaves the
   * first serving a half-broken app. The visible symptom is
   * `ENOENT: ... .next/server/pages/_document.js` in the browser while the dev server itself looks
   * healthy in the terminal — which is exactly as confusing as it sounds, and has now cost time
   * twice (docs/DECISIONS.md #17).
   *
   * `npm run build:check` sets this to `.next-build` so a verification build can run at any time
   * without disturbing a dev server. Prefer it over `npm run build` while developing.
   */
  distDir: process.env.NEXT_DIST_DIR ?? ".next",
  eslint: {
    // CI runs `npm run lint` as its own step; don't duplicate it during `next build`.
    ignoreDuringBuilds: true,
  },
  experimental: {
    // Required for middleware.ts's `export const runtime = "nodejs"` (see that file's comment).
    // A real, recognized flag in 15.5.23 at the build/runtime level — confirmed by the
    // "Experiments (use with caution)" banner `next build` prints — but missing from this
    // version's NextConfig type declarations, hence the cast.
    nodeMiddleware: true,
  } as NextConfig["experimental"],
};

export default nextConfig;
