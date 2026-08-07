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
