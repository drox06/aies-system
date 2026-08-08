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

---

## 8. `signIn()`'s `totpCode: undefined` was silently sent as the literal string `"undefined"`

**Module:** 00, session 3 (found during manual browser verification of the login flow)
**Found by:** logging in as a TOTP-enrolled user reliably produced "Incorrect authenticator code"
instead of prompting for one, even though no code had been entered yet.
**Root cause:** `src/app/login/page.tsx` called `signIn("credentials", { totpCode: needsTotp ?
totpCode : undefined, ... })`. Auth.js's client (`node_modules/next-auth/react.js`) encodes
credentials via `new URLSearchParams({...})`, and `URLSearchParams` stringifies an `undefined`
property value as the four-character string `"undefined"` rather than omitting the key.
Server-side, `src/auth.ts`'s `raw.totpCode ? String(raw.totpCode) : undefined` sees a non-empty
(truthy) string, skips the "was a code even provided" check, and fails TOTP verification instead
of asking for one.
**Chose:** Send `totpCode: needsTotp ? totpCode : ""` (a real empty string) instead of `undefined`.
**Why this stayed hidden through session 2:** every account tested then had `totpEnabled: false`
at login time (enrollment happens *after* first login), so `authorize()` never reached the branch
that reads `totpCode` at all. It only surfaces once an account has completed enrollment and logs
in again — exactly the scenario this session's manual verification exercised for the first time.
**Also fixed alongside this:** a synchronous re-entrancy guard (`submittingRef`) on the login
form's submit handler, since a caller reported two simultaneous requests were reproducing the same
symptom in a way that was hard to distinguish from the encoding bug — the guard is correct
regardless of whether that was a genuine double-fire or a testing artifact.

---

## 9. `Strict-Transport-Security` is now only sent in production

**Module:** 00, session 3 (found during manual browser verification)
**Found by:** after the first local login attempt, all further navigation to `http://localhost:3000`
failed with `ERR_SSL_PROTOCOL_ERROR` — the browser had started force-upgrading every request to
`https://localhost`, which the dev server doesn't serve.
**Root cause:** `middleware.ts` sent `Strict-Transport-Security: max-age=63072000;
includeSubDomains; preload` on every response, including local plain-HTTP dev traffic. A browser
that honors HSTS for `localhost` (not all do — Chrome normally exempts it, but this held in the
Claude Browser pane's environment) caches that instruction and won't make another plain-HTTP
request to the origin until it expires.
**Chose:** Only set the header when `process.env.NODE_ENV === "production"`.
**Why:** HSTS is meaningless (and actively harmful, as observed) over a connection that was never
HTTPS in the first place — RFC 6797 says browsers should ignore it over plain HTTP, but relying on
every browser/environment to do so is exactly what broke here. Recovering required opening a fresh
browser tab (a new profile/context) since there was no way to clear the cached HSTS policy through
the available tooling.

---

## 10. `notify`'s email channel is enqueued but has no consumer yet — by design

**Module:** 00, session 4
**Ambiguity:** specs/00-foundation.md §7.3 lists three channels — in-app, email, daily digest —
with no guidance on what to do if the email provider (Resend/SMTP, Spec.md's stack table) isn't
configured yet, which it isn't this session.
**Chose:** `notify()` fully implements the in-app channel (the only one that's actually visible to
anyone yet) and, when a notification type's resolved channels include email, enqueues a job on a
`notify_email` queue via the existing job-queue infrastructure (session 3) — but no handler is
registered for that queue. Per the job queue's own design, an unregistered queue dead-letters
immediately with a clear `lastError`, surfaced in the (future) admin dead-letter UI.
**Why:** This is a deliberate use of an existing mechanism rather than a gap. Spec.md §3.3's own
principle — "Silent job failure is the main risk of this design; make failure loud" — is exactly
what happens here: "email wanted but not configured" becomes a visible, queryable dead-lettered
job instead of a silently dropped notification or a fabricated no-op email sender that looks like
it works. `digest` is tracked as a preference but nothing reads it yet, since it would compound on
email already working.
**Revisit:** once an email provider is configured (a `docs/DEPLOYMENT.md`-era decision — Spec.md
§10 lists "Outbound document email" under module 10 integrations), register a `notify_email`
handler and, separately, a scheduled digest job.

---

## 11. Only the Supabase storage driver is implemented — no local filesystem driver yet

**Module:** 00, session 4
**Ambiguity:** specs/00-foundation.md §7.2 offers two options for local development: "the
Supabase CLI's local stack or a filesystem driver behind the same interface."
**Chose:** Neither, for now — `src/server/core/storage/driver.ts` defines the swappable
`StorageDriver` interface the spec asks for, but only `supabase-driver.ts` implements it. Local
dev talks to the real `aies-files` bucket in the same remote `aies-platform-dev` Supabase project
already used for Postgres (docs/DECISIONS.md #1's pattern extended to Storage).
**Why:** A filesystem driver built without ever being exercised — no tests, no real call site
using it — would be exactly the "half-finished implementation" this project's own conventions
warn against. The real driver is fully tested (including round-tripping actual bytes through a
real signed URL, not mocked), and Supabase Storage was already one credential away, unlike the
local CLI stack (Docker, deferred in docs/DECISIONS.md #1) or a filesystem driver's own signed-URL
semantics needing to be invented from scratch just to fit the interface.
**Revisit:** if a genuinely offline local dev workflow becomes necessary, or per Spec.md §7.6's
self-host fallback.

---

## 12. Approval step "mode" — only "parallel" (first decision wins) is implemented

**Module:** 00, session 4
**Ambiguity:** specs/00-foundation.md §7.4 says step definitions support "parallel-or-sequential
mode" with no further explanation of what "sequential" means for a single step's set of eligible
approvers (role-holders, permission-holders, or a specific user).
**Chose:** Eligibility per step is a *predicate* over a user (`isEligibleToDecide(user)`), not an
enumerable list — matching how the rest of RBAC works (`user.permissions.has(...)`, not "fetch
everyone with this permission"). "Parallel" (first eligible decision resolves the step) is fully
implemented. "Sequential" (require literally every eligible person to approve) would need an
enumerable approver set, which this model doesn't have, and no confirmed AIES scenario (quotation
approval, cash advance approval — both single decisive approvers, VP or President-fallback) needs
committee-style unanimity. `assertStepsSupported()` rejects any step declaring `mode: "sequential"`
at workflow-save time — fails loud and early, rather than silently treating it as "parallel" (a
real behavior difference someone could reasonably be surprised by) or accepting a definition nothing
will honor correctly.
**Revisit:** if a real workflow genuinely needs unanimous multi-approver agreement, at which point
the eligibility model would need to gain an enumeration capability (e.g. resolving `requiredRole`
against `db.user` to get an actual headcount) — a bigger change than adding a flag.

## 13. Approval engine emits only the three events Spec.md §7.4 names

**Module:** 00, session 4
Advancing a multi-step workflow to its next step doesn't emit an event — only full approval
(`approval.approved`), rejection (`approval.rejected`), and creation (`approval.requested`) do,
matching the spec's literal list. `listMyApprovalInbox()` is pulled on demand rather than pushed,
so nothing is actually missed; an intermediate `approval.step_advanced` event can be added later
once a real multi-step workflow needs to notify a second step's approvers proactively.
