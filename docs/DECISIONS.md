# Decisions Log

ADR-style entries for ambiguities resolved during the build, per Spec.md §0 step 5 and §11.3. Not
for the company's own confirmed answers — those live in `docs/DECISIONS-CONFIRMED.md`.

---

## 1. Local dev database deferred; CI is the only verified live-DB path for now

**Module:** 00, session 1
**Ambiguity:** specs/00-foundation.md §2 calls for `docker/docker-compose.dev.yml` for local
Postgres, and the review gate in `docs/BUILD-PROTOCOL.md` §7 expects "migration applies cleanly
to a fresh database." The build machine had neither Docker nor a local Postgres installed.
**Chose:** Write `docker/docker-compose.dev.yml` so it's ready to use, but don't install Docker
Desktop this session (confirmed with the user — it's a heavier, more consequential install than
Node was). `.github/workflows/ci.yml` runs a real Postgres service container and is the actual
verified path for `prisma migrate deploy` / drift-checking until local Docker exists.
**Why:** Installing Docker Desktop involves kernel-level virtualization (WSL2/Hyper-V), a likely
reboot, and licensing terms worth the company knowing about — not something to do silently mid-
session. Nothing in module 00 session 1 requires a live database (no models exist yet; see #3).
**Revisit:** before module 00 session 2 (RBAC models + first real migration), since that session
does need a live database to run `prisma migrate dev`.

**Addendum (still session 1):** revisited immediately — WSL2 wasn't installed either, so Docker
Desktop would have meant installing WSL2, a reboot, then Docker Desktop, possibly another reboot.
Since Supabase is the actual deployment target anyway (Spec.md §3.1), the user created a real
Supabase project (`aies-platform-dev`, ap-southeast-1) instead of a local database. `.env` now
holds working credentials: `DATABASE_URL` via the transaction-mode pooler (port 6543,
`pgbouncer=true`) for the app, `DIRECT_URL` via the session-mode pooler (port 5432) for Prisma
Migrate — the session-mode pooler is used instead of Supabase's true direct connection
(`db.<ref>.supabase.co`) because that host is IPv6-only unless the paid IPv4 add-on is purchased,
and this is Supabase's own recommended pattern for Prisma. `prisma migrate deploy` connects
successfully. `docker/docker-compose.dev.yml` stays in the repo unused for now — still useful if
AIES later works from a machine/network where the Supabase pooler isn't reachable, or moves to
the self-host fallback (Spec.md §7.2).

---

## 2. `prisma.config.ts` instead of `package.json#prisma` for the split-schema path

**Module:** 00, session 1
**Ambiguity:** specs/00-foundation.md §2 says to use the `prismaSchemaFolder` preview feature.
Prisma 6.19 (the version installed) reports that preview feature as stable/deprecated-as-a-flag,
and warns that configuring the schema folder path via `package.json#prisma` is deprecated for
removal in Prisma 7.
**Chose:** Removed `previewFeatures = ["prismaSchemaFolder"]` from the generator block (no longer
needed) and configured the schema folder location via `prisma.config.ts` instead of
`package.json#prisma`.
**Why:** Matches current Prisma guidance and avoids building on a config surface Prisma is about
to remove.

---

## 3. No migration generated in module 00 session 1

**Module:** 00, session 1
**Ambiguity:** specs/00-foundation.md §2 lists Prisma bootstrap as in-scope for session 1; it
wasn't obvious whether that requires an actual migration file to exist by the end of the session.
**Chose:** Left `prisma/migrations/` absent. `prisma/schema/schema.prisma` holds only the
datasource/generator config — zero models are owned by the module manifest system itself (it's
pure TypeScript, no persistence). The first real migration lands in session 2 alongside the RBAC
models (`User`, `Role`, `Permission`, etc.), which is also when a migration would first mean
anything.
**Why:** Generating an empty migration now would be a no-op that verifies nothing.

---

## 4. Auth.js session strategy is `jwt`, not `database` — with a twist that keeps it live

**Module:** 00, session 2
**Ambiguity:** specs/00-foundation.md §4.1 says "Sessions: database-backed." Auth.js v5 hard-
rejects that combination at runtime: `UnsupportedStrategy: Signing in with credentials only
supported if JWT strategy is enabled.` This is enforced in `@auth/core` itself, not a
misconfiguration on our part — a Credentials provider cannot be paired with `session.strategy:
"database"`.
**Chose:** `session.strategy: "jwt"`. To keep the spirit of "database-backed" — permission and
deactivation changes should take effect without waiting for token refresh — the `session`
callback (src/auth.ts) re-resolves roles/permissions/totpEnabled/mustChangePassword from Postgres
on **every** request, keyed off the JWT's `sub`, rather than trusting cached claims. If the user
was deactivated or deleted since the token was issued, `session.user.id` is set to `""` and
middleware treats that as unauthenticated (checks `session.user.id`, not just session presence).
**Cost:** no per-device "revoke this session" and no "full session list with device/IP" — JWTs
aren't individually revocable without a blocklist. If that's wanted later, the plan is a
`sessionVersion` counter on `User`, stamped into the JWT at issuance and checked against the
current DB value on each request; "sign out everywhere" becomes incrementing the counter. Not
built yet because nothing in session 2 requires it.
**Revisit:** when the "full session list + revoke all" UI feature is actually prioritized.

---

## 5. `middleware.ts` must live in `src/`, and needs the Node.js runtime, not Edge

**Module:** 00, session 2
Two build-environment surprises, both silent (no error, middleware just doesn't run):
1. With a `src/` directory layout, Next.js expects `src/middleware.ts`. A root-level
   `middleware.ts` is silently ignored — no warning, no build error, requests just pass straight
   through with none of the CSP headers or auth redirects applied. Caught by manually checking for
   a `Content-Security-Policy` response header and finding none.
2. The `session` callback does a real Prisma query on every request (see #4), which can't run on
   the Edge runtime middleware uses by default. Next.js 15.5's Node.js middleware runtime
   (`export const runtime = "nodejs"` in middleware.ts) makes this work, but requires
   `experimental.nodeMiddleware: true` in `next.config.ts` — and that flag isn't in this Next
   version's `NextConfig` TypeScript types yet, hence the `as NextConfig["experimental"]` cast
   there. (`next build` prints a harmless "Invalid next.config.ts options" warning for this flag
   while still enabling it — confirmed by the "Experiments (use with caution): ✓ nodeMiddleware"
   banner it also prints.) `src/auth.config.ts` holds the Edge-safe alternative (no provider, no
   adapter) in case this ever needs to move back to Edge.

---

## 6. CSP nonce propagation requires `headers()` in the root layout — which forces dynamic rendering everywhere

**Module:** 00, session 2
**Found by:** the Playwright e2e test failing only in production mode (`next build && next
start`), never in dev. `curl` against the built app showed `<template
data-dgst="BAILOUT_TO_CLIENT_SIDE_RENDERING">` for `/login` and zero `nonce="..."` attributes on
any `<script>` tag, despite the CSP response header carrying one — meaning the strict production
CSP (`'strict-dynamic'`, no `'unsafe-eval'`) was silently blocking every script from executing,
so the page hydrated never and stayed permanently blank.
**Root cause:** Next.js only stamps its own framework-injected scripts with the middleware's
nonce if a Server Component in the tree calls `headers()`. Nothing did.
**Chose:** `src/app/layout.tsx`'s `RootLayout` is now `async` and calls `await headers()` (value
unused — the call itself is what matters). This also happens to fix the `BAILOUT_TO_CLIENT_SIDE_
RENDERING` on `/login`, since `useSearchParams()` no longer needs to defer to the client once the
route is dynamically rendered.
**Cost:** calling `headers()` opts every route under this layout out of static prerendering — the
build output changed from mostly `○ (Static)` to all `ƒ (Dynamic)`. Acceptable for a five-person
internal app with no CDN-cacheable public pages; would be worth revisiting if a future route
genuinely wants static generation (a nested layout scoped to just that route could read
`headers()` instead of the root one).
**Verified:** rebuilt, confirmed the header's nonce and the script tags' `nonce="..."` attributes
match byte-for-byte within a single response, and the Playwright e2e test passes against the
production build.

---

## 7. Vitest runs test files sequentially (`fileParallelism: false`)

**Module:** 00, session 2
**Found by:** `npm test` intermittently failing 2-7 of the DB-touching tests with `Can't reach
database server at aws-0-ap-southeast-1.pooler.supabase.com:6543` — inconsistent counts across
runs, never the same tests, always the ones hitting Postgres. Not a code bug: Vitest defaults to
one worker process per test file, each instantiating its own `PrismaClient`, all opening
connections to the same Supabase project simultaneously — enough to exhaust the free-tier
transaction pooler's connection slots.
**Chose:** `fileParallelism: false` in `vitest.config.ts`, so the DB-touching test files run one
at a time. Confirmed stable across repeated runs after the change (was previously reproducing on
~2 of 3 runs).
**Revisit:** if the test suite grows slow enough for this to matter, a shared test-scoped
`PrismaClient` (rather than each file's default import touching the same global singleton
independently across worker processes) or a paid Supabase tier with more pooler connections would
remove the need for this constraint.
