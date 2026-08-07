# Module 00 — Foundation

**Depends on:** nothing. **Blocks:** everything.
**Definition of done:** the app deploys to the DS220+ over HTTPS, a seeded admin can log in,
create a user, assign roles, and every action they took appears in the audit log.

---

## 1. Scope

This module builds no business features. It builds the skeleton every business module plugs
into. Resist the urge to start on CRM. If the foundation is weak, modules 01–10 will each
reinvent auth, audit, and file handling differently, and the ISO 9001 evidence trail will be
unreliable.

---

## 2. Project bootstrap

- Next.js 15 App Router, TypeScript `strict: true`, ESLint + Prettier, Husky pre-commit.
- Prisma with a split schema (`prisma/schema/*.prisma`, `prismaSchemaFolder` preview feature).
- Vitest + Playwright; GitHub Actions running lint, typecheck, tests, and `prisma migrate diff`
  on every PR.
- `docker/docker-compose.dev.yml` for local Postgres (no Redis — see Spec.md §3.3).
- `docker/docker-compose.yml` kept working as a **future self-host target**, not the deployment
  path. Spec.md §3.1 explains why the NAS was ruled out.
- Vercel project with preview deploys per PR; Supabase project for Postgres and Storage.
- `npm run bootstrap` = migrate deploy + seed + interactive first-admin creation.

---

## 3. Module manifest system

This is the mechanism that makes modules interconnectable. Build it now.

```ts
// src/server/core/module-registry.ts
export interface ModuleManifest {
  key: string;                    // "quotation"
  name: string;                   // "Quotations"
  version: string;
  models: string[];               // Prisma models owned
  permissions: PermissionDef[];   // { key, label, group, defaultRoles }
  emits: string[];                // domain events published
  consumes: EventSubscription[];  // { event, handler }
  nav?: NavEntry[];               // { label, href, icon, permission, order }
  settings?: SettingsSchema;      // zod schema for module settings
  searchProviders?: SearchProvider[];
}
```

The app boots by importing all manifests, validating there are no permission-key or event-name
collisions, assembling the navigation tree, and registering event subscriptions. A module can
be disabled in settings and its nav, permissions, and subscriptions disappear cleanly.

---

## 4. Identity and access

### 4.1 Auth

**This application is reachable from the open internet** (decision 26) and five accounts between
them can do everything the company does. Security is not a later phase.

- Auth.js v5. Providers: credentials (argon2id hashes) and optional Google Workspace OIDC
  restricted to the `aieselectromech.com` domain. Auth.js rather than Supabase Auth, so the
  stack stays portable if AIES ever self-hosts.
- Sessions: database-backed, 12-hour idle timeout, 30-day absolute.
- **TOTP 2FA is mandatory for every user.** No opt-out, no admin-only carve-out. Enrolment is
  forced on first login and the account is unusable until it completes.
- Rate limiting on all mutation endpoints and on file downloads.
- Strict CSP, HSTS, `X-Frame-Options: DENY`, secure `SameSite=Lax` cookies.
- Optional office IP allow-list on finance and admin areas — configurable, off by default.
- Audit-log alerting to the president on: permission changes, user creation, first-time cost-field
  access by a role, and any override of a blocking gate.
- Password policy: 12 char minimum, breach-list check via zxcvbn score ≥ 3, no forced rotation.
- Login throttling: 5 failures → 15-minute lockout, logged and notified to admins.
- Full session list per user with device/IP and a "revoke all sessions" action.

### 4.2 RBAC

```prisma
model User        { id, email, name, phone, jobTitle, isActive, mustChangePassword, ... }
model Role        { id, key, name, isSystem }
model Permission  { id, key, label, group }
model UserRole    { userId, roleId }
model RolePermission { roleId, permissionId }
model UserPermissionOverride { userId, permissionId, granted }  // grant or revoke individually
```

