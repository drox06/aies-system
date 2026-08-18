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

## 14. `ActivityFeed` comments now resolve `authorId` to a display name

**Module:** 00, session 4
**Found during manual browser verification:** posting a comment on `/admin/users` rendered the
raw `Comment.authorId` cuid (e.g. `cmsjmsdl4000gup3w75a7btnz`) as the author, while audit entries
in the same feed already show a friendly `actorLabel`. Since specs/00-foundation.md §7.6 calls
`ActivityFeed` "the heart of the replace-external-chat-apps requirement," showing a raw id where a
name belongs is a real usability defect, not cosmetic.
**Fix:** `getActivityFeed()` (`src/server/core/comments/activity-feed.ts`) now looks up the
distinct `authorId`s for a feed's comments against `User` and attaches a resolved `authorLabel`,
same field name and shape as the audit side. `Comment.authorId` deliberately stays a plain string
(no Prisma relation added) — same decoupled-from-`User` convention already used by
`AuditLog.actorId` and `EventOutbox.actorId` — so the lookup is a small second query, not a schema
relation. Falls back to the raw id if the user record is gone, rather than throwing.
**Note:** unlike `AuditLog.actorLabel` (a snapshot captured once, at write time, so a renamed user
doesn't rewrite history), this is a live lookup — resolved fresh on every read, so a renamed user's
older comments show their current name. That's the intentionally different choice here: a comment
thread is closer to a chat log (where every UI, e.g. Slack, shows the current display name) than to
a compliance audit trail (where "what was true at the time" is the point).

## 15. Brand assets are generated from a traced vector master, not hand-authored

**Module:** 00, session 5
**Context:** Spec.md §6.1 requires five SVG derivatives plus four raster icons, produced by
"trace or rebuild from the JPG". The company supplied a vector master — an 802-path auto-trace
in which every gradient is approximated by ~60 flat colour bands.

**Verified the palette against it first:** the trace's colours match Spec.md §6.2's sampled tokens
almost exactly (`#011761` vs `--aies-navy-900: #011860`, `#FD5E0F` vs `--aies-orange-500: #FD5E13`,
`#EC010C` vs `--aies-red-500: #EE010C`). That independently confirms §6.2 was genuinely sampled
from this artwork, so the tokens are used verbatim.

**Chose:** a committed generator, `scripts/build-brand-assets.ts` (`npm run brand`), rather than
hand-edited SVGs. Every derivative needs the same corrections, and doing them once by hand means
they can never be redone when better artwork arrives. Outputs are committed so Vercel builds do
not depend on the script.

Corrections the generator applies, each for a specific defect in the master:

- **Background removed.** The master is fully opaque — it traced the JPG's white background as a
  full-canvas path. Spec.md §6.1 requires transparency, and without this the logo would carry a
  white box onto the navy sidebar §6.4 calls for.
- **Drop shadow removed.** The artwork's soft shadow survived flattening as a single flat grey
  sliver ~120:1 wide. At sidebar size it reads as a stray rule under the logo, and a logo should
  not carry a baked shadow into a PDF header.
- **Mono variants are a hybrid.** Wordmark and gear come from the background path's knockout
  subpaths, which trace those large shapes crisply. The tagline does *not* — the knockout renders
  8px type coarsely enough to fill the "O" of ELECTROMECHANICAL solid and melt "ME" together — so
  the tagline is taken from its own 48 letter paths instead, combined through a luminance mask.
  A mask rather than a compound path because the tracer painted the counters *over* the letters
  as separate light shapes rather than cutting holes in them, and subtracting those without a
  mask would need boolean path arithmetic. Cost: 32kB raw / 12.5kB gzipped.

**The mark is rebuilt as geometry, not extracted.** In the artwork the "S" sits on top of the
gear, so the traced gear paths have an S-shaped void through them — cropping them yields a gear
with a bite out of it, unusable as a favicon. The replacement was measured off the source raster
(least-squares circle fit plus a radial fill profile): 12 teeth at a 30° pitch, hole below 0.45R,
solid ring 0.56–0.88R, teeth 0.88–1.0R at ~50% duty. It is drawn in a navy→sky gradient echoing
the chrome's light direction, and reads cleanly at 16px where 60 bands of traced chrome would not.

**Known limitation:** the full-colour lockup is 364kB (130kB gzipped) because the banded trace
needs 800 paths. If genuine gradient artwork (an `.ai`/`.eps` export with real gradient fills
rather than a posterised trace) is ever supplied, drop it in at `brand/aies-logo-source.svg`,
re-run `npm run brand`, and every derivative regenerates.

**Amended (still session 5):** this entry originally justified that weight by noting the asset was
off the hot path, since the shell used the 12.5kB mono variant. That is no longer true. On the
company's instruction the full-colour lockup is now used on both the auth screens and the sidebar,
so it loads on every page. Two things make that acceptable rather than a regression: it is one
file shared by both, so after the login screen it is already cached and the marginal cost on every
later page is zero; and the mono variant could not be used in either place once the requirement
was to show the *actual* logo. The mono-white silhouette and the 0.6kB mark are still generated
and still correct for anywhere the colour version cannot go. If the first paint ever feels heavy
on a plant LTE connection, the fix is a raster derivative for fixed-size screen use, keeping the
SVG for PDF headers where the vector genuinely matters.

**Placing the colour lockup in navy chrome:** §6.1's "never place the gradient version on a
coloured background" is satisfied by a white plate behind it, not by exception. The rule is not
decorative — the wordmark's "AI" runs navy-900 to blue-600, so directly on the navy sidebar it
would be navy on navy, and the near-black tagline would disappear. The logo sits on white; the
white sits on navy. The plate's padding doubles as the clear space §6.1 requires.

**Rejected:** a second raster supplied mid-session (`aies logo png.png`, 1264×843). It is a
redrawn interpretation, not the same artwork — the lightning bolt is reshaped, the palette drifts
lighter than the §6.2 tokens, and the content ratio is 1.79:1 against the original's 2.61:1
(§6.1 records "roughly 2.6:1"). It is also raster, lower-resolution than the JPG already in
`brand/`, and equally opaque, so it cannot serve the 24px-sidebar-to-300dpi-PDF range that made
vector matter in the first place.

## 16. A database error in the session callback degrades access; it does not sign the user out

**Module:** 00, session 5
**Found by:** manual verification. Mid-session the browser was silently returned to `/login`. The
dev log showed `JWTSessionError` caused by `Timed out fetching a new connection from the
connection pool (timeout: 10, limit: 25)` raised from `src/auth.ts`'s `session` callback — the
full test suite was running against the same Supabase pooler as the dev server.

**Why it mattered more than the local cause:** decision #4 has the session callback re-read roles
and permissions from Postgres on *every* request, which is what makes deactivation take effect
immediately. The callback had no error handling, so any failure of that query propagated, Auth.js
treated the session as unreadable, and the user was signed out. On Vercel, against a pooled
Supabase connection, brief connection pressure is an ordinary event — and the consequence was
every signed-in user being thrown back to the login screen and made to re-enter a TOTP code,
because one query was slow.

**Chose:** catch inside the callback and distinguish the two facts that were being conflated:

- The query *answered* and said the user is missing, inactive or deleted → invalidate, as before.
  That is a real authorization decision.
- The query *could not be made* → keep `session.user.id` and grant nothing. Identity came from a
  signed JWT and needs no database to be trusted; permissions did not survive verification, so
  none are granted. Permission-gated procedures fail closed, the user stays signed in, and the
  next request restores the session once the database answers.

**Rejected:** caching the last known permissions in the JWT and falling back to them. That would
keep the app fully usable through an outage, but it would also mean a revoked permission could be
exercised for the life of the token precisely when the audit trail is least able to record it.
Degrading to no access is the safer failure, and it is self-healing.

**Note:** the error is logged with `console.error` rather than swallowed, so the underlying
connection problem stays visible instead of being masked by the graceful degradation.

## 17. `next build` and `next dev` must not share an output directory

**Module:** 00, session 5
**Cost:** hit twice in one session, and the second time it was mistaken for a broken login.

`next dev` and `next build` write to the same `.next` directory. Running a production build while
the dev server is up overwrites the chunks the running server is serving, and the symptom is not
an error — it is this:

```
Error: Cannot find module './331.js'
    at .next/server/app/login/page.js
  page: '/login'
```

The page still returns **200 with correct HTML**. Only its JavaScript is dead. So the form renders
perfectly, the button looks enabled, and clicking it does nothing at all — no request leaves the
browser, nothing appears in the server log, no error surfaces anywhere the person clicking can
see. During the module 00 review gate this was reported as "I typed in my credentials but nothing
happens", and the obvious readings (wrong password, broken auth, a bug in the new app shell) were
all wrong.

Two distinct traps, and the second is the one that actually cost the time:

1. **Building while the server runs** corrupts the server's own cache.
2. **Clearing `.next` and restarting fixes the server but not the browser.** An already-open tab
   keeps its old bundle, whose handlers reference deleted chunks. The tab must be *hard* reloaded
   (`Ctrl`+`Shift`+`R`) — an ordinary refresh can serve the same dead bundle from cache. The
   server log looks completely healthy at this point, which makes it worse.

**Rule:** stop the dev server before `npm run build`, or build from a separate checkout. When
verification work is happening in a browser, do not restart the dev server underneath it; if the
cache must be cleared mid-session, say so explicitly and expect a hard reload, because the person
in the browser has no way to tell a dead bundle from a working one.

### Reversed in module 01 session 3 — it *was* solvable by configuration

This entry originally closed with:

> **Not solvable by configuration.** `distDir` could separate the two, but that would diverge from
> what Vercel builds and trade a loud, well-understood local annoyance for a quiet difference
> between local and production output. The discipline is cheaper than the divergence.

That was a prediction about how reliably the discipline would hold, and it has now failed three
times — the third while demonstrating module 01 to the company, which produced a full-screen
`ENOENT: no such file or directory, open '.next/server/pages/_document.js'` in the browser while the
dev server's own terminal output looked entirely healthy. That asymmetry is the expensive part: the
place you would look for the fault reports success.

Two things make the original objection weaker than it read at the time:

1. **The proposal it rejected was to *replace* the default `distDir`.** What is implemented instead
   is `distDir: process.env.NEXT_DIST_DIR ?? ".next"`. `NEXT_DIST_DIR` is set only by
   `npm run build:check`. `npm run build` — what CI and Vercel run — is byte-for-byte unchanged, so
   there is no divergence in the build that actually ships.
2. **"A loud, well-understood local annoyance" is not what this is.** It is silent in the terminal
   and misleading in the browser, and it has twice been mistaken for an application bug.

**The residual is real and worth stating:** `build:check` does not exercise the exact `.next` path
production uses, so a defect that depended on the output directory would not be caught locally. CI
runs the real `npm run build` on every push, which is where that would surface. That is a fair
trade; it was not obviously fair before the failure count reached three.

**Use `npm run build:check` while developing.** `npm run build` stays the production command.

Verified by running a full `build:check` against a live dev server and confirming the server still
served the login page afterwards — precisely the sequence that broke it.

## 18. The CRM account model is `CustomerAccount`, because Auth.js already owns `Account`

**Module:** 01, session 1
**Collision:** specs/01-crm-inquiry.md §2 names the central CRM model `Account`. Prisma model names
must be unique across the whole schema, and `prisma/schema/auth.prisma` already defines an
`Account` — the Auth.js adapter's OAuth account-link table.

**Why the auth one cannot move:** `@auth/prisma-adapter` calls `prisma.account` by that exact name.
Renaming the model breaks the adapter, and `@@map` only changes the *table* name, not the client
property. There is no configuration for it short of writing a custom adapter.

**Why the CRM one moved instead:** the alternative was deleting the Auth.js `Account` model and
dropping `PrismaAdapter`, which is defensible on paper — the app is credentials-plus-JWT
(docs/DECISIONS.md #4), no application code references `prisma.account`, and the table is dormant.
But it is a change to authentication, made to win a naming argument, and Spec.md §4.1 keeps
optional Google Workspace OIDC on the roadmap, which is exactly what that table is for. Trading a
working auth path for a nicer identifier is a bad trade.

**Chose:** `model CustomerAccount`, with every *field* name left as the spec writes it — `accountId`
on `Site` and `Contact`, and the relation field named `account`. So `site.account.name` reads
naturally and modules 02–10 can keep saying "accountId" as their specs do; only `db.customerAccount`
differs, at the call site, where the distinction between a customer account and a login account is
arguably clearer anyway.

**Watch for:** anyone reading specs/01–10 will type `db.account` first and get the OAuth table,
which has a `userId` and no `name` — so it fails loudly rather than silently returning wrong rows.

## 19. Accreditation tracks the outcome only — the document checklist §5b describes was dropped

**Module:** 01
**Spec deviation, decided by the company.**

specs/01-crm-inquiry.md §5b specifies a per-customer requirement checklist — SEC registration, BIR
2303, mayor's/business permit, PhilGEPS, PCAB licence, ISO certificates — with per-document expiry
tracking, because "a mayor's permit expires annually and quietly invalidates an accreditation".
That was built, then removed.

**Why.** Those are **AIES's own** corporate documents, submitted to each customer to *get*
accredited. They are lodged and tracked on each customer's own portal, which is the authoritative
record of what that customer has and whether they accepted it. Mirroring them here created a second
copy with no way to stay in step with the first.

The duplication had a concrete cost, surfaced when the company asked whose mayor's permit was
meant. AIES has **one** mayor's permit. Storing its expiry per accreditation record meant that on
renewal each January, PD would have to open every customer's checklist and retype the same date —
and any record missed would silently read as expired. That is the "lives in someone's memory and a
folder" failure §5b exists to end, reintroduced one layer down.

**Chose:** the record now holds only the outcome — the certificate the customer issued back, and
its expiry date, both of which *are* per-customer facts. `assertCanBeAccredited` still gates the
`accredited` status on both, and that gate matters more now, not less: with the checklist gone
those two fields are the entire evidence base.

**Rejected:** keeping the checklist as optional. An empty checklist on every record is a feature
people learn to ignore, and a half-filled one is worse than none — it looks like a record of what
was submitted while being a record of what somebody remembered to type.

**If the shared-document problem needs solving later**, it belongs in module 07's DMS, where the
permit exists once with one expiry and each accreditation references it. Do not rebuild it here.

**Migration** `20260808213546_accreditation_drop_requirements` drops the column. Destructive by
design; the data it held is on the customers' portals.

---

## 20. The lifecycle diagram is transcribed literally, including what it does not draw

**Ambiguity.** specs/01-crm-inquiry.md §3 gives the inquiry lifecycle as a diagram. A diagram shows
the edges it draws; it does not say whether the ones it omits are forbidden or merely unremarkable.
Two omissions matter in practice: there is no `new → disqualified` edge, and no way back out of
`won` / `lost` / `disqualified`.

**Chose:** transcribe it literally. `ALLOWED_TRANSITIONS` contains exactly the edges §3 draws, so
junk has to be acknowledged and moved to `evaluating` before it can be disqualified, and a closed
inquiry cannot be reopened.

**Why.** Spec.md §11.3 asks for the most conservative reading, and here the conservative reading is
also the operationally safer one. The failure this module exists to remove is inquiries
disappearing — Spec.md §1.2 lists "lost inquiries" as a consequence to be designed out. A one-click
discard on an inquiry nobody has read is precisely how that happens, and it would be
indistinguishable in the data from an inquiry that was properly assessed and rejected. Two extra
clicks is a small price for a disqualification that somebody demonstrably looked at.

Reopening is refused for the same reason in reverse: an inquiry that was won, then reopened, then
lost has no honest status history, and §3's whole purpose is to make the pipeline report mean
something. The error message says "Log a new inquiry instead", which is the correct answer — the
customer came back, and that is a new event with its own date.

**Also chosen:** `quoted`, `won` and `lost` are marked `systemOnly`. §3 says "`won` / `lost` are set
by the quotation outcome, not manually — the inquiry mirrors its quotation", and `quoted` mirrors
`quotation.sent` by the same logic. Until module 02 exists these three are unreachable, which is
correct rather than a gap: an inquiry marked won by hand with no quotation behind it is a number
nobody can audit. `transitionInquiryService` takes a `bySystem` flag for module 02 to use, and the
router deliberately does **not** expose it — otherwise anyone with `crm.edit` could post
`{ to: "won", bySystem: true }` and book a sale that never happened.

**Revisit** when module 02 lands: it subscribes to `quotation.sent` / `accepted` / `rejected` and
calls the transition service with `bySystem: true`. Nothing in the state machine changes.

---

## 21. The SLA working calendar is Philippine regular holidays only, and the pause is built before it can bite

**Ambiguity.** specs/01-crm-inquiry.md §3 sets the acknowledgement SLA at "1 business day,
configurable". Spec.md §10 describes a configurable working calendar in system settings.
`SystemSetting` belongs to module 09 and does not exist, so neither the calendar nor the "1" is
configurable yet.

**Chose:** `src/server/core/calendar/business-days.ts`, with weekends plus the seven Philippine
**regular** holidays that fall on a fixed date. The movable regular holidays (Maundy Thursday, Good
Friday, the two Eids, Chinese New Year) are set by presidential proclamation annually and cannot be
computed; the "special non-working days" (Ninoy Aquino Day, All Saints', 31 December) are
no-work-no-pay days many private firms work through. Both are omitted, and `setHolidayProvider`
exists so module 09 replaces the source without any caller changing.

**Why that direction of error.** A missing non-working day makes the deadline *earlier*, so an
inquiry escalates sooner than it strictly must. Erring the other way would let a genuinely late
inquiry sit quietly, which is the exact failure §3 exists to prevent. One business day means the
same clock time on the next working day, which needs no office-hours model: a full working day
forward is a full working day forward whatever time the clock started.

**No timezone library.** The Philippines has not observed daylight saving since 1978, so Asia/Manila
is a fixed UTC+8. Dates are stored as UTC instants per Spec.md §6.6 and the offset is applied only
to decide which calendar day an instant falls on. A tz database would be a dependency to maintain
for an offset that has not moved in half a century — Spec.md §2's "every dependency added must be
justified" cuts against it.

**The pause, stated honestly.** §5 says the SLA clock pauses during `inspection_required`, and §10
asks for that behaviour by name. But §3's own diagram only reaches `inspection_required` from
`evaluating`, which is downstream of `acknowledged` — so an unacknowledged inquiry cannot be in that
state, and the pause **cannot currently affect the acknowledgement escalation**. It is built and
tested anyway, for two reasons: §10 requires it, and module 02's quotation-turnaround SLA will be
the first clock it actually moves. `assessInquirySla` also refuses to escalate anything sitting in
`inspection_required` regardless of the arithmetic, so the pause survives any future loosening of
the transition map.

Paused time is banked in *business* milliseconds, not wall time. A pause raised Friday afternoon and
closed Monday morning gives back only the working part; banking wall time would hand the inquiry two
free days of budget that were never spent.

---

## 22. Principal events are declared even though §8 does not list them

**Ambiguity.** specs/01-crm-inquiry.md §8 lists the module's emitted events and names no principal
event at all. But §5c requires that "on `stage = appointed`, the prospect converts into a `Supplier`
(module 03) with `isPrincipal = true`, carrying the agreement, price list, and contacts across. No
re-keying." Those two statements cannot both be honoured without an event: Spec.md §3.6 requires
cross-module side effects to go through the domain event bus.

**Chose:** declare `principal.stage_changed` and `principal.appointed` in the CRM manifest. §8's
list is read as the inquiry-side inventory rather than as an exhaustive contract — it was written
alongside §3, and §5c was added as a separate concern.

**Why not create the `Supplier` here.** Module 03 owns that model. Writing it from module 01 would
leave module 03 something to reconcile rather than something to build — the same trap the ISO 8.4
supplier register was deliberately kept out of in session 1 (see the known issues in PROGRESS.md).
So `principal.appointed` carries the full payload module 03 needs, and that module subscribes and
calls `linkPrincipalSupplierService` to write `supplierId` back.

Until module 03 exists, an appointed prospect sits with `supplierId` null. That is an accurate
description of reality — AIES has appointed them and the purchasing record does not exist yet — and
the panel says so on screen rather than leaving a silent gap.

**§10's "exactly one supplier" is half-testable now**, and the half this module owns is tested:
appointing emits exactly one `principal.appointed`, appointing twice is refused, and
`linkPrincipalSupplierService` is idempotent on redelivery (module 00's queue guarantees
at-least-once, not exactly-once) while refusing a *different* second supplier. The other half is
owed by module 03's gate.

**Appointment is gated on the signed agreement and its expiry.** §5c treats the distributor
agreement as the substance of the appointment, and an appointment with no agreement behind it is a
claim nobody can check.

---

## 23. A file-access checker must not read its entityType from the service that imports it

**What happened.** `principal-access.ts` took `PRINCIPAL_ENTITY_TYPE` from `principal-service.ts`,
and `principal-service.ts` imported `./principal-access` for its registration side effect. That is a
cycle, and because the checker calls `registerFileAccessChecker(PRINCIPAL_ENTITY_TYPE, ...)` at
module-evaluation time it read the binding before the service had finished initialising.
`next build` died with `ReferenceError: Cannot access 'k' before initialization` while collecting
page data for `/api/cron/nightly`. `npm run typecheck` was clean.

**Chose:** the entityType constant lives in the pure rules file (`principal-lifecycle.ts`), which is
where `ACCREDITATION_ENTITY_TYPE` already lived in `accreditation-rules.ts` — that is why
accreditation never hit this. The service re-exports it so existing call sites need no second
import.

**The general rule**, now written down twice in one session: a constant shared across a module
boundary belongs in the module's pure file, not in its service. Session 2 learned it from a client
component pulling `node:crypto` into the browser bundle; this is the same lesson from the server
side. The `no-restricted-imports` rule added after session 2 catches the client-side case only — it
cannot see a server-to-server cycle, so this one is caught by `next build` and by nothing else.

**Also worth recording, and now resolved:** two builds in this session failed with
`EINVAL: invalid argument, readlink '.next/…'`. That was OneDrive, not Next.js. The repo lived
under `C:\Users\Drox\OneDrive\Desktop\`, and OneDrive converts freshly written build output
into cloud placeholders while the build is still running; `rm -rf .next` cleared it each time.

**The repo has since been moved to `C:\dev\aies`, out of OneDrive entirely.** Build failures
were the harmless symptom. The one that mattered was `.git`: OneDrive holding a lock on a pack
file or on `index` mid-write can damage the repository, and that is the one thing in the tree
which cannot be rebuilt from itself. GitHub remains the backup, so nothing was ever at risk of
being lost — but recovery would have meant re-cloning rather than repairing.

Verified after the move: `git fsck` clean, `HEAD` still `ac27e8c` and in sync with
`origin/main`, `.env` and `node_modules` intact, and — the actual proof — `next build`
succeeding against a *dirty* `.next`, which is precisely the operation that had failed twice.

**Do not move it back.** If a future clone lands under OneDrive again, `EINVAL: readlink` on a
`.next` path is the symptom to recognise.

---

## 24. `prisma migrate diff --shadow-database-url` destroyed the development database

**Module:** 01, review gate. **Cost:** every row in the database, and the module 00 gate evidence.

While ticking off the review gate's "migration applies cleanly to a fresh database", I ran:

```
npx prisma migrate diff --from-migrations prisma/schema/migrations
  --to-schema-datamodel prisma/schema --shadow-database-url <DIRECT_URL>
```

**Prisma resets whatever it is given as a shadow database.** It drops and recreates the schema
there to compute a clean diff. `DIRECT_URL` is the live development database, so every table went
to zero: users, roles, permissions, audit log, accounts, inquiries, accreditations, principals,
notifications, numbering counters.

**The command was also unnecessary.** `npx prisma migrate status` had already answered the question
one line earlier — "Database schema is up to date!". The second command added no information and
cost everything.

**Recovered** by `npm run seed` and `npm run demo:crm`: roles, permissions, the five named users,
approval rules, numbering formats, requirement templates, and demo data.

**Not recovered, and not recoverable without a Supabase PITR restore:**

- The operator's password and TOTP enrolment. Accounts came back on the seed default with
  `mustChangePassword` set, so the authenticator had to be re-enrolled.
- **The audit log**, including the evidence PROGRESS.md cited for module 00's review gate
  (`login=2`, `create=1`, `role_assigned=9`). For an ISO 9001 system that trail *is* the record —
  see Spec.md §1.3, "every record that constitutes objective evidence must be immutable once
  approved, attributable to a named person, and timestamped". Losing it on a development database
  is survivable. The same command against production would be a reportable incident.
- **Numbering counters.** They restarted from 1, so the next account was `ACC-0001` — a number
  already issued. Spec.md §5 says numbers are never reused.

**Rules, in order of how much they would have helped:**

1. **Never pass a real database URL as `--shadow-database-url`.** A shadow database is scratch
   space by definition; Prisma will wipe it without asking. Point it at a throwaway database or do
   not run the command.
2. **`prisma migrate status` is the safe drift check.** It is read-only and it answers the review
   gate's question. `migrate diff` against a shadow database answers a narrower question that has
   not yet been worth asking.
3. **CI already proves the gate item.** `.github/workflows` stands up a fresh `postgres:16-alpine`
   service and runs `npx prisma migrate deploy` on every push, which is exactly "migrations apply
   cleanly to a fresh database" — verified by a machine, on a database nobody cares about. There
   was never a reason to reproduce it locally against real data.

**Neither `git` nor the codebase was at risk** — this destroyed data, not source. Everything needed
to rebuild the schema and the seed was in the repository, which is why recovery took two commands.
That is the argument for keeping seed scripts complete and current, and it paid for itself here.

---

## 25. Quotation numbers follow AIES's own convention, not Spec.md §5's

**Module:** 02, session 1.

Spec.md §5's table gives quotations `QTN-{YY}{MM}-{####}` → `QTN-2608-0042`, with `R{n}` appended
for revisions. The company gave their actual convention instead:

| | Format | Example |
|---|---|---|
| Local customers | `AIESLQ` + 2-digit year + 4-digit series | `AIESLQ260001` |
| Indent / international | `AIESIQ` + 2-digit year + 4-digit series | `AIESIQ260001` |
| Any revision | base + `REV` + 2-digit revision | `AIESLQ260001REV01` |

**The spec loses, and it is not close.** These numbers are printed on quotations customers already
hold and on documents referenced in existing correspondence. A document number is an external
identifier, not an internal preference — Spec.md §5's own framing ("configurable per document type
in system settings") says the table is a default, and this is exactly the case it anticipated.

**Two document types, not one with a prefix argument.** `quotation_local` and `quotation_indent`
are separate types in the numbering service, because the counter is scoped per document type.
Sharing one would interleave the series — the fourth local quote of the year would be `AIESLQ260007`
because three indent quotes happened in between. There is a test for this.

**The January restart is emergent, so it is tested.** The counter's scope key is built from the
format's own date tokens, so `{YY}` alone means the series restarts each year with nobody resetting
anything. Nothing in the code says "reset in January", which is exactly why a test asserts it —
a series that silently continued across years would not be discovered until 2027.

**`REV00` is never printed.** The first issue of `AIESLQ260001` is just `AIESLQ260001`; a `REV00`
suffix would invite the question "where is revision zero?". The suffix appears from revision 1.

**`quoteType` is stored on the quotation** rather than parsed back off the prefix. A record whose
stored type disagreed with its own number would be unresolvable, and the parse helper exists only
so that a person pasting `AIESLQ260001REV02` into search finds the quotation.

**The spec's `quotation` format is deleted from the seed**, not left inert. Left in place it would
be the obvious document type to reach for, and would quietly allocate a `QTN-` number onto a
document AIES would not recognise.

---

## 26. AIES's registered details live in code until module 09's settings exist

**Module:** 02, session 1.

Spec.md §11.2 item 1 lists the registered company details as genuinely open, to be "entered manually
in system settings at first run", and warns that "every PDF header depends on them". Module 09 owns
that screen and does not exist. The company supplied the values, so they live in
`src/server/core/company.ts` behind `getCompanyDetails()`.

**Not a `SystemSetting` table invented here.** That would be a second settings mechanism for module
09 to reconcile — the same trap that kept the ISO 8.4 supplier register and module 03's `Supplier`
out of module 01. Constants in one file are findable and impossible to get half-migrated.

**Read through the function, never the constant.** That is the seam: when module 09 lands,
`getCompanyDetails()` becomes a settings read and no caller changes.

The supplied address read "Manadaluyong City"; it is stored as **Mandaluyong City**. Flagged to the
company rather than corrected silently — if the original spelling was deliberate, this is the line
to change.

---

## 27. Issuing a quotation is two facts, because the app cannot watch an outbound email

**Module:** 02, session 3. **Directed by the company.**

specs/02-quotation.md §7 assumes the platform sends the quotation itself: "Send by email from the
record… PDF attached, recipients defaulted to the inquiry contacts." It cannot yet. Module 10 owns
outbound document email and Spec.md §3.4 removed inbound ingest entirely, so the real process is:
produce the PDF, download it, attach it to Gmail or Outlook, send it from there.

That leaves a gap nothing in the app can close by itself, and the company asked for it to be
modelled honestly rather than papered over with a single "Mark as sent" button.

**Chose:** two separate facts.

| | What it means | Who establishes it | Status effect |
|---|---|---|---|
| **Downloaded** | The document was produced and a named person has it | The PDF route, automatically | **None** |
| **Sent** | It reached the customer, on a stated date | A person, explicitly | `sent`, and the inquiry moves to `quoted` |

**Why downloading changes nothing.** A quotation is routinely printed just to check it reads
properly before anyone intends to send it. Treating that as issuance would tell the customer's
pipeline column something that never happened, and §3 of module 01 ties `quoted` to the quotation's
outcome for exactly this reason.

**Why the send date is separate from the confirmation date.** People send on Friday and tick the box
on Monday. The customer's validity clock runs from the former, so `sentAt` is the date it went and
`sentConfirmedAt` records when somebody said so. The gap between them is visible rather than lost.

**Why confirming requires a prior download.** Confirming a send for a document nobody produced is
either a mistake or a route this system knows nothing about. Refusing it is what keeps the download
log usable as evidence.

**The reliability problem, and the answer.** A human assertion is only as good as the discipline
behind it, and Spec.md §1.2 lists "work assigned verbally… no accountability" as a failure to design
out. `sweepUnsentDownloads` chases anything downloaded and never confirmed, at 2 and 5 days. Without
it, "confirm sent" is a box people forget and the pipeline quietly fills with inquiries stuck in
`quoting` that were in fact quoted weeks ago — module 01's own "inquiries get lost" failure,
displaced one step down the process.

**Rejected: treating the download as the send.** Simpler, and wrong in the direction that matters —
it would report work as done on the strength of somebody having looked at it.

**Revisit when module 10 lands.** Sending from the record makes `sentAt` an observed fact rather
than a claim, the confirmation step disappears, and the sweep has nothing to find. The two-fact
model is the honest shape for the interim, not the destination.

---

## 28. `instrumentation.ts` is compiled for the edge runtime too, and a runtime guard does not stop that

**Module:** 02, session 3. **Cost:** the dev server served 500s on every page while its own log
said the feature was working.

The dev job-queue drainer (DECISIONS-adjacent: added in `526cb8e` so the pipeline and Quotations
would connect locally) was put in Next's `instrumentation.ts`, guarded like this:

```ts
if (process.env.NEXT_RUNTIME !== "nodejs") return;
const { drain } = await import("@/server/core/jobs/queue");
```

That reads as safe and is not. **`process.env.NEXT_RUNTIME` is a runtime check; webpack's module
graph is built at compile time.** Next compiles `instrumentation.ts` for *both* runtimes, so the
edge bundle still followed the dynamic import into `queue.ts`, which imports `node:crypto`, which
edge cannot resolve:

```
Module build failed: UnhandledSchemeError: Reading from "node:crypto" is not handled by plugins
```

**The failure mode is what makes this worth an entry.** The Node instance still ran, so
`[dev-drain] relayed=2 claimed=2 succeeded=2` kept appearing in the terminal — the drainer really
was working — while every page and every tRPC call returned 500. A log that reports success while
the app is down is the most expensive kind of wrong, and it is exactly what a runtime guard around
a compile-time problem produces.

**Chose:** move the loop out of the bundle entirely. `npm run dev` now runs `scripts/dev.mjs`, a
plain Node wrapper that spawns `next dev` and POSTs `/api/cron/drain` on a timer. It imports nothing
from the app, so it cannot participate in any bundle — and it exercises the *same endpoint Vercel
Cron calls in production*, so the path under test in development is the path that runs live. The
previous version imported the internals directly, which was one more way for dev and production to
drift.

`npm run dev:next` remains for a bare server with no drainer.

**Rejected: `serverExternalPackages` or a webpack `resolve.fallback`.** Both would have silenced the
error by teaching the edge bundle to ignore a module it should never have contained. The module
genuinely does not belong there.

**The general rule:** anything in `instrumentation.ts` must be safe to *bundle* for edge, not merely
safe to *execute* there. If it touches Prisma, the file system, or a `node:` builtin, it does not
belong in that file at all.

---

## 29. The approval fallback window counts working hours, reversing a documented simplification

**Module:** 02, session 3. **Reverses:** the "Working-hours note" that shipped in
`src/server/core/rbac/approval-fallback.ts` from module 00 session 2.

Spec.md §4.4 says the escalation windows are **working** hours — "cash advances 4 working hours,
quotations 24 working hours" — and specs/02-quotation.md §12 makes it a named test. The original
implementation compared wall-clock elapsed time and said so in a header comment, on the reasoning
that no working calendar existed yet:

> `escalateAfterHours` is compared against wall-clock elapsed hours… that setting isn't built yet
> (module 00 session 5+), so this is a deliberate simplification.

That reasoning expired. Module 01 built `src/server/core/calendar/business-days.ts` for §3's
acknowledgement SLA, it is pure, and `businessMsBetween` answers exactly this question. Leaving the
simplification in place would no longer be a shortcut; it would be a bug with a comment on it.

**The failure it was producing** is worth stating, because it is not a rounding difference. A
quotation submitted at 17:00 on Friday reached the President's queue at 17:00 on **Saturday** — the
VP had not had one working hour to look at it, and the fallback fired against a window nobody was
awake for. Escalation is supposed to mean "the primary approver has had their chance and did not
take it"; over a weekend, wall-clock time asserts that falsely.

**Chose:** `elapsedHours = businessMsBetween(requestedAt, now) / 3_600_000`, plus a new
`fallbackAvailableAt` (via `addBusinessMs`) so the queue screen can say *when* the President becomes
eligible rather than making the reader do working-calendar arithmetic.

**Note what did *not* change.** `eligibleToDecideRoles` still contains the fallback approver at all
times: §4.4 is explicit that "the President can always act immediately, without waiting for the
window, on anything". The window governs **inbox visibility**, not authority. And a President's
decision is still stamped `isFallback` regardless of timing — that is about who decided, not when.

**The tests had to be rewritten, and that is the honest cost.** They used offsets from
`Date.now()` ("five hours ago, past the four-hour window"), which under working-hours arithmetic
means five hours only if the suite runs on a working day. Run on a Saturday, the old assertions
would have silently inverted. Both files now pin a holiday provider and use fixed Manila instants
with the weekday named in the test. Any future test of an elapsed-time rule must do the same.

**"Working hours" here means whole working days, not office hours.** `businessMsBetween` counts all
24 hours of a working day, so 24 working hours is one working day — the same unit
`assessInquirySla` uses for §3's "1 business day". Modelling 09:00-18:00 would make "24 working
hours" mean nearly three days, which is not what anybody at AIES means by it.

---

## 30. The pipeline's "Received PO" column is module 03's `CustomerPO`, not two fields on `Inquiry`

**Module:** 01/03, at the company's request. **Asked for as:** "add a Sent column and Received PO
column… for this to move to the next column a PO should be uploaded."

Two decisions, and the second is the one that will still matter in six months.

### `quoted` is relabelled, not duplicated

The company asked for a "Sent" column. One already existed under a different name: §3 sets `quoted`
from `quotation.sent`, so an inquiry is `quoted` at precisely the moment its quotation went out.

Adding a separate `sent` status would have produced two columns for one fact, one of them
permanently empty. What was actually wrong was the word. On a board where the previous column is
"Quoting", the label "Quoted" reads as *we have written a quotation* — which is what "Quoting"
already means, so the board appeared to have two preparation columns and no issuance one.

**Chose:** map the label in `humanStatus` and leave the stored key alone. `quoted` is §3's
vocabulary and is already in every audit row, every event payload and every report. Renaming the key
would have rewritten history to fix a caption.

### The PO is module 03's model, pulled forward

The obvious cheap move was `Inquiry.customerPoNumber` + `customerPoFileId` + a boolean. It would
have taken an afternoon.

It is also precisely the mistake this build has already refused twice — module 05's `PaymentTerm`
and ISO 8.4's supplier register — where a later module's data gets a temporary home in an earlier
one and then has to be reconciled or migrated. specs/03-order-procurement.md §2 already defines
`CustomerPO` field for field, and §1 calls PO receipt "the pivot point… where the deal stops being a
sales artifact and becomes an obligation", which is exactly the column being asked for. Building
anything else would have been inventing a second answer to a question already answered.

**Chose:** `CustomerPO` as §2 specifies it, plus the smallest possible `order` manifest — one model,
one event, two permissions, no nav. Module 03's own session extends this row instead of migrating
away from something else.

**The dependency direction is the part that needed care.** Module 01 must not import module 03
(Spec.md §3.6: dependencies run downward), and module 03 already imports module 01 to move the
inquiry. So §3's gate is a **registered check**: module 03 teaches the state machine how to answer
"does this inquiry have a PO?", the same pattern as module 00's file-access checkers and the RBAC
scope registry. It fails closed — with nothing registered the move is refused, never allowed.

**A subscription the spec had already written became possible.** specs/02-quotation.md §10 lists
`customer_po.received` as an event module 02 consumes to set a quotation `accepted`; module 02's
manifest recorded it as undeclarable because nothing emitted it. It does now. That is not
housekeeping: a quotation left `sent` after the customer ordered against it would be expired by §7's
nightly sweep, which would then tell the owner that a won deal had lapsed.

### What is deliberately still missing

`po_received → won` stays system-set, and nothing sets it. A received PO is not a delivered job —
the sales order, the supplier PO, the goods receipt and the operations handover are all module 03
and 04, and until one of them exists a card that reaches "Received PO" stays there. That is the
honest state of the build rather than a gap to paper over with a manual "mark won" button, which
would put unauditable numbers into the pipeline report §1 exists to produce.

---

## 31. Money on a PDF is written with its ISO code, because the document font has no peso sign

**Module:** 02. **Found by:** the company reading a downloaded quotation — "the currency … shows as
`±`".

Every amount on a downloaded quotation and costing sheet read `±765,000.00`. On screen the same
figures were correct.

**The formatter was not the bug.** `formatMoney` uses `Intl.NumberFormat` with `style: "currency"`,
which produces `₱765,000.00` — right in a browser, which has fonts covering it. The PDF documents
are drawn in Helvetica, whose WinAnsi encoding has no `₱`, so `@react-pdf` substituted a glyph. The
substitution happened to look like `±`, which a customer reads as a **tolerance** on a price. That
is the part that made this urgent rather than cosmetic.

The symptom was also misleading in a way worth remembering: `€` survives (WinAnsi has it) and `$`
always would, so the bug looked currency-specific while the cause was the font.

**Chose:** a separate `formatMoneyCode` for documents — `PHP 765,000.00` — leaving `formatMoney`
with its symbol for the screen.

**Rejected: embedding a font that carries `₱`.** It would have fixed the glyph and left a worse
problem standing. AIES now quotes in three currencies, and a document that says only `$`, read in
Manila, is ambiguous between US and other dollars. `USD` is not. ISO codes are also what a
customer's accounts payable department files against, and what a bank needs on a remittance.

**Related, same request:** the currency became a closed list — `PHP`, `USD`, `EUR` — chosen when the
quotation is created. Free text would accept "Php", "php" and "peso" as three different currencies
and make §4's FX buffer meaningless. It is not a database table: a configurable currency list is
module 09's settings problem, and a second settings mechanism here is the trap already refused for
`PaymentTerm` and the supplier register.

---

## 32. Landed cost is stored where a raw cost belongs, and it made FX silently wrong twice

**Module:** 02. **Found by:** the company asking "is there something wrong with this?" about a
comment that claimed a conversion the code did not perform.

### What was wrong

`QuotationLine.unitCost` holds the cost **after** FX and the buffer have been applied. Nothing on a
saved line records that. So no code that receives a `unitCost` can tell whether it is a supplier's
raw figure or one that has already been converted — and two paths guessed wrong.

**One, mine, from §3's RFQ apply.** A supplier's EUR 1,450 was handed to the line service with a
rate of 1, and stored as a cost of 1,450 **pesos** — about a sixty-fifth of the truth. Margin then
looked enormous, §4's floor never tripped, and the quotation would have reached the VP's approval
queue looking like the best deal of the year. The comment beside it said the cost "is converted by
the builder's rate"; nothing converted it. A comment describing intent rather than behaviour is
worse than no comment, because it stops the next reader looking.

**Two, older, in the builder.** `LineEditor` loads the stored (landed) cost and re-sends the
quotation's `fxBufferPct` with it on every save. Measured: a 3% buffer turns 1,000 into 1,030, then
1,060.90, then 1,092.73. Cost creeps up and margin quietly down, once per save, for as long as
somebody keeps editing.

Neither was caught by tests, and the reason is worth naming: every existing test used a single
currency and the default buffer of zero, so the multiplications were all by one.

### What was done now

`SaveLinesInput.costsAreLanded` — an explicit statement about the **data**, not about the caller's
authority (which `canSeeCost` already covers). When set, the engine is given a rate of 1 and a
buffer of 0, and the quotation's stored `fxBufferPct` is left alone rather than overwritten.

§3's apply now converts the supplier's figure itself and **refuses when it cannot**: a quotation in
PHP taking a EUR price with no rate set is stopped with a message saying so. A wrong rate is not
better than a missing one.

The *stored* `costFxRate` keeps the rate that was used even though the stored cost is already
converted — §4: "Never overwrite a historical rate." The flag says the engine must not apply the
rate twice, not that the rate never existed. Getting that wrong is what the third new test caught.

### The root fix, done straight after

The patch above stopped one symptom. The company asked for the recommendations to be carried out if
they made the app less susceptible to bugs later, so the cause was removed too:

**`QuotationLine.unitCost` now holds the supplier's raw figure**, in `costCurrency`, with
`costFxRate` beside it. Landed cost is derived by `landedUnitCost()` in `costing.ts` — which is what
§4 asked for in the first place: "Store `unitCost` in `costCurrency` **and** the `costFxRate` used at
the time of quoting."

The property this buys is worth stating plainly: **a save is now idempotent by construction.**
Feeding a stored line back through the engine produces the same numbers, because what is stored are
the *inputs* rather than a previous output. There is a test that saves the same line four times and
asserts the cost never moves; under the old design it went 6,025.50 → 6,206.27 → 6,392.46 → 6,584.23.

The `costsAreLanded` flag added an hour earlier was deleted. It existed to disambiguate raw from
landed, and there is nothing left to disambiguate.

**No data migration was needed**, and that was checked rather than assumed: the database held one
quotation line, at cost 0, rate 1, buffer 0 — where raw and landed are the same number.

What changed elsewhere, all of it mechanical once the rule was clear: the costing sheet derives the
cost column instead of reading it; the what-if calculator feeds the stored line's own rate and the
quotation's buffer, so its answer is the number a real save would produce; the RFQ apply hands the
supplier's figure straight through and only has to decide the *rate*; and the builder round-trips
`costCurrency` and `costFxRate` per line — without which the next save would reset an imported
EUR line's rate to 1 and understate its cost sixty-fivefold, which is the original bug wearing a
different hat.

**What is still open:** the builder shows the raw cost and has no field for the rate, so a
foreign-currency line can only be costed through the RFQ flow today. Adding a rate column to the
line editor is small and belongs with §4's FX work.



## 33. Archiving is a fourth thing, alongside deleted, cancelled and expired

**Module:** 02. **Asked for by:** the company — "apply auto archiving of quotations that have
already received POs, archive them after 14 days of PO receipt", with the archive visible only to
EA and KJ.

The obvious implementations are all wrong, and each is wrong in a way that would only surface later.

**Not `deletedAt`.** Soft delete already exists and would have taken about four lines. But
`deletedAt` means *this record should not have existed* — it is what the delete button sets, with a
typed reason, and what every list in the build filters on. A won deal is the opposite of that. Two
meanings on one column would make "show me the deleted quotations" unanswerable within a year.

**Not a `status`.** `status` records what the **customer** did: sent, accepted, rejected, expired.
An archived quotation is still `accepted` — that is the whole point of it — and adding `archived` to
the state machine would force every transition rule to decide what it means to accept an archived
quotation, which is a question nobody asked.

So `archivedAt` is its own column, because archiving is a statement about *which screen a finished
document belongs on* and nothing else.

### Two consequences that fall out of that framing

**It gates the list, not the record.** `quotation.view_archive` decides who can ask for the archived
half of the list. It does **not** guard `quotation.get`: an archived quotation still opens by id for
anybody who could open it before. A link in an email from last year should not break, and hiding a
document from the person who wrote it is a different decision from keeping it off their list.

**The filter is in the service, not the page.** `listQuotationsService` applies `archivedAt: null` by
default and only honours `archived: true` when the caller holds the permission. A UI-side filter
would leave the rows on the wire, which is the difference between not showing something and not
sending it.

A caller without the permission who asks for the archive gets the working list, silently. An error
would confirm that an archive exists to somebody not meant to know.

### Why fourteen days rather than on receipt

Archiving the moment the PO lands would hide the document during the only stretch it is still in
daily use — the fortnight after an order is exactly when people open the quotation to check what was
quoted against what the customer actually ordered, to answer a scope question, to chase a
discrepancy. Two weeks is past that and well short of memory.

**The sweep reads the PO, not the status.** `accepted` is reachable without a purchase order — a
revision chain, a manual transition — and finished work means the order arrived, not that a column
says so.

## 34. The sixty-day clock now counts business activity, not logged calls

**Module:** 01. **Asked for by:** the company — "contact history should count the 60 days not based
on calls or contacts but on POs received on this particular customer".

specs/01-crm-inquiry.md §1 states the question the whole CRM is designed around: *"who haven't I
talked to in 60 days?"* Session 3 implemented that literally — the list read the `Activity` log and
nothing else, on the reasoning that editing a customer's address is not talking to them.

That reasoning is still right and the conclusion was too narrow. **A logged call is a record of
somebody remembering to log a call.** In a five-person firm that is uneven at best, so the list
produced false alarms in the one direction that matters: a customer who had placed an order last
week appeared on a chase list because nobody had typed anything into the CRM. A list that is wrong
in the harmless-looking direction is exactly the list people learn to skim past.

A purchase order, a quotation going out, an inquiry arriving are events the **system observes**
whether or not anybody writes them down. So the list counts those too, and reports which one it
found — "last order 84 days ago" and "last call 84 days ago" are different problems needing
different phone calls. Editing a record still counts for nothing.

The heading changed with the meaning: **"Accounts with no activity"**, not "not contacted".

### The 500-day dormancy sweep, and why it is unusually cautious

The same instruction added a second rule: *"log the customer dormant if AIES did not receive a PO
from this customer in 500 days."* This is the only place in the build where a **nightly job changes a
business record's status with no person behind it**, which is worth naming because it is a line the
rest of the system deliberately does not cross — every other sweep sends a notification and leaves
the record alone.

Three guards, each protecting a decision a person made:

1. **`blacklisted` is never touched.** That status exists because somebody decided this customer is a
   problem. Overwriting it with the milder `dormant` would erase that on the day it counts.
2. **Only accounts the sweep itself parked are revived**, which is what the new `autoDormantAt`
   column is for. A customer somebody deliberately parked stays parked when an order arrives, and a
   person gets to look at it. Without that column the two cases are indistinguishable and the sweep
   would have to either never undo itself or undo somebody else's decision.
3. **Every change writes an audit row** as `System` with `actorId: null`, saying how many days it
   had been. Attributing it to whoever triggered the cron would be a lie on the record.

An account that has never ordered anything counts from its creation date. A prospect that has sat
sixteen months without buying is precisely what `dormant` describes.

## 35. File *removal* got its own registry, because reading and removing are different questions

**Module:** 00, on module 01's behalf. **Asked for by:** the company — "the uploaded files should
have visible indicators that a file is uploaded, and make the uploaded files removeable in cases of
wrong files are chosen for upload".

Uploading has worked since session 4. Nothing could **list** what had been uploaded, so every
attachment in the app was a single id stored on its parent row (`certificateFileId`,
`priceListFileId`). That is right for a certificate — there is exactly one — and useless for what a
site visit actually brings back, which is eleven photographs. specs/01 §5 has printed "Bring back:
photos" under every inspection request since session 2 with no upload control on the page.

The interesting decision is the second registry. `registerFileAccessChecker` answers "may this user
download this file", and the obvious move was to reuse it for removal. That would have been wrong:
**every checker written so far is permission-based**, so folding removal in would have handed
deletion to everybody who can look. The president can read every accreditation certificate in the
company; that is not a reason for them to be able to delete one out from under the Admin Manager who
is accountable for it.

So `registerFileManageChecker` is separate, and its default is narrower than the read default's:
**the uploader only**. Somebody who attached the wrong scan a minute ago should be able to take it
back without an administrator, and nobody else should be able to remove evidence from a record they
happen to be able to read.

Removal is **soft**, and refuses when a parent record still points at the file. The second half
matters more than it looks: clearing `priceListFileId` is the parent module's job, and a file removed
out from under it leaves a dangling id whose only symptom is a broken link on a page nobody opens
until it matters.

### The tRPC procedures carry no permission gate at all

`files.forEntity` and `files.remove` are `protectedProcedure`, not `p("…")`. "Who may see the files
on this record" has a different answer for an accreditation certificate, a supplier's quotation and a
site photograph — and each module already answers it by registering a checker. A permission on the
procedure would either be broad enough to override those answers or narrow enough to lock out the
people they exist to admit.

## 36. The appointment refuses a missing permission set, where acknowledgement skips it

**Module:** 01. **Asked for by:** the company — "make it so, that only EA or KJ can approve/appoint
principal suppliers", and separately an override of the document requirement for small suppliers.

`ActorMeta.permissions` is optional. That was a deliberate call in session 3 so the many internal
callers — event subscribers, nightly sweeps, scripts — need not fabricate a permission set, and the
one check that reads it (may this person acknowledge this inquiry?) treats absence as *not a person,
skip it*. docs/PROGRESS.md already flags the trap: a new router that forgets to populate `actorMeta`
would silently lose the check.

The appointment gate reads the same optional field and reaches the **opposite** conclusion: absent
means **no**.

The difference is what the two operations are. Acknowledgement happens automatically all over the
place — a subscriber marks an inquiry acknowledged as a side effect of something else, and refusing
it because a sweep has no permission set would break ordinary flows. **Nothing appoints a principal
automatically.** There is exactly one caller, it is a router with a live session behind it, and
anything else reaching that line is a bug. So the safe reading of a missing permission set is a
refusal, and a test pins it with a bare `{ actorId, actorLabel }` actor.

The override follows the same reasoning one level down: it needs the same permission, a written
reason of at least ten characters, and it writes **its own audit row** separate from the stage
change — because "who appointed this principal without an agreement, and what did they say about
it" is a question an ISO 9001 auditor asks by itself and should be findable by itself.

One case is easy to get wrong and is tested: passing an override reason when the documents were
there all along must **not** mark the record as overridden. A false entry in an audit trail is worse
than a missing one.


## 37. Recovery codes, reversing "there is no way back in"

**Module:** 00. **Asked for by:** the company, after this file and PROGRESS.md had both carried the
lockout as a known risk for several sessions.

specs/00-foundation.md §4.1 makes TOTP mandatory — "no opt-out, no admin-only carve-out" — and this
build honoured it completely: no recovery codes, no admin reset, so a lost phone meant a permanent
lockout recoverable only by an operator running `npm run reset:credentials` against the database.
With five users and one of them the president, that is an operational risk created by a rule meant
to reduce risk.

### The fix that was rejected

**An admin-initiated reset** is the obvious answer and it is wrong, for a reason
`scripts/reset-user-credentials.ts` has stated since session 2: letting a signed-in president clear
somebody else's second factor means one compromised officer account can take over every other
account *without ever knowing a password*. That is privilege escalation straight through the control
§4.1 calls non-negotiable, and it converts a lockout risk into a total-compromise risk.

### What was built

Ten single-use codes, generated at enrolment, shown exactly once, stored as argon2 hashes — a
recovery code is a credential, and a database leak that hands over the second factor in plaintext
defeats the point of having one.

**A code is not an opt-out**, which is what keeps this compatible with §4.1. Redeeming one signs the
user in *and revokes the enrolment*, so the next screen is enrolment again. The factor is restored,
never skipped — and the old authenticator, which may be in somebody else's hands, stops working at
the same moment.

Four details worth keeping:

- **Same field as the TOTP code at login.** The person using one has lost their phone and is already
  having a bad morning; a second form is friction with no security value. The shapes cannot collide:
  six digits versus ten characters from an alphabet with no `I`, `L`, `O` or `U`.
- **Every unused code is checked even after a match**, with the result accumulated rather than
  returned early. Argon2 is deliberately slow, so a first-match return leaks through timing roughly
  where in the list the code sat. Three lines to avoid explaining why it did not matter.
- **Regeneration requires the current password.** Minting ten bypass credentials from an already-open
  session would let anybody who found an unlocked laptop walk away with permanent access.
- **Spent codes are kept, not deleted.** "Which code was used, when, and from where" is evidence
  about a real security event.

The CLI script remains as the last resort for the case where every code is also gone.

## 38. The end-to-end suite signs in for real, and that is the point

**Module:** 00. **Asked for by:** the company — "what do you recommend?" about the standing caveat
that no UI had ever been systematically reviewed.

Every screen sits behind a mandatory TOTP gate, so nothing automated could reach any of them. That
is why docs/PROGRESS.md carried a "Not visually verified" list from module 00 onward, and it is not a
theoretical gap. Three bugs shipped that unit tests are *structurally incapable* of catching, because
in each case the code was correct and what was missing was a route between two working halves:

- **Accreditation** — service, panel, tests, and no way to create the first record. The register
  listed records that already existed; its empty state pointed at an account page whose card was
  read-only. Two screens pointing at each other.
- **Contacts and plants** — modelled since session 2, with nothing in the UI able to create one, so
  every picker depending on them was permanently empty.
- **Photographs** — uploaded fine, stored fine, and blocked by a CSP header on the way back, with no
  server log and no failed request. Only a console violation.

`otpauth` was already a dependency, because the server uses it to *verify* codes. The same library
generates them. So a Playwright test can compute a valid second factor from a known secret and log
in exactly as a person does.

`scripts/seed-e2e-user.ts` creates one account with a constant TOTP secret, refuses to run without
`ALLOW_E2E_USER`, and uses a domain that cannot receive mail. The published secret is not a weakness:
it exists on a development database, and anybody who can reach that database does not need a second
factor.

The tests are deliberately **shallow and wide**. They do not re-test business rules that already have
unit coverage — they assert each screen loads, renders its own heading, resolves its loading state,
raises no CSP violation, and shows the control that is the reason to open it. Two of them exist
purely as regression tests for the failures above: one asserts a customer record offers "Add a
plant", "Add a contact" and the accreditation control; the other asserts the quotation panels appear
in the order the company asked for.

It runs in CI after the build.

## 39. §3's check reports everything and blocks almost nothing

**Module:** 03. **From:** specs/03-order-procurement.md §3.

The spec puts more weight on this one function than on anything else in the module: *"System runs a
three-way check against the source quotation… **This single check prevents the most expensive
category of error in this business.**"*

The expensive error is not arithmetic. It is a customer ordering four units against a quotation for
five, or ordering at last quarter's price, and nobody noticing until the goods are bought, shipped
and installed — at which point AIES is holding stock it cannot bill for. Thirty seconds at PO
receipt; unrecoverable afterwards.

So the question this decision settles is not *what* to compare but **what to stop**. A check that
blocks on every difference gets worked around, and a check that blocks on nothing gets clicked past.
The split is about who is entitled to decide:

- **Currency mismatch — blocking, and it returns immediately.** Every other comparison is meaningless
  across currencies, and reporting a PHP/USD difference as an "amount mismatch" would send somebody
  looking for a discount that does not exist. The result says plainly that nothing else was compared.
- **Amount difference — advisory.** A customer ordering part of a scope is ordinary, and so is one
  who negotiated after the document went out. What must not happen is nobody *seeing* it.
- **Quantity difference, and a quoted line not ordered — advisory.** Same reasoning. These are real
  commercial facts the person recording the PO is entitled to accept.
- **A line on the PO that is not on the quotation — blocking.** It has no agreed price and no costed
  supply. Proceeding means committing to deliver something nobody has priced, which is precisely the
  error the check exists to prevent. No note can accept it; the answer is a revision.

Every finding is reported, never just the first: somebody resolving these wants the whole list, and a
check that reveals one problem at a time turns a single conversation with the customer into three.

**Where the advisory findings get their teeth** is `verifyCustomerPoService`, which refuses to record
a verification with differences unless somebody writes down why. A `verified` flag with no
explanation answers "did somebody check?" and not "what did they see, and why was it alright" — and
the second question is the one asked six months later when the customer disputes what they ordered.
The explanation is written to the record as well as to the audit log: the log is the evidence, the
record is what the next person to open the PO actually reads.

**`quantitiesChecked` is reported honestly.** `CustomerPO` has no line model — §2 does not give it
one — so quantities can only come from a person reading the customer's scan and typing them. A check
that silently passed when nobody typed them would be worse than no check: it would say "verified"
about something it never looked at. The screen says the quantities were not compared, and the audit
row says so too.

The check is a pure function (`po-verification.ts`, no Prisma), so the screen shows exactly what the
server enforces. Same split as `inquiry-lifecycle.ts` and `costing.ts`.

## 40. The sales order copies the quotation, and that copy is the obligation

**Module:** 03. **From:** specs/03-order-procurement.md §3, which says only "copies quotation lines".

A reference would have been less code. It would also have been wrong. The quotation can be revised
after the order is raised, and the obligation is to **what the customer ordered on the day**, not to
whatever the document says later. `SalesOrderLine.quotationLineId` keeps the trail back without
letting the trail move the obligation. There is a test that revises the quotation underneath a live
sales order and asserts nothing on the order moved.

Two smaller things settled with it:

- **`requiresExecution` is set from `itemType` only.** §3 names two tests — service/labour, *or* a
  product flagged as requiring installation. The second needs a flag on `Product` that does not
  exist. Inventing one here would hand module 04 a second mechanism to reconcile, so it is recorded
  rather than half-implemented, with an assertion in the test file as the reminder. That flag is what
  separates a delivery from a job: wrong in one direction and a project never reaches operations,
  wrong in the other and a box of spares generates an installation ticket nobody needs.
- **`financeStatus` starts at `not_required`, not `awaiting_downpayment`.** Module 05 owns
  `PaymentTerm` and its `downpaymentPct`, so there is nothing to read yet. Starting at
  `awaiting_downpayment` would show a gate indicator on every order for a condition nobody has set.

The `sales_order.created` event carries the **per-line** execution flags rather than a summary,
because §3 asks module 04 to link each proposed ticket back to the specific lines it covers.
Re-reading the order at job time would make the proposal a function of whenever the drain ran.

## 41. Approving a supplier is a different permission from adding one

**Module:** 03. **From:** specs/03-order-procurement.md §2, and ISO 9001 clause 8.4.

§2 is blunt about the directory: *"this directory is maintained by users, not by any integration.
Make the create/edit form fast and forgiving — it is the only way suppliers get in."* So `name` is
the only required field. A form that demands a TIN before it will save is a form somebody works
around by putting the order through on WhatsApp, and then the directory is wrong *and* incomplete.

That forgiveness is exactly why the approval is separate. `supplier.manage` is wide (PD, EM, both
officers); `supplier.approve` is the president and the vice-president. If they were one permission,
anybody who could type a vendor in could also declare it approved, which is the one thing clause 8.4
exists to prevent. The approval control is on the record panel, not the create form, and it demands a
reason — an approval nobody can explain is not evidence of anything.

**Approval gates buying, not knowing.** Recording what an unapproved supplier quoted is useful and
allowed. Ordering from one is the decision clause 8.4 governs, and that gate belongs on the supplier
PO in session 2, where it can be overridden with a reason by somebody accountable.

**Expiry is derived, never stored as a swept flag.** `supplierApprovalState()` reads the date at the
moment of asking, because a flag that needs a nightly sweep to stay true is a flag that is wrong
between sweeps — and this one gates buying decisions. `expired` and `none` stay distinct states:
one says somebody did the work and it lapsed, the other says nobody has done it yet, and colouring a
fresh directory as failure would make the screen read as broken.

A principal appointed under §5c arrives **already approved**, with the expiry following the
distributor agreement's. An appointment means the agreement was signed and the officers weighed it,
which is the evidence clause 8.4 asks for; and a lapsed agreement should lapse the approval with it.

## 42. Both procurement gates refuse by default and can be overridden — never silently

**Module:** 03. **From:** specs/03-order-procurement.md §4 and §5, and ISO 9001 clause 8.4.

Two separate refusals stand between a supplier PO and the outside world: the customer's downpayment
has not arrived (§4), and the supplier is not approved to buy from (clause 8.4, built in session 1
and gating nothing until now). §4 says exactly why neither is absolute:

> The `president` or `vice_president` may override with a logged reason — **this happens in real
> life, and pretending otherwise means people work around the system instead of through it.**

That sentence is the whole design. A gate that cannot be passed gets passed anyway — on WhatsApp, by
a PO raised outside the system, by a phone call — and then the system is not merely bypassed, it is
*wrong*, because it now shows an order that does not exist. So the gates are:

- **Checked at send, not at draft creation.** A draft is somebody working out what to buy; the
  commitment is the send. Blocking the draft would stop procurement preparing while finance chases
  the money, which helps nobody.
- **Separately overridable, with separate reasons.** They answer different questions — "why did we
  buy before the customer paid" and "why did we buy from an unapproved vendor" — and an auditor asks
  them separately. One blanket "override" flag would collapse two answers into none.
- **Written to the record *and* the audit log.** The log is the evidence; the column is what the next
  person to open the PO reads. §11 asks only for the log; the column is the addition, because a
  reason nobody can find while looking at the order is a reason nobody reads.
- **Demanding of more than three characters.** Other reasons in this build accept three. This one
  requires ten, because "urgent" explains nothing and this sentence is read years later by somebody
  who was not in the room.

**The downpayment gate reads `financeStatus`, not a payment record.** Module 05 owns payments and
will move that column; module 03 owns the column. The dependency runs downward, there is no second
mechanism to reconcile, and the gate is already correct on the day payments exist.

**Today the downpayment gate is inert, and honestly so.** `PaymentTerm` is module 05's, so every
sales order is created with `downpaymentPct = 0` and the gate reports "not required" — which is it
working, not it failing. The blocking path is tested by setting the column directly, which is exactly
what module 05 will do.

## 43. The supplier PO prints the goods total, not the landed total

**Module:** 03. **From:** specs/03-order-procurement.md §5.

§5 asks for freight, duties, brokerage and bank charges on the PO header, "allocated across lines by
value or by weight… **Without this, reported margin is fiction on imported goods.**"

They are captured, allocated and shown on the AIES-facing screen. They are **not** on the document
that goes to the supplier, and that is deliberate: those are AIES's own costs of getting the goods
here, not part of what this supplier is owed. Printing them on their order invites them to quote
against a number that is not theirs. The document shows the subtotal; the record shows the landed
cost.

Allocation is **by value only**. Weight is not captured on any line, and inventing a weight column
nobody fills would give module 09 a second allocation basis that is always empty.

**The rounding is the whole difficulty.** ₱1,000 of freight across three equal lines gives 333.33
three times and loses a centavo, and a centavo lost per shipment is a margin report that never quite
reconciles — worse than a visible error, because nobody can find it. So allocation happens in integer
centavos, shares are floored, and **the remainder goes to the largest line**: the sum is exact and
the residue lands where it is proportionally smallest. Ties break on the lowest line number so two
runs over the same PO can never differ.

Allocation is **derived at read time, never stored**. Changing the freight on the header would
otherwise leave stale per-line values behind, and the stale one is the one module 09 would report.

## 44. A rolled-back migration row can make Prisma offer to destroy your database

**Module:** 03, but it is a standing hazard.

`npx prisma migrate dev` answered a request to create a new migration with:

> The migration `20260815140000_module_03_supplier_sales_order` was modified after it was applied.
> We need to reset the "public" schema… **All data will be lost.**

Nothing had been modified. That migration failed once on a UTF-8 BOM that PowerShell redirection had
written into the file, was resolved with `migrate resolve --rolled-back`, had the BOM stripped, and
applied cleanly. But **`migrate resolve --rolled-back` retains the failed row**, carrying the
checksum of the file *as it was when it failed*. So `_prisma_migrations` held two rows for one
migration, one of which can never match the file again. `migrate dev` compares by name, found the
stale one, and offered the nuclear option.

The first diagnostic missed it, because it built a `Map` keyed by migration name and the successful
row overwrote the rolled-back one — a reminder that a lookup which silently keeps the last duplicate
is a lookup that hides the case you are debugging.

`scripts/check-migration-checksums.ts` exists so this is diagnosable rather than guessed at. It
prints **every** row per migration, and `--fix` repairs only the two harmless cases: a
line-endings-only difference (`git add` normalises CRLF to LF, so the file Prisma hashed at apply
time is no longer the file on disk), and a rolled-back row whose checksum describes an attempt that
never applied. It refuses to touch a migration whose SQL genuinely changed after a successful apply,
because re-recording that checksum would bury a real problem.

**The rule: never answer a checksum complaint with `migrate reset` against a database holding real
work.** Diagnose first. The schema was never in question here — only a fingerprint on a row
describing something that never happened.

## 45. Booking goods in and certifying them are two acts, by two people

**Module:** 03. **From:** specs/03-order-procurement.md §6, and ISO 9001 clause 8.4.2.

§6 opens with a requirement rather than a description: "**Incoming inspection is required** (ISO 9001
clause 8.4.2, verification of externally provided processes/products): quantity check, damage check,
documentation check (test certificates, calibration certificates, datasheets, warranty), and photos."

The obvious implementation is one call — type the quantities, tick a box, save. It would be wrong,
because the two acts happen at different moments and usually to different people. The boxes arrive
and get counted at the gate, often by a technician on a phone; the calibration certificates get
checked against them later, sometimes the next day, by somebody who was not there. A single call
forces whoever signs for the delivery to also certify paperwork they have not seen, and the reliable
result of that is a tick box that always gets ticked.

So there are three services and two permissions:

- `createGoodsReceiptService` records what arrived. `goods_receipt.create`, granted to technicians.
- `inspectGoodsReceiptService` records the four checks. `goods_receipt.inspect`, **not** granted to
  technicians — the person who unloaded the crate should not be the one certifying it.
- `acceptGoodsReceiptService` is the only thing that moves a quantity onto the customer's order, and
  the only place the gate is enforced.

**All four checks, no partial credit.** Three out of four with a warning was considered and rejected:
an inspection that can be *mostly* done is one that is mostly not done, and the clause's whole value
is that "we checked" means something specific. They are four separate booleans rather than one flag
because they fail for different reasons — the count can be right while the certificate is missing,
and those are two different conversations with the supplier.

**Photographs are counted, never claimed.** There is no "did you take photos?" checkbox, because that
is a checkbox that always gets ticked. The server counts the stored image files. It then *freezes*
the result on the record, so a photo deleted next year cannot retroactively invalidate an inspection
that really happened.

**Only accepted quantities advance fulfilment.** Rejected goods are going back to the supplier;
counting them as received would make a customer's order look fulfilled by a box in a returns bay.
For the same reason the supplier PO's status and the sales order's procurement column are both
**derived** from quantities rather than set by hand — a status that disagrees with its own numbers is
the sort of thing nobody notices until procurement chases a delivery that is already in the
warehouse.

**Rejections do not invent an NCR.** §6 says they "auto-raise an NCR (module 08) against the supplier
and a return-to-supplier task". Module 08 does not exist. The reason is recorded on the line and
`goods.rejected` carries everything the NCR will need, so raising one later is a read of that event
rather than an archaeology exercise. Inventing an NCR model here would hand module 08 something to
reconcile instead of something to build — the same trap `PaymentTerm` and the supplier register were
both kept out of.

## 46. Delivery is not built, because §7 gates it on a module that does not exist

**Module:** 03. **From:** specs/03-order-procurement.md §7.

§7 is unusually explicit about the boundary, and it rules this session out of building delivery:

> **DR request** comes from a delivery ticket (module 04 §13), **not from a screen in this module**.
> A DR is never issued without a ticket to execute it — the flowchart's `DR REQ` box is a real gate
> and prevents DRs floating around unassigned.

Module 04 does not exist, so there is no ticket, so there is no legitimate way to create a delivery
receipt. The three options were all bad in different ways:

1. **Build a "create DR" screen anyway.** It would breach the one boundary §7 states outright, and
   the DRs it created would be exactly the unassigned ones the gate exists to prevent.
2. **Build the model and service with no route to them.** This build has shipped that failure three
   times (docs/DECISIONS.md #38) — accreditation, contacts and plants, photographs — and each time it
   was reported by the company rather than caught by a test.
3. **Invent a minimal ticket here** so the gate has something to check. That is the trap this build
   has refused four times now: a concept invented early for a later module to reconcile.

So `DeliveryReceipt` is **not** in the schema, `delivery.create` is **not** in the manifest, and
`sales_order.goods_delivered` and `delivery.dr_signed` are **not** declared — a manifest's `emits`
describes what is emitted, and an event declared early lets a later module subscribe to something
that never fires, which fails silently.

The consequence is worth stating plainly: **`po_received → won` still has nothing setting it.** A
received PO is not a delivered job, and the thing that would make it decidable is precisely what §7
gates on module 04. It moves when delivery does.

What *is* built and stays built: `SalesOrderLine.qtyDelivered` exists, `procurementStatusFrom` and
the receipt arithmetic are pure and tested, and §8's inventory posture ("track quantities on hand
only as `qtyReceived − qtyDelivered` per sales order line") needs no further schema — so when module
04's delivery lane lands, this half is waiting for it rather than needing rework.

## 47. One house numbering format, and the two series that keep their own

**Module:** cross-cutting. **Asked for by:** the company, 2026-08-16 — "except AIESLQ and AIESIQ,
rename document codes… make it follow this template `AIES[document code]-[current year][number
series]`".

Every series had drifted into its own shape: `RFQ-{YY}-{####}`, `SO-{YY}-{#####}`,
`INQ-{YY}{MM}-{####}`, `ACC-{####}`. Widths disagreed for no reason, some carried a month and most
did not, and nothing on the number said whose document it was. The house template settles all of it:

> `AIES{CODE}-{YY}{####}` — `AIESRFQ-260001`, `AIESPO-260001`, `AIESGRN-260001`.

The company's template and their second example disagreed about the hyphen (`AIESRFQ-260001` versus
`AIESPO260001`); they confirmed the hyphen. Four digits everywhere, from their example — 9,999
documents per series per year, which is far beyond AIES's volume.

**Three deliberate exceptions:**

- **`quotation_local` and `quotation_indent`** keep `AIESLQ{YY}{####}` and `AIESIQ{YY}{####}`, with
  no hyphen. They are the company's own long-standing convention and are already on documents that
  went to customers. Excluded by name in the request.
- **`account` and `supplier` stay yearless** — `AIESACC-0001`, `AIESSUP-0001`. They identify a
  *relationship*, not a dated document, so their counter must never reset; a customer keeps one code
  forever rather than collecting a new one each January. Confirmed with the company rather than
  assumed, because applying the template literally would have changed what those codes mean.
- **`controlled_doc`** keeps `AIES-{DEPT}-{TYPE}-{###}`: module 07 numbers ISO documents by
  department and type, not by date.

**The counters were reset and the live records renumbered.** Roughly 180 numbers in each module 03
series had been burned by tests that then deleted their own records, so the first real sales order
would have been `SO-26-00189` and the first supplier PO `PO-26-00150`. Spec.md §5 permits gaps, but
a company's first purchase order going out numbered 00150 invites a question nobody should have to
answer. `scripts/renumber-to-house-format.ts` did the rename; every renumbered record got a **new**
audit row explaining the discontinuity, and old rows were left quoting the old number — an audit log
that edits itself is worth nothing.

### The trap this exposed, worth more than the rename

`reset-numbering-counters.ts` fixed the counter rows that **already existed**. The inquiry format
dropped its month, which moved its counter from scope key `26:08` to `26` — and a scope with no row
starts at zero. The next inquiry would have been handed `AIESINQ-260001`, a number already on a
record, and the unique index would have rejected it at the moment somebody was trying to log a
customer's call.

The script is now **scope-aware**: it computes the scope key today's format would produce, and seeds
a row at the floor for any that has none. A format's *shape* changing is rarer than its prefix
changing, and correspondingly easier to miss — the prefix change is visible in every number, the
scope change is visible nowhere until a collision.

## 48. The numbering counter records the format that produced it

**Module:** 00. **Asked for by:** the company — "what can be done about the trap, so that it is
eliminated?"

docs/DECISIONS.md #47 describes a near-miss: the inquiry format lost its `{MM}`, its counter's scope
key moved from `26:08` to `26`, the new scope had no row, and the next inquiry would have been issued
a number already on a record. That was *repaired* by hand. The repair left the trap in place — change
a format's shape, deploy, and the next allocation collides again, with nothing in the system to stop
it.

### Why it can happen at all

A counter's identity is `(documentType, scopeKey)`, and **`scopeKey` is derived from the format**. So
a format's shape is not metadata about the counter; it is part of the counter's *name*. Change the
shape and you have not edited a counter, you have addressed a different one — which, being new,
starts at zero.

### Why the obvious guards do not work

- *Compare the format on the row.* The dangerous case is precisely the one where **the row does not
  exist yet**, so there is nothing to compare.
- *Refuse any scope the allocator has not seen.* That is January. A guard that fires on 2 January
  with a customer waiting is a guard somebody deletes, and then there is no guard at all.

The two cases are identical from the allocator's position — a scope key it has never seen — and the
only thing that separates them is whether the *format* changed. So the format has to be recorded
where the allocator can see it.

### What was built

`DocumentSequence.format` stores the format each counter was last advanced under, stamped on every
allocation. Before issuing, `allocateNumber` checks the **sibling** scopes of the same document type:

- All on today's format → a new scope is a new period. Issue from 1. January works.
- Any on a different format → the shape moved and nothing has reconciled. **Refuse**, naming the
  document type, the stale format, the affected scopes, and the command that fixes it.

A refusal costs one command. A duplicate number costs a document, and surfaces as a unique-constraint
error in a salesperson's face mid-task. The migration backfills every existing row, because a guard
that is inert on exactly the installations that already have live counters is not a guard.

`reset-numbering-counters.ts` stamps the new format as it reconciles, which is what clears the
refusal — so the fix is the same command whoever hits the error is already being told to run.

### The second trap, in the same script

`highestInUse` ended in `default: return 0`, and "this series has no records" is indistinguishable
from "this switch has never been taught about this series". It silently offered to reset a live
counter to zero **twice** — once for `supplier_rfq` while `RFQ-26-0001` existed, and again for module
03's three series. It now throws on an unknown document type, and the types that genuinely issue
nothing yet are listed by name in `NOT_YET_ISSUED`. A forgotten case fails loudly; an empty series is
a decision somebody wrote down.

### What is still not eliminated

Counters climb every time the suite runs, because tests allocate against the development database and
there is no separate test database (that was tried in module 02 and reverted). So a reset is a
*hand-over step*, not a stable state — it has to be the last thing done before the company looks at
the app. The real fix is a separate test database, and it stays deferred.

## 49. Tickets are proposed, never generated by an event

**Module:** 04. **From:** specs/04-operations-projects.md §4.

Everything was in place to wire this the obvious way. Module 03 emits `sales_order.created` carrying
per-line `requiresExecution` flags, module 04 has a job queue to consume it, and the routing is
mechanical — execution lines become an installation ticket, goods lines become a delivery ticket. One
subscriber and tickets appear the moment an order is raised.

§4 rules it out in a sentence:

> Operations **confirms or edits** the proposed set before generation. **Do not auto-generate
> silently — one PO can legitimately be one ticket or eight, and only a human knows which.**

So `proposeTickets` is a **pure function** that writes nothing, `proposeTicketsForSalesOrderService`
is a **query**, `generateTicketsService` takes the set somebody confirmed, and the operations
manifest's `consumes` is **empty** — with a test pinning it empty, because the shortcut is exactly
the kind that gets added later by someone who sees an event going unused.

The reason is not fussiness about process. A wrong ticket set is not a wrong record: it is a crew at
the wrong site on the wrong day, or a delivery van sent for goods that needed commissioning. The
record can be corrected on Monday; the day cannot.

**What the proposal deliberately does not decide.** §2 distinguishes `new_project` from
`installation` by whether the work builds something or fits into what is already there — and nothing
on a sales order line says which. So the proposal always offers `installation` and its rationale says
so in as many words. Guessing would produce a wrong answer that *looks* authoritative, which is worse
than an honest one, because a reviewer corrects an obvious placeholder and rubber-stamps a confident
mistake.

**Execution lines merge into one ticket.** Two meters installed at one site on one visit is one job;
splitting per line would put two tickets on one van and the reviewer would merge them. The proposal
starts merged and the reviewer splits — the direction that makes the common case free.

**A line already covered by a live ticket cannot be covered again.** §4 wants the link accurate "so
fulfilment counters and billing milestones stay accurate", and two tickets claiming one line bills it
twice. Reopening the proposal after generating shows only what is left.

## 50. A project belongs to a generation, not to a ticket

**Module:** 04. **From:** specs/04-operations-projects.md §1 and §2.

§2: "A single PO can generate several tickets, and **several tickets can roll up to one project**."
So `generateTicketsService` creates *one* project per confirmed batch and links every execution
ticket in it — three visits to the same site for the same order share one schedule, one team and one
close-out pack. Creating a project per ticket would give them three of each and make the close-out
pack meaningless.

**A delivery ticket never joins it**, and that is §1 speaking rather than a convention: "The delivery
lane is genuinely separate. It has its own mobilization and demobilization and its own retry loops.
**It is not a step inside a project — it is a ticket type. Model it as such.**" `ticketNeedsProject`
is a pure function so the rule is stated once and tested directly, and a delivery-only generation
creates no project at all.

The project carries the sales order's `total` as `contractValue` and its `totalCost` as `budgetCost`
from the moment it exists, so module 09's budget-versus-actual has something to compare against on
day one rather than being backfilled later — and both are permission-gated on the way out, because
§19 is explicit that technicians "see scope, site data, and their own cash advances — **never
contract value or margin**".

## 51. Module 04 declares its permissions late, where module 03 declared them early

**Module:** 04. **Contradicts, deliberately, the choice recorded for module 03.**

Module 03's manifest declared `sales_order.close`, `goods_receipt.inspect` and the rest in session 1,
before anything used them, with the reasoning that §10 lists them and "a permission that appears
later means a role assignment that has to be redone".

Module 04 does the opposite: §19 lists thirty permissions and the manifest declares seven.

The difference is elapsed time, and it is worth being explicit about because the two rules look
contradictory. Module 03's later sessions were days away — a declared-but-unused permission was
briefly inert and then real. Module 04's gates are whole sessions each, several of them: declaring
`cash_advance.approve` now would put a permission in every role screen that grants access to nothing
at all for weeks. Somebody would assign it, expect an approval queue, and find none. A permission
that exists and does nothing teaches people that permissions do not mean anything.

So the rule is not "declare early" or "declare late" — it is **declare when the gap is short enough
that nobody can act on the permission in between**. Both manifests carry a test pinning what they
hold back and why.

## 52. A permission is declared in the change that gates something with it

**Module:** cross-cutting. **Asked for by:** the company — "what do we do on the deliberate
inconsistency? if this will cause problems later on, we better fix this now rather than later."

docs/DECISIONS.md #51 recorded module 03 and module 04 declaring permissions on opposite principles
and argued both were defensible. Checking the question properly showed that **neither was right as
stated**, and that eleven permissions across four modules were already granting access to nothing.

**Module 03's justification does not survive inspection.** It declared all of §10 up front so that
"a permission that appears later means a role assignment that has to be redone". But
`prisma/seed.ts` upserts a permission *and* its `defaultRoles` on every run — a permission added in
a later session is granted to its default roles automatically at the next seed. There was no re-work
to avoid. What the early declaration did produce was `sales_order.edit`, `.close` and `.cancel`
sitting in the admin role screen with nothing behind them.

**Module 04 stated the right principle and did not follow it either**, declaring `ticket.cancel`,
`project.view` and `project.manage` in the same session that gated none of them.

### The rule

**Declare a permission in the change that uses it** — the same rule `emits` already follows, and for
the same reason. `tests/server/core/modules/permissions-are-used.test.ts` scans `src/` for every
`p("x")` gate, `permissions.has("x")` check and hoisted constant, and fails on any manifest
permission nothing consults. An exception needs an entry in `DECLARED_WITHOUT_A_GATE` with a reason;
"we will need it soon" is not one, since that is the argument the test exists to refuse.

The test also asserts that its own scan finds known permissions, because an "assert nothing is wrong"
test whose matcher silently stops matching passes vacuously forever.

### Why a dead permission is not harmless

It appears in the admin role screen. Somebody grants it, expects a delete button or an approval
queue, and finds nothing. The lesson learned is that the permissions in this system do not mean
anything — and that is expensive to unteach, because the next permission they are told is load-
bearing gets the same shrug.

### The eleven, and one real defect among them

`crm.export`, `inquiry.disqualify`, `quotation.cancel`, `approval.act_as_fallback`,
`sales_order.edit`, `.close`, `.cancel`, `ticket.cancel`, `project.view`, `project.manage` — all
removed. Two are worth naming:

- **`approval.act_as_fallback`** could never have gated anything. Spec.md §4.4's fallback is resolved
  from `ApprovalRule.fallbackApproverRole`, so the rule row already names who may act; a second
  answer to the same question is only a way for the two to disagree.
- **`quotation.override_margin_floor`** was worse than dead. The margin panel told the user "sending
  it needs `quotation.override_margin_floor`, which only the president and vice-president hold", and
  the costing sheet PDF said the same — **and nothing anywhere enforced it**. §4 asks only for "a
  warning when any line is below the configured floor", which is what the code does. So the screen
  was describing a financial control the system does not have, on the document where somebody
  decides whether a thin margin is acceptable. Both texts now say what is true: it is a warning, and
  the Vice President's approval is the control.

### The seed now prunes

Adding-only is how eleven accumulated unnoticed. `seedRolesAndPermissions` deletes any `Permission`
row no manifest declares, so the manifests are the source of truth in both directions. Safe by
construction: a permission nothing gates cannot be protecting anything, and its `RolePermission`
rows cascade.

---

## #53 — A cash advance settles on cash recorded, not on arithmetic

specs/04-operations-projects.md §5, module 04 session 2.

The first version of the liquidation reconciled an advance like this: the balance to return is
`released − spent`, and once you know that, the advance is settled. It is the obvious reading, and
it is wrong in a way that would not have shown up until somebody asked why nothing was ever
outstanding.

`isFullySettled` asked whether `spent + balanceReturned >= released`. With `balanceReturned` derived
as `released − spent`, that expression is **true for every input**. Every advance would have settled
on its first receipt, §5's `partially_liquidated` would have been unreachable, and the register —
the entire point of §5 — would have shown an empty outstanding list on a day when five technicians
were holding company money.

The mistake is treating a fact as a calculation. Money the technician has not handed back is still
in their pocket; the system cannot infer its return from a subtraction. So `reconcile()` takes
`amountReturned` as a **recorded input** alongside cumulative spend, and reports:

- `unaccounted` — released, minus receipts, minus cash actually back. The number finance chases.
- `balanceReimbursable` — measured against the release alone, because returned cash cannot both come
  back and be owed out again.
- `settled` — only when nothing is unaccounted for.

The two balances stay separate fields rather than one signed number, as §5 words them ("balance to
return" **or** "reimbursement due"). They are different transactions handled by different people —
cash coming in, and a payment going out — and a signed column makes "how much is sitting in
technicians' pockets" depend on a sign test somebody eventually gets backwards.

### Why this was caught

Not by review. `cash-advance-rules.test.ts` asserts that filing ₱2,000 of receipts against a ₱5,000
advance leaves it **unsettled** with ₱3,000 unaccounted — a test written from §5's sentence about
`partially_liquidated` rather than from the implementation. A test that only exercised the happy
total would have passed against the broken version.

---

## #54 — Approving an advance and releasing the money are different permissions

specs/04-operations-projects.md §5, module 04 session 2.

§5's complaint is not that advances are unapproved. It is that the gap between a decision and cash in
a pocket is invisible: "currently invisible to everyone until a technician can't board a bus."

So the gate blocks on **`released`**, never on `approved`, and the two acts carry different
permissions — `cash_advance.approve` (Vice President, seeded by module 00) and
`cash_advance.release` (finance officer, Admin Manager, President). The Vice President deliberately
does **not** hold release.

This is not separation of duties for its own sake. If one person held both, the natural interface
would be a single Approve-and-release button, the gap would close in the UI, and the state §5 exists
to surface — *approved, but the crew still has nothing* — would become unrepresentable. The
permission split is what keeps that state on the screen. `operations-manifest.test.ts` pins it.

The same reasoning shapes the record page: the release card is its own block rather than a field in
the approval card, and it is shown to people who cannot action it, because a coordinator who cannot
release money still needs to know the crew has none.

---

## #55 — The block on a new advance has no override, and that is the point

specs/04-operations-projects.md §5, module 04 session 2.

§5: "Overdue liquidation blocks that person from requesting a new advance."

Every other gate in this build is overridable by somebody accountable, with a reason — the
downpayment gate, clause 8.4, the cash advance gate itself. The pattern is deliberate and stated in
docs/DECISIONS.md #45: a system that cannot represent the urgent Friday exception is a system people
work around.

This one is different, and `canRequestAdvance` has no override parameter. An unliquidated advance is
money already gone; the next advance is the only leverage the company has left. And unlike the other
gates, the blocked act and the blocking condition belong to the **same person** — an override here
would be the requester routing around their own paperwork, which is not an exception, just an
absence of a rule.

The sanctioned way out is the one §5 already provides: ask the Vice President for an extension. That
is why *formally extended* does not block while *late* does — if an approved extension left the
block in place, granting one would mean nothing.

---

## #56 — The scope-change link prompts sales; it does not raise the revision

specs/04-operations-projects.md §6.1, module 04 session 3.

§6.1 is unusually emphatic: "Discovering at inspection that the job is bigger than quoted is normal;
discovering it *after* mobilization is expensive. **This link is one of the highest-value things the
platform does.**"

The tempting implementation is to raise the quotation revision automatically. It is wrong twice.
Only a human knows whether extra scope is chargeable, absorbed as goodwill, or a misunderstanding to
be argued about with the customer — and a revision that appears by itself still has to be priced by
somebody who was not told why it exists. The spec's own verb is "prompts", and it is load-bearing.

So `promptRevisionOnScopeChange` finds the quotation behind the surveyed work and notifies whoever
prepared it, carrying the surveyor's own words. The decision stays with sales; what changes is that
they hear on the day of the survey rather than from an argument on site.

### Firing once is what makes it worth reading

`scopeChangeReportedAt` records that sales has been told. A surveyor correcting a measurement
re-saves the inspection, and a second "the job is bigger than quoted" notification would teach the
recipient to close them unread — destroying precisely the warning the section says must land.

It also refuses to fire on a flag with no notes. An inspection can be saved while still `scheduled`,
and a half-filled draft should not page sales; `inspectionCompleteness` separately blocks the flag
from reaching `completed` unexplained, because sales cannot revise a quotation against a tick box.

### The emission is on *save*, not on completion

The whole value is how early it lands. A surveyor who flags a scope change from the site on Tuesday
and finishes the paperwork on Friday has given sales three days; waiting for `completed` throws them
away.

---

## #57 — Photographs on a site inspection are a warning, not a gate

specs/04-operations-projects.md §6.1, module 04 session 3.

`inspectionCompleteness` blocks on three fields — when the visit happened, who attended, what was
found — and treats missing photographs and measurements as warnings that the screen shows and the
record keeps.

Requiring photographs is the obvious stricter choice, and it is wrong. A refused-entry visit produces
none and is still a real inspection, whose finding is "we could not get in" — exactly the sort of
thing that must be recordable, because it is the thing that changes a schedule. §6.1 does not ask for
photographs to be mandatory.

The general rule this is an instance of: **a gate people cannot satisfy honestly gets satisfied
dishonestly.** A survey with one meaningless photograph attached to clear a requirement is worse than
one that openly admits it has none, because the first looks complete to everybody downstream.

The same reasoning appears in module 03's goods receipt, where photograph presence is *recorded and
frozen* rather than required, and in §5's cash advance, where a short release is recorded rather than
refused.

---

## #58 — Pin the absence you mean, not a proxy for it

specs/04-operations-projects.md §4 and §6.1, module 04 session 3.

`operations-manifest.test.ts` asserted `operationsManifest.consumes` was **empty**, to protect §4's
rule: "Do not auto-generate silently — one PO can legitimately be one ticket or eight, and only a
human knows which."

The intent was right and the assertion was a proxy. Session 3 added a subscription to
`inspection.requested` — which specs/01-crm-inquiry.md §5 asks for by name, and which crm.prisma has
promised in a comment since module 01 — and the test failed. Not because anything was wrong, but
because emptiness cannot distinguish the subscription the spec demands from the one it forbids.

A proxy assertion fails in exactly this way: it goes red on a correct change, and the cheapest way to
make it green is to weaken it. It now asserts what it actually means — that `sales_order.created` and
`customer_po.received` are not subscribed — which is both stronger (it stays meaningful as more
subscriptions land) and honest about what it is protecting. A second test pins the presence of
`inspection.requested`, so a refactor cannot quietly drop it and leave the schema comment lying.

---

## #59 — A notification is not a record: the scope change is marked on the quotation

specs/04-operations-projects.md §6.1, module 04 session 3.

§6.1 calls the inspection-to-quotation link "one of the highest-value things the platform does". The
first implementation emitted `scope_change.identified`, module 02 subscribed, and it notified the
person who prepared the quotation. That is what the spec asks for, and it was not enough.

The notification goes to the in-app bell with email off, because the `notify_email` queue still has
no handler (docs/DECISIONS.md #10). So the platform's highest-value link sat entirely on its weakest
channel. Miss the bell and **nothing ever surfaces the finding again** — the crew mobilises three
weeks later against a quotation nobody revised, which is precisely the failure §6.1 exists to
prevent, arriving by a different road.

So the finding is now written onto the `Quotation` itself and stays visible until it is resolved. The
notification is the nudge; the columns are the record.

### Still a prompt, not an automatic revision

Unchanged, and worth restating because the mark makes auto-revising look more tempting rather than
less. Only a human knows whether extra scope is chargeable, absorbed, or a misunderstanding, and a
revision raised by a robot still has to be priced by somebody who was not told why it appeared. §6.1's
verb is "prompts".

### Two ways out, and both are recorded

- **Revising the quotation** clears the mark automatically, inside `reviseQuotationService`'s own
  transaction. Raising the revision *is* the action the prompt was asking for; a second click to
  acknowledge a thing you have just done is how people learn to dismiss without reading.
- **Dismissing** requires a reason of real length. "We absorbed it" is a decision worth keeping where
  silence is not, and it is what somebody reads six months later when the job overran and nobody
  remembers agreeing to it.

A resolved mark is still shown, quietly. Hiding it the moment it is dealt with would throw away the
only evidence the decision was ever made.

### Once, but not never again

The **event** fires once — `scopeChangeReportedAt` on the inspection — because a surveyor correcting
a measurement must not re-send "the job is bigger than quoted", and a warning that arrives repeatedly
is one people learn to close unread.

But *once, ever* also means *never again*. `sweepUnactionedScopeChanges` runs nightly and chases the
unresolved **mark** every three working days, widening to the account owner as well as the preparer —
after a fortnight the person who wrote the quotation may not be the person who can get a decision out
of the customer. Working days rather than calendar, so a Friday finding does not chase somebody on a
Sunday.

§6 asks for none of this. It is the same shape as the seven-day silent-quotation sweep and the
overdue-liquidation sweep already running nightly, and it is the difference between a link that fires
and a link that lands.

### A second finding does not overwrite the first

`promptRevisionOnScopeChange` guards its write on the flag still being clear. The newer inspection
still notifies — the person needs to know — but silently replacing the older notes would lose a
finding nobody had dealt with, which is the thing the whole mechanism exists to stop.

---

## #60 — File access checkers must be registered by the route that reads them

Found while verifying module 04 session 3's inspection photographs; affects module 00's storage core
and all nine entity types that use it.

`src/server/core/storage/access.ts` keeps its checkers in module-level `Map`s, populated as a side
effect of importing the module that owns each entity type. That pattern is fine. What was missing was
anything guaranteeing the import had happened by the time somebody asked to download a file.

`/api/files/[id]/route.ts` imports `canAccessFile` and nothing else.

On a single long-lived Node process it worked **by accident**: the tRPC route loads
`src/server/api/root.ts`, which pulls in every router and therefore every service, so the maps were
full by the time anyone clicked a photograph. **Next.js bundles each route separately.** In
production that route is its own function whose import graph contains none of those services, the
maps are empty, and `canAccessFile` falls through to its default:

```ts
return file.uploaderId === user.id;
```

Every file, of every entity type, readable only by whoever uploaded it. The president cannot open a
certificate PD uploaded; the operations manager approving a site inspection cannot see its
photographs.

### The default was right; the assumption was not

`canAccessFile`'s fallback is deliberately conservative — "never no one, never anyone signed in" —
and it is the reason this fails **closed**. A permissive default would have made the same bug a
disclosure rather than an obstruction. Nothing about the default changes; what changes is that
registration is now guaranteed rather than assumed.

### The fix, and why a barrel

`src/server/core/storage/register-checkers.ts` imports all nine registrar modules and exports a
constant the route **references** — a bare side-effect import is exactly the line a tidy-up removes,
and removing it silently restores the bug.

Alternatives considered and rejected: registering inside `access.ts` inverts the dependency and makes
the storage core import every business module; lazy `await import(...)` inside each checker moves the
same ordering problem one level down.

### Why this needed a test rather than a comment

`tests/server/core/storage/file-access-registration.test.ts` asserts the barrel lists every module
that calls a registrar — **by reading the source**, not by importing the modules. Importing them here
would register the checkers and make any assertion about the registry pass trivially, which is the
trap this exact class of bug sets. It carries a self-check for the same reason the permission audit
does.

### The lesson generalises

A registry filled by import side effects is only as reliable as the weakest entry point that reads
it. Any such registry needs either an explicit load step or a test that the load step is complete —
the working-by-accident case is indistinguishable from the working-by-design case right up until a
bundler separates them.

---

## #61 — A red end-to-end suite nobody runs is worse than no suite

Found in the same pass as #60.

`tests/e2e/home.spec.ts` asserted a heading reading "AIES Operations Platform" on the login page.
That heading was replaced by the full-colour logo lockup when the auth screens were restyled (commit
`61f13f0`). The test had been failing from that moment until module 04 session 3 — through five
sessions of work, because nothing re-ran it.

The direct cost was small: one stale assertion, fixed by asserting the logo's accessible name and the
"Sign in" heading that is actually rendered. The real cost is what a standing failure does to the
suite's value. When the run finally happened it reported `1 failed, 20 passed`, and the tempting
reading — the one very nearly taken — is "that failure is old, the new work is green". A suite that
trains its reader to skip failures has stopped being a check.

Two things follow, and both are now true:

- The e2e suite runs at the end of a session that adds or changes a screen, not "eventually". Sessions
  2 and 3 added six surfaces between them and neither ran it until prompted.
- It must end green or the failure gets fixed in that session. There is no such thing as a known
  failing e2e test here; there is only a suite people believe or a suite people ignore.

---

## #62 — A server-side rule with no way to satisfy it is not a rule

Found by the company's review pass on module 04 session 3, 2026-08-16.

Two defects, one shape. In both cases the service was right, the screen was missing, and every test
passed because the tests called the service directly.

**The site inspection could never be completed.** `inspectionCompleteness` requires at least one
attendee; the report form had no attendee field, and the booking panel sent `inspectedByIds: []`. So
the server asked for something no screen could supply, and `completeInspectionService` was
unreachable through the UI — permanently.

**The scope-change banner was locked exactly when it mattered.** Its actions were gated on
`editable || status === "sent"`. A scope change is found by surveying a ticket; the ticket exists
because the customer's purchase order arrived; the purchase order moves the quotation to `accepted`.
So the single state the banner is built for was the one state it could not be actioned in. Compounding
it, `isRevisable` omitted `accepted` too — against its own stated rule, "the statuses a customer has
already seen" — leaving no way to re-price work the company had just discovered.

### Why the existing tests could not catch either

Both had unit coverage that passed. `cash-advance.test.ts` and `site-inspection.test.ts` call
services with well-formed arguments, which is exactly what a screen that cannot produce those
arguments never does. The Playwright suite passed too: it asserts pages *render*, and both pages
rendered perfectly — one of them just had no field on it.

The gap is between "the page loads" and "a person can finish the job". Nothing in the build tested
the second, and the company found both defects within an hour of looking.

### What follows

- When a rule requires a field, the change that adds the rule adds the input. They are one change,
  not two, and splitting them produces exactly this.
- A permission or status gate on a UI action must be justified against the state the feature
  actually occurs in — not the state the record happens to be in while you are writing it.
- Screen-level smoke tests are necessary and not sufficient. The class of bug they miss is the one
  where every part works and no path connects them, which is the same class as DECISIONS #60.

---

## #63 — Filing a receipt in the app is a claim, not proof

specs/04-operations-projects.md §5, at the company's request during the same review.

Session 2 treated a cash advance as settled the moment the numbers reconciled. The company's
correction: the physical service invoices and official receipts have to reach finance, and somebody
has to check them against what was typed, before the advance is closed.

They are right, and §5 already said so — `CashAdvanceLiquidation.status` is specified as
draft | submitted | under_review | approved | rejected. I modelled that vocabulary in session 2 and
wired nothing to move it, which made filing receipts in the app equivalent to proving they exist.
They are not the same thing: what makes a cost deductible is a BIR official receipt, on paper, and no
amount of typing produces one.

So an advance whose numbers reconcile now stops at **`pending_settlement`** — shown as "liquidated —
pending settlement" — and `reviewLiquidationService` closes it. `cash_advance.review_liquidation`
gates the review, which §19 names and nothing had used.

### Pending settlement is not the technician's problem

`pending_settlement` is in `OUTSTANDING_STATUSES`, so the advance stays visible in the register as an
open item. But `liquidationStanding` reports it as **settled**, so it is never chased as late and
never blocks the next advance. The deadline was about handing receipts in, and they have been handed
in; holding somebody's next advance hostage to finance's queue would punish them for a delay that is
not theirs.

### The reminder is part of the control

The liquidation form carries a bordered notice that the paper must be submitted to finance. It is
deliberately the loudest thing in that card: a technician who files in the app and keeps the receipts
in a folder in their truck has not done the thing the status now waits for, and the only moment they
can be told is while they are typing.

---

## #64 — A test that reads a shared queue must say so, not hope

specs/00-foundation.md §6's job queue; found by module 04 session 4's full suite run, 2026-08-17.

`drain()` claims the oldest pending jobs in the table — `ORDER BY "runAt" ASC LIMIT batchSize` — and
that is exactly what a worker should do. It also makes every test that calls it implicitly dependent
on the contents of a table every other test writes to.

`queue.test.ts` enqueued a job, called `drain({ batchSize: 10 })`, and asserted its job had
succeeded. On 2026-08-17 the database held **exactly ten** pending jobs left over from other files:
other tests emit domain events, `relay.test.ts` turns every unrelayed outbox row into a job, and
nothing drains those. The batch was consumed before the test's own job was reached, and five
assertions read "expected 'pending' to be 'succeeded'".

### It failed because the suite grew, not because anything changed

This is the part worth remembering. Sessions 2, 3 and 4 added event-emitting tests until the backlog
crossed the batch size. Nothing in that diff touched the queue. A test that breaks from unrelated
growth is the hardest kind to place, because the change that triggers it is innocent and the failure
points somewhere else entirely.

It also looked like flake — two runs failed eleven and then five assertions — which sent the first
diagnosis toward timeouts under connection-pool contention. That guess was wrong and would have been
"fixed" by raising the global timeout, burying a real coupling behind a slower suite. The differing
counts were the backlog shifting, not nondeterminism.

### The fix, and the general rule

Both files now clear pending jobs in `beforeAll`. Pending jobs on a test database are detritus by
definition — nothing asserts on another file's unprocessed work — so this is safe, and it converts
an accidental precondition into a stated one.

The rule it stands for: **when a test exercises something that reads global state, it establishes
that state rather than inheriting it.** The alternative is a test that passes for a year and then
fails for a reason unrelated to anything anybody edited.

### A note on reading test output

The first two diagnoses of this were slowed by piping vitest through `tail`, which discards the
failure detail and leaves only the summary. A green summary read that way is still trustworthy; a red
one is useless. Capture the whole run.

---

## #65 — A default must not assert a decision nobody made

specs/04-operations-projects.md §7, module 04 session 5.

`Ticket.materialRequestStatus` was declared in session 1 with `@default("not_applicable")`. It read
as a harmless starting value. It was not: every ticket the system generated claimed that somebody had
considered whether the job needed materials and answered **no**.

§7 forbids that exact confusion, and says why the middle answer is modelled at all: "`N/A` is a
legitimate, recorded answer — **not a skipped step**. The record shows someone decided."

A default of `not_applicable` makes the record show a decision that never happened. The gate opened,
the ticket looked ready to mobilise, and the crew would have discovered the truth at the store — the
precise failure §7's diamond exists to prevent, produced by the schema rather than by anybody's
mistake.

### The fix, and the value that was missing

The default is now `undecided`, which is not in §3's status list because §3 assumed the question
always gets asked. §7 is the section that insists it be recorded *when* it is, and the corollary is a
value meaning nobody has been asked yet. `materialGate` treats `undecided` as **blocking**: a gate
that waves through the case nobody has looked at prevents nothing at all.

### The general rule

**A default is an assertion.** `not_applicable`, `approved`, `passed`, `none required` — every one of
those states a fact about the world, and a column that states it before anybody has looked is lying
in the direction that opens gates. When there is no safe thing to assert, the default has to be the
value that means *unanswered*, and the unanswered case has to be the one that blocks.

Two earlier decisions are the same shape from the other side: §5's `cashAdvanceRequired` is a boolean
because "no" is a decision worth recording (#53's neighbourhood), and #57's photograph rule keeps a
warning rather than inventing a passed state. This one is where the principle was breached and the
test caught it.

### It was caught by a test written from the spec's sentence

`material-request.test.ts` asserts that a brand-new ticket reads `undecided`, because §7 says the
unanswered state must be distinguishable. That assertion failed on the first run against a service
that was otherwise correct — the bug was a year-old schema default, not the code under test.

---

## #66 — An escape hatch that opens nothing is worse than none

specs/04-operations-projects.md §8, module 04 session 6.

Session 2 built `operations.override_ca_gate` and session 4 built
`operations.override_methodology_gate`. Both write an audit row and move the ticket's status. Neither
changed the thing the gate function actually reads — `cashAdvanceGate` reads the advance's status,
`methodologyGate` reads the method statement's — so both gates went on saying no.

Until §8 there was nothing downstream asking, so the defect was invisible: the overrides appeared to
work because the only observable effect was the audit row and the status they did write. Building the
readiness check is what made the question "and then what?" answerable.

An override that leaves the gate shut is worse than having no override at all. With none, somebody
escalates. With one, somebody presses it, sees a confirmation, and believes they are through — and
finds out at the gate.

### Reading the audit log, rather than mirroring a flag

`readinessForTicketService` looks for the override audit rows on the ticket and treats the matching
item as passing, carrying the officer's reason onto the list.

The alternative — a `caGateOverriddenAt` column on `Ticket` — was rejected. An override is a decision
somebody made and signed; the audit row **is** the signed copy. A mirrored flag would be a second
answer to "was this overridden", the two would eventually disagree, and the flag is the one that
would be trusted because it is the one the code reads.

The cost is a query against `AuditLog` in a read path, which is cheap and, more to the point,
correct: there is exactly one record of the decision and everything reads it.

### The narrower lesson

**A gate and its override must be tested together.** Each of those overrides had a test proving it
wrote its audit row and moved the status. Neither had a test proving anybody could then proceed,
because at the time nothing could. Where a feature's whole purpose is to unblock something that does
not exist yet, the test that matters cannot be written yet — and that is worth writing down at the
time, rather than discovering two sessions later.

## #67 — A metric that moves backwards as work finishes is a metric nobody trusts

§9 calls first-time-right "the quality metric that matters most and is currently unmeasurable", so
the moment `QAApproval` rows exist it becomes measurable and the counting rule has to be decided
deliberately rather than fallen into.

`firstTimeRightRate` counts over **approved records only**. A job currently going round the rework
loop is not counted as a first-time-right failure, even though it plainly failed the first time.

The alternative — count every inspected job, failures included — is more intuitive and is wrong. A
job rejected today and approved next week would move the rate *down* on rejection and back *up* on
approval. A number that gets worse while the crew fixes the problem, then recovers when they finish,
is one people learn to argue with rather than act on. Counting only finished jobs means the rate
moves in one direction per job and never revises itself.

The cost is that the rate lags: a bad month looks fine until its rework clears. That is the right
trade for a metric whose whole purpose is to be quoted in a review meeting without a caveat.

### A rate over zero jobs is not 100%

`ratePct` is `null`, not `100`, when nothing has been inspected, and the message says so in words.
Zero-denominator percentages default to flattering — a fresh install would report perfect quality —
and a dashboard tile reading 100% is indistinguishable from a real one.

## #68 — A scripted edit that misses its anchor fails silently, and green proves nothing

Three times in this module a Python edit script did not change what it was supposed to change, and
in each case the build, the typecheck and the lint all passed afterwards — because the code they
checked was the unchanged code.

- `ProgressPanel` was never wired into the ticket page: the script asserted *after* a partial
  replacement, so the assertion threw before `write_text` and nothing at all was written.
- The `methodology` numbering format, and later `qa_approval`, failed to match because Prettier had
  reflowed the anchor line since the pattern was written.

The shape is the same each time: a `str.replace` that matches nothing returns the original string
perfectly happily, and every downstream check then agrees the untouched code is fine.

**The practice:** assert before writing, never after; and verify by the effect rather than by the
exit code — count the wire-ins, re-read the seeded formats, grep for the symbol. "The build passed"
is evidence about code that may not be the code that was meant to exist.

The related habit, from the same cause: run Prettier **before** the suite rather than after, so a
formatting pass cannot reflow a file out from under an edit that has already been verified.

## #69 — Provenance, because the specification §10 wants to compare against is prose

§10 is unambiguous: "Test results are compared against the **specification from the accepted
quotation**, not against a value typed in by the technician. Out-of-spec results are flagged
automatically."

Module 02 does not store a specification anybody can compare against. `QuotationLine` carries
`description`, `longDescription`, `manufacturer`, `modelNumber`, `partNumber` — prose, written to be
read by a customer. The only structured `specifications Json` in the schema belongs to `InquiryItem`,
and that one is deliberately the *customer's* words rather than AIES's, kept separate so the company
can still answer "is what we quoted actually what they asked for?".

So the sentence cannot be implemented as written. The question is what to build instead.

### What was rejected

A comparison engine where the technician types the criterion and then the measurement, and the
software flags the mismatch. This is the obvious build and it is theatre: the person whose work is
being judged supplies both halves of the judgement. It would produce a certificate carrying an
automatic-looking verdict that means nothing, which is worse than no verdict, because a reader
believes it.

### What was built

Provenance. Every criterion records where it came from and when it was fixed:

- **`criterionSource`** is `quotation` — pinned to a specific promised line, carrying that line's
  text copied at citation time so a later revision cannot quietly rewrite it — or `stated`, meaning
  nobody could point at a promised line. Stated criteria are allowed, counted, and reported on the
  record, because refusing them would only push people into citing a line that does not say what they
  claim.
- **`criterionSetAt` and `measuredAt` are stamped by the server**, never accepted from the caller. A
  provenance field the client can write is decoration. A criterion fixed in the same act as the
  reading it judges is flagged: legal, sometimes unavoidable, and worth less than one written first.

The walk to the promised line is ticket → sales order line → quotation line, which module 03 already
describes as the answer to "what did we actually promise?" once a quotation has been superseded.

The honest summary the record now carries: §10's automatic flag is worth exactly what its criteria
are worth, and the record says what they are worth.

### What would close the gap properly

A structured `specifications Json` on `QuotationLine`, populated when a quotation is built, so a
criterion could be *read* rather than cited. That is a module 02 change, nothing in module 02
populates it today, and inventing the shape here would guess at what module 02 will need. Recorded
rather than done — and the citation link means the day it exists, the criteria already point at the
right lines.

## #70 — `jsonb` does not preserve key order, so never compare JSON by stringifying it

Caught by a test that expected a criterion's timestamp to survive a save that only added a
measurement. It did not.

`saveTcService` decides whether a criterion changed by comparing it against the stored one. The first
implementation used `JSON.stringify(a) === JSON.stringify(b)`. Postgres `jsonb` **reorders object
keys** on the way in, so `{kind, min, max}` comes back as `{max, min, kind}` — a different string for
an identical object. Every save therefore looked like a change.

The consequence was not a crash. It was that `criterionSetAt` would be re-stamped on every save, so
every test would appear to have had its limit written after its own reading, so the warning that says
exactly that would fire on every record ever produced. A warning that always fires is one people
learn to click past within a week — and the signal it carries is the entire point of DECISIONS #69.
A defect that degrades a signal to noise leaves everything green.

The fix is a canonical serialiser that sorts keys before comparing. **Anywhere in this codebase that
compares two values that have been through a `Json` column, sort the keys first** — there are Json
columns on defects, punch items, loop checks, training records and custom fields, and the same
comparison written the obvious way would be wrong in the same silent way.

## #71 — Coverage and fault are two questions, and a missing warranty date is neither answer

§11 lists three outcomes for a warranty callback: in warranty, out of warranty, and "AIES-caused
defect". Read quickly, that is one field with three values, and it is the obvious way to build it.

It is wrong, and the case that proves it is the one the single enum cannot express: **our fault, out
of warranty**. §11 says an AIES-caused defect makes the ticket non-billable *and* raises an NCR, and
nothing in that sentence depends on the window still running. A company that installed something
badly does not get to charge for fixing it because thirteen months have passed. With one field,
"out_of_warranty" and "aies_caused" are mutually exclusive, so that job either gets billed or the
company loses the record that it was ever its own fault.

So the record keeps two axes:

- **`coverage`** — what the dates say, or what a person decided they say.
- **`attribution`** — whose fault it was, on §8's standby-attribution pattern, for the same reason:
  the commercial position rests on who caused it.

Billability is then derived from the pair and **stored**, because it is a position the company took
on a date. Recomputing it on read would let a corrected warranty date silently rewrite what the
customer was told.

### `unknown` is an answer

Equipment reaches the installed base from commissioning, from a migration, or from somebody typing
it in, and plenty of it will carry no warranty window at all. The two tempting defaults are both
wrong in the same way:

- treat a missing end date as **expired**, and the company bills a customer for work that may well
  have been covered;
- treat it as **covered**, and the company gives work away.

Both are software answering a commercial question it has no basis to answer. So `readCoverage`
returns `unknown`, `determine` routes it to `needs_determination` — no ticket, no sales referral,
nothing committed — and a person establishes the terms. Same principle as §7's undecided material
gate (DECISIONS #65) and §9's waived client inspection: a question nobody has answered must not be
stored as an answer. The out-of-warranty-but-cause-unknown case parks the same way, because quoting
before the cause is known risks charging for the company's own defect.

### Overriding the dates is allowed, silently is not

A person may overrule what the record says — goodwill, or terms the equipment record never captured.
`checkClaim` refuses the override without a reason, because the next person to read the claim needs
to know the answer did not come from the window.

### What Equipment being built here costs

§16 owns the installed base. §11 cannot work without the warranty window, and a gate with nothing to
check is the theatre #69 refused — so the model is built now with its §11 fields live and its PM
scheduling fields inert, exactly as §7 built a minimum-viable `StockItem` for the material gate. The
alternative was deferring §11 until §16, which would have left the flowchart's warranty diamond
undrawn for several more sessions.

## #72 — Close-out blockers are computed from other sections' records, never ticked

§12 makes project close-out the moment that "emits `project.closed` → module 05 releases final
billing. **This is the explicit handover the brief describes.**"

That sentence rules out the obvious implementation. A close-out checklist is normally a `Json` column
of booleans a project manager ticks, and that design produces a document which says only that
somebody clicked six times. It cannot be wrong, because it makes no claim about the world.

So all six of §12's blockers are **derived**, each from the section that owns the underlying fact:

| Blocker | Read from |
| --- | --- |
| Critical punch items | §10's `TestingCommissioning.punchItems`, through `closeoutBlockers` |
| Unapproved service reports | §12's own `ServiceReport.status` |
| Failed QA | §9's `QAApproval` — the **latest** verdict per ticket |
| Unliquidated cash advances | §5's `CashAdvance.status` |
| Unreturned tools | §7's `MaterialRequestLine`, through `outstandingCustody` |
| Missing customer acceptance | §12's own record |

`ProjectCloseOut.checklist` stores the last computed state so a screen can render without running six
queries, but `closeOutProjectService` **recomputes before it closes anything**. A cached "yes" from
last Tuesday is not a thing to bill a customer on.

### Each one separately, on purpose

§20 requires each blocker to hold close-out on its own and release on its own. The cheapest way to be
sure of that is for no two of them to share a code path, so each is its own query and its own entry
in the returned list — and there is a test per blocker in both directions.

### The latest QA verdict, not any failed one

§9 counts rework rounds, so a ticket that failed QA in March and passed in April is a job that went
round the loop and came out. Counting *any* failed record would block close-out on history that has
already been put right, and a blocker nobody can clear is one people learn to route around.

### Cleared rows are returned too

§12: "The blockers show as a checklist so the PM can see who owns each one." `closeOutChecklist`
returns all six whether or not they block, each with its owner named. A list containing only problems
makes "clear" indistinguishable from "nobody has checked" — and an empty list is the most ambiguous
screen of all.

### A default that holds rather than releases

`customerAcceptanceRequired` defaults to `true`. DECISIONS #65 warned against defaults that assert a
decision nobody made, and this is the case that shows where the line sits: the danger there was a
default that let something through unnoticed. Here the default's effect is to **hold**, which is
visible immediately and cannot quietly release a project. Waiving it stays a deliberate act with a
reason, as §9's waived inspection and §10's absent witness are.

## #73 — The close-out pack is an index, not a merged binder

§12 asks for the close-out pack "generated as **one indexed PDF** and filed as a controlled
document", then lists sixteen contents: methodology, inspection reports, delivery receipts, QA
records, the T&C certificate, service reports, as-built drawings, and so on.

The document this session generates is the **cover sheet, the index, and AIES's own summary
sections**. It does not append the attached files themselves.

### Why not

Appending them means merging arbitrary uploaded bytes into one stream. That needs a PDF manipulation
library — `@react-pdf/renderer` composes documents it authors and cannot embed an existing PDF — and
even with one it only works for attachments that *are* PDFs. Real close-out attachments are
photographs, scans, spreadsheets and whatever a customer emailed. A merger that silently dropped
every non-PDF would produce a pack that looks complete and is not, which is the failure mode this
module has refused everywhere else.

### What the index does instead

It answers all sixteen items, including the ones that are missing, and says why:

- present, with the document number or count;
- absent, stated plainly — "No inspection recorded";
- **not built yet**, naming the section that owes it — as-built documentation and spare parts belong
  to §16, delivery receipts to module 03 §7, which is itself blocked on §13.

An index that omits what it cannot answer reads as a complete pack with fewer requirements. Naming
the gap is what makes the document useful to the person who has to close it: "as-built documentation:
not on file" tells a project manager what to go and get, and a missing section tells them nothing.

### The banner

A pack pulled while blockers are open prints "PROVISIONAL — this project is not closed". §12 calls
close-out the handover that releases final billing, and a document that looks identical before and
after that moment is one somebody will bill against early. Same reasoning as §10's certificate, which
prints DRAFT until commissioning is actually complete.

### When to revisit

If the company needs a true single-file binder for a client or an auditor, the work is a PDF merge
library plus a rasterising step for non-PDF attachments. That is a deliberate piece of work, not a
line in this session — and the index makes it additive rather than a rewrite.

## #74 — Who was sent and who turned up are two facts

From the company's review of 2026-08-17: make "Who attended" on a site inspection a choice of Sales,
Technical or Others-with-a-name, rather than a checkbox list of every internal user.

Acting on that surfaced a defect underneath it. The form's "Who attended" wrote to
`SiteInspection.inspectedByIds` — the field that means **who is assigned to go**, set when the survey
is scheduled. One column, two meanings, and the completeness gate read it as attendance.

The consequence is small until it is not. A survey is scheduled and DJ is assigned. On the day DJ is
sick and somebody else goes. With one field there are two options: leave DJ recorded as having
attended, which is false and is what the report will say; or overwrite him, which destroys the record
of who was originally assigned and therefore of the fact that the plan changed. Neither is
recoverable, and a survey report is a document that gets quoted back in a scope dispute.

So `attendees Json` was added and `inspectedByIds` kept its original meaning:

- **`inspectedByIds`** — who was assigned to go. Set at scheduling.
- **`attendees`** — `[{ party, name }]`, who actually turned up. Set on the report.

`inspectionCompleteness` reads `attendees`, because that is the one that is true.

### Departments, not names, for AIES's own people

What matters on a survey is that sales and technical were both there. A picker of every employee is a
list people scroll past rather than read, and the names it captures are already recoverable from the
assignment. Anybody who is *not* AIES — the client's engineer, a principal's representative — is the
person whose name nobody can look up later, so `other` requires one. An `other` with no name is
refused, the same rule §9's unexplained waiver and §10's absent witness are held to.

## #75 — Sufficient is not the same as necessary: who may approve a survey

The same review: "aside from EA and KJ, the personnel who assigned the site inspection during the
quoting process should also be able to approve the site inspection report, this ensures that they have
reviewed the site inspection report prior to continuing the quotation process."

The company's reason is better than the one the code had. `approveInspection` was gated on
`project.manage`, so an officer signed off surveys they had not asked for and whose quotation they
were not writing — which is the definition of a rubber stamp. The person who requested the survey is
the one whose quotation depends on what it says, and requiring their signature is what actually
guarantees somebody read the report before the quote went out.

`SiteInspection` already carried `requestedById`, so the change was where the check lives rather than
what it knows. The router dropped to `ticket.execute` and the rule moved into the service:

    project.manage  OR  being the requester

**Neither is necessary; either is sufficient.** That is the shape a permission check takes when a
relationship can substitute for a role, and it cannot be expressed in the router's single-permission
gate at all — which is why the gate was wrong rather than merely narrow. A bystander with neither is
still refused, and there is a test for that as well as for the requester path.

## #76 — Demo accounts must be off by default, not deleted by hand

The seed created four `demo-*@aies.local` accounts sharing one publicly-known password, so somebody
could click around a role they are not.

Deleting them never stuck. `prisma/seed.ts` runs again every time a numbering format is added — which
happened in six of the last eleven sessions — and recreated all four each time. The deletion and the
recreation were in different heads, so the accounts were permanent in practice and nobody noticed.

They are now behind `SEED_DEMO_USERS=1`, off by default. The same shape as the e2e account's
`ALLOW_E2E_USER` guard, for the same reason: an account with a known password is a way in that nobody
owns, and the database this seeds is about to be the live one.

**The general point:** a cleanup that something else undoes is not a cleanup. When deleting seeded
data, change the seed in the same commit or the deletion is theatre.

## #77 — A sales order belongs to the deal, not to the account

The purge script's first run stopped half way through with a foreign key violation, and the reason is
worth keeping.

It scoped everything by **account**: resolve the accounts to keep, delete what belongs to the rest.
That is the right instinct — deleting by name pattern breaks the day a real customer is called "SPO
Corporation" — but it asked the wrong question of one table. `AIESSO-260157` sat on the real account
while its quotation, `AIESLQ260524`, was a review-pass record. So the script kept the order and
deleted the quotation and customer PO underneath it, and Postgres refused, correctly:
`SalesOrder.customerPOId` is a required foreign key with no cascade.

The database was right and the script was wrong. An order's account is *who it is for*; its quotation
is *what it is*. Scope by the account and you keep orders whose subject matter has been deleted.

Fixed by dooming a sales order when **either** its account or its quotation is doomed, and by
releasing `SupplierPOLine.salesOrderLineId` — nullable, no cascade — before removing the lines it
points at.

### The failure was safe, and that is not luck

Deepest dependants first, every step scoped to resolved ids, never a bare `deleteMany` on a business
table. So the run that stopped had already cleared module 04 and the doomed sales orders and had
touched nothing real; re-running after the fix was idempotent. **A destructive script should be
restartable**, because the interesting ones stop halfway.

### Two things the script got wrong about itself

Both found by reading it against what it actually did:

- Its comment said orphaned audit rows were cleared. The code never cleared them, and the code was
  right — **a trail that a cleanup script edits is not a trail.** The comment was corrected to say so.
- It emptied the search index and printed "re-index search from the app". There is no such button.
  Ctrl+K finding nothing after a cleanup looks exactly like search being broken, so the script now
  rebuilds the index for what survives. That incidentally closed a standing gap: `reindexAccount` has
  existed since module 01 and nothing ever called it, so customer accounts were never searchable.

## #78 — Home is a page with no nav entry, and that is the point

Home was a module 00 scaffold for eleven sessions: the signed-in user's own permission count and a
checklist of infrastructure with "Built" badges. The first screen everybody opened every day, about
the software rather than about their work.

The company's decision of 2026-08-17, after two reversals worth recording:

1. Build a cross-module landing summary — what needs *you*, filtered to what you can act on.
2. Revert it; remove Home entirely and wait for module 09's dashboard.
3. Keep the page, **take it out of the nav**, and grow it into DJ's dashboard when module 09 lands.

The third is the right answer and the middle one taught why. Spec 09 §2 builds *five* landing pages,
one per person, and singles out DJ's blocked-at-a-gate widget as "the single most useful widget in the
platform for this company". The summary already carries that tile. Deleting it would have meant
rebuilding it in module 09; keeping it in everybody's sidebar would have put a half-built dashboard in
front of four people who did not ask for one.

So `/` renders it, nothing links there, and it is the seed of one of module 09's five pages.

### Why not redirect to My day

The obvious move, and wrong. My day is module 01 §6 and CRM-only — follow-ups, silent quotations,
inspections assigned to you. It serves EA and EM well and gives DJ, PD and a technician a page about
somebody else's job. A redirect would have sent half the company somewhere useless.

### Absent, not zero

Permissions decide which tiles **exist**, not what they show. Someone without `warranty.determine`
sees no warranty tile rather than one reading 0, because a count of a queue you cannot open is noise
dressed as information — and worse, "0" tells them nothing is waiting when they were never going to be
told either way. Where a tile *does* apply and the queue is empty it says so in words: an empty page
and "nothing is waiting on you" are the same pixels and opposite messages.

`home-service.test.ts` pins both, and asserts counts as **changes** rather than absolutes, because
every tile counts a global queue and DECISIONS #64 is about exactly that trap.

## #79 — A rename is not local, and strict mode is how you find out

"Awaiting approval" became "Quotations for Approval" at the company's request. Three places needed it:
the nav label, the page's own heading, and the Playwright assertion. Renaming only the nav would have
left the menu contradicting the page it opens.

Playwright then failed on something the rename had broken at a distance. The sidebar test asserted
`getByRole("link", { name: "Quotations" })`, which had matched exactly one link for eleven sessions.
The new label *contains* the old one, so it resolved to three elements and strict mode refused.

The test was right to fail and the fix is `exact: true`. The general point: **a substring-matching
locator is a latent failure that fires when an unrelated label grows.** It passed for months not
because it was correct but because nothing had collided with it yet. The list is now matched exactly,
covers the entries added since, and asserts Home is *absent* from the sidebar — the rule from #78,
tested rather than assumed.

## #80 — When the reason for a rule dies, the rule may not

The company confirmed on 2026-08-18 that the Synology DS220+ is a backup and recovery target only,
never a host.

Most of the repo already agreed — Spec.md §11 recorded the NAS as not viable for the application, and
the architecture diagram had it as backup and archive. One place did not, and it mattered: **spec 09 §1
argued its entire design constraint from that hardware.** "The DS220+ has two Celeron cores. Never run
analytical aggregation synchronously in a request."

Left alone, whoever builds module 09 reads a constraint whose stated reason is obsolete and concludes
the constraint is too. So the reason was rewritten rather than the rule:

- **Serverless functions have a wall-clock limit.** An in-request aggregation does not get slow, it
  gets killed, and the user sees a 504 rather than a slow page.
- **Vercel scales out; Supabase Postgres does not.** Five dashboards scanning transaction tables are
  five concurrent scans on one instance, and everything else queues behind them.
- **A dashboard is read far more often than its data changes.** Recomputing per view is waste on any
  hardware.

The thresholds move from "a 2GB box" to "seconds of function budget". None of the four practices —
materialised fact tables, dashboards reading them, queued ad-hoc reports, stored KPI snapshots —
change at all.

**The lesson worth keeping:** a rule justified by one fact about the world outlives that fact, and the
dangerous state is a live rule with a dead reason attached. When a premise changes, go and find what
was argued from it. `grep DS220` took ten seconds and found the one file that would have misled the
next reader.

## #81 — Three bugs that only a live deployment could show

The app went to Vercel on 2026-08-18, before §13 rather than after module 04. Within an hour it
surfaced three defects that 1211 tests, a Playwright pass over every screen, typecheck, lint and
eleven sessions of review had all missed. Each is worth recording for what made it invisible.

### The crons had never run, and looked like they were

`vercel.json` scheduled `/api/cron/drain` every minute. The dashboard showed both crons registered on
the right schedules. Nothing ran.

**Vercel Cron invokes a path with a `GET`. Both routes exported only `POST`.** Every minute the drain
fired, received 405, and did nothing.

Nothing already in the repo could have caught it. The tests call the handler directly; the local
verification used `curl -X POST`; typecheck and lint see a valid route. **None of them knows which
verb the scheduler uses**, and that fact lives entirely outside the codebase. The symptom was a job
sitting `pending` with `attempts: 0` — due, and never once claimed.

This is the strongest argument for the deployment order that was chosen. §14's offline PWA is next
after §13, and it depends on the same class of environment-specific behaviour.

### Re-attaching a removed file silently did nothing

Uploads deduplicate on `entityType + entityId + sha256` so the same bytes are not stored twice. The
lookup ignored `deletedAt`, so a file that had been removed and was re-attached found **its own
tombstone** and returned it as a successful upload. Every list filters removed rows, so the file
existed and was invisible.

The worst shape a bug can take: the interface reported success. Reviving the row is the fix rather
than inserting a second one, because removal is deliberately soft — the bytes never left the bucket.

Missed because **no test had ever removed a file and re-attached it.** Individually the operations
were covered; the sequence was not.

### The dead-letter pile was about to become meaningless

The first successful drain dead-lettered a `notify_email` job: no handler registered. That queue has
no handler by design (#10), and every module sets `email: false` for that reason — except
`comment.mentioned`, which did not. In production every @mention would have created a job that dies.

The cost is not the wasted row. **Dead jobs are the pile you look at when something is wrong**, and
filling it with failures you expect is how a real one goes unnoticed. Same reasoning as #70's warning
that always fires.

### What connects them

None was a logic error. Each was a **boundary** — between the scheduler and the app, between two
operations that were individually correct, between a queue and a consumer that does not exist. Test
suites are good at logic and blind to boundaries, and the only cure found so far is to put the thing
in the place where the boundary is real.

---

## #82 — A courier's proof of delivery is not a signature

specs/04-operations-projects.md §13.2 says it in one line, and the line is the reason §13 exists as a
separate section rather than a status field on the ticket. The temptation is obvious: the courier's
POD is a document, it arrives with a name on it, and it says the box got there. Treating it as
completion would close the ticket, release billing, and be wrong.

What the POD establishes is that *a* box reached *an* address and *somebody* signed for it. What
invoicing needs is that **this customer accepted these goods against this order**. The gap between
those two claims is exactly where a disputed invoice lives, and it does not close by being ignored.

So `recordCourierPodService` produces `delivered_unsigned` — the same state an own-vehicle delivery
reaches when nobody signs — and `canComplete` refuses both modes without `drSignedAt`. The two modes
converge deliberately: the clock that chases a missing signature should not have to know how the box
travelled.

This is the same shape as #57's approval document, §9's QA evidence and §12's service report. **A
status AIES set and an artefact somebody else produced are different claims, and only the second
survives an argument.** §13 is the fifth section to land on it, which is enough repetitions that it
should be read as the platform's default rather than as five coincidences.

---

## #83 — The state that costs money every day it is ignored

Most gates in this platform protect a record. `delivered_unsigned` protects revenue: the goods are
with the customer, AIES has performed, and it cannot invoice. Every day in that state is earned money
sitting uncollected — unlike a missing waiver or an unapproved methodology, doing nothing here has a
*running* cost rather than a compliance one.

Three consequences followed, and none of them would have been obvious from the model:

**It says so on the screen, not only in a nightly job.** The panel shows the billing consequence in
the state where it applies. A driver who knows the invoice is blocked will go back for the signature;
one who sees a neutral status badge will not.

**The escalation fires once.** `unsignedEscalatedAt` is the marker. A nightly job that renotified
every night would be filtered into a mail rule inside a week, and then the one that mattered would be
filtered too — the same reasoning as #70's warning that always fires.

**The notification names a person, not a queue.** It goes to whoever issued the DR, because they are
the one who cannot bill. Deliberately *not* to the driver: `driverName` is free text, since a hired
driver has no account here, and inventing a user from a name would be a guess.

The last point is worth stating plainly because the sweep almost shipped as an `emit` alone. Several
sweeps in this codebase emit an event that nothing subscribes to — which is fine as a record and
useless as an escalation. **An escalation nobody sees is not an escalation**, and the event and the
notification answer different questions.

---

## #84 — Prefill the receipt, because the alternative is two people typing the same thing

`deliverableLinesForTicketService` reads the sales order lines and hands them to the DR form already
filled in. The obvious version asks the person issuing the receipt to type the descriptions.

A delivery receipt whose lines do not match the sales order is a document a customer can sign
perfectly honestly and still leave the invoice arguable — "we received two flow meters" against an
order for "Flow meter DN150, qty 2" is a discrepancy somebody has to reconcile later, from memory.
The only reliable way to keep two documents identical is to never ask anybody to type them twice.

Two details fall out of the same reasoning:

- **Execution lines are excluded.** §7 already excludes them from `goods_delivered`; the receipt has
  to agree, or it invites a signature against work that has not happened.
- **The quantity offered is what is outstanding**, not what was ordered — a second delivery against a
  partly-delivered line should not default to re-delivering the whole quantity.

The file picker on the same panel is the same principle applied to the signature: the existing
pattern in this codebase is a text input for a file id, which is unusable for the person this screen
is actually for — a driver, on a phone, at a customer's gate. §14's offline PWA will make that worse
before it makes it better.

---

## #85 — The same mistake §13.2 warns about, one layer down

`statusAfterAttempt` returned `completed` when the driver ticked "delivered" and "signed". It read as
obviously right and it was wrong twice over.

The visible symptom was a collision: logging the successful visit closed the flow, so
`completeDeliveryService` — the call actually carrying the signature file — was then refused as a
duplicate. Two integration tests failed on "This delivery is already complete." Both would have
passed if the assertion had only checked the final status.

The real defect is the one underneath. **A driver ticking "signed" is the driver's account of what
happened at the gate. The uploaded receipt is the artefact.** Between the two sits the case that
happens constantly in the field: the paper genuinely was signed, and it is now in a folder in the van
rather than in the system. A flow that reaches `completed` on the tick alone has a record claiming a
delivery is closed with nothing to invoice against, and it silently drops out of the escalation sweep
that exists to chase exactly that.

So an attempt can never produce `completed`. Every delivery parks in `delivered_unsigned` until the
signed receipt is uploaded, and the tick survives in the attempt history as evidence about the visit —
which is what it is — and prefills the completion form.

What makes this worth writing down is that #82 was authored in this same session, about a courier's
POD not being a signature, and the rules file one directory away made the identical substitution for
an own-vehicle delivery. **Stating a principle in a decision record does not implement it.** The
integration tests caught it; neither the unit tests, which pinned the wrong answer, nor the
typechecker could have.

---

## #86 — A rejection that only exists in a response body is a lost afternoon

§14 states its conflict policy and then says why, in the strongest language anywhere in the spec
pack: the server "surfaces the conflict on next sync — **never silently discards work**", because
"losing a technician's afternoon destroys trust in the system permanently. Treat this as a
correctness requirement."

The natural implementation satisfies none of that. A service throws `TRPCError`, tRPC returns it,
the client shows a toast. That works exactly when somebody is looking at the screen — which, for
offline field work, is the one case that does not apply. The phone is replaying a queue from a
pocket on a drive home. If the tab is closed, the OS backgrounds the app, or the connection drops
while the error is in flight, then the refusal *and the fact that the work was ever attempted* are
both gone.

So `runFieldWrite` **commits** a `rejected` row carrying the reason, and the client reads it back and
shows the technician what happened to their work. The error is still thrown, for the online caller
who is watching; the row is what survives for the one who is not.

Three consequences that are easy to get backwards:

- **A crash is not a rejection.** A lost database connection recorded as `rejected` would tell
  somebody their work was refused when the truth is that nobody knows whether it landed — and would
  stop the retry that is the correct response. Only `BAD_REQUEST` is a decision.
- **A refusal is final; a failure is not.** The client keeps them as separate states for the same
  reason. Retrying a business rule forever is noise; giving up on a network blip is data loss.
- **The record is written after the work, not before.** Claiming the id first would need a `pending`
  state and an answer for a process that dies holding a claim. Recording after means a crash leaves
  no row and the replay simply runs, which is the safe direction to fail in.

---

## #87 — The queue may not be tidied up, by anybody, including the user

Everything else in the offline store can be rebuilt by reconnecting. The outbox cannot: it holds
work that exists nowhere else in the world. That single asymmetry decided several things that
otherwise look like over-caution.

**Sign-out refuses to wipe while work is queued.** The obvious behaviour — clear local data on
sign-out, for the next person who picks up a shared device — trades a *certain, irreversible* loss
against a privacy *risk*. So `wipeOfflineData` returns `{ wiped: false, queued: n }` and the caller
has to decide, with the honest options being "sync first" or "confirm you are throwing this away".

**The storage guard only ever warns.** §14 asks for a warning at 80% of quota and says "never
silently drop queued items". An eviction policy would be easy to add and would eventually, on a full
device, delete a queued photograph — the exact failure the section exists to prevent. When space
runs short the answer is to tell the person to sync, not to make room by discarding the one thing
that cannot be recovered.

**A drain stops at the first transport failure but continues past a refusal.** If the connection has
gone, the rest of the queue will fail identically, and marching through fifty items turns one outage
into fifty incremented counters and fifty copies of the same error. A refusal is specific to its
item, so it is not a reason to stop.

**Photos are compressed at capture, not at upload.** §14 asks for ~1600px/80% and the reason is
quota rather than bandwidth: twelve uncompressed photographs is tens of megabytes of IndexedDB
against a budget the browser may measure in the same units, and the eviction that follows takes the
queue with it. They are also uploaded *before* the write that references them, so a record never
points at files that may never arrive.

---

## #88 — Three things that only looking at the screen could find

`/field` was committed with a green suite, a clean build, passing lints and an auth-gated route
check. Then somebody looked at it on a phone-sized viewport, and found three defects in one
screenshot.

**The permission had never reached the database.** `delivery.execute` was declared in
`operations.manifest.ts` and no seed had run since. The manifest is the source of truth for
*intent*; `prisma/seed.ts` is what turns it into `Permission` and `RolePermission` rows. Every test
that touches permissions constructs its own `AuthedUser` with an explicit permission set, so not one
of 1275 tests reads those tables — the gap is invisible from inside the suite by construction. The
live site had the same hole: the deploy that shipped `/field` shipped a screen that 403s for
everyone. **A new permission needs a seed run wherever it is deployed**, and nothing enforces that
today (see PROGRESS "Known issues").

**The app shell was wrapping the screen that exists to have no shell.** §14 asks for "a distinct,
stripped-down screen for drivers… **nothing else**", and the page was written accordingly — then
rendered inside a hamburger, a search box, a notification bell and a help button, because
`providers.tsx` has a `BARE_ROUTES` list and `/field` was not on it. The page had no way to know it
was being wrapped, and no test asserted the absence of chrome.

**The indicator contradicted itself.** The header read "Everything sent" beside a button reading
"Sending…", because `useSync` drained on mount without first asking whether there was anything to
drain. Both labels were individually correct and the pair was nonsense — on the one indicator whose
whole job is to answer "is my work safe?" at a glance.

None of the three is a logic error, and that is the pattern. #81 said the same thing about the first
hour on Vercel: **each was a boundary** — between a manifest and the database that has to be told
about it, between a page and the layout that wraps it, between two labels that are rendered
separately and read together. Test suites are good at logic and blind to boundaries. The only cure
found so far is to put the thing in the place where the boundary is real, which for a screen means
looking at it.

---

## #89 — What a phone found that a green suite could not

The company ran a review pass on their own phone, on the live site, and reported five things. Three
were defects, and all three had been invisible to 1275 passing tests, a clean build, and a
screenshot taken by an automated browser on the same screen an hour earlier.

**"Loading takes 5 to 10 seconds."** Supabase runs in `ap-southeast-1` (Singapore). `vercel.json`
set no `regions`, so Vercel defaulted to `iad1` — Washington DC. Every page meant a phone in Manila
reaching a function in the United States, which then crossed the Pacific again for each query, and
the root layout forces dynamic rendering for the CSP nonce (#5), so nothing was cached to hide it.
Pinned to `sin1`. The fix is one line; finding it required somebody to say the app felt slow, because
locally it never was.

**"Install just made a bookmark."** `src/middleware.ts`'s matcher excluded `_next/static`,
`favicon.ico` and `brand/` — and not `manifest.webmanifest` or `sw.js`. Both are fetched by the
*browser* rather than by the page, so both were redirected to `/login`: Chrome asked for a manifest
and got an HTML login page, so the app was never installable, and the service worker script was HTML,
so registration failed and there has been **no offline shell in production since the first deploy**.
Nothing in the app could notice — no page requests either file.

**"I don't see the /field screen."** Correct: there was no way to reach it. It was built shell-free
and left out of the navigation, so the only route in was typing the URL. Stripped-down describes what
the screen *shows*; it is not a reason for the screen to be unreachable. It now has a nav entry gated
on `delivery.execute`, pinned by a test.

Two reports were good news and are worth recording as such: the screen is readable in full daylight,
and navigation went where it said it would.

**The pattern, for the third time.** #81 was the first hour on Vercel, #88 was the first look at a
screen, and this is the first use on a phone. Every defect in all three was a **boundary** — between
a scheduler and an app, a manifest and a database, a page and its layout, a middleware matcher and
the browser's own requests, a datacentre and its database. None was a logic error, and the suite is
excellent at logic. The only method that has ever worked is putting the thing in the place where the
boundary is real: deploy it, open it, hand it to somebody on the equipment they will actually use.

---

## #90 — A comment in a schema-validated JSON file is an outage

The region fix in #89 was one line and correct. It shipped alongside a `"//regions"` key holding five
lines explaining *why* Singapore, in the house style of putting the reasoning next to the decision.

`vercel.json` is validated against its `$schema`, and Vercel **fails the entire deployment** on an
unrecognised property. So the commit that was supposed to make the site fast instead stopped it
deploying at all — and every fix travelling with it went nowhere: the manifest still returned a login
page, `/field` still had no nav entry, and the company re-tested and correctly reported that nothing
had changed.

Two things worth keeping:

**The habit was right and the target was wrong.** Reasoning belongs next to the decision *when the
format has somewhere to put it*. JSON does not — it has no comments, and `"//key"` is a convention
that only works where nothing validates. The reasoning now lives in `docs/DEPLOYMENT.md` under the
Vercel section, which is where somebody changing the region would actually look.

**"I pushed a fix" and "the fix is running" are different claims.** The fetch that proved the manifest
was still HTML was read as "the deploy has not landed yet" — a guess that happened to be true about
the symptom and wrong about the cause, and which would have wasted the next round of testing. The
check that settles it is the deployment's own status, and asking for it is cheaper than inferring it.

---

## #91 — Four commits of finished work, unreachable, because a build cache remembered an old schema

Every deployment from `ea3d725` onward failed. The live site stayed on `a549ecf` while four commits
of correct, tested, pushed work sat in GitHub doing nothing — including the fixes for the three
defects the company had already reported.

The cause: **`package.json` had no `postinstall: prisma generate`**. Vercel caches `node_modules`
between builds and the Prisma Client lives inside it, so each build compiled today's code against
whichever schema was current when the cache was last populated. From `ea3d725` that client predated
`DeliveryReceipt`, `DeliveryTicketFlow` and `FieldSubmission`, and `next build` typechecked
`db.fieldSubmission` against a client that had never heard of it.

It builds on a developer machine because `prisma migrate dev` regenerates the client as a side
effect of adding the migration. The failure needs a *cached* `node_modules` and a *new* model, and
neither `npm run build` nor the full test suite reproduces that locally. Confirmed by restoring the
pre-`ea3d725` schema, regenerating, and watching `tsc` produce the same errors.

**The expensive part was not the missing line. It was three wrong diagnoses in a row**, each
plausible, each acted on, none checked against the deployment's own status:

1. *"The deploy has not landed yet"* — inferred from the manifest still returning HTML. Consistent
   with the evidence and wrong.
2. *"My `//regions` comment failed the schema validation"* — a real bug, worth fixing, and **not** the
   cause: `ea3d725` and `348b5c4` had already failed before that key existed.
3. *"Vercel has stopped seeing the repository"* — reached after the company reported not finding the
   commits, when the deployments existed and were red.

One screenshot of the Deployments tab ended it in seconds. The lesson is not "check the logs", which
everybody already knows. It is that **an inference about a system you cannot see is a hypothesis, and
stating it as a finding costs somebody else a testing round**. Two of those three were reported to
the company as conclusions. The right move, available from the first symptom, was to say the deploy
status was unknown and ask for it.

---

## #92 — "Not applicable" is an answer somebody has to be allowed to give

§15 lists `pass/fail` and `pass/fail/NA` as two separate item types. The easy reading is that one is
a convenience variant of the other. It is not — it is the whole difference between a checklist and a
formality.

If N/A were universally available, every awkward item would get one. The document would still be
signed, still be filed, still look like evidence, and say nothing: which is precisely "the
undocumented, verbal way work is currently confirmed" that §15 opens by promising to replace, with
extra steps. So **the template author decides, per item, whether "not applicable" is on offer at
all**, and `checkResponse` refuses an N/A recorded against an item that never offered one. The
refusal is not a validation nicety; it is the mechanism.

Three consequences fall out:

- **An unset answer is never read as N/A.** They are reported separately, because one is a decision
  somebody made and the other is a question nobody reached.
- **The screen shows the N/A button only where the template allows it.** A UI that offered it
  everywhere would undo the rule without touching the rule.
- **The seeded templates use it sparingly** — hot work permits, scaffolding, calibration certificates:
  things a particular site can genuinely lack. Everything a technician must actually confirm is
  `pass_fail`, which has no way out.

This is the sixth appearance of the same principle (§7's diamond, §9's waiver, §10's witness, #65's
default, #71's unknown coverage) and the first where it is a **type** rather than a field somebody
remembered to add. That is the right place for it: a field can be left off the next form, a type
cannot.

---

## #93 — A published procedure that can be edited is not a procedure

§15: "templates are versioned; responses permanently record the version used, so historical evidence
reflects the procedure actually in force."

That sentence is only true if a published version cannot be changed. If it can, then a checklist
somebody signed six months ago silently comes to mean whatever the template says today — which is
strictly worse than having no checklist, because it looks like evidence and is not. Somebody would
defend it in an audit before discovering that.

So there is no code path that mutates the `sections` of anything published. `saveDraft` refuses
anything but a draft; `publish` freezes; `revise` copies into the next version and retires the
previous one rather than deleting it, because responses cite it as what they followed. The seed
follows the same rule — it creates a version 1 where nothing exists and never touches an existing
one, so a deploy cannot rewrite the company's procedures.

**And the response keeps its own snapshot of the items it answered.** That is deliberate duplication.
Evidence that can only be read by joining to another table depends on that table still being right,
and this is the kind of record somebody opens in five years with no idea what else has changed since.
The snapshot costs a few kilobytes and removes an entire class of "it looked fine at the time".

The same reasoning already made `reviseTemplate` copy the previous items rather than start blank: a
procedure somebody has to retype is a procedure that quietly stops being revised, and the version
history then lies by omission.

---

## #94 — A screen reachable only from a record disappears when there are no records

Twice in two days, in the same shape.

`/field` was built shell-free and left out of the navigation, so the only way in was typing the URL,
and the company reported "I don't see the /field screen" — correctly. That was #89.

Then §15's eleven seeded checklists were reachable only through the dropdown on a ticket's Checklist
panel. Which was fine until the sample ticket was deleted at the company's request, at which point
the templates existed, were seeded, were tested, and were invisible. The company reported "I don't
see any of these 11 items on my end" — also correctly, and this time the deletion that hid them was
mine.

The rule both cases teach: **a thing users are meant to review, revise or learn from needs its own
door**, independent of any record. Checklists are a library — somebody reads them, corrects the
wording, prints them for a toolbox talk, all without a job in front of them. Attaching the only
entrance to a ticket confused "where you *use* it" with "where you *find* it".

Worth noting how it was missed both times. The gap was documented — PROGRESS said in plain words
"the template *builder* screen is not built" — and that note was read as a missing *feature* rather
than as a missing *route to existing content*. The eleven templates were listed in a review document
sent to the company hours before they reported not being able to see them, which should have been the
clue: if a document has to describe what is in the app, the app is not showing it.

Both screens now have a nav entry, each pinned by a test asserting it appears for the right
permission and not otherwise.

---

## #95 — Four renewal reasons are four conversations, not one flag

§16 names four things that should generate a lead: contracts expiring in 90 days, calibrations due in
60, warranties ending, equipment past its service interval. And it says why they matter more than
anything else in the section — "this is where the recurring revenue in this business lives".

The obvious implementation is one `needsAttention` boolean and a date. It is wrong, and the reason is
commercial rather than technical: **"your contract ends next quarter" and "your transmitter is out of
calibration next month" are different calls, to different people, with different urgency.** Collapsing
them produces a list somebody has to open each row to understand, which in practice means the list
does not get worked.

So `dueRenewals` returns a typed reason per item, one item can raise two leads, and each lead carries
`pitch` — the argument for the call, in words a salesperson can read without opening the record. A
lead that says only "AIESMC-260001 ends in 40 days" gets closed as noise by whoever picks it up three
weeks later; one that says renewing before the lapse keeps the visits continuous is a conversation.

Two consequences that look like details:

**A warranty that has already ended raises nothing.** It is the past, not a renewal, and dressing it
up as expiring would have the salesperson say something untrue on the call. The maintenance
conversation it implies is real but different.

**Colour on the screen comes from urgency, not from reason.** A calibration due tomorrow and a
contract ending tomorrow are equally urgent. The reason is already the section heading; tinting by it
would have said the opposite of what is true.

---

## #96 — What the nightly job acts on and what the screen shows are one function

`dueRenewalsService` is called by the renewals page and by the sweep. That is deliberate and worth
stating, because the natural build is two queries — one shaped for a list, one shaped for a job.

Two queries drift. Not immediately: one gets a filter for a case the other never sees, or a window is
tuned in one place. Then the dashboard says four things are due and the job raises five, and the
next person cannot tell which is broken — so they stop trusting both. A dashboard that disagrees with
the process behind it is worse than no dashboard, because it is consulted before it is doubted.

The same reasoning already put `plannedVisitDates` in the rules layer rather than storing a schedule:
the contract screen and the PM sweep compute the same visits from the same term, so editing the term
cannot leave a stored schedule behind that nobody recalculated.

**And the flags differ on purpose.** Contracts carry `renewalFlaggedAt` so a renewal is raised once —
ninety nights of the same alert teaches sales to filter it, and then the ninety-first, a real lapse,
is filtered too (#83's argument again). Equipment carries no such flag, because servicing an item
moves its own `nextPMDueAt` and recalibrating moves `calibrationDueAt`. The work itself is the
"handled" signal, which is truer than a marker somebody has to remember to clear.

---

## #97 — A scheduler that refuses is a scheduler people work around

§17's board reports conflicts. It does not prevent them, and `scheduleTicketService` writes the
schedule and returns what that broke rather than throwing.

The instinct is the opposite: the system knows the technician is already booked, so it should say no.
But a dispatcher putting one person on two short jobs in the same industrial estate is doing their job
well, and the system has no way to know that. Refuse it and the schedule moves somewhere the system
cannot see — a whiteboard, a group chat, somebody's head — and then the board is wrong about
*everything* rather than about one day. A tool that is wrong about one day is still worth reading.

The same reasoning runs through the rest of §17:

- **Scheduling somebody who is on leave is reported, not blocked.** People come back early, and a
  dispatcher who knows that should not have to delete the leave record to do their job.
- **The one thing genuinely refused is a window that ends before it starts.** That is not a judgement
  call, it is a typo, and there is no legitimate intent behind it to respect.
- **Conflicts appear at the top of the board**, because a rule that is enforced nowhere has to be
  visible somewhere. Reported-but-buried would be the worst of both.

---

## #98 — The board renders §8's answer rather than forming its own

§17: "gate status is visible on every card. A ticket that is scheduled but has no released cash
advance or unissued materials shows red."

The obvious build queries the advance and the materials and decides. That is a **second**
implementation of §8's readiness check, and the two disagree within a month — one gets a case the
other does not. Then the board shows green while mobilisation refuses, and nobody can tell which is
right, because both look authoritative.

So `cardStatus` takes §8's `Readiness` and renders it. The board contributes exactly one fact §8 does
not have: whether a crew is committed to a date. That produces the distinction §17 is actually asking
for — an unready ticket with no date is ordinary work-in-progress, the same ticket with three
technicians booked on Thursday is the thing that ruins a week, and they must not look alike.

It costs a query per scheduled card. That is the right trade at this size, and the alternative is a
dispatch board that is confidently wrong about whether a crew can start.

**Two related calls.** A ticket whose readiness cannot be read is shown blocked, not ready — an
unknown gate is a blocker everywhere else in this platform. And capacity counts everybody holding
`ticket.execute` rather than everybody in the `technician` role: an operations manager who spends half
their week in the field is real capacity, and counting by role name would hide them from the one
number §17 says sales needs before promising a date.

---

## #99 — A Date built inline is a new React Query key every render

`/dispatch` sat on "Loading the week…" indefinitely, on desktop and on a phone. The server answered
the same query in 2.6 seconds every time it was asked, and it was being asked continuously.

```tsx
const weekDate = new Date(Date.now() + weekOffset * 7 * 24 * 60 * 60 * 1000);
const board = trpc.operations.dispatchBoard.useQuery({ weekOf: weekDate });
```

`Date.now()` moves. A new `Date` object each render is a new query key each render, so the query
refetched forever and `isPending` never became false. The screen was doing exactly what it was told
and telling the truth about it.

Two things make this worth writing down rather than just fixing:

**Every automated check passed.** Typecheck, lint, build, 1416 tests. The bug lives in the identity of
an object across renders, which is not a thing any of them look at. It needed somebody to open the
page and wait.

**The fix is a memo *and* a floor to midnight.** Memoising on `weekOffset` alone still produces a new
key whenever the component remounts, and the value drifts by milliseconds between mounts for no
reason a reader could see. Flooring to the day makes the key mean what it says: a week.

The general rule: **anything that goes into a query key must be stable for as long as the query
should be**. A date, an array literal, an object literal built in the render body — all the same trap.

---

## #100 — Seeding through the services still let a screen come up empty

`sample-records-dispatch.ts` creates its records through the real services rather than `db.create`,
for the reason `sample-records.ts` gives: a row inserted directly has no number, no audit row, no
events, and has passed none of the rules.

It still produced an empty `/field`. The script created a delivery *ticket*; the screen lists delivery
*flows*, and a delivery ticket with no flow is not yet a drop. Reported as "delivery mode is still
empty", which was exactly right.

So the discipline was correct and insufficient. Going through the services guarantees each record is
*valid*; it does not guarantee the set of records is what a screen actually reads. The check that
would have caught it is the one that catches everything else in this project: **open the screen and
look**, which is what the company did.

Two smaller things the same script got wrong, both worth the same lesson:

- Its `--remove` found accounts only through their tickets, so a run that failed before creating any
  left an account and its site behind — and the account delete then failed on the site's foreign key
  and said nothing useful. Sites go first now, and accounts are found by name independently of how far
  the run got.
- It tried to seed ₱2,450 of diesel and was refused: "anything over ₱500.00 needs its receipt". The
  rule working. Rather than fake a receipt file that would 404 when clicked, the sample stops below
  the line and the over-threshold case is a review step with a real photograph — a better test of it
  than a seeded row could be.

---

## #101 — A question with no control is a gate nobody can pass

§15's `photo` item type rendered this and nothing else:

> Attach below, then record the file ids here as they upload.

There was no "here". The `Attachments` component below uploaded the file to the checklist, but
nothing connected an uploaded file to the *question*, so `photoFileIds` stayed empty, `isAnswered`
stayed false, and sign-off refused. The company hit it on a QA inspection: everything filled in, an
image uploaded, still blocked — with the screen correctly listing "Photographs of the finished work:
Not answered" and no way on earth to answer it.

The rules were right. The service was right. The item was genuinely unanswered. **The screen offered
no way to make it answered**, which turns a correct gate into a dead end — and a dead end is worse
than a missing feature, because the person is told what is wrong and still cannot act.

It is the same mistake as the file-id text box on §13's delivery panel, which was corrected the same
way: **pick from what is there rather than type an identifier**. A `photo` item now lists the
checklist's attachments with a tick beside each. Nobody types a cuid; nobody can.

Two things this rhymes with, and the pattern is worth naming:

- **#94's screens with no door** — finished work with no way to reach it.
- This: a finished *question* with no way to answer it.

Both are the same failure at different scales. The code is complete and correct, and a person cannot
get to the thing it does. Every automated check passes, because none of them ask "can a human
complete this task?"

**Also fixed alongside it:** the Sign off button was disabled with no stated reason when the name box
was empty. A disabled control that does not say why is the same dead end in miniature, and on a phone
there is not even a tooltip to fall back on. It now says so in the page.

---

## #102 — A draft can be discarded; a signed checklist cannot

The company asked for delete, with the reason attached: "a wrong checklist might be selected and is
not needed. This will leave an 'in progress' when it does not really progress."

That is exactly right, and the harm is subtler than clutter. An abandoned draft sits on the ticket
looking like outstanding work. A list of outstanding work containing things nobody intends to do is a
list people stop reading — and then the item on it that *did* matter is skipped too. Same argument as
#83's nightly alert and #70's warning that always fires: the cost of noise is that the signal goes
with it.

**The line is completion, and it does not move.** §15 exists so that what was checked can be read
afterwards. A signed checklist is the evidence; evidence somebody can remove once it becomes
inconvenient is not evidence. So `deleteResponseService` refuses a completed one and says what to do
instead — fill in a new one, and the history shows both, which is what actually happened.

**Soft, not hard.** A draft can be half-filled, and somebody clicking the wrong row should not destroy
an afternoon of answers. §14's entire argument is that field work is not lost casually, and that
argument does not stop applying because the work is unfinished.

**Be precise about what "soft" buys, because the first draft of this entry was not.** The row survives
with `deletedAt` and `deletedBy` set, and the answers survive with it. **Nothing in the application
can bring it back** — there is no restore anywhere in this platform except file re-upload (#81), and
no screen or service that clears `deletedAt` on a checklist. Recovery today means somebody with
database access running an update.

So the guarantee is narrower than "recoverable" suggests: the work is *not destroyed*, and getting it
back is a support task rather than a click. That is the right trade for a mistaken discard — the
damage is bounded and reversible by someone — but writing "recoverable" without saying by whom was
the same class of error as a comment that does not match its code.

**The screen does not offer what the service would refuse.** Discard appears only on unfinished rows.
The service refuses a completed one regardless of what any screen offers — but a button that exists
to be rejected teaches people that the app argues with them, and there is no reason to invite that.

**Every discard asks first**, at the company's instruction: press Discard, and the row asks "discard
this checklist?" with *Yes, discard it* and *Keep it*, naming what goes with it.

Worth setting against §17's scheduling confirmation, which asks **only** when there is a clash. The
two look like the same pattern and are governed by opposite reasoning:

- A booking with no clash is **harmless**, so a dialog there is pure friction — and friction on the
  harmless case is exactly what teaches people to click through dialogs without reading, so that the
  one that mattered gets clicked through too.
- A discard is **never harmless**. There is no version of it that costs nothing, so there is no case
  to skip the question for.

The rule that generalises: *confirm when the action has a cost, not when the system is merely
uncertain*. A dialog that fires on the safe path spends the user's attention and buys nothing.

---

## #103 — Recording what was spent, and claiming it, are two different permissions

**2026-08-18, from the module 04 re-check.** The company asked one question: *"when above 499 and asks
for receipt, how does the personnel comply with this request? there's no place to attach receipt."*

The answer was that they could not, and it was worse than the question implied. `checkExpense` put
the missing receipt in **errors**, and `saveExpenseService` throws on any error — so an expense over
₱499 could not be **saved at all**. Not saved-and-flagged. Not saved-and-unclaimable. Refused. The
hint under the field read "attach the receipt to the expense once it is saved", describing a
sequence the rule made impossible; the file plumbing it needed (`FIELD_EXPENSE_ENTITY_TYPE`, a
registered access checker, a `receiptFileIds` column) had existed since §16 and nothing ever called
it.

### The split

- **Recording is now always allowed.** Missing receipt over the threshold is a warning that says
  what to do next.
- **Claiming is not.** `checkExpenseClaimable` runs at submit. Receiptless ₱800 is never reimbursed.

The rule still bites. It bites at the claim rather than at the writing-down.

### Why that is right independent of the screen

What was spent is a **fact**; what may be claimed is a **policy**. A technician who paid ₱800 for a
taxi paid it, receipt in hand or lost in a jacket, and refusing to record it does not unspend the
money — it moves the number somewhere the company cannot see. The job's cost silently stops being
knowable, which is the same failure as **absent ≠ zero**, arrived at from a different direction. And
the control the receipt rule exists to be — company money leaving on somebody's say-so — is a
decision made by a second person at submit, against a record that already exists.

### Where a receipt is counted from

Two places could hold one: the row's `receiptFileIds`, or a file uploaded against the saved row.
Only the second is reachable from a screen, because the expense has no id until it exists. So both
are unioned, in the two places that ask — `submitExpensesService` and `listExpensesService` — and
the badge on the screen is derived from the same union as the refusal. A screen saying "receipt
attached" while the submit says it is missing is worse than either answer alone.

### The test that pinned the wrong answer

`timesheet-rules.test.ts` asserted the old refusal and passed throughout. Same shape as #85: a unit
test confirms the answer somebody already decided on and cannot notice the question was wrong. §16
had rules tests and **no service test at all**, which is exactly the gap the defect lived in — a
`timesheet.test.ts` now exists and covers the path a person actually walks.

Third instance of #101 — a correct gate with no control to pass it. The first two were a checklist
photo item and a delivery file-id box. The pattern is now specific enough to look for on purpose:
**wherever a rule requires evidence, find the control that supplies it, and follow it end to end.**

---

## #104 — The screen says which build it is

**2026-08-18.** "Is the fix live yet?" has cost real time twice — three wrong diagnoses of a failed
deployment (#91), and a review round where a fix was reported as not working because the tab
predated it. Neither the reviewer nor I could answer it from the screen.

The sidebar now reads `build 3e770fe`, taken at build time from `VERCEL_GIT_COMMIT_SHA` so it cannot
drift from what is deployed. Locally it reads `dev`.

Seven characters. The alternative was continuing to answer an empirical question by argument.

---

## #105 — The inbox decided approvals without telling anybody what they meant

**2026-08-18. I got this wrong once before correcting it, and the correction matters.**

My first reading of AIESCA-260127 was that its two commits — the engine's decision and the advance's
own update — had been interrupted between them. That was wrong. The real cause is deterministic and
much larger.

`/approvals`, the global "Awaiting my approval" inbox, decided requests by calling
`decideApprovalRequest` **and nothing else**. The engine updates its own row. It does not know that
approving a cash advance releases it for payment, or that approving a quotation lets it be issued —
that knowledge lives in each module's service. So the request went to `approved` and the business
record stayed exactly where it was.

Both exits then sealed: approving refused because no request was pending any more, re-submitting
refused because it was no longer a draft. A decision recorded against a record that could not
receive it.

**It applied to every approval type** — quotations, supplier POs, cash advances, extensions. Nobody
had decided one of the others from the inbox yet.

### Why nothing caught it

Each module's own approval path is correct and well tested. The inbox is a different path to the
same act, and it is *the likely one* — the notification says something needs approval, and the inbox
is where the notification points. The suite tested the path the code was written for and not the
path the person takes.

### The fix

A decision handler registry, the same shape as `registerFileAccessChecker`: modules say what
deciding their entity type means, the core holds a map, a barrel guarantees registration on a route
whose bundle contains none of them. The router dispatches through it and **refuses an unregistered
type** rather than half-deciding it — the old default was the dangerous one, because a decision that
half-applies looks complete.

Each handler calls the module's existing service. A handler that reimplemented the service would be
a second definition of what approving means, and the second definition is the one that drifts.

### The screen

It showed `CashAdvance — cmsyrix32002pl5045aucx6ca` and two buttons. No number, no amount, no
purpose, no requester, no link, and no box for a reason when sending something back. The company
asked for the request to be viewable by the approver, which is right, and understates it: an
approval **is** the control — the moment a second person is supposed to look. A screen that cannot
show what is being decided turns that control into a formality, and a formality in an ISO-audited
process is a finding waiting to be written.

The readable facts were already stored. `entitySnapshot` is captured at request time and is
deliberately immutable, so it is the honest record of what the approver was shown — exactly the
property you want behind a decision somebody has to stand by. It was being written and never read.

### #106 — Three silently disabled controls in one week

The cash advance override "did not push thru" because its button is disabled below ten characters of
reason and said nothing about it. The service was right, the permission was seeded, the control
looked pressable and did nothing.

That is the third: the checklist sign-off button, the QA photo item, this. **A tooltip is not a
fix** — these get used on a phone, where nothing hovers. The rule now: a disabled control states its
condition in visible text, next to itself.

---

## #107 — Not everything on an order is a thing you hand over

**2026-08-19, from the company's list.** §4's proposal read `!requiresExecution` as "goods", so
anything that did not need somebody on site got a **delivery** ticket. `service` and `labour` route
to execution correctly; `travel`, `freight` and `misc` did not, and each proposed a delivery.

The cost was not a spare ticket. §13 holds a delivery at `delivered_unsigned` until a signature
arrives, and **gates billing on it**. So a freight charge would sit unsigned forever, keeping a
finished order looking incomplete and blocking the very invoice the freight was charged on. A lane
built for handing over equipment, applied to a line item that was never going to arrive in a van.

An **allow-list** now decides it: only `product` is physically deliverable. A new item type added
later is not deliverable until somebody says so, which is the safe direction — a missing delivery
ticket is visible on the proposal screen, whereas a spurious one is a lane somebody has to work out
how to close.

Lines needing no ticket are reported **separately** from lines nothing covers. Lumping them together
would train the reviewer to ignore the "these lines have no ticket" warning, and then a genuinely
dropped line goes unnoticed — which is the failure that warning exists to prevent.

---

## #108 — The installed app had no way back

**2026-08-19.** A standalone PWA renders with no browser chrome: no address bar, no back button.
That is the point of installing it, and it is also how somebody who taps into a ticket from the
dispatch board ends up with no way back except the sidebar, which returns them to a list rather than
to where they were. On iOS there is not even a system gesture for the first navigation of a session.

Shown **only** when running standalone. In a browser it would be a second back button an inch from
the real one — clutter at best, and a control that behaves differently from its neighbour whenever
the two disagree about history.

Disabled rather than hidden when there is nowhere to go back to, so the header does not jump the
moment somebody navigates once. And it says why, per #106.

