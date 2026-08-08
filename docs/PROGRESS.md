# Build Progress

Last updated: 2026-08-08
Current module: 01 — CRM and Inquiry Intake (session 1 of 3 started)
Status: in progress. Module 00 is COMPLETE and tagged `module-00-complete`.

## Done
- [x] Spec pack organized into repo layout (Spec.md, docs/, specs/, brand/)
- [x] Git repo initialized, `main` branch, pushed to https://github.com/drox06/aies-system
- [x] Supabase dev project (`aies-platform-dev`, ap-southeast-1) — real Postgres, working
      `DATABASE_URL`/`DIRECT_URL` in `.env` (gitignored)
- [x] Module 00 session 1 — bootstrap, Prisma, CI, module manifest system
- [x] Module 00 session 2 — Auth + TOTP + RBAC + seeded roles + approval fallback (see git
      history / earlier PROGRESS.md revisions for full detail)
- [x] Module 00 session 3 — Audit log, event outbox, job queue, numbering:
  - [x] `AuditLog` model + `writeAuditLog()` — must run in the same `$transaction` as the change
        it records (proven by an integration test that forces the audit write to fail and
        confirms the business change rolls back too), with a redaction list for sensitive fields
  - [x] Audit logging wired into `admin.createUser`/`assignRole`/`removeRole` via a
        `router.ts`/`service.ts` split (`src/server/core/admin/service.ts`) — the split exists
        specifically so this transactional logic is testable without pulling in the full Auth.js
        config, which only resolves inside the Next.js runtime
  - [x] Reusable `<AuditTrail entityType entityId />` component + `audit.listForEntity`
        procedure, mounted on `/admin/users` behind a per-row "Show activity" toggle
  - [x] `EventOutbox` model + transactional `emit()` (naming-convention validated:
        `entity.verb_past_tense`)
  - [x] Postgres job queue (`Job` model): `enqueue()` (idempotency-key safe), `drain()` (atomic
        `SELECT ... FOR UPDATE SKIP LOCKED` claim, exponential backoff retry, dead-letter after
        `maxAttempts`, **stale-lock recovery** so a job killed mid-handler by a serverless
        timeout gets redelivered exactly once rather than stuck forever)
  - [x] Outbox-to-job relay (`relayOutboxToJobs`) + `events` queue handler dispatching to
        `module-registry`'s subscribers + `POST /api/cron/drain`
  - [x] Numbering service: format mini-language (`{YY}`, `{MM}`, `{####}`, arbitrary `{NAME}`
        extras), atomic allocate/preview (same `ON CONFLICT` upsert pattern as the session-2 rate
        limiter), all 15 document-type formats from Spec.md §5 seeded
  - [x] 82 automated tests total, all passing, including the exact scenarios specs/00-
        foundation.md §11 calls out by name: "an update writes exactly one log row with a correct
        diff; a forced failure rolls back both the change and the log", "50 concurrent
        allocations produce 50 unique sequential numbers", "killing the drain mid-flight
        redelivers the event exactly once to an idempotent handler; a duplicate cron invocation
        does not double-send"
  - [x] **Manually verified end-to-end in a real browser**: logged in as EA (full TOTP flow),
        created a user from `/admin/users`, assigned it a role, expanded its activity panel and
        confirmed both actions appear correctly attributed and timestamped in the audit trail
  - [x] Found and fixed two more real bugs during that manual pass (docs/DECISIONS.md #8-#9):
        `signIn()` was sending `totpCode: undefined` as the literal string `"undefined"`
        (`URLSearchParams` doesn't omit `undefined` values), which made a TOTP-enrolled account
        fail verification instead of being prompted for a code — invisible in session 2 because
        no account had `totpEnabled: true` *at login time* back then; and `Strict-Transport-
        Security` was being sent over local plain-HTTP dev traffic, which force-upgraded the
        browser to `https://localhost` and broke all further local navigation until a fresh
        browser context was opened

- [x] Module 00 session 4 — Storage, customFields, notify, approvals, comments, search:
  - [x] Storage: real Supabase Storage bucket (`aies-files`) created via `scripts/ensure-
        storage-bucket.ts`; `FileObject` model (dedup by sha256 within an entity);
        `{entityType}/{yyyy}/{mm}/{entityId}/{uuid}-{sanitized-filename}` key scheme
        (specs/00-foundation.md §7.2); executable/oversize rejection, pluggable scan hook
        (no-op by default), sharp-generated web derivative for images; `POST /api/files` and
        `GET /api/files/[id]` (permission-checked via a per-entityType-registered
        `FileAccessChecker`, then redirect to a short-lived signed URL)
  - [x] customFields: `CustomFieldDef` model, runtime Zod schema built from active defs
        (`buildCustomFieldsSchema`), admin-only CRUD router gated on a new
        `admin.manage_custom_fields` permission (president-only by default)
  - [x] notify: `Notification` + `NotificationPreference` models, per-type channel defaults
        with per-user override, in-app coalescing within a type's time window (increments an
        existing unread notification's `count` instead of spawning duplicates), email channel
        enqueues to a deliberately handler-less `notify_email` queue (docs/DECISIONS.md #10)
  - [x] approvals: generic `ApprovalWorkflow`/`ApprovalRequest`/`ApprovalAction` engine with
        per-step eligibility as a predicate (role/permission/specific-user, or a real
        `ApprovalRule` + the session-2 fallback resolver via `approvalRuleKey`); "parallel"
        (first eligible decision resolves the step) is the only supported step mode
        (docs/DECISIONS.md #12); reusable `<ApprovalPanel>` + a global "Awaiting my approval"
        inbox at `/approvals`; verified end-to-end against the real seeded
        `cash_advance.approve` rule (VP eligible immediately, President eligible immediately
        too and stamped as a fallback decision)
  - [x] comments: threaded `Comment` model (15-minute author-only edit window measured from
        creation, edit history via `CommentEdit`, soft delete), `@mention` notifications
        (5-minute coalesce window), `<ActivityFeed>` merging comments with audit-log entries
        into one chronological stream — mounted on `/admin/users` in place of the session-3
        `<AuditTrail>` (superset)
  - [x] search: `SearchIndex` model, Postgres full-text (`tsvector`/`plainto_tsquery`) primary
        path with a `pg_trgm` fuzzy fallback for typo tolerance (extension enabled via a
        tracked migration, not a one-off script — confirmed *not* enabled by default on a
        fresh Supabase Postgres), merged with live results from session 1's previously-unused
        `SearchProvider` registry, deduped by `entityType:entityId`; Cmd/Ctrl+K
        `<GlobalSearch>` modal mounted app-wide (only when authenticated)
  - [x] 160 automated tests total (34 files), all passing; `typecheck`, `lint`, and
        `next build` all clean
  - [x] **Manually verified end-to-end in a real browser** (signed in as EA/president):
        Ctrl+K opens the global search modal, a query round-trips through `search.query` (200
        OK, "No results." renders cleanly since no business entities exist to index yet in
        module 00); posted a comment on `/admin/users`' `<ActivityFeed>` and confirmed it
        appears immediately with correct timestamp and Edit/Delete controls
  - [x] Found and fixed one real bug during that manual pass (docs/DECISIONS.md #14):
        `<ActivityFeed>` rendered a comment's raw `authorId` cuid instead of a name — audit
        entries in the same feed already showed a resolved `actorLabel`, so the inconsistency
        was visibly wrong the moment a real comment was posted. Fixed by resolving
        `authorId` → `User.name` in `getActivityFeed()` (live lookup, not a write-time
        snapshot like audit's `actorLabel` — deliberately different, see #14 for why)

- [x] Module 00 session 5 — design system, app shell, DataTable, deployment artifacts:
  - [x] **Brand extraction (Spec.md §6.1) from a real vector master.** The company supplied one
        mid-session, so nothing was hand-traced. `scripts/build-brand-assets.ts` (`npm run brand`)
        generates all four SVGs plus `favicon.ico`/`icon-192`/`icon-512`/`apple-touch-icon`;
        outputs are committed so Vercel builds don't depend on it. The master is an 802-path
        auto-trace and needed three corrections, each for a defect that would otherwise have
        shipped — see docs/DECISIONS.md #15. The gear mark is rebuilt as geometry because the "S"
        overlaps the gear in the artwork, so an extracted gear has a bite out of it.
  - [x] Verified Spec.md §6.2's palette against the vector master: `#011761` vs `navy-900
        #011860`, `#FD5E0F` vs `orange-500 #FD5E13`, `#EC010C` vs `red-500 #EE010C`. The tokens
        were genuinely sampled from this artwork, so they are used verbatim.
  - [x] Tailwind v4 + Inter (self-hosted via next/font, so the strict CSP needs no font-src
        exception). Tokens exposed both as `--color-*` (Tailwind utilities) and the spec's own
        `--aies-*` names (so PDF templates written against Spec.md resolve directly).
  - [x] §6.3's "red problem" enforced structurally, not by comment: `Button` has **no** brand-red
        variant, so a destructive action always renders in `--color-danger`. `StatusBadge` carries
        status colour in a tinted background and dot but takes its text ink from an AA-passing
        token, because §6.2's own contrast table rules orange-500 (3.1:1) out for small labels.
  - [x] `DataTable` built out fully before its first caller, per §8's "over-invest here":
        server-side pagination, sort, filter chips, saved views, column visibility, CSV export
        (RFC 4180 escaping + UTF-8 BOM so Excel renders ₱), bulk actions. Holds state and hands it
        out via `onStateChange` rather than fetching, so it works with tRPC, a server action or a
        plain array.
  - [x] Remaining §8 components: `RecordLayout`, `PageHeader`, `Card`, `EmptyState`,
        `StatusBadge`, `MoneyCell`, `MoneyInput`, `DateCell`, `UserAvatar`, `FileDropzone`
        (posts to the session-4 `/api/files`, uploads sequentially), `ConfirmDialog` (optional
        `confirmPhrase` for irreversible actions), `Menu`.
  - [x] App shell: sidebar assembled from module manifests and filtered by permission
        **server-side**, top bar with search/bell/account menu, mobile drawer, collapsible.
        Foundation gained its own manifest so its pages route through the same mechanism every
        business module will use.
  - [x] Error handling: tRPC `errorFormatter` puts the request id on the wire for every error and
        logs the unexpected ones against it; `app/error.tsx` shows Next's server-side digest as
        the reference, so what the user quotes is the token an admin greps for.
  - [x] PWA: manifest route + service worker caching brand assets and an offline notice —
        deliberately **not** API responses or authenticated HTML (see the note in `public/sw.js`).
  - [x] Deployment artifacts: `docs/DEPLOYMENT.md` (all 13 items of Spec.md §7.5 with exact DSM
        menu paths, the quarterly restore-drill table, and the ~USD 45/month cost stated plainly),
        `docker/docker-compose.yml` + `Dockerfile` + `Caddyfile` self-host fallback with a CI job
        that boots it, `scripts/backup-to-nas.sh` (staged `.partial` dir, manifest, and a
        `pg_restore --list` verification before accepting the dump), `scripts/restore.sh` (refuses
        non-scratch targets, prints a row-count sanity report), `vercel.json` cron.
  - [x] 179 tests across 36 files, all passing; typecheck, lint and `next build` clean.
  - [x] Found and fixed three real bugs by using the app rather than testing it — see the two
        DECISIONS entries below and the hover-menu note.

- [x] **Module 00 review gate (docs/BUILD-PROTOCOL.md §7) — PASSED, tagged
      `module-00-complete`.**
  - [x] `npm test` — 186 tests across 37 files. `npm run lint`, `npm run typecheck`,
        `next build` all clean.
  - [x] Migration applies cleanly (13 migrations + `20260808072831_user_deleted_by`); CI applies
        the whole chain to a fresh Postgres on every push.
  - [x] **Manual check performed by the operator in a browser**, evidenced in the audit log
        rather than asserted: `login=2` ("EA signed in"), `create=1` ("Created user
        Demo@aies.local with role Technician"), `role_assigned=9`. That is exactly the protocol's
        "log in, create a user, assign a role, confirm the audit log caught all three".
  - [x] Six defects found by that pass, all fixed — see the session 5 feedback list below.
  - [ ] **Deferred, with reason:** the gate's "a non-privileged role cannot see cost fields in the
        serialised response" cannot be executed in module 00, because no cost or margin field
        exists until module 02. `tests/server/core/rbac/field-gating.test.ts` covers the stripping
        logic and `permission-matrix.test.ts` asserts only president/vice_president hold
        `finance.view_cost`. **The serialised-response check is owed by module 02's gate.**

### Defects found by the module 00 manual pass (all fixed in session 5)
1. **Every input was invisible.** Tailwind v4's preflight resets input/select borders and
   backgrounds, and login, change-password, enroll-totp and admin/users were still on bare HTML
   from sessions 2–3. Adding Tailwind made their fields disappear. All four rebuilt on the design
   system.
2. **Add-role gave no feedback.** `assignRole`/`removeRole` had no `onError`, so a rejection was
   indistinguishable from success. The audit log records the cost: the same assignment twice,
   three seconds apart.
3. **A stale `.next` cache silently killed the app's JavaScript** — pages returned 200, buttons
   did nothing. Twice. docs/DECISIONS.md #17.
4. **A pooler timeout signed every user out.** docs/DECISIONS.md #16.
5. **~550ms of latency on every request** from the session callback's three queries. Now one.
6. **The permission-matrix test read a role's permissions through a user who held it** — unsound
   given §4.2's multiple roles, and it produced a false alarm on `finance.view_cost` the moment an
   admin assigned `viewer` to the vice-president. Now reads the role's own grants.

## In progress — Module 01, CRM and Inquiry Intake

Planned as **3 sessions** (BUILD-PROTOCOL §6 splits only 00 and 04 explicitly, but this module
carries 8 models, a status machine with SLA escalation, requirements templates, accreditation, a
principal pipeline, kanban/My Day/Account 360, and a merge tool):

- **Session 1 — manifest, permissions, core data model.** Manifest + permission wiring (done
  below), then `Account` / `Site` / `Contact` + migration, `ACC-` codes on create, account CRUD,
  fuzzy duplicate detection on create (§7), and the Account 360 shell (§6).
- **Session 2 — inquiry.** `Inquiry` / `InquiryItem` / `Activity`, the §3 lifecycle state machine,
  §4 requirements templates and the completeness gate, the §3 SLA escalation job, and the §5
  inspection request.
- **Session 3 — the rest.** §5b accreditation, §5c principal prospects, §6 kanban / My Day /
  follow-up engine, and the §7 merge tool.

### Done in session 1
- [x] `src/server/core/modules/crm.manifest.ts` — all 12 permissions from §9 and all 9 emitted
      events from §8, registered in `manifests.ts`.
- [x] **Closed a real gap in the module 00 foundation:** `prisma/seed.ts` never read
      `registry.permissions`. specs/00-foundation.md §3 promises modules own their permissions and
      the app assembles them, but nothing consumed that — module 00's own manifest declares none,
      so it was never exercised. A business module could declare `crm.view`, pass boot-time
      collision validation, and still never reach the database, leaving every procedure gated on
      it permanently 403 with nothing visibly wrong. The seed now unions foundation permissions
      with manifest ones: **20 seeded (8 foundation + 12 CRM)**, verified against the database.
- [x] `account` numbering format `ACC-{####}` (§2). No year segment, unlike every other document
      type — an account code identifies a customer relationship permanently, so its counter must
      never reset.
- [x] Sidebar icons for the four CRM nav entries.
- [x] 9 tests covering the manifest↔seed join, §9's role assignments, and that `crm.view_all` is
      kept off the default sales grant so §10's record-scoping test can mean something.
- [x] `prisma/schema/crm.prisma` — §2's `CustomerAccount`, `Site`, `Contact`, migration
      `20260808101705_crm_accounts_sites_contacts`. **The model is `CustomerAccount`, not
      `Account`** — see docs/DECISIONS.md #18; field names stay `accountId` / `account` so the
      spec's vocabulary survives where it is actually read.
- [x] `src/server/core/crm/duplicates.ts` — §7 fuzzy duplicate detection on all three signals
      (TIN exact, `pg_trgm` name similarity ≥ 0.4, contact-email domain), in one query so the
      caller can be told *which* signal matched. Free mailbox domains (gmail, yahoo…) are excluded,
      or every account with a gmail contact would match every other. It warns, never blocks:
      several unrelated "… Water District" entities genuinely exist. 10 tests against the real DB.
- [x] `src/server/core/crm/account-service.ts` — create/update/soft-delete with `ACC-` codes,
      audit rows carrying a changed-fields-only diff, and the §8 `account.created` event emitted
      transactionally.

### Next concrete step
Expose the account service over tRPC and build the list UI:
1. `src/server/api/routers/crm.ts` with `p("crm.view")` / `p("crm.create")` / `p("crm.edit")` /
   `p("crm.delete")` procedures wrapping the service, plus a `checkDuplicates` query the create
   form calls before submitting. Register it in `src/server/api/root.ts`.
2. `/crm/accounts` using the session-5 `DataTable` (its API is complete — server-side pagination,
   sort, filter chips, CSV export — pass `rows`/`total` and handle `onStateChange`).
3. Record scoping (§10): a user without `crm.view_all` must see only accounts they own. Implement
   as a `where` fragment in the service, following `src/server/core/rbac/scope.ts`.

Then session 2 (inquiry) as planned above.

Notes for whoever picks this up:
  - `allocateNumber` takes **no** transaction client, so an account code is allocated before the
    transaction opens and a rollback burns it. Module 00's numbering contract explicitly permits
    gaps; fine for an internal account code, but revisit before anything the BIR counts.
  - Soft delete needs **both** `deletedAt` and `deletedBy` (module 00 shipped `User` missing
    `deletedBy`; the CRM models already do this correctly).
  - If `prisma migrate dev` hangs on an advisory lock, or `prisma generate` fails with `EPERM`,
    the dev server is holding it — stop the dev server first. See "Known issues" below.

## Not started
- [ ] Modules 02–10

## Decisions made this module
- docs/DECISIONS.md #1-#3: session 1 (local DB deferred → real Supabase dev project instead;
  `prisma.config.ts` over `package.json#prisma`; no migration when no models exist yet).
- docs/DECISIONS.md #4-#7: session 2 (Auth.js `jwt` strategy; `middleware.ts` in `src/` + Node.js
  runtime; CSP nonce needs `headers()` in root layout, forcing dynamic rendering; Vitest
  `fileParallelism: false` for Supabase pooler connection limits).
- docs/DECISIONS.md #8-#9: session 3 (`totpCode` must be `""` not `undefined` in `signIn()` calls;
  `Strict-Transport-Security` only sent in production, never over local HTTP).
- docs/DECISIONS.md #10-#14: session 4 (`notify`'s email channel intentionally has no consumer
  yet; only the Supabase storage driver is implemented, no local filesystem driver; approval step
  `mode` only supports "parallel"; approval engine emits only the three spec-named events;
  `ActivityFeed` resolves comment `authorId` to a live `authorLabel`, unlike audit's write-time
  snapshot).
- docs/DECISIONS.md #15-#17: session 5 (brand assets generated from the vector master by a
  committed script, with the mark rebuilt as geometry and a second supplied raster rejected as a
  redrawn interpretation; a database error in the Auth.js session callback now degrades access
  instead of signing the user out; never run `npm run build` against a live dev server — it
  silently kills the running app's JavaScript while every page still returns 200).

## Known issues / to revisit
- No per-device "revoke this session" / session list UI yet (docs/DECISIONS.md #4).
- The optional Google Workspace OIDC provider is not wired up (adapter is ready for it).
- Office IP allow-list (Spec.md §7.4) needs the `SystemSetting` mechanism (§10), not built yet.
- Audit-log alerting to the president on login lockouts has a `TODO` in
  `src/server/core/auth/login-throttle.ts` — now unblocked (the audit log exists as of this
  session) but not yet wired up; revisit in a future session.
- `audit.listForEntity` is gated on `admin.manage_users` for every entity type, since `User` is
  the only one with an audit trail so far (`src/server/api/routers/audit.ts` has the note) —
  generalize to a per-entityType permission registry once a second entity type needs one.
- `next build` prints a harmless "Invalid next.config.ts options... nodeMiddleware" warning every
  time (docs/DECISIONS.md #5) — cosmetic, the flag works.
- The Node.js/npm PATH issue from session 1 (explicit `C:\Program Files\nodejs` prepend needed in
  Bash) is still observed; hasn't blocked anything.
- Vercel Cron isn't actually configured yet (no real Vercel project exists) — `POST /api/cron/
  drain` is built and tested but has never been invoked by a real cron scheduler. That's a
  session 5 deployment-artifacts concern.
- `notify_email` queue has no registered handler by design (docs/DECISIONS.md #10) — it will
  dead-letter every enqueued job until a real email provider is wired up (later module/session).
- No local filesystem storage driver (docs/DECISIONS.md #11) — `StorageDriver` is an interface,
  only the Supabase implementation exists.
- Approval workflows only support `mode: "parallel"` steps (docs/DECISIONS.md #12) — saving a
  `"sequential"` step throws at workflow-save time rather than being silently mistreated.
- `GlobalSearch`/`SearchIndex` has nothing to find yet — no session-4-or-earlier entity type
  calls `indexEntity()` on create/update, since module 00 has no business entities of its own.
  Verified the plumbing (search request round-trips, renders "No results." cleanly) but real
  end-to-end fuzzy/full-text search UX is unverified until module 01+ starts indexing records.
- The full-colour `public/brand/aies-logo.svg` is 364kB (130kB gzipped) because the supplied
  master is a posterised trace needing 800 paths. Acceptable only because it is off the hot path
  — the shell uses the 12.5kB mono variant and the 0.6kB mark. If artwork with real gradient fills
  is ever supplied, replace `brand/aies-logo-source.svg` and re-run `npm run brand`.
- `docker/docker-compose.yml` and its Dockerfile have never been executed (no Docker on the build
  machine). The new `self-host-fallback` CI job is their first run.
- No `/api/cron/nightly` route yet — Spec.md §7 calls for one, but nothing needs it until module
  10's media-archive lifecycle job. `docs/DEPLOYMENT.md` §2 records where to add it.
- The notification bell polls every 60s. Fine for five users; Supabase Realtime is the upgrade
  path when it stops being.
- Email is still unconfigured (SPF/DKIM/DMARC documented in `docs/DEPLOYMENT.md` §4 but not set
  up), so `notify_email` jobs continue to dead-letter by design.
- **`prisma migrate dev` can hang on `pg_advisory_lock`.** Supabase's pooler keeps a session alive
  after a migrate command ends, and if that command was interrupted the lock is never released —
  one was found held by an idle connection for 3.2 hours, silently blocking every later migration.
  To clear it, terminate the *idle* session holding a granted advisory lock:
  `SELECT pg_terminate_backend(l.pid) FROM pg_locks l JOIN pg_stat_activity a ON a.pid = l.pid
  WHERE l.locktype = 'advisory' AND l.granted AND a.state = 'idle';`
  Stopping the dev server first also helps, since it holds pooler connections.
- Module 01 §8 lists `quotation.sent` / `quotation.accepted` / `quotation.rejected` as consumed by
  CRM, but they are **not** declared in the CRM manifest yet: `buildModuleRegistry` rejects a
  subscription to an event no module emits, so declaring them before module 02 exists would fail
  boot. `tests/server/core/modules/crm-manifest.test.ts` pins this so it resurfaces then.
