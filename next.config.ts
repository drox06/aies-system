import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  reactStrictMode: true,
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
