import type { NextAuthConfig } from "next-auth";

// Edge-safe subset of the Auth.js config. middleware.ts (Edge runtime by default) imports only
// this — never src/auth.ts, which pulls in @node-rs/argon2 (native bindings) and the Prisma
// adapter via the Credentials provider's `authorize()`, neither of which run on the Edge runtime.
export const authConfig = {
  pages: { signIn: "/login" },
  providers: [],
} satisfies NextAuthConfig;
