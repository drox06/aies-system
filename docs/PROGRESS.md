# Build Progress

Last updated: 2026-08-09
Current module: 02 — Quotation. Module 01 is COMPLETE and tagged `module-01-complete`.
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

- **Session 1 — accounts and accreditation. DONE, see below.** Manifest, permissions, core data
  model, accounts UI, and — pulled forward from session 3 at the company's request — the whole of
  §5b customer accreditation including its renewal workflow.
- **Session 2 — inquiry. DONE, see below.** `Inquiry` / `InquiryItem` / `Activity`, the §3
  lifecycle state machine, §4 requirements templates and the completeness gate, the §3 SLA
  escalation job with its working calendar, and the §5 inspection request.
- **Session 3 — the rest. DONE, see below.** §5c principal prospects, §6 kanban / My Day /
  Account 360 / follow-up engine, and the §7 merge tool. (§5b accreditation moved to session 1.)

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
- [x] `src/server/api/routers/crm.ts` + `/crm/accounts` on the session-5 `DataTable`, with one
      dialog serving create and edit (two dialogs sharing a twelve-field form is how a field ends
      up on create and missing from edit). The §7 duplicate check runs *while the form is being
      filled*, naming which signal matched.
- [x] Record scoping (§4.2, §10) as a `where` fragment, not a post-filter — a post-filter pages
      wrongly and still fetches rows the user may not read. `getAccount` scopes inside the lookup,
      so an out-of-scope id is indistinguishable from a missing one; a 403 would confirm the record
      exists to someone not allowed to know that.
- [x] Primary contact (name / mobile / position / email) captured inline on the account, stored as
      a `Contact` with `isPrimary` rather than as new columns — `CustomerAccount.phone`/`email` are
      the company switchboard, and one model means the same person can later attach to a site or an
      inquiry without being re-typed.
- [x] Accounts list carries an **Accreditation Status** column: green *Accredited*, orange *Renewal
      due*, red *Accreditation expired*, grey for in-progress or none. The good case is stated
      rather than implied — a blank cell reads the same as "nobody has checked", and "are we still
      accredited with them?" is the question the column exists to answer. The health aggregator
      stays generic (module 05 registers a finance contributor later), but the column filters to
      `kind === "accreditation"` so a column with that heading can never quietly start showing
      receivables; finance gets its own column when it lands.
- [x] **§5b customer accreditation, pulled forward from session 3** — model, register page, and
      per-customer panel. Records **only the outcome**: the certificate the customer issued and its
      expiry. The document checklist §5b describes was built and then removed at the company's
      direction — those are AIES's own documents, tracked on each customer's portal. See
      docs/DECISIONS.md #19; it matters because AIES has *one* mayor's permit and the old model
      made PD retype its expiry on every customer's record each January.
- [x] Status is **derived, never stored**: a record saying `accredited` with a past expiry reads as
      expired, because nobody runs a job before opening a page. `assertCanBeAccredited` gates the
      `accredited` status on certificate + expiry — with the checklist gone those two fields are the
      entire evidence base.
- [x] Certificate upload via module 00 storage, with a CRM `FileAccessChecker`: module 00's default
      is "only the uploader", which is the right default and the wrong answer here — PD uploads it,
      the salesperson deciding whether to quote needs to see it. Read follows `crm.view`, scoping
      still applies.
- [x] **Renewal workflow.** 90/60/30-day reminders to PD; an **Acknowledge renewal** button that
      records PD taking the task on and starts a clock; escalation to president and vice-president
      at 30/45/60 days if no new certificate arrives. Recipients resolve **by role**, not by
      hardcoded id. Completion is a certificate uploaded *after* the acknowledgement with a future
      expiry — "has a certificate" would mark every renewal done the instant it started, since the
      previous cycle's certificate is still attached. That also makes the new certificate the tick:
      the sweep clears the acknowledgement, so nobody has to remember to mark it done.
- [x] **EA approval gate** for renewals on blacklisted or dormant customers, and the record does
      **not** move until approved — "prior to commencement" means the work does not start. The
      branch lives in the approvals workflow's condition, not in an `if`: module 00's engine
      resolves a request with no applicable step as approved on creation, so an active customer
      needs no special case. First real business use of that engine.
