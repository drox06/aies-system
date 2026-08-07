import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  reactStrictMode: true,
  eslint: {
    // CI runs `npm run lint` as its own step; don't duplicate it during `next build`.
    ignoreDuringBuilds: true,
  },
};

export default nextConfig;
