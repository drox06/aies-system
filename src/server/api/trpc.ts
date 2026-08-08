import { initTRPC, TRPCError } from "@trpc/server";
import superjson from "superjson";
import { auth } from "@/auth";
import { checkRateLimit } from "@/server/core/rate-limit";
import type { AuthedUser } from "@/server/core/rbac/types";

export async function createTRPCContext(opts: { headers: Headers }) {
  const session = await auth();

  // Consumed by src/server/core/audit/audit.ts writes (specs/00-foundation.md §5's `ip`,
  // `userAgent`, `requestId` fields) — never trust these for security decisions, only logging.
  const ip =
    opts.headers.get("x-forwarded-for")?.split(",")[0]?.trim() ??
    opts.headers.get("x-real-ip") ??
    null;
  const userAgent = opts.headers.get("user-agent");
  const requestId = opts.headers.get("x-request-id") ?? crypto.randomUUID();

  return { session, ip, userAgent, requestId };
}

export type Context = Awaited<ReturnType<typeof createTRPCContext>>;

const t = initTRPC.context<Context>().create({ transformer: superjson });

export const router = t.router;
export const publicProcedure = t.procedure;

const enforceAuth = t.middleware(({ ctx, next }) => {
  if (!ctx.session?.user) {
    throw new TRPCError({ code: "UNAUTHORIZED" });
  }

  const user: AuthedUser = {
    id: ctx.session.user.id,
    email: ctx.session.user.email ?? "",
    name: ctx.session.user.name ?? "",
    roleKeys: ctx.session.user.roleKeys,
    permissions: new Set(ctx.session.user.permissions),
  };

  return next({ ctx: { ...ctx, user } });
});

// specs/00-foundation.md §4.1: "Rate limiting on all mutation endpoints." 30/minute is a starting
// default with no per-procedure tuning yet; revisit once real usage patterns exist.
const MUTATION_RATE_LIMIT = 30;
const MUTATION_RATE_WINDOW_MS = 60_000;

const rateLimitMutations = t.middleware(async ({ ctx, next, type, path }) => {
  if (type !== "mutation") return next();

  const key = ctx.session?.user?.id
    ? `mutation:user:${ctx.session.user.id}`
    : `mutation:anon:${path}`;
  const result = await checkRateLimit(key, MUTATION_RATE_LIMIT, MUTATION_RATE_WINDOW_MS);

  if (!result.allowed) {
    throw new TRPCError({
      code: "TOO_MANY_REQUESTS",
      message: `Rate limit exceeded. Try again in ${Math.ceil((result.retryAfterMs ?? 0) / 1000)}s.`,
    });
  }

  return next();
});

/** specs/00-foundation.md §4.2: `const protectedProcedure = t.procedure.use(requireAuth);` */
export const protectedProcedure = publicProcedure.use(rateLimitMutations).use(enforceAuth);

/** specs/00-foundation.md §4.2: `const p = (perm) => protectedProcedure.use(requirePermission(perm));` */
export const p = (permission: string) =>
  protectedProcedure.use(({ ctx, next }) => {
    if (!ctx.user.permissions.has(permission)) {
      throw new TRPCError({ code: "FORBIDDEN", message: `Missing permission: ${permission}` });
    }
    return next({ ctx });
  });