- [x] Reminders are **in-app only, by design** (not because email is unwired): the renewal happens
      on the customer's portal. With email on, every reminder enqueued a `notify_email` job onto a
      queue that has no handler, so each dead-lettered — filling the one place operational failures
      are meant to be visible. Pinned by a test that asserts no email job *and* that the in-app one
      still lands, so it cannot pass by doing nothing.
- [x] `/api/cron/nightly` (which §9.1 asked for and nothing needed until now), running both sweeps,
      each caught separately. Scheduled 02:00 Manila in `vercel.json`.
- [x] `scripts/demo-crm-data.ts` (`npm run demo:crm`, `-- --clean`) — six accounts covering the
      states that actually differ, positioned on exact threshold days so the sweeps fire. Both
      sweeps verified end to end against it.
- [x] A guard that **every registered nav href resolves to a real page**, after the first CRM
      manifest advertised four routes that did not exist. Verified it fails when the defect is
      reintroduced.
- [x] 240 tests across 41 files; lint, typecheck and `next build` clean.

### Done in session 2 — the inquiry
- [x] `Inquiry` / `InquiryItem` / `Activity` per §2, plus `RequirementTemplate` (§4) and
      `InspectionRequest` (§5), in migration `20260809050852_crm_inquiry_items_activities`.
- [x] **A working calendar**, because §3's SLA is meaningless without one:
      `src/server/core/calendar/business-days.ts`. Weekends plus the seven fixed-date Philippine
      *regular* holidays. The movable ones are proclaimed annually and cannot be computed, and the
      "special non-working days" are no-work-no-pay days many firms work through — both are omitted,
      and the omission errs towards escalating *sooner*, which is the safe direction. No timezone
      library: Asia/Manila has been a fixed UTC+8 since 1978. `setHolidayProvider` is the seam for
      module 09's settings. See docs/DECISIONS.md #21.
- [x] **§3's lifecycle as a real state machine** (`inquiry-lifecycle.ts`, pure — no Prisma, so the
      UI imports the same rules the server enforces and the buttons cannot drift from the checks).
      §3's diagram is transcribed literally, including what it does not draw: no
      `new → disqualified` shortcut, and no reopening a closed inquiry. `quoted` / `won` / `lost`
      are `systemOnly` — §3 says the quotation sets them — and the router deliberately does not
      expose the `bySystem` flag, or anyone with `crm.edit` could book a sale that never happened.
      See docs/DECISIONS.md #20.
- [x] `lostReason` enforced as a picklist on `lost`, per §3's "without enforced loss reasons the
      pipeline reports are worthless".
- [x] Every status change writes an audit row — which is also what puts it in the activity feed,
      since module 00's feed merges audit rows by entity. §8's named events
      (`inquiry.acknowledged`, `inquiry.quoting_started`, `inquiry.lost`) are emitted alongside the
      generic `inquiry.status_changed`, so a subscriber does not have to filter every change.
- [x] **§4 requirements templates**, seeded for all seven service types and editable per §4's
      "editable in settings". Answers are namespaced `{serviceType}.{key}` — an inquiry with a
      supply line and an installation line asks both checklists, and a bare key would let one
      answer mark the other answered. `required: true` is spent only where a quotation genuinely
      cannot be priced without the answer; a gate that blocks on nice-to-haves gets overridden
      every time and stops meaning anything.
- [x] **The completeness gate blocks `quoting`**, and names the unanswered fields rather than
      showing a count — "6 of 9" tells you that you are stuck without telling you what to go and
      ask. Override needs a real reason (at least a sentence), recorded on the record *and* in the
      audit log. The seed writes `label` but never `fields` on update, so re-seeding cannot throw
      away a question somebody added.
- [x] **§3's SLA escalation**, added to `/api/cron/nightly`. Unacknowledged past its deadline →
      president and vice-president, resolved **by role**. `slaEscalatedAt` makes it fire once, not
      nightly forever. The deadline is **derived, never stored**, the same call as the
      accreditation status: a stored `slaDueAt` goes stale the moment somebody corrects a backdated
      `receivedAt`.
- [x] **§5 inspection requests** are assigned to any active user, with a due
      date, and that person is notified with the purpose, deadline, window and required outputs.
      Three things had to be fixed for that to be true rather than nominal: the assignee picker used
      `admin.listUsers` (president-only, so the dropdown was empty for everyone else); it listed
      every user through a president-only permission; and `technician` /
      `operations_manager` held no `crm.view`, so the notification linked to a record the
      recipient could not open. `inquiryScopeWhere` now also admits an assigned inspector, which a
      test proves is load-bearing. Assigned inspections appear on the assignee's My Day with the
      site access notes, since those decide whether the visit can happen at all.
