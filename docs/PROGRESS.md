# Build Progress

Last updated: 2026-08-08
Current module: 00 — Foundation (session 1 of 5 complete)
Status: in progress

## Done
- [x] Spec pack organized into repo layout (Spec.md, docs/, specs/, brand/)
- [x] Git repo initialized, `main` branch
- [x] Module 00 session 1 — bootstrap, Prisma, CI, module manifest system:
  - [x] Next.js 15 App Router, TypeScript `strict: true`, ESLint flat config + Prettier + Husky
        pre-commit (lint-staged)
  - [x] Prisma split schema (`prisma/schema/`, config via `prisma.config.ts`) — datasource/
        generator only, zero models yet (see docs/DECISIONS.md #3)
  - [x] `src/lib/db.ts` Prisma client singleton
  - [x] `docker/docker-compose.dev.yml` for local Postgres (not yet run — see docs/DECISIONS.md #1)
  - [x] Module manifest system: `src/server/core/module-registry.ts` (`ModuleManifest`,
        `defineManifest`, `buildModuleRegistry` — permission/event collision validation, nav tree
        assembly, disabled-module handling) + `src/server/core/manifests.ts` boot aggregator
  - [x] Vitest set up, 7 unit tests on the module registry, all passing
  - [x] Playwright set up, one e2e smoke test (home page + `/api/health`), passing
  - [x] `.github/workflows/ci.yml` — lint/typecheck/test/build + Postgres service container +
        `prisma migrate deploy` + drift check on PR; migrate-deploy-to-production job scaffolded
        but inert until Supabase secrets exist
  - [x] `.env.example`, `docs/DECISIONS.md` started

- [x] Repo pushed to GitHub: https://github.com/drox06/aies-system (remote `origin`, branch `main`
      tracking `origin/main`)
- [x] Supabase project `aies-platform-dev` (ap-southeast-1) created — real Postgres, not local
      Docker (see docs/DECISIONS.md #1 addendum). `.env` has working `DATABASE_URL` (transaction
      pooler, 6543) and `DIRECT_URL` (session pooler, 5432) — `prisma migrate deploy` connects
      successfully.

## In progress
- [ ] Module 00 session 2: Auth + TOTP + RBAC + seeded roles + approval fallback
      Next concrete step: add `prisma/schema/auth.prisma` with `User`, `Role`, `Permission`,
      `UserRole`, `RolePermission`, `UserPermissionOverride` (specs/00-foundation.md §4.2), then
      run the first real `prisma migrate dev --name init` against the now-working Supabase dev
      database, then wire Auth.js v5 with credentials (argon2id) + mandatory TOTP per §4.1.

## Not started
- [ ] Module 00 session 3: Audit log, event outbox, job queue, numbering
- [ ] Module 00 session 4: Storage, notify, approvals, customFields, comments, search
- [ ] Module 00 session 5: Design system (brand extraction first), app shell, DataTable,
      deployment artifacts (docs/DEPLOYMENT.md, docker-compose self-host fallback)
- [ ] Modules 01–10

## Decisions made this module
- See docs/DECISIONS.md entries #1–#3 (local DB deferred, prisma.config.ts over
  package.json#prisma, no migration yet since no models exist) and the addendum to #1 (used a
  real Supabase dev project instead of Docker).

## Known issues / to revisit
- Node.js was not installed on the build machine; installed Node 24 LTS via winget during this
  session. Docker was never installed — a real Supabase project is standing in for local Postgres
  instead (docs/DECISIONS.md #1 addendum).
- The harness's shell processes inherit a stale PATH from before the Node install, so `node`/
  `npm`/`npx` must be invoked with an explicit PATH prepend (`C:\Program Files\nodejs`) in Bash,
  or `$env:Path` refreshed in PowerShell, until this is no longer observed (e.g. after a reboot).
- `.github/workflows/ci.yml` has run at least once (push to `main` after the initial commits) but
  its result hasn't been checked yet — no `gh` CLI available locally to query it; check the
  Actions tab at https://github.com/drox06/aies-system/actions.
- `DATABASE_URL`/`DIRECT_URL` in `.env` point at a shared Supabase project, not a disposable local
  DB — running `prisma migrate reset` or similar destructive commands against it during session 2
  development should be done deliberately, not as a routine "start over" reflex.
