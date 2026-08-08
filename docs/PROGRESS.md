# Build Progress

Last updated: 2026-08-08
Current module: 00 — Foundation (session 2 of 5 complete)
Status: in progress

## Done
- [x] Spec pack organized into repo layout (Spec.md, docs/, specs/, brand/)
- [x] Git repo initialized, `main` branch, pushed to https://github.com/drox06/aies-system
- [x] Supabase dev project (`aies-platform-dev`, ap-southeast-1) — real Postgres, working
      `DATABASE_URL`/`DIRECT_URL` in `.env` (gitignored)
- [x] Module 00 session 1 — bootstrap, Prisma, CI, module manifest system (see git history for
      full detail; unchanged since last update)
- [x] Module 00 session 2 — Auth + TOTP + RBAC + seeded roles + approval fallback:
  - [x] `prisma/schema/auth.prisma`: `User`, `Role`, `Permission`, `UserRole`, `RolePermission`,
        `UserPermissionOverride`, `Account`, `Session`, `VerificationToken`, `ApprovalRule` — first
        real migration (`20260808001921_init_auth_rbac`) applied to the Supabase dev DB
  - [x] `prisma/schema/core.prisma`: `RateLimitBucket` (migration
        `20260808003447_rate_limit_bucket`)
  - [x] RBAC core: `src/server/core/rbac/permissions.ts` (role-union + override resolution),
        `field-gating.ts` (cost/margin stripping mechanism), `scope.ts` (per-module scope
        registry) — all unit tested
  - [x] `src/server/core/rbac/approval-fallback.ts`: the automatic fallback resolver (Spec.md
        §4.4) — inbox visibility gated by window, president always eligible to decide, fallback
        stamping keyed on who decided not on timing. Fully unit tested against the exact
        scenarios in the spec.
  - [x] `prisma/seed.ts`: 9 roles, 7 core permissions, 5 named users (EA/KJ/PD/DJ/EM per
        docs/DECISIONS-CONFIRMED.md), 4 demo users (one per unassigned role), 4 default
        `ApprovalRule` rows. Idempotent (upserts) — verified by running twice and checking exact
        row counts.
  - [x] Auth.js v5: credentials provider (argon2id via `@node-rs/argon2`), forced TOTP
        (`otpauth` + `qrcode`), login throttling (5 fail → 15 min lock), password policy
        (`@zxcvbn-ts`, 12 char + score ≥ 3), CSP/HSTS/security-header middleware. Session
        strategy is `jwt`, not `database` — see docs/DECISIONS.md #4 for why and what it costs.
  - [x] tRPC bootstrap: context, `protectedProcedure`/`p(permission)` per the spec's own naming,
        Postgres-backed atomic rate limiter on all mutations (30/min/user, tested for real races)
  - [x] `auth` router (TOTP enrollment/confirm, change password) and `admin` router (list/create
        users, assign/remove roles) — both permission-gated
  - [x] Minimal UI: `/login` (two-step, TOTP field appears on demand), `/enroll-totp` (QR +
        manual key), `/change-password`, `/`, `/admin/users` — no design system yet (session 5)
  - [x] Permission-matrix integration test against the real seeded DB (specs/00-foundation.md
        §11's explicit requirement), e2e smoke test, 44 automated tests total, all passing
  - [x] **Manually verified end-to-end in a real browser**: unauthenticated → redirected to
        `/login`; login → forced TOTP enrollment → forced password change → dashboard; president
        created a new user and assigned a role; that new user, logged in as `technician`, has the
        admin link hidden AND gets a real 403 calling `admin.listUsers` directly — confirming
        server-side enforcement, not just UI hiding
  - [x] Found and fixed three real bugs only a live run surfaced (all in docs/DECISIONS.md
        #4-#6): Auth.js rejects database sessions with a Credentials provider; `middleware.ts`
        must live in `src/` or it's silently never invoked; CSP nonces don't reach Next's own
        scripts without `headers()` in the root layout, which silently broke the production build
        (hydration completely blocked) while dev mode looked fine

## In progress
- [ ] Module 00 session 3: Audit log, event outbox, job queue, numbering
      Next concrete step: `prisma/schema/audit.prisma` with `AuditLog` (specs/00-foundation.md
      §5) — written inside the same transaction as the change it records. Wire it into the
      `admin` router's `createUser`/`assignRole`/`removeRole` mutations first (the module 00
      "done" manual check is explicitly: create a user, assign a role, confirm the audit log
      caught both). Then `EventOutbox` + the Postgres-backed job queue (Spec.md §3.3) and
      `numbering` (§5).

## Not started
- [ ] Module 00 session 4: Storage, notify, approvals, customFields, comments, search
- [ ] Module 00 session 5: Design system (brand extraction first), app shell, DataTable,
      deployment artifacts (docs/DEPLOYMENT.md, docker-compose self-host fallback)
- [ ] Modules 01–10

## Decisions made this module
- docs/DECISIONS.md #1-#3: session 1 (local DB deferred → real Supabase dev project instead;
  `prisma.config.ts` over `package.json#prisma`; no migration when no models exist yet).
- docs/DECISIONS.md #4: Auth.js session strategy is `jwt` (Credentials provider forbids
  `database`), with per-request DB-backed permission refresh to stay functionally equivalent.
  Cost: no per-device session revocation yet.
- docs/DECISIONS.md #5: `middleware.ts` lives in `src/`; Next.js 15.5 Node.js middleware runtime
  needs `experimental.nodeMiddleware` (undocumented in this version's types, hence a cast).
- docs/DECISIONS.md #6: CSP nonce propagation requires `headers()` in the root layout, which
  forces every route to dynamic rendering. Acceptable trade for a 5-person internal app.
- docs/DECISIONS.md #7: Vitest `fileParallelism: false` — Supabase free-tier pooler connection
  limit was being exhausted by parallel test-file workers, causing real intermittent failures.

## Known issues / to revisit
- No per-device "revoke this session" / session list UI yet (docs/DECISIONS.md #4). The plan
  (`sessionVersion` counter, checked per-request) is written down but not built — revisit when
  that UI feature is actually prioritized.
- The optional Google Workspace OIDC provider (specs/00-foundation.md §4.1) is not wired up —
  `PrismaAdapter` is configured and ready for it, but only the Credentials provider exists today.
- Office IP allow-list for finance/admin areas (Spec.md §7.4) is not built — needs the
  `SystemSetting` mechanism (§10), which isn't scheduled until later in module 00.
- Audit-log alerting to the president on login lockouts (specs/00-foundation.md §4.1) has a
  `TODO` in `src/server/core/auth/login-throttle.ts` — blocked on session 3's audit log existing.
- `next build` prints a harmless "Invalid next.config.ts options... nodeMiddleware" warning every
  time (docs/DECISIONS.md #5) — cosmetic, the flag works, but worth knowing it's not a real error.
- The Node.js/npm PATH issue from session 1 (explicit `C:\Program Files\nodejs` prepend needed in
  Bash) is still observed; hasn't blocked anything, just a standing note for future sessions.