- [x] **§5 inspection requests** with site, window, purpose, questions and required outputs.
      Raising one moves the inquiry through `transitionInquiryService` rather than writing the
      status directly, so it passes the same §3 legality check and produces the same audit row.
      Completing or cancelling returns it to `evaluating` and banks the paused time in *business*
      milliseconds — banking wall time would hand back a weekend that was never spent.
- [x] `/crm/inquiries` list (SLA state per row) and `/crm/inquiries/[id]` record page (status
      actions, requirements checklist, inspection panel, activity feed), with the Inquiries nav
      entry added **in the same change** as the pages, per the guard test.
- [x] Inquiries are indexed for Ctrl+K on create and update — the first entity type in the system
      to call `indexEntity()`, so the search plumbing built in module 00 session 4 now has
      something real to find.
- [x] `Activity` (§2's relationship record) with `activity.logged`, and `lastContactByAccount()` —
      the query behind §6's "accounts not contacted in N days" — built now so the model can be
      checked against its purpose rather than assumed to fit.
- [x] 298 tests across 45 files; lint, typecheck and `next build` clean. §10's three named cases
      are covered: the SLA fires "at the right time and not before" (asserted on both sides of the
      minute), pauses during `inspection_required`, and the requirements gate blocks `quoting`
      until complete or overridden. **The gate test was verified to fail when the gate is removed.**
- [x] `npm run demo:crm` now also loads four inquiries covering the states that differ.

### Done in session 3 — principals, the pipeline views, and merge
- [x] **A lint rule that stops a component importing server code.** Session 2 lost a build to a
      client component importing a service for one constant, dragging Prisma and `node:crypto` into
      the browser bundle; typecheck did not catch it. `eslint.config.mjs` now allow-lists the pure
      modules a component may import and rejects everything else under `src/server/`. Verified by
      reintroducing the original defect plus `@/lib/db` and a numbering import — all three blocked.
- [x] **§5c principal supplier acquisition.** `PrincipalProspect` + migration
      `20260809…_crm_principal_prospects`, an explicit stage machine, a board at `/crm/principals`,
      and the nightly agreement / price-list expiry sweep. The pipeline deliberately differs from
      §3's in one way: it allows parking as `dormant` and reviving to wherever the conversation left
      off, because a manufacturer going quiet is normal where an inquiry going quiet is the failure
      the module exists to remove. Backward moves are still refused.
- [x] Appointing emits `principal.appointed` with a payload complete enough for module 03 to build
      the `Supplier` without re-keying (§5c). The model is **not** created here — that would leave
      module 03 something to reconcile rather than something to build. An appointed prospect sits
      with `supplierId` null until then, and the panel says so on screen. docs/DECISIONS.md #22.
- [x] Appointment is gated on the signed agreement **and** its expiry date: an appointment with no
      agreement behind it is a claim nobody can check.
- [x] Price lists are AIES's cost side, so their file-access checker is narrower than the rest of
      CRM — `principal_prospect.manage` or `finance.view_cost`, per Spec.md §4.3.
- [x] **§6 kanban** at `/crm/pipeline`. Native HTML5 drag, no library (Spec.md §2). Drag is an
      enhancement, never the only route: every card is also a link to its record page where the same
      transitions are ordinary buttons, because HTML5 drag is neither keyboard-operable nor usable
      with gloves (§6.6). Dropping calls `transitionInquiryService` — §3's map, the lost-reason rule
      and the §4 gate all still apply.
- [x] **§6 My Day** at `/crm/my-day`: overdue follow-ups, awaiting your action, needs a next step,
      and accounts not contacted in 60 days. Always the caller's own work even for someone holding
      `crm.view_all` — a president opening My Day wants their own list, not all five people's.
- [x] "Not contacted" counts logged calls, meetings and site visits — **not** `updatedAt`. Editing a
      customer's address is not talking to them, and a CRM that counts it reports everything fine
      right up until the customer goes elsewhere. Pinned by a test that edits a stale account and
      confirms it stays on the list.
- [x] **§6 follow-up engine** in `/api/cron/nightly`: one notification per owner per day, not one
      per record. Eleven overdue follow-ups is one prompt to open My Day, not eleven badges.
- [x] **§6 Account 360** at `/crm/accounts/[id]`: details, accreditation (derived, with the
      "cannot issue a PO" warning §5b asks for), open inquiries with an inquiry-level win rate,
      sites, contacts, and a contact-history log with an inline "log contact" form. The five
      sections belonging to unbuilt modules are **not** stubbed as empty cards — one line names what
      is coming and which module brings it.
- [x] **§7 merge tool.** Repoints sites, contacts, inquiries, sub-accounts, activities and comments
      in one transaction, then runs an orphan check **before commit** so §10's "no orphans" is
      enforced at runtime rather than only asserted in a test. The duplicate is soft-deleted and
      reparented onto the survivor so it stays findable; its accreditation is retired rather than
      moved, because the record is unique per account and "are we accredited?" has one answer. The
      merge is audited against **both** ids — a single row on the survivor leaves the duplicate's
      page silent.
- [x] `MERGE_TARGETS` is a list, not a sequence of hand-written updates: the failure mode is
      forgetting one, and module 02's `Quotation.accountId` goes in that list.
- [x] 343 tests across 49 files; lint, typecheck and `next build` clean. §10's remaining named cases
      are covered — merge repoints with no orphans, and the half of "appointing creates exactly one
      supplier" this module owns (exactly one event, no second appointment, idempotent relink).

### Module 01 review gate (docs/BUILD-PROTOCOL.md §7) — PASSED, tagged `module-01-complete`
- [x] `npm test` — 359 tests across 50 files. `npm run lint`, `npm run typecheck`,
      `npm run build` all clean.
- [x] Migrations apply cleanly to a fresh database — proven by CI, which stands up a fresh
      `postgres:16-alpine` service and runs `prisma migrate deploy` on every push. **Do not try to
      reproduce this locally against the real database**; see docs/DECISIONS.md #24, where doing so
      destroyed every row in it.
- [x] **Manual pass performed by the operator**, covering all eight routes. Findings:
  - Kanban drag works, and an illegal move is refused with the reason. The one interaction no test
    can reach, now exercised by hand.
  - The §4 requirements gate blocked `quoting`, and the logged override released it — both halves
    of §4 confirmed on screen.
  - A site inspection was assigned, completed with findings, and returned the inquiry to
    `evaluating`, resuming the SLA clock.
  - Ctrl+K found an account and navigated to it.
  - `DEMO-Samson Controls` read as "Price list lapsed"; appointing `DEMO-Yokogawa` was refused for
    want of a signed agreement.
- [x] Three defects found by that pass, all fixed in `41e825e` — see "Defects found by the module 01
      manual pass" below.
- [x] PROGRESS.md and DECISIONS.md current.

### Defects found by the module 01 manual pass
1. **The acknowledgement badge kept shouting after the SLA stopped mattering.** An inquiry in
   `quoting` still showed a red "Acknowledged late", which reads as needing action when nothing can
   be done. Now quiet text once the inquiry is past `acknowledged`; the fact is kept, the alarm is
   not.
2. **`declined` was terminal, and it sits one click from every live stage.** A misclick could only
   be fixed by abandoning the record and retyping it. Now revivable like `dormant`, including
   straight back to `appointed` — the agreement gate still applies, so an undo cannot create an
   appointment with no paperwork behind it. This reverses the reasoning in the original
   implementation, at the company's request and correctly.
3. **My Day's "not contacted in 60 days" looked broken and was working.** The rule ignores accounts
   younger than the window, but demo accounts were created today, so the section could never
   populate. Demo accounts are now backdated 120 days.

Also landed in the same commit: accounts are indexed for Ctrl+K on create and update, and dropped
from the index on soft delete. Inquiries had been indexed since session 2, so searching a customer's
name found their inquiries but not the customer.

## In progress — Module 02, Quotation

specs/02-quotation.md §1: "This module deserves more care than any other." Planned as **4 sessions**:

- **Session 1 — the spine.** Data model + migration (DONE), module manifest and §11 permissions,
  QTN numbering with the revision suffix, the §4 costing engine as pure rules, and 
  stripping on the way out. Consumes  to create the draft.
- **Session 2 — the builder and revisions.** Line editing, grouping, optional lines, both pricing
  modes, header discount, VAT modes, the margin panel, and §5's revision chain with its diff view.
- **Session 3 — approval and issuance.** §6 through module 00's approvals engine (the
   rule with  is already seeded), §7's branded PDF plus
  the watermarked internal costing sheet, the send flow, and the auto-expire job.
