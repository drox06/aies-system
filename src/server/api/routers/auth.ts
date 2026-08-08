import { hash, verify } from "@node-rs/argon2";
import { TRPCError } from "@trpc/server";
import QRCode from "qrcode";
import { z } from "zod";
import { db } from "@/lib/db";
import { checkPasswordPolicy } from "@/server/core/auth/password-policy";
import { generateTotpSecret, totpProvisioningUri, verifyTotp } from "@/server/core/auth/totp";
import { protectedProcedure, router } from "@/server/api/trpc";

export const authRouter = router({
  // Generates and stores a new secret but does not enable TOTP yet — enabled only once the user
  // proves they can produce a valid code (confirmTotpEnrollment), so a mistyped/unscanned QR
  // can't silently lock the account out later.
  startTotpEnrollment: protectedProcedure.mutation(async ({ ctx }) => {
    const user = await db.user.findUniqueOrThrow({ where: { id: ctx.user.id } });
    if (user.totpEnabled) {
      throw new TRPCError({ code: "BAD_REQUEST", message: "TOTP is already enrolled." });
    }

    const secret = generateTotpSecret();
    await db.user.update({ where: { id: user.id }, data: { totpSecret: secret } });

    const uri = totpProvisioningUri(secret, user.email);
    const qrCodeDataUrl = await QRCode.toDataURL(uri);

    return { secret, qrCodeDataUrl };
  }),

  confirmTotpEnrollment: protectedProcedure
    .input(z.object({ code: z.string().length(6) }))
    .mutation(async ({ ctx, input }) => {
      const user = await db.user.findUniqueOrThrow({ where: { id: ctx.user.id } });
      if (!user.totpSecret) {
        throw new TRPCError({ code: "BAD_REQUEST", message: "Start enrollment first." });
      }
      if (!verifyTotp(user.totpSecret, input.code)) {
        throw new TRPCError({ code: "BAD_REQUEST", message: "Invalid code." });
      }

      await db.user.update({
        where: { id: user.id },
        data: { totpEnabled: true, totpEnrolledAt: new Date() },
      });

      return { ok: true as const };
    }),

  changePassword: protectedProcedure
    .input(z.object({ currentPassword: z.string(), newPassword: z.string() }))
    .mutation(async ({ ctx, input }) => {
      const user = await db.user.findUniqueOrThrow({ where: { id: ctx.user.id } });

      const currentOk = await verify(user.passwordHash, input.currentPassword);
      if (!currentOk) {
        throw new TRPCError({ code: "BAD_REQUEST", message: "Current password is incorrect." });
      }

      const policy = checkPasswordPolicy(input.newPassword, [user.email, user.name]);
      if (!policy.ok) {
        throw new TRPCError({ code: "BAD_REQUEST", message: policy.reason });
      }

      const passwordHash = await hash(input.newPassword);
      await db.user.update({
        where: { id: user.id },
        data: { passwordHash, mustChangePassword: false },
      });

      return { ok: true as const };
    }),
});
