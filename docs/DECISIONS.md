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