- **Session 4 — RFQ, negotiation, reuse.** §3's supplier RFQ sub-flow, §8's negotiation log and
  what-if calculator, §9's duplicate/templates/self-building catalogue.

### Done in session 1
- [x]  — , , ,
      , , , migration .
      Money is  throughout;  and the computed line figures are stored rather
      than recomputed, because §4 says never to overwrite a historical rate and a recomputed margin
      would silently rewrite what the company decided months ago.
- [x]  on  for the optimistic locking Spec.md §10 requires by name.

### Next concrete step
**Module 02 — Quotation.** Read `specs/02-quotation.md` in full, then plan it into sessions the way
module 01 was (it is the second-largest module in the pack: evaluation, supplier RFQ, costing, the
quote builder, revisions, approval, and a PDF).

Two things are already waiting for it, both built and unreachable until it lands:

1. **`inquiry.quoting_started`** is emitted whenever an inquiry reaches `quoting`. Module 02
   subscribes and creates the linked Quotation draft (§3).
2. **`quoted` / `won` / `lost` are system-only transitions.** §3 says the quotation's outcome sets
   them, so `transitionInquiryService` refuses them from a user and accepts them with
   `bySystem: true`. Module 02 calls that from its `quotation.sent` / `accepted` / `rejected`
   subscribers, and adds those three to the CRM manifest's `consumes` —
   `tests/server/core/modules/crm-manifest.test.ts` pins this so it resurfaces.

