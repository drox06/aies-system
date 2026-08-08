import { z } from "zod";
import {
  ACCOUNT_STATUSES,
  ACCOUNT_TYPES,
  createAccountService,
  deleteAccountService,
  getAccountService,
  listAccountsService,
  updateAccountService,
  type ActorMeta,
} from "@/server/core/crm/account-service";
import { findDuplicateAccounts } from "@/server/core/crm/duplicates";
import { p, router, type Context } from "@/server/api/trpc";

function actorMeta(ctx: Context & { user: { id: string; name: string } }): ActorMeta {
  return {
    actorId: ctx.user.id,
    actorLabel: ctx.user.name,
    ip: ctx.ip,
    userAgent: ctx.userAgent,
    requestId: ctx.requestId,
  };
}

/** Shared by create and update. Everything optional on update; `name` is required on create. */
const accountFields = {
  legalName: z.string().nullish(),
  tin: z.string().nullish(),
  industry: z.string().nullish(),
  accountType: z.enum(ACCOUNT_TYPES).optional(),
  website: z.string().nullish(),
  email: z.string().email().nullish().or(z.literal("")),
  phone: z.string().nullish(),
  billingAddress: z.unknown().optional(),
  shippingAddress: z.unknown().optional(),
  // A string, not a number: money crosses the wire as a decimal string so it never passes through
  // a float on the way to Prisma's Decimal.
  creditLimit: z.string().nullish(),
  currency: z.string().optional(),
  ownerId: z.string().nullish(),
  parentAccountId: z.string().nullish(),
  customFields: z.unknown().optional(),
};

export const crmRouter = router({
  listAccounts: p("crm.view")
    .input(
      z
        .object({
          search: z.string().optional(),
          status: z.enum(ACCOUNT_STATUSES).optional(),
          page: z.number().int().positive().optional(),
          pageSize: z.number().int().positive().max(100).optional(),
          sortKey: z.string().nullish(),
          sortDir: z.enum(["asc", "desc"]).optional(),
        })
        .optional(),
    )
    .query(({ ctx, input }) => listAccountsService(ctx.user, input ?? {})),

  getAccount: p("crm.view")
    .input(z.object({ accountId: z.string() }))
    .query(({ ctx, input }) => getAccountService(ctx.user, input.accountId)),

  /**
   * specs/01-crm-inquiry.md §7 — called by the create form *before* submitting, so the warning
   * arrives while the user can still act on it. Gated on `crm.create` rather than `crm.view`:
   * it is only useful to someone about to create, and it reveals account names.
   */
  checkDuplicateAccounts: p("crm.create")
    .input(
      z.object({
        name: z.string(),
        tin: z.string().nullish(),
        email: z.string().nullish(),
        excludeAccountId: z.string().nullish(),
      }),
    )
    .query(({ input }) => findDuplicateAccounts(input)),

  createAccount: p("crm.create")
    .input(z.object({ name: z.string().min(1), ...accountFields }))
    .mutation(({ ctx, input }) => createAccountService(actorMeta(ctx), input)),

  updateAccount: p("crm.edit")
    .input(
      z.object({
        accountId: z.string(),
        name: z.string().min(1).optional(),
        status: z.enum(ACCOUNT_STATUSES).optional(),
        ...accountFields,
      }),
    )
    .mutation(({ ctx, input }) => updateAccountService(actorMeta(ctx), input)),

  deleteAccount: p("crm.delete")
    .input(z.object({ accountId: z.string() }))
    .mutation(({ ctx, input }) => deleteAccountService(actorMeta(ctx), input)),
});
