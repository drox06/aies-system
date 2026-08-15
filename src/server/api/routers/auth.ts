import { hash, verify } from "@node-rs/argon2";
import { TRPCError } from "@trpc/server";
import QRCode from "qrcode";
import { z } from "zod";
import { db } from "@/lib/db";
import { writeAuditLog } from "@/server/core/audit/audit";
import { checkPasswordPolicy } from "@/server/core/auth/password-policy";
import { countRemainingRecoveryCodes, issueRecoveryCodes } from "@/server/core/auth/recovery-codes";
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

      /**
       * Enable the factor and issue the way back in, in one transaction.
       *
       * Both or neither: an enrolment that succeeded without codes would leave the user in exactly
       * the state this feature exists to prevent, and codes issued against an enrolment that failed
       * would be credentials for nothing.
       */
      const codes = await db.$transaction(async (tx) => {
        await tx.user.update({
          where: { id: user.id },
          data: { totpEnabled: true, totpEnrolledAt: new Date() },
        });
        return issueRecoveryCodes(user.id, tx);
      });

      // The only time these are readable. Returned, never logged.
      return { ok: true as const, recoveryCodes: codes };
    }),

  /** How many codes are left, for the warning on the account screen. */
  recoveryCodeStatus: protectedProcedure.query(async ({ ctx }) => ({
    remaining: await countRemainingRecoveryCodes(ctx.user.id),
  })),

  /**
   * Issues a fresh set, invalidating every existing code.
   *
   * Gated on the current password, which is the point: a recovery code is a credential that
   * bypasses the second factor, so minting ten of them from an already-open session would let
   * anybody who found an unlocked laptop walk away with permanent access. Re-authenticating proves
   * the person at the keyboard is the account holder, not somebody who sat down after them.
   */
  regenerateRecoveryCodes: protectedProcedure
    .input(z.object({ currentPassword: z.string().min(1) }))
    .mutation(async ({ ctx, input }) => {
      const user = await db.user.findUniqueOrThrow({ where: { id: ctx.user.id } });
      if (!user.totpEnabled) {
        throw new TRPCError({
          code: "BAD_REQUEST",
          message: "Enrol an authenticator first — recovery codes are a backup for it.",
        });
      }
      if (!(await verify(user.passwordHash, input.currentPassword))) {
        throw new TRPCError({ code: "BAD_REQUEST", message: "That password is not right." });
      }

      const codes = await issueRecoveryCodes(user.id);

      await writeAuditLog(db, {
        actorId: user.id,
        actorLabel: user.name,
        action: "recovery_codes_regenerated",
        entityType: "User",
        entityId: user.id,
        summary: `${user.name} generated a new set of recovery codes. The previous set no longer works.`,
      });

      return { recoveryCodes: codes };
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