Also owed by module 02's own gate: module 00 deferred "a non-privileged role cannot see cost fields
in the serialised response" because no cost field existed. Module 02 creates them.

**Blocked on input:** the company supplied `AIES Quotation 2026 - template.pdf` as the PDF template.
Its text is in subsetted fonts with custom encodings and could not be extracted without adding a PDF
parsing dependency, which Spec.md §2 requires justifying. Ask for a `.docx`, a plain-text export, or
the field list before building the PDF template. Everything else in module 02 can proceed without it.

Notes for whoever picks this up:
  - **Never pass a real database URL as `--shadow-database-url`.** Prisma wipes it. docs/
    DECISIONS.md #24.
  - Use **`npm run build:check`**, not `npm run build`, while a dev server is running.
    docs/DECISIONS.md #17.
  - **Never use `Promise.all` inside a Prisma interactive transaction** — one connection, and the
    failure reads as "Can't reach database server".
  - A client component importing a *service* fails `next build` and not typecheck; the lint rule in
    `eslint.config.mjs` catches it now. Shared constants live in the pure rules files.
  - `allocateNumber` takes no transaction client, so a rollback burns a number. Gaps are permitted
    by Spec.md §5, but quotations are customer-facing — revisit before module 02 issues QTN numbers.
  - The repo lives at `C:\dev\aies`, deliberately outside OneDrive.

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
- docs/DECISIONS.md #18-#19: module 01 (the CRM account model is `CustomerAccount` because Auth.js
  already owns `Account` and its adapter calls `prisma.account` by name; accreditation records the
  outcome only — certificate and expiry — because AIES's own documents live on each customer's
  portal, and duplicating them made one mayor's permit into N expiry dates to maintain).

## Not visually verified

Everything below passes typecheck, lint, tests and a production build, and was checked through
the DOM or the served HTML — but **nobody has looked at it on screen**. The module 00 manual pass
found six defects that 186 automated tests did not, so this distinction is worth keeping honest.

- The sidebar's white logo plate and the 20px lucide icons (module 00 session 5). The browser pane
  had signed itself out, so these were confirmed by computed geometry and a clean compile only.
- **All of module 01's UI**, now eight routes: `/crm/my-day`, `/crm/pipeline`, `/crm/accounts`,
  `/crm/accounts/[id]`, `/crm/inquiries`, `/crm/inquiries/[id]`, `/crm/accreditations`,
  `/crm/principals`. **Not one of them has been looked at on screen.** The kanban's drag-and-drop
  in particular has never been exercised by a human hand — it is the one interaction in the module
  that automated tests cannot reach at all. Verified by 240 tests and a production build only. `npm run demo:crm` loads
  six accounts covering the states that differ, so a manual pass has something to look at. The
  Accreditation Status column was checked by calling `getAccountFlags` directly against that data —
  DEMO-0001 green *Accredited*, 0002 and 0004 orange *Renewal due*, 0003 red *Accreditation
  expired*, 0005 and 0006 grey — but **the rendered page has still not been looked at**.
  DEMO-0003 is the one to scrutinise: it says `accredited` with an expiry 7 days past and must
  show red.