- Users hold **multiple roles** — at AIES one person is often sales and operations.
- Permission resolution: union of role permissions, then apply per-user overrides.
- Server enforcement helper:
  ```ts
  const protectedProcedure = t.procedure.use(requireAuth);
  const p = (perm: string) => protectedProcedure.use(requirePermission(perm));
  // usage: p("quotation.approve").input(...).mutation(...)
  ```
- Record-level scoping via a `scope` helper each module implements:
  `scopeFor(user, "account")` returns a Prisma `where` fragment. Default for `sales` without
  `crm.view_all`: `{ OR: [{ ownerId: user.id }, { teamMembers: { some: { userId: user.id } } }] }`.
- **Field-level gating:** cost and margin fields are stripped in the service layer, not the UI,
  when the user lacks `finance.view_cost`.

### 4.3 Seeded roles

Seed the roles from Spec.md §4: five active (`president`, `vice_president`, `admin_manager`,
`operations_manager`, `marketing_manager`) and four unassigned for future hires (`technician`,
`sales`, `finance_officer`, `viewer`).

- **`finance.view_cost` and `project.view_pl` are granted to `president` and `vice_president`
  only.** Cost and margin are stripped in the service layer for everyone else — verify by
  inspecting the serialised API response, not the rendered page.
- **`quotation.approve`, `cash_advance.approve`, and `cash_advance.approve_extension` are held by
  `vice_president` and `president` only.**
- Build the **automatic approval fallback** in this module (Spec.md §4.4), since modules 02, 03,
  04 and 05 all depend on it: `president` becomes an eligible approver for anything the
  `vice_president` has not acted on within a configurable window, without any nomination step.
  Both may act after the window; first decision wins; the VP's queue does not clear. Every
  fallback approval is stamped as a fallback with the elapsed time — the audit trail must never
  present it as though the VP decided.
- Seed one demo user per role for testing, clearly marked and excluded from production seeds.

---

## 5. Audit log

```prisma
model AuditLog {
  id          String
  at          DateTime  @default(now())
  actorId     String?          // null for system/job actors
  actorLabel  String           // denormalised, survives user deletion
  action      String           // "create" | "update" | "delete" | "approve" | "login" | custom
  entityType  String
  entityId    String
  summary     String           // human sentence: "Approved QTN-2608-0042R2"
  diff        Json?            // { field: { from, to } } — omit unchanged fields
  ip          String?
  userAgent   String?
  requestId   String?
  @@index([entityType, entityId, at])
  @@index([actorId, at])
}
```

- Written inside the same transaction as the change. If the audit write fails, the change rolls
  back. This is non-negotiable for ISO evidence.
- Append-only: no update or delete API exists, at any permission level.
- A reusable `<AuditTrail entityType entityId />` component renders the history on every record.
- Sensitive values (password hashes, tokens) are never written to `diff`. Maintain a redaction
  list.

---

## 6. Domain event bus

```ts
emit("sales_order.created", { salesOrderId, accountId, total }, { actorId, requestId });
```

- Events are persisted to an `EventOutbox` table in the same transaction as the business change
  (transactional outbox pattern), then relayed into the job queue (Spec.md §3.3) by the cron
  drain. This guarantees an event is never lost or double-emitted on a crash or a mid-flight
  function timeout.
- Handlers are idempotent and receive `{ payload, event, attempt }`. Failures retry with
  exponential backoff, then land in a dead-letter queue visible in the admin UI.
- Event names are `snake_case`, `entity.verb_past_tense`. Registered in manifests; collisions
  are a boot error.

---

## 7. Core services

### 7.1 `numbering`
Implements Spec.md §5. Sequence rows locked with `SELECT ... FOR UPDATE`. Formats configurable
in settings. Preview endpoint so the UI can show the next number before save.

### 7.2 `storage`
- **Supabase Storage** buckets, private by default. Local development uses the Supabase CLI's
  local stack or a filesystem driver behind the same interface — keep the driver swappable so a
  future self-host does not touch call sites.
- Path scheme: `{entityType}/{yyyy}/{mm}/{entityId}/{uuid}-{sanitized-filename}`.
  Never trust or reuse the client filename as a path component.
