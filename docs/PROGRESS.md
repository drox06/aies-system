# Build Progress

Last updated: 2026-08-08
Current module: 00 — Foundation (session 3 of 5 complete)
Status: in progress

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

## In progress
- [ ] Module 00 session 4: Storage, notify, approvals, customFields, comments, search
      Next concrete step: `src/server/core/storage/` — Supabase Storage client wrapper with the
      `{entityType}/{yyyy}/{mm}/{entityId}/{uuid}-{sanitized-filename}` path scheme
      (specs/00-foundation.md §7.2), a `FileObject` Prisma model (size/mime/sha256/uploader/
      entity link, dedup by sha256 within an entity), and `/api/files/[id]` that checks
      permission server-side before issuing a short-lived signed URL. Needs a real Supabase
      Storage bucket created in the `aies-platform-dev` project first — the Supabase project
      itself already exists (docs/DECISIONS.md #1 addendum) but no storage bucket has been
      created in it yet.

## Not started
- [ ] Module 00 session 5: Design system (brand extraction first), app shell, DataTable,
      deployment artifacts (docs/DEPLOYMENT.md, docker-compose self-host fallback)
- [ ] Modules 01–10

## Decisions made this module
- docs/DECISIONS.md #1-#3: session 1 (local DB deferred → real Supabase dev project instead;
  `prisma.config.ts` over `package.json#prisma`; no migration when no models exist yet).
- docs/DECISIONS.md #4-#7: session 2 (Auth.js `jwt` strategy; `middleware.ts` in `src/` + Node.js
  runtime; CSP nonce needs `headers()` in root layout, forcing dynamic rendering; Vitest
  `fileParallelism: false` for Supabase pooler connection limits).
- docs/DECISIONS.md #8-#9: session 3 (`totpCode` must be `""` not `undefined` in `signIn()` calls;
  `Strict-Transport-Security` only sent in production, never over local HTTP).

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