- The redesigned `/login`, `/change-password` and `/enroll-totp` screens carrying the full-colour
  lockup on a light ground. Markup verified by `curl`; appearance not.
- `docker/docker-compose.yml` has never been executed at all (no Docker on this machine) — the
  `self-host-fallback` CI job is its first real run.

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
- The full-colour `public/brand/aies-logo.svg` is 372kB (130kB gzipped) because the supplied
  master is a posterised trace needing 800 paths. It is now used on **both** the auth screens and
  the sidebar (on a white plate), on the company's instruction, so it loads on every page — the
  earlier justification that it was "off the hot path" no longer holds. Acceptable because it is
  one file shared by both, so it is cached before any page after login, but if first paint feels
  heavy on plant LTE the fix is a raster derivative for fixed-size screen use, keeping the SVG for
  PDF headers. See docs/DECISIONS.md #15's amendment. If artwork with real gradient fills is ever
  supplied, replace `brand/aies-logo-source.svg` and re-run `npm run brand`.
- **Losing an authenticator locks a user out permanently.** specs/00-foundation.md §4.1 makes TOTP
  mandatory with "no opt-out, no admin-only carve-out", and this app generates and redeems no
  recovery codes, so there is no self-service path back in. The only recovery is an operator with
  database access running `npm run reset:credentials -- <email>`. That is a deliberate trade
  (a recovery-code path is a second, weaker authentication factor), and the enrolment screen now
  warns about it — but with five accounts and one of them the president, it is worth revisiting
  before this carries real business data.
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
- **The ISO 9001 clause 8.4 approved-supplier register is owed.** The company asked to know both
  "can we legally sell to this customer" (built — §5b accreditation) and "is this vendor approved
  to buy from" (**not built**). The second is spec 08 §5's `SupplierEvaluation` and needs module
  03's `Supplier`; building it now would mean inventing a supplier record module 03 then has to
  reconcile.
- **The accreditation renewal sweeps have never run on a schedule.** No Vercel project exists, so
  `vercel.json`'s cron entries are inert. Verified manually with
  `curl -X POST http://localhost:3000/api/cron/nightly`.
- `ApprovalCondition.value` is numeric only (`evaluateCondition` rejects non-numeric snapshot
  fields), so the renewal workflow's "customer is blacklisted or dormant" test uses an
  `accountRestricted` 1/0 mirror alongside the readable `accountStatus`. Extending the condition
  language to strings is a module 00 change nothing has yet needed.
- **The §7 merge has no undo.** It is transactional and audited against both accounts, and the
  duplicate is soft-deleted rather than destroyed, so the data survives — but there is no button to
  reverse it. §7 says the tool is for admins and `crm.merge` sits with president and vice-president
  only. Revisit if it is ever used in anger.
- **Accounts are still not indexed for search.** Inquiries now are (session 2), so Ctrl+K finds
  those — but `account-service.ts` never calls `indexEntity()`, so searching a customer name finds
  its inquiries and not the account itself. One call in each of create/update, mirroring
  `reindexInquiry`.
- **The SLA is not configurable.** §3 says "1 business day, configurable";
  `INQUIRY_ACK_SLA_BUSINESS_DAYS` is a constant because `SystemSetting` belongs to module 09. The
  holiday list has the same problem and already has its seam (`setHolidayProvider`). See
  docs/DECISIONS.md #21.
- **§3's SLA pause cannot currently bite.** §5 pauses the clock during `inspection_required`, but
  §3's own transition map only reaches that state after acknowledgement, by which point the
  acknowledgement SLA is already satisfied. The mechanism is built and tested because §10 asks for
  it by name and module 02's quotation-turnaround clock will be the first to use it. See
  docs/DECISIONS.md #21.
- **`quoted` / `won` / `lost` are unreachable until module 02.** Deliberate — §3 says the
  quotation sets them. Module 02 calls `transitionInquiryService` with `bySystem: true` from its
  `quotation.sent` / `accepted` / `rejected` subscribers.