- Every stored file gets a `FileObject` row: size, mime, sha256, uploader, entity link.
- Deduplication by sha256 within an entity.
- Downloads always go through `/api/files/[id]`, which checks permission server-side and then
  issues a **short-lived signed URL**. Never a public bucket, never a guessable path.
- Upload limits: 50 MB default, 200 MB for `operations` (site video). Reject executables.
- Provide a `scanHook` interface (no-op by default) so a scanner can be wired in later without
  touching call sites.
- A nightly job syncs the bucket to the NAS backup share (module 10 §6), one direction only.
- Image uploads generate a web-sized derivative with `sharp` — field photos from phones are
  often 8 MB and must not be served raw over a plant's LTE connection.

### 7.3 `notify`
- Channels: in-app (Supabase Realtime + bell), email, daily digest. **No SMS** (decision 30).
- Per-user, per-event-type preferences with sensible defaults.
- Notification types registered by modules; a generic preferences screen renders from the
  registry.
- **Rate limit and coalesce.** Ten comments on one quote in five minutes is one notification.

### 7.4 `approvals`
Generic, attachable to any entity:
```prisma
model ApprovalWorkflow { id, entityType, name, isActive, steps Json }
model ApprovalRequest  { id, entityType, entityId, workflowId, status, currentStep, requestedById, ... }
model ApprovalAction   { id, requestId, step, approverId, decision, comment, at }
```
- Step definition supports: required role, required permission, specific user, threshold
  condition (e.g. `total > 500000` or `marginPct < 15`), and parallel-or-sequential mode.
- Emits `approval.requested`, `approval.approved`, `approval.rejected`.
- Reusable `<ApprovalPanel />` and a global "Awaiting my approval" inbox.

### 7.5 `customFields`
Because every AIES customer has different requirements and rigid schemas will not survive.
```prisma
model CustomFieldDef { id, entityType, key, label, type, options Json?, required, order, isActive }
```
- Types: text, textarea, number, currency, date, select, multiselect, boolean, user, file.
- Values stored in a `customFields Json` column on the host entity (JSONB, GIN-indexed).
- Zod schema built at runtime from definitions; validated server-side.
- Renderable in list views as columns and usable in filters.

### 7.6 `comments`
```prisma
model Comment { id, entityType, entityId, authorId, body, parentId?, mentions String[], attachments, editedAt?, deletedAt? }
```
- Markdown body, @mention autocomplete over users, file attachments via `storage`.
- @mention triggers a notification. Editing is allowed for 15 minutes, then locked; edits keep
  history.
- `<ActivityFeed />` component merges comments + audit entries + status changes into one
  chronological stream. **This component is the heart of the "replace external chat apps"
  requirement — invest in it.**

### 7.7 `search`
- Global search bar (Cmd/Ctrl+K). Modules register `SearchProvider`s.
- Postgres full-text over a materialised `SearchIndex` table, refreshed by event subscription.
- `pg_trgm` fuzzy fallback for part numbers and customer names with typos.

---

## 8. Application shell and design system

- Implement the brand extraction procedure in **Spec.md §6.1 before writing components.**
- Build the shared component library on shadcn/ui: `DataTable` (server-side pagination, sort,
  filter chips, saved views, column visibility, CSV export, bulk actions), `RecordLayout`
  (two-column with activity feed), `StatusBadge`, `MoneyInput`, `MoneyCell`, `DateCell`,
  `UserAvatar`, `FileDropzone`, `ApprovalPanel`, `ActivityFeed`, `AuditTrail`, `EmptyState`,
  `ConfirmDialog`, `PageHeader`.
- `DataTable` is used by every module. Over-invest here; it will be built 30 times otherwise.
- App shell: collapsible sidebar assembled from module manifests, top bar with global search,
  a "+ Create" menu, notification bell, and user menu.
- **PWA:** manifest, service worker, installable. Offline shell caching now; module 04 adds
  offline data sync.
- Error handling: typed tRPC errors → toast; unexpected errors → error boundary with a request
  ID the user can quote to an admin. Log server errors with the request ID.

