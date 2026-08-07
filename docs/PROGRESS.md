# Build Progress

Last updated: 2026-08-08
Current module: 00 — Foundation (session 1 of 5)
Status: in progress

## Done
- [x] Spec pack organized into repo layout (Spec.md, docs/, specs/, brand/)
- [x] Git repo initialized

## In progress
- [ ] Module 00 session 1: bootstrap, Prisma, CI, module manifest system
      Next concrete step: scaffold package.json, tsconfig, ESLint/Prettier, Husky (Next.js 15 App
      Router, TypeScript strict) per specs/00-foundation.md §2.

## Not started
- [ ] Module 00 session 2: Auth + TOTP + RBAC + seeded roles + approval fallback
- [ ] Module 00 session 3: Audit log, event outbox, job queue, numbering
- [ ] Module 00 session 4: Storage, notify, approvals, customFields, comments, search
- [ ] Module 00 session 5: Design system (brand extraction first), app shell, DataTable,
      deployment artifacts
- [ ] Modules 01–10

## Decisions made this module
- (none yet — see docs/DECISIONS.md once created)

## Known issues / to revisit
- Node.js was not installed on the build machine; installed Node LTS via winget during this
  session. The harness's shell processes inherit a stale PATH from before the install, so `node`/
  `npm` must be invoked with an explicit PATH prepend (`C:\Program Files\nodejs`) in every shell
  command until the machine-level PATH propagates to new processes naturally (e.g. after reboot).
