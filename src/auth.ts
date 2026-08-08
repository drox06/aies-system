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
  adapter: PrismaAdapter(db),
  session: {
    strategy: "database",
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
    async session({ session, user }) {
      const [roleKeys, permissions, dbUser] = await Promise.all([
        resolveUserRoleKeys(user.id),
        resolveUserPermissions(user.id),
        db.user.findUniqueOrThrow({
          where: { id: user.id },
          select: { totpEnabled: true, mustChangePassword: true },
        }),
      ]);

      session.user.id = user.id;
      session.user.roleKeys = roleKeys;
      session.user.permissions = [...permissions];
      session.user.totpEnabled = dbUser.totpEnabled;
      session.user.mustChangePassword = dbUser.mustChangePassword;

      return session;
    },
  },
});