---

## 9. Deployment artifacts

Write these in this module. See Spec.md §7 for the topology and the reasoning.

### 9.1 Vercel + Supabase
- Vercel project linked to the GitHub repo, production on `main`, preview per PR.
- Environment variables documented in `.env.example`; `.env` never committed.
- Vercel Cron entries: `/api/cron/drain` every minute, `/api/cron/nightly` once daily.
- Supabase: connection pooling configured for serverless (use the pooled connection string for
  the app, the direct string for migrations), storage buckets and policies, `pg_cron` enabled,
  **point-in-time recovery on** — do not run the company on the free tier.
- GitHub Actions: lint, typecheck, test, and `prisma migrate deploy` on merge to `main`.
  Migrations never run by hand against production.

### 9.2 `docker/docker-compose.yml` — self-host fallback
Kept working but not the deployment path. Services: `app`, `postgres:16-alpine`, `caddy`. This is
what AIES uses if the NAS is later upgraded to 6 GB or they move to a VPS. A test in CI must
prove it still boots, or it will rot within two months.

### 9.3 `scripts/backup-to-nas.sh` and `scripts/restore.sh`
Specified in module 10 §6. The restore script is what makes the quarterly drill actually happen.

### 9.4 `docs/DEPLOYMENT.md`
Written for a competent person who is not a DevOps engineer. Cover, with exact menu paths:

1. GitHub repo, branch protection, required checks.
2. Vercel project, env vars, custom domain `erp.aieselectromech.com`, cron entries.
3. Supabase project, pooling, buckets, `pg_cron`, PITR.
4. SPF, DKIM, DMARC for the sending domain.
5. NAS: create the `aies-backups` share on a Btrfs volume, DSM Task Scheduler entry for the
   nightly pull, Btrfs snapshot schedule, Hyper Backup to an off-site target.
6. Synology Drive read-only mirror for published documents.
7. Monitoring: uptime check on `/api/health`; alerts on backup failure, dead-lettered jobs, and
   volume above 80%.
8. **Quarterly restore drill checklist, with a place to record the date it was last done.** A
   backup you have not restored is not a backup, and this is also ISO evidence.
9. Monthly patch window and the Dependabot workflow.
10. Cost expectation and what makes the bill grow (Spec.md §7.6).
11. Self-host fallback procedure.

## 10. Settings

`SystemSetting` key-value table with zod-validated, module-registered schemas. Foundation settings:

- **Company profile** — legal name, registered address, TIN, logo, landline, email. Entered
  manually at first run (decision 32); **do not hard-code any of it**. Every PDF header depends on
  this, so ship required-field validation and block document generation until it is complete.
- Numbering formats, fiscal year, currency and FX defaults.
- **Working calendar** — working days, hours, and Philippine holidays. Cash advance liquidation
  deadlines and SLA clocks count working days, so this is load-bearing, not cosmetic.
- Email configuration and templates, backup status display, module enable/disable.

---

## 11. Tests required before this module is done

- Permission matrix: each of the nine seeded roles hitting each seeded procedure, asserting
  allow/deny — with explicit assertions that `admin_manager`, `operations_manager`, and
  `marketing_manager` cannot read cost or margin fields in the serialised response.
- 2FA is enforced: a user without TOTP enrolled cannot reach any authenticated route.
- Approval fallback: before the window elapses only the VP can approve; after it, the president
  can too, and the record is stamped as a fallback with elapsed time. The president can act
  immediately at any time. The VP's queue still shows the item after fallback.
- Audit: an update writes exactly one log row with a correct diff; a forced failure rolls back
  both the change and the log.
- Numbering: 50 concurrent allocations produce 50 unique sequential numbers.
- Storage: path traversal attempts rejected; unauthorised download returns 403.
- Outbox: killing the drain mid-flight redelivers the event exactly once to an idempotent
  handler; a duplicate cron invocation does not double-send.
- E2E: login → create user → assign role → that user sees only their permitted nav.
