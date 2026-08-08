import { verify } from "@node-rs/argon2";
import { PrismaAdapter } from "@auth/prisma-adapter";
import NextAuth, { CredentialsSignin } from "next-auth";
import Credentials from "next-auth/providers/credentials";
import { authConfig } from "@/auth.config";
import { db } from "@/lib/db";
import { verifyTotp } from "@/server/core/auth/totp";
import {
  isLockedOut,
  recordFailedLogin,
  recordSuccessfulLogin,
} from "@/server/core/auth/login-throttle";
import { resolveUserPermissions, resolveUserRoleKeys } from "@/server/core/rbac/permissions";

// Auth.js v5's CredentialsSignin subclasses carry a `.code` the client can branch on (e.g. to
// show a TOTP field) without leaking *why* through the generic OAuth-style error message.
class InvalidCredentialsError extends CredentialsSignin {
  code = "invalid_credentials";
}
class AccountLockedError extends CredentialsSignin {
  code = "account_locked";
}
class TotpRequiredError extends CredentialsSignin {
  code = "totp_required";
}
class InvalidTotpError extends CredentialsSignin {
  code = "invalid_totp";
}

export const { handlers, auth, signIn, signOut } = NextAuth({
  ...authConfig,
  // Kept for a future optional Google Workspace OIDC provider (specs/00-foundation.md §4.1),
  // which would use it for Account linkage — unused by the Credentials provider below.
  adapter: PrismaAdapter(db),
  session: {
    // Auth.js hard-disallows "database" strategy combined with a Credentials provider
    // (UnsupportedStrategy) — session data is instead resolved fresh from the DB on every
    // request in the `session` callback below, keyed off the JWT's `sub`, so permission/
    // deactivation changes still take effect immediately rather than waiting on token refresh.
    // See docs/DECISIONS.md for what this costs: no per-device "revoke this session" (only
    // "sign out everywhere" would be buildable, and isn't built yet either).
    strategy: "jwt",
    // specs/00-foundation.md §4.1: 12h idle timeout, 30-day absolute lifetime.
    maxAge: 30 * 24 * 60 * 60,
    updateAge: 12 * 60 * 60,
  },
  providers: [
    Credentials({
      credentials: { email: {}, password: {}, totpCode: {} },
      authorize: async (raw) => {
        const email = String(raw.email ?? "")
          .toLowerCase()
          .trim();
        const password = String(raw.password ?? "");
        const totpCode = raw.totpCode ? String(raw.totpCode) : undefined;

        const user = await db.user.findUnique({ where: { email } });
        if (!user || !user.isActive || user.deletedAt) {
          throw new InvalidCredentialsError();
        }

        if (isLockedOut(user)) {
          throw new AccountLockedError();
        }

        const passwordOk = await verify(user.passwordHash, password);
        if (!passwordOk) {
          await recordFailedLogin(user.id);
          throw new InvalidCredentialsError();
        }

        if (user.totpEnabled) {
          if (!totpCode) {
            throw new TotpRequiredError();
          }
          if (!user.totpSecret || !verifyTotp(user.totpSecret, totpCode)) {
            await recordFailedLogin(user.id);
            throw new InvalidTotpError();
          }
        }

        await recordSuccessfulLogin(user.id);

        return { id: user.id, email: user.email, name: user.name };
      },
    }),
  ],
  callbacks: {
    async jwt({ token, user }) {
      if (user?.id) {
        token.sub = user.id;
      }
      return token;
    },
    async session({ session, token }) {
      const userId = token.sub;
      if (!userId) return session;

      try {
        const dbUser = await db.user.findUnique({
          where: { id: userId },
          select: { isActive: true, deletedAt: true, totpEnabled: true, mustChangePassword: true },
        });

        // Deactivated or deleted since the token was issued: surface as unauthenticated rather
        // than trusting stale claims. middleware.ts checks `session.user.id`, not just session
        // truthiness, specifically so this takes effect.
        if (!dbUser || !dbUser.isActive || dbUser.deletedAt) {
          session.user.id = "";
          session.user.roleKeys = [];
          session.user.permissions = [];
          return session;
        }

        const [roleKeys, permissions] = await Promise.all([
          resolveUserRoleKeys(userId),
          resolveUserPermissions(userId),
        ]);

        session.user.id = userId;
        session.user.roleKeys = roleKeys;
        session.user.permissions = [...permissions];
        session.user.totpEnabled = dbUser.totpEnabled;
        session.user.mustChangePassword = dbUser.mustChangePassword;

        return session;
      } catch (error) {
        // The database could not be *asked* — which is a different fact from "this user is not
        // allowed", and must not be conflated with it. Letting this throw makes Auth.js raise
        // JWTSessionError and drop the session, so one slow query (a Supabase pooler timeout, a
        // failover) signs everybody out and forces a full re-login including TOTP. Observed
        // exactly that during session 5: `Timed out fetching a new connection from the connection
        // pool` logged every user out mid-work. See docs/DECISIONS.md #16.
        //
        // So: keep the identity, which came from a signed JWT and needs no database to trust, and
        // grant nothing, because no permission could be verified. Every permission-gated
        // procedure then fails closed while the user stays signed in, and the next request repairs
        // the session once the database answers again.
        console.error("[auth] session callback could not reach the database:", error);
        session.user.id = userId;
        session.user.roleKeys = [];
        session.user.permissions = [];
        return session;
      }
    },
  },
});
