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
  - [x] **Deferred, now closed by module 02 session 1.** The gate's "a non-privileged role cannot
        see cost fields in the serialised response" could not be executed in module 00, because no
        cost or margin field existed until module 02. `tests/server/core/rbac/field-gating.test.ts` covers the stripping
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

specs/02-quotation.md §1: "This module deserves more care than any other." Planned as
**4 sessions**:

- **Session 1 — the spine.** Data model + migration (DONE), module manifest and §11 permissions,
  QTN numbering with the revision suffix, the §4 costing engine as pure rules, and
  `finance.view_cost` stripping on the way out. Consumes `inquiry.quoting_started` to create the
  draft.
- **Session 2 — the builder and revisions.** Line editing, grouping, optional lines, both pricing
  modes, header discount, VAT modes, the margin panel, and §5's revision chain with its diff view.
- **Session 3 — approval and issuance.** §6 through module 00's approvals engine — the
  `quotation.approve` rule with `escalateAfterHours: 24` is already seeded, so the §4.4 fallback to
  the president needs no new machinery. Then §7's branded PDF plus the watermarked internal costing
  sheet, the send flow, and the auto-expire job.
- **Session 4 — RFQ, negotiation, reuse.** §3's supplier RFQ sub-flow, §8's negotiation log and
  what-if calculator, §9's duplicate / templates / self-building catalogue.

### Done in session 1
- [x] `prisma/schema/quotation.prisma` — `Quotation`, `QuotationLine`, `SupplierQuoteRequest`,
      `SupplierQuoteLine`, `Product` and `PaymentTerm`, in migration
      `20260809215615_quotation_core`. Money is `Decimal` throughout. `costFxRate` and the computed
      line figures are **stored, not recomputed**: §4 says never to overwrite a historical rate, and
      a recomputed margin would silently rewrite what the company decided months ago.
- [x] `version` on `Quotation`, for the optimistic locking Spec.md §10 requires by name and §12
      tests ("concurrent edit raises a version conflict rather than a silent overwrite").
- [x] Applied by the hand-written-migration route. `prisma migrate dev` wanted to reset the whole
      schema — it needs a shadow database, cannot create one on Supabase, and offers the real one
      instead. A **read-only** `migrate diff --from-url` proved the database already matched the
      datamodel apart from the new tables, so the SQL came from that, was applied with
      `db execute`, and marked with `migrate resolve`. Additive only.
- [x] **The §4 costing engine**, pure and in integer centavos — not float (0.1 is not
      representable, and forty lines of drift becomes a total ending .99999998 on a signed
      document) and not Prisma's `Decimal` (exact, but it would drag the Prisma runtime into the
      browser). Both pricing modes, the FX buffer, line and header discounts, all four VAT modes,
      optional lines excluded from totals *and* margin, the margin floor, and §8's what-if
      calculator. 17 tests, every expected figure worked out by hand per §12.
- [x] **The company's own quotation numbering**, replacing Spec.md §5's placeholder:
      `AIESLQ260001` for local, `AIESIQ260001` for indent/international, `REV01` appended from the
      first revision. Two independent series, each restarting each January — both emergent from the
      numbering service's scope key, and therefore both tested. `quoteType` stored on the record.
      docs/DECISIONS.md #25. 13 tests.
- [x] **AIES's registered details** behind `getCompanyDetails()`, ready for §7's PDF header.
      Constants until module 09's settings screen exists, deliberately rather than inventing a
      second settings mechanism. docs/DECISIONS.md #26.
- [x] **The module manifest** with §11's permissions — eleven of the thirteen. `quotation.approve`
      and `finance.view_cost` are foundation-owned (module 00 seeded them, the first because it
      needed the 24-hour approval rule, the second because Spec.md §4.3 makes cost visibility a
      system-wide rule). Redeclaring either would give one key two owners, which the registry's
      collision check exists to catch. 31 permissions now seed: 8 foundation + 23 from manifests.
- [x] **§2's status list as a transition map** (`quotation-lifecycle.ts`, pure). The shape worth
      noticing is what is missing: nothing returns to `draft` from `sent`, because §5 makes a sent
      quotation immutable and the way back is a revision. `accepted` and `expired` are system-only —
      one mirrors module 03's `customer_po.received`, the other is §7's auto-expire job.
- [x] **Consuming `inquiry.quoting_started`**, so an inquiry reaching `quoting` gets its draft
      automatically — the loop the pipeline drag already opens. Idempotent, because module 00's
      queue delivers at least once and a redelivery must not issue a second quotation number
      against the same work. Subscribed through a dynamic import so registering the manifest does
      not pull Prisma into `prisma/seed.ts` and the nav tests.
- [x] **Cost and margin stripped from the serialised response** — header *and* lines. A margin panel
      hidden in the UI while `lines[0].unitCost` still rides along in the JSON is a rendering choice
      anyone can undo from the network tab.
- [x] **Module 00's deferred review-gate item is now satisfied.** That gate asked for "a
      non-privileged role cannot see cost fields in the serialised response" and could not be run,
      because module 00 had no cost field. `tests/server/core/quotation/quotation-flow.test.ts`
      inspects the payload for every field in both cost lists, and confirms the customer-facing
      figures survive — a gate that stripped `total` as well would pass a naive test and produce an
      unreadable quotation.
- [x] 401 tests across 53 files; lint, typecheck and `build:check` clean.
- [x] Repaired the migration ledger. This morning's wipe (docs/DECISIONS.md #24) had also dropped
      Prisma's `_prisma_migrations` table, so all 21 earlier migrations read as unapplied against a
      schema that plainly contained them. Each is marked resolved; status is now 22 migrations,
      up to date, and a read-only diff confirms the database matches the datamodel exactly.

### Done in session 2
- [x] `quotation-line-service.ts`, and it is deliberately the **only** writer of `subtotal`,
      `total`, `totalCost`, `marginAmount` and `marginPct`. All five are derived from the lines by
      `computeCosting`, so a second writer would put the stored figures out of step with the lines
      that justify them — and nobody would notice until a customer added the column up themselves.
      It stores the *landed* unit cost the engine computed, not the raw input, so FX and the buffer
      are applied exactly once.
- [x] **Optimistic locking** (Spec.md §10, §12). `updateMany` with `where: { id, version }` rather
      than `update`, because `update` throws on a missing row and that is indistinguishable from the
      record having been deleted; zero rows affected means somebody saved first. **Verified
      load-bearing** by removing the version predicate and watching the test fail.
- [x] **Edits outside `draft` are refused in the service**, not the UI (§12), and the message says
      to revise — §5 makes a sent quotation immutable and that is the shape of the whole model.
- [x] **§5's revision chain.** Clones into n+1 as `draft` sharing the base number; requires a reason
      from the picklist (the ISO 8.2.4 record of *why* the quote changed); numbers from the highest
      revision in the chain rather than the one being revised, so revising R1 while R2 exists gives
      R3 instead of colliding on `[number, revision]`. One root: R0 has no parent and every revision
      points at it, so listing a chain is one query rather than a recursive walk.
- [x] The prior revision is **not** superseded on creation. §5 supersedes "at the moment the new one
      is sent", so a half-written revision cannot retire a quotation the customer is holding.
      Session 3's send flow does that transition.
- [x] **§5's diff**, pure so the builder and the PDF share it. Matches lines by **description, not
      line number** — positional matching reports every line below an insertion as "changed", which
      is unreadable exactly when somebody is reading it aloud on a negotiation call. Duplicate
      descriptions pair in order.
- [x] 14 tests covering three of §12's named cases.

- [x] **A hazard the builder created, found before it shipped.** §11 gives `quotation.edit` to the
      sales roles and Spec.md §4.3 withholds `finance.view_cost` from all of them — so a
      salesperson opens a quotation whose lines arrive with cost **stripped** (the gate working),
      edits a description, and saves. Posting those lines back verbatim would write zero cost and
      carry a fictional 100% margin into the VP's approval queue with nothing wrong on screen.
      `saveQuotationLinesService` now takes `canSeeCost` and carries the stored costs across by line
      number. The flag is **required, not defaulted** — `true` would be a silent hole, `false` would
      break cost-holders — and the router reads it from the session, never the request body.
      Verified load-bearing by disabling the carry-over and watching the test fail. 5 tests.
- [x] The FX buffer is not re-applied on a price-only save: the preserved cost is already landed, so
      three consecutive saves leave it byte-identical. Otherwise it is a slow leak visible only as
      shrinking margin.
- [x] `/quotations` list and `/quotations/[id]` builder, with the **nav entry in the same change**
      (icon mapped in `AppShell.tsx` first, since that map is an allow-list).
- [x] The builder recomputes through the **same** `computeCosting` the server stores with, so the
      figure moving under the cursor is the figure that gets saved. Both §4 pricing modes: typing a
      markup derives the price and locks that field; clearing it hands control back and the margin
      becomes implied.
- [x] Cost columns exist only for a caller with `finance.view_cost` — the server never sent them to
      anyone else, so there is nothing to render and nothing to post back.
- [x] **The margin panel renders only figures the server sent**, and returns `null` when they are
      absent rather than defaulting to zero. Recomputing margin in the browser would hand back
      exactly what the API refused; a margin of "0%" on an uncosted quotation is a lie the VP would
      act on. It marks itself "As last saved" while lines are dirty rather than showing a figure
      that silently describes something else.
- [x] Revision panel: the chain, the §5 picklist, and the diff defaulting to the previous revision —
      the question asked on a negotiation call is almost always "what changed since the last one?".
- [x] 420 tests across 55 files; lint, typecheck and `build:check` clean. `/quotations` compiles and
      serves under the dev server.

- [x] **The pipeline and Quotations are now actually connected — the join was missing
      infrastructure, not code.** Dragging an inquiry to `quoting` correctly emitted
      `inquiry.quoting_started`, and module 02's subscriber correctly creates the draft, but nothing
      **drained the queue in development**: `POST /api/cron/drain` is hit by Vercel Cron in
      production and by nothing at all locally. Both halves worked and nothing joined them, which
      looks exactly like a broken feature and is the worst kind of bug to chase.
      **`npm run dev` now runs `scripts/dev.mjs`**, which spawns `next dev` and POSTs
      `/api/cron/drain` every 5s — the same endpoint Vercel Cron calls in production.
      `DISABLE_DEV_DRAIN=1` opts out; `npm run dev:next` is a bare server.
      *The first attempt put this in `instrumentation.ts` and broke the dev server outright* — see
      docs/DECISIONS.md #28.
- [x] Deliberately **not** solved by calling the subscriber inline from the inquiry transition.
      Spec.md §3.6 routes cross-module side effects through the event bus, and the outbox is what
      guarantees an event is neither lost nor double-delivered on rollback. Bypassing it would make
      dev and production diverge, which is how the drain path stops being exercised and rots.

### Started in session 3 — issuance, at the company's direction

§7 assumes the app sends the email itself. It does not: module 10 owns outbound document email, and
Spec.md §3.4 removed inbound ingest entirely. So the PDF is downloaded and attached to an external
mail client, and **this system cannot observe that it was sent.** The company asked for that gap to
be modelled honestly rather than papered over, and it shapes everything below.

- [x] **Two facts, recorded separately**, because conflating them would make the pipeline lie.
      *Downloaded* — the document was produced and a named person has it, the last fact this app can
      establish on its own. It changes **no status**: a quotation is routinely printed just to check
      it reads properly, and treating that as issuance would tell the customer's pipeline column
      something that never happened. *Sent* — asserted by a person, with the date it **actually**
      went, which is not always the date somebody ticked the box.
- [x] `downloadCount` is incremented, not replaced. "Downloaded three times and still not sent" is
      the signal worth having.
- [x] **The download log is the audit trail**, not a new model: `writeAuditLog` already carries who
      and when, and module 00's activity feed merges audit rows by entity, so it appears in the
      record's timeline for free.
- [x] The internal costing sheet does **not** count as ready for sending — §7's internal document is
      a management report and nobody emails it to a customer.
- [x] **Confirming sent requires a prior download.** Confirming a send for a document nobody
      produced is either a mistake or a route this system knows nothing about; refusing it keeps the
      download log meaningful as evidence.
- [x] §5's supersession happens **here**, at the moment the new revision is sent — not when it was
      created. A half-written revision must never retire the quotation the customer is holding.
- [x] **`sweepUnsentDownloads` is what makes a human assertion trustworthy.** Without it "confirm
      sent" is a box people forget, and the pipeline fills with inquiries stuck in `quoting` that
      were quoted weeks ago — the "inquiries get lost" failure module 01 exists to remove, displaced
      one step down the process. Chases at 2 and 5 days, on the threshold day only.
- [x] **The chain the company asked about now runs end to end**: inquiry reaches `quoting` → draft
      created → confirmed sent → `quotation.sent` → module 01's subscriber moves the inquiry to
      `quoted`, a transition §3 makes system-only precisely so no person can fake it. Tested through
      the registry's real subscriber rather than a reimplementation, so it tests the wiring.
- [x] A subscriber failure degrades rather than dead-letters: an inquiry that has already moved on
      logs a warning, because the quotation is sent either way and the job's real work is done.
- [x] The session-1 pin in `crm-manifest.test.ts` fired exactly as designed — it was written to fail
      the moment module 02 landed so the failure would name the work. Rewritten for its second life:
      it now asserts `quotation.sent` **is** consumed and `.accepted`/`.rejected` are **not yet**,
      since nothing emits those until §8's negotiation flow in session 4.

**When module 10 lands this collapses.** Sending from the record makes `sentAt` an observed fact,
the confirmation step disappears, and the sweep has nothing to find. See docs/DECISIONS.md #27.

- [x] **§7's two PDFs**, via `@react-pdf/renderer` (Spec.md §3.2's named choice, so pre-justified).
      The customer document follows §7's own section list: header with company block and document
      number, customer and site, scope narrative, grouped line table, commercial summary, terms,
      exclusions and assumptions, standard terms, signature block, and the §6.4 controlled-document
      footer with `Doc No. / Rev. / Page x of y`.
- [x] **Cost cannot appear on the customer PDF, because it cannot be expressed there.**
      `CustomerQuotationPdfProps` has no cost, markup or margin field, so an edit that tries to
      print one does not compile. The internal costing sheet is a **separate document with a
      separate props type** rather than the same component behind a `showCosts` flag — a boolean is
      one variable away from printing margin on a document the customer keeps, and two documents
      cannot make that mistake.
- [x] The costing sheet is watermarked INTERNAL, landscape, gated on `finance.view_cost` at the
      route, and names who generated it so a printed copy left on a desk is attributable.
- [x] **`GET /api/quotations/[id]/pdf`** renders and records the download. A route handler rather
      than a tRPC procedure because the response is bytes; recording happens *there* rather than in
      a button, because the fact worth recording is "the bytes left the server" and a button records
      an intention. Recorded only after a successful render — a failed render produced no document,
      and logging it would put a fiction in the trail the send flow depends on.
- [x] `aies-logo-pdf.png` added to the brand build: `@react-pdf` draws PNG and JPEG, and its partial
      SVG support would be asked to rasterise an 800-path auto-trace on every quotation.
- [x] The issuance UI: Download, then "Confirm sent" with the date it **actually** went, and the
      download log on the record.
- [x] **Tests check the assembled props, not the PDF bytes**, and that is deliberate. `@react-pdf`
      compresses content streams and subsets fonts with custom encodings, so grepping the output for
      a cost figure would pass whether the guarantee held or not — worse than no test. The props are
      the document's complete input, so they are scanned recursively instead. 7 tests.
- [x] `vitest.config.ts` now sets `esbuild.jsx: "automatic"`. Next compiles the `.tsx` documents
      with the automatic runtime; Vitest's own transform defaulted to the classic one and failed at
      render time with "React is not defined" rather than at compile time.
- [x] 443 tests across 57 files; lint, typecheck and `build:check` clean. Both documents rendered
      from a real quotation and reviewed on screen.

### Also in session 3 — the company's review of the first real quotation

They logged an inquiry, quoted it, printed it, and sent back six things. All six are done.

- [x] **An inquiry is logged *for* a named salesperson, and that person's acknowledgement is what
      continues the process.** Their words: "i want this to be sent to a specific sales person to be
      assigned by whoever logged the inquiry. then upon acknowledgement of the assigned person, this
      will continue the current process."

      `createInquiryService` already accepted `ownerId`; nothing in the UI ever sent one, so every
      inquiry silently belonged to whoever typed it. Three parts were missing:

      1. **An "Assign to" picker** on the quick-create form, defaulting to "Me — I will handle it".
         Fed by `crm.inquiryOwners`, gated on `crm.create` rather than `admin.manage_users` — the
         same trap that left the inspection assignee dropdown empty for everyone but the president.
         Every active user is offered; sales roles are labelled and sorted first, not used as a bar.
         Spec.md §4.3 is explicit that a five-person company has no clean separation of duties, and
         the company overruled exactly this restriction once already on inspections.
      2. **The assignee is told**, on creation and on reassignment, with the inquiry number and
         subject in the title and the assigner's name in the body. Non-fatal and outside the
         transaction: a failed notification must not lose a customer's call. Nobody is notified about
         their own typing, which is the commonest case by far.
      3. **`new → acknowledged` is now the owner's move.** Acknowledgement is where §3's SLA clock
         stops and somebody's name goes against the work — if any passer-by can click it, the clock
         measures nothing. A holder of `inquiry.assign` may still acknowledge on someone's behalf
         (leave, illness, a waiting customer), and the audit row records who actually clicked.

      `canAcknowledge` lives in the **pure lifecycle file**, so the record page disables the button
      with the same function the service refuses the mutation with, and they cannot drift. The record
      page now also shows who it is assigned to, which it never did.
- [x] **The company address is set as lines, not wrapped by the renderer.** It was breaking mid-
      address in the header column. `CompanyDetails.addressLines` is now `["930 Doña Basilisa Yangco
      Street,", "Barangay Namayan, Mandaluyong City, 1550, Philippines"]` — the company decides where
      the break falls. The header block's `maxWidth` went 220 → 260 in the same change: the longer
      line measures ~205pt at 8pt Helvetica, so 220 left 15pt of slack and would have wrapped again
      the moment anything grew. 150 (logo) + 260 is still well inside `CONTENT_WIDTH`.
- [x] **Space between "QUOTATION" and the proposal title** — `marginTop: 6` and `lineHeight: 1.35`,
      plus a 330pt cap so a long title wraps instead of colliding with the number block.
- [x] **Commercial terms are enterable at last.** Delivery lead time, delivery term, payment terms
      and warranty printed "—" on every document because **nothing in the app could set them**. New
      `TermsPanel` on the quotation record, draft-only like every other edit (§5).
- [x] **§7's terms and conditions are AIES's own nine clauses**, supplied by the company, replacing
      the placeholder wording this build shipped with. `{{CUSTOMER}}` in clause 1 is filled with the
      account name when the terms are seeded.
- [x] **Each clause is editable, and the clauses live on the quotation.** This is the load-bearing
      decision of the change: a quotation is a contract, so the clauses printed on it must be the
      ones the customer accepted — not whichever set the company is using when somebody reprints it
      six months later. `createQuotationService` seeds `Quotation.termsAndConditions` from the
      defaults; after that the record owns its own terms, editable line by line, frozen on send with
      everything else. A record created before the column existed falls back to the defaults rather
      than printing a document with no terms at all.
- [x] `paymentTermsText` is what prints; `paymentTermsId` stays for module 05's structured link. The
      document used to print the id, so a customer could receive a page with a cuid where the payment
      terms belong.
- [x] 463 tests across 59 files; lint and typecheck clean. 20 new tests across two files.

### Finished in session 3 — §6's approval and §7's auto-expire

**Module 02 session 3 is complete.** All five items the previous session left are done.

- [x] **The escalation window counts working hours.** Fixed first, because everything below depends
      on it. `resolveApprovalFallback` compared wall-clock time and carried a comment explaining
      why: no working calendar existed when module 00 wrote it. One does now — module 01 built
      `business-days.ts` for §3's SLA, and it is pure. The bug that was producing is not a rounding
      difference: a quotation submitted at 17:00 Friday reached the President's queue at 17:00
      **Saturday**, before the VP had had one working hour to look at it. Escalation is supposed to
      mean the primary approver had their chance. docs/DECISIONS.md #29.
- [x] Added `fallbackAvailableAt`, so the queue and the record page can say *when* the President
      becomes eligible instead of making the reader do calendar arithmetic.
- [x] **§6 through module 00's engine, with no role name in a conditional.** §6 says how not to
      build this — "rather than by hard-coding 'VP approves'" — so `approval-service.ts` has no
      `if (total > x)` and no `"vice_president"` in an `if`. One step carrying `approvalRuleKey`,
      and *who decides* comes entirely from the `ApprovalRule` row: the VP, the President after the
      window, who may act immediately, whether a decision is stamped as a fallback. Value bands
      later mean adding a `condition` to the step, which is data.
- [x] The margin goes into `entitySnapshot` although no step reads it today. A condition can only be
      evaluated against fields captured **at request time**, so omitting them would make switching
      bands on a migration rather than a settings change — which is the thing §6 asked to avoid.
- [x] **No migration.** `Quotation` already had `approvedById`, `approvedAt`, `decisionAt` and
      `rejectionReason`, and the submission time the window counts from is
      `ApprovalRequest.requestedAt` — the request row *is* the record of the submission, so copying
      it onto the quotation would create two truths that can disagree.
- [x] `draft → pending_approval → approved`, rejection back to `draft` with a **mandatory** comment.
      Mandatory because the comment *is* the instruction: a quotation sent back with no reason is
      one the preparer resubmits unchanged.
- [x] Submitting is gated on `quotation.edit`, not `quotation.approve` — otherwise only the VP could
      put a quotation in front of the VP. A quotation with no lines is refused: it would reach the
      queue as a zero-total row, which reads as a bug in the queue rather than a mistake in the
      quotation.
- [x] `quotation.submitted_for_approval`, `quotation.approved` and `quotation.rejected_internally`
      are now emitted — the three that were declared in the manifest and unused.
- [x] **The VP's queue is a stack of decidable cards, not a table.** §6 asks for "approvable in
      sequence without opening each one", and the VP's real task is a sitting: work down the list,
      approve most, send one back. Total, margin, customer and age are on the card; margin is
      *absent*, not zeroed, for anyone without `finance.view_cost`. Escalated rows say so.
- [x] The record page's `ApprovalPanel` serves three audiences from one card: the preparer's submit
      button and the rejection comment that tells them what to change; the approver's decision
      without leaving the record; and everyone's view of who decided and whether it was a fallback.
      Whether *you* may decide is answered by the server, never guessed from a role in the browser.
- [x] **§7's auto-expire**, nightly. Flips `sent` quotations past `validUntil` to `expired` with a
      `System` audit row and no actor — nobody did this, and attributing it to whoever triggered the
      cron would be a small lie in the trail. Emits `quotation.expired`.
- [x] `under_negotiation` is **warned but not expired**, and that is a deliberate reading. §7 names
      `sent`; flipping a quotation to expired underneath two people who are mid-conversation would
      show the pipeline a deal as lost that nobody lost. The seven-day warning is what answers the
      real risk — a negotiation outliving its own price — and §5 already has `validity_extension` as
      a revision reason for the fix.
- [x] 490 tests across 61 files (27 new); lint, typecheck and `build:check` clean. The nightly cron
      was run against the dev server and returned the new sweep's result alongside the others.

### Also in session 3 — the pipeline's Sent and Received PO columns

Asked for directly: *"in the pipeline, add a Sent column and Received PO column. after the quote is
ticked as sent to the customer, can you auto-transfer the sent quoted to the Sent column, then for
this to move to the next column a PO should be uploaded in the Sent column."*

- [x] **`quoted` now reads as "Sent".** Not a new status — §3 already sets `quoted` from
      `quotation.sent`, so an inquiry is `quoted` precisely when its quotation went to the customer,
      and a second status for one fact would leave one of them permanently empty. What was wrong was
      the *word*: next to a column called "Quoting", "Quoted" reads as *we wrote a quotation*, which
      is what the previous column already means. The stored key stays `quoted` because every audit
      row and report contains it; only the label moved, in `humanStatus`, so every screen agrees.
- [x] The auto-transfer the company describes **already worked** — module 01 subscribes to
      `quotation.sent`. What was missing was a column that said so.
- [x] **New `po_received` status, labelled "Received PO"**, and a `requiresCustomerPo` gate on
      `quoted → po_received`. The column *means* the customer's PO arrived, so a card sitting in it
      with nothing behind it would be the same failure as a quotation marked sent that nobody sent.
- [x] **The PO is module 03's `CustomerPO`, built as specs/03-order-procurement.md §2 defines it** —
      not `customerPoNumber` fields bolted onto `Inquiry`. §1 calls PO receipt "the pivot point…
      where the deal stops being a sales artifact and becomes an obligation", which is exactly the
      column being asked for. Hanging it off the inquiry would have been a second mechanism for a
      thing module 03 already owns, the trap already refused for module 05's `PaymentTerm` and ISO
      8.4's supplier register.
- [x] A minimal **`order` manifest** (module 03's first) owning that one model and emitting
      `customer_po.received`. It is explicitly not module 03: no sales order, no supplier, no
      supplier PO, no goods receipt, no ticket generation.
- [x] **§2's "scanned PO is mandatory" is enforced as evidence, not validation.** The service
      re-reads the stored `FileObject` and refuses one uploaded against a different record — an id
      in a request body proves nothing. `fileId` is a non-null column for the same reason.
- [x] **Module 01 does not import module 03.** Dependencies run downward (Spec.md §3.6), and module
      03 already imports module 01, so the gate is a *registered check*: module 03 teaches the state
      machine how to answer "does this inquiry have a PO?", the same pattern as module 00's
      file-access checkers. It **fails closed** — with nothing registered the move is refused.
- [x] **specs/02-quotation.md §10's `customer_po.received` subscription now exists.** It was
      declared unbuildable in session 1 because nothing emitted the event; module 02 now consumes it
      and sets the quotation `accepted`. That is not tidiness: left `sent`, §7's nightly sweep would
      expire a quotation the customer had already ordered against and tell the owner a won deal had
      lapsed.
- [x] The dialog is shared by the board and the inquiry record, so drag is an enhancement rather
      than the only route (Spec.md §6.6) and the two forms cannot drift on what "mandatory" means.
      The panel disappears entirely for somebody without `customer_po.view` — a technician assigned
      a site inspection can open the inquiry and has no business seeing commercial paperwork.
- [x] The PO amount is **not** pre-filled from the quotation. The number that matters is the one on
      the customer's document, and pre-filling it invites nobody to read it; a mismatch is real, and
      module 03 turns it into §2's discrepancy check.
- [x] 11 tests. `po_received → won` stays system-set: a received PO is not a delivered job, and
      modules 03 and 04 own what happens next.

### Also in session 3 — four corrections from reading a downloaded document

- [x] **Amounts on a PDF are written with the ISO code, not a currency symbol.** Every peso figure on
      a downloaded quotation and costing sheet came out as `±765,000.00`. The cause was not the
      formatter: the documents are drawn in Helvetica, whose WinAnsi encoding has no `₱`, so
      `@react-pdf` substituted a glyph — and a customer reads `±` as a tolerance. New
      `formatMoneyCode` writes `PHP 765,000.00`; `formatMoney` keeps the symbol on screen, where the
      browser has the font. Embedding a peso-carrying font would have fixed the glyph and left a
      second problem: a document quoted in dollars and read in Manila is ambiguous when it says only
      `$`. `USD` is not, and ISO codes are what a customer's finance department files against.
- [x] **A quotation is raised in PHP, USD or EUR**, chosen at creation. Three, because those are the
      three AIES quotes in — an indent order priced by a European principal is quoted in euros. A
      closed list rather than free text: "Php", "php" and "peso" would each pass a string field and
      make §4's FX buffer meaningless.
- [x] **The costing sheet's heading was crowding the title beneath it** — the same fix already made
      to the customer document, plus a width cap so a long title wraps instead of running into the
      document number.
- [x] **The demo data is gone**, at the company's request: 6 `DEMO-` accounts, 4 `INQ-DEMO-`
      inquiries, 5 `DEMO-` principal prospects, 5 accreditation records — and `AIESLQ260062`, which
      was raised against `DEMO-0003` and so was demo data whatever its number looked like. Their own
      chain is untouched: `ACC-0001` A4One → `INQ-2608-0545` → `AIESLQ260244` → PO 123456798.
- [x] Three scripts, kept because the questions recur: `inspect-business-data.ts` (read-only
      inventory), `purge-demo-data.ts` and `purge-test-residue.ts`. Both purges report by default and
      need `--apply`, which is the right default for anything that removes rows.
- [x] `purge-test-residue.ts` earned itself immediately: an interrupted suite left 11 test accounts,
      and the dev drainer had turned the tests' `inquiry.quoting_started` events into 6 real draft
      quotations. It selects structurally — *an owner id matching no `User` row* — so it can never
      match a record a person created.
- [x] **Counters restarted as far as they safely can**: inquiry 833 → 545, quotation 542 → 244. Not
      to zero, because `INQ-2608-0545` and `AIESLQ260244` still exist and a counter lowered past a
      live number hands the next record a code the database refuses. `reset-numbering-counters.ts`
      computes that floor rather than trusting an argument.

- [x] **Then renumbered, at the company's word**: `INQ-2608-0545 → INQ-2608-0001` and
      `AIESLQ260244 → AIESLQ260001`, and the counters to 1. `renumber-to-restart-series.ts` refuses
      a quotation with a `sentAt` — Spec.md §5's "never reused, never reordered" protects a number
      that has been *outside the building* — so the override is an explicit `--include-sent`, valid
      here only because the recipient was a test account. Old audit rows keep the old number; each
      renumber writes a **new** row explaining the change, because an audit log that edits itself is
      worth nothing.
- [x] The dry run caught the reason this had to wait: it first listed `INQ-2608-0570…0574`, which
      were *test inquiries the suite was creating at that moment*. A whole-series renumber needs a
      quiet database.

### Done in session 4 — §3's supplier RFQ, §8's negotiation, §9's reuse

**§3 — the supplier RFQ, which the schema had been waiting on since session 1.**

- [x] §3 exists for one stated reason: "make that coordination a first-class record instead of an
      email nobody can find."
- [x] **The app does not send it, and §3.2 confirms that rather than deferring it** — PD emails
      supplier price inquiries by hand. Same shape as §7's issuance: the app produces the document
      and the draft text, a person sends it, and `markRfqSent` is their assertion that they did.
      That is what starts the response clock, not creation — a draft sitting unsent is nobody's
      fault but the sender's.
- [x] **Lines are copied, not referenced**, and the request body is generated once and stored. The
      quotation keeps moving underneath; a body regenerated next week would be a different document
      wearing the same number. Tested by editing the quotation out from under a raised RFQ.
- [x] **`sourceLineNo` is the new column and it is what makes §3.5 possible.**
      `saveQuotationLinesService` deletes and recreates every line on each save, so a
      `QuotationLine` id is not stable and a foreign key would dangle. Without recording the source
      line, an RFQ raised on lines 2 and 5 has lines 1 and 2 and the mapping back is gone.
- [x] **The trap this flow was always going to fall into.** §3 gives supplier pricing to PD, who by
      Spec.md §4.3 does **not** hold `finance.view_cost` — and the line service zeroes cost for a
      caller who cannot see it. That guard exists to stop a cost-blind *browser* posting back
      figures it was never shown; here they are read from the RFQ rows on the server. Without the
      distinction the person the spec put in charge of supplier pricing would wipe every cost they
      applied. There is a test named after it.
- [x] §3.6's matrix flags the cheapest offer and does not choose it — in the test the cheaper one is
      four weeks slower. Across mixed currencies it flags nothing: naming a winner without the
      quotation's rate would name the wrong one confidently.
- [x] **The RFQ PDF is not a quotation with the prices removed.** No AIES pricing, no customer name,
      no margin — a supplier who learns which customer this is for and what AIES sells it at has
      everything they need to go around AIES. It carries the four things §3.2 says a response must
      contain as empty columns, so the document asks the questions itself.
- [x] `supplier_rfq.sent` and `supplier_rfq.responded` were declared in the manifest and emitted by
      nothing. §3.3's overdue sweep chases weekly rather than daily, on the nightly cron. 23 tests.

**§8 — negotiation.**

- [x] §8 opens by quoting the company: *"if not we leave room for negotiations."* Being pushed on
      price is part of the process, so the record holds it.
- [x] **The round log is a table, not four columns.** Three rounds of push and counter-push is the
      ordinary case and columns hold only the last one; the question a sales meeting actually asks
      — "how far have we already come down?" — is unanswerable from a final position.
      `authorisedById` is the caller, because a concession is a margin decision.
- [x] **The what-if calculator writes nothing**, and there is a test named after that. A calculator
      that silently saved would turn every idle "what about 700k?" on a phone call into a real change
      to a live document. Target-total and target-discount inputs funnel into one arithmetic path,
      because two implementations of the same sum eventually disagree.
- [x] It reports `needsReapproval` for **any** live quotation whose price moves, not only one that
      breaches the floor: §6 approved a different number. §8 asks the UI to "offer to raise the
      approval request in place"; the offer is a revision, since §5 makes a sent quotation immutable
      and the revision is what carries the new price back through §6.
- [x] **`lostReason` uses module 01's picklist**, not a second one — two vocabularies would mean
      neither win/loss report could be trusted. It is a new column rather than a reuse of
      `rejectionReason`, which records why the *VP* sent it back. 12 tests.
- [x] `MARGIN_FLOOR_PCT` moved out of the PDF renderer into `costing.ts`. Three callers need it now,
      and a pricing rule has no business living in the document that happens to print it.

**§9 — reuse.**

- [x] **Duplicating is not revising, and they are opposites.** A revision shares the base number,
      supersedes what came before and is ISO 8.2.4 evidence; a duplicate is a new quotation that
      happens to start from an old one. Conflating them would file one customer's document in
      another's revision history.
- [x] A duplicate re-seeds the **terms for the new customer** — clause 1 names the client, and a
      copy that still names the previous one is a contract with somebody else's name in it. It drops
      the supplier link (the answer to "where did this cost come from?" has changed), gets a fresh
      validity date, and does not carry site or contact to a different account.
- [x] **The refresh-costs prompt reports and changes nothing**, as §9 asks. A line the catalogue has
      never costed is flagged *harder* than an old one: "nobody has ever priced this from a
      supplier" is the stronger warning, and silence would read as approval.
- [x] **The catalogue offers rather than creates.** One that silently absorbed every typed line would
      stop being the list of things AIES actually sells. 13 tests.
- [x] One test-suite lesson worth keeping: the `Product` catalogue is **global**, so a test that adds
      an entry changes what every later test in the file sees. The first version of the reuse suite
      failed exactly that way, and the failure looked like a bug in the candidate query.

### Also in session 4 — cost is stored raw, and the FX class of bug is gone

Asked whether the RFQ apply was sound. It was not, and the cause ran deeper than the symptom.

- [x] **The symptom:** a supplier's EUR 1,450 was stored as a cost of 1,450 **pesos** — about a
      sixty-fifth of the truth. Margin looked enormous, §4's floor never tripped, and the quotation
      would have reached the VP's queue looking like the best deal of the year. The comment beside it
      claimed a conversion the code did not perform.
- [x] **The cause:** `QuotationLine.unitCost` held the cost *after* FX and the buffer, and nothing
      recorded that it did — so no caller could tell a raw supplier figure from a converted one. A
      second live instance was found by probing rather than guessing: the builder reloaded the landed
      cost and re-sent the buffer with it, so a 3% buffer compounded on every save (1,000 → 1,030 →
      1,060.90).
- [x] **The fix, which is what §4 asked for all along** — "Store `unitCost` in `costCurrency` **and**
      the `costFxRate` used at the time of quoting". `unitCost` is now the supplier's raw figure;
      landed cost is derived by `landedUnitCost()` in `costing.ts`.
- [x] **A save is now idempotent by construction**, because what is stored are the *inputs* rather
      than a previous output. There is a test that saves the same line four times and asserts the
      cost never moves; under the old design it went 6,025.50 → 6,206.27 → 6,392.46 → 6,584.23.
- [x] **No data migration was needed, and that was checked rather than assumed:** the database held
      one quotation line, at cost 0, rate 1, buffer 0 — where raw and landed are the same number.
- [x] The `costsAreLanded` flag added an hour earlier was deleted; there is nothing left to
      disambiguate. The costing sheet derives its cost column, the what-if calculator feeds the
      stored rate and the quotation's buffer, and the builder round-trips `costCurrency` and
      `costFxRate` per line — without which the next save would reset an imported EUR line's rate to
      1 and reproduce the original bug.
- [x] 167 tests across the quotation suite; four existing assertions were rewritten because they
      asserted the old contract, two of them by name. docs/DECISIONS.md #32.

**Still open on FX:** the builder shows the raw cost and has no field for the rate, so a
foreign-currency line can only be costed through the RFQ flow today. A rate column on the line editor
is small and belongs with §4's FX work.

### After the review gate — five things from using the app

- [x] **EA and KJ can delete a quotation.** A new `quotation.delete` permission, separate from
      `quotation.cancel` because they are different acts: cancelling records that a live quotation is
      no longer being pursued, deleting takes it off the screens. **Soft, always** — Spec.md §5 says
      numbers are never reused, and a hard delete would free `AIESLQ260012` to be handed out twice.
      A typed reason is required, because the question asked later is never whether something was
      deleted but why. Refused when a customer PO answers it: that PO references this quotation by
      number, and deleting it would leave module 03 holding an order against nothing.
- [x] **Panel order on the quotation record** is now Details → Lines → Supplier pricing → Terms, as
      asked. It reads better too: the lines are what the page is about, and supplier pricing is
      something you do *to* them.
- [x] **A negotiated discount no longer rewrites the line amounts.** Yesterday's §4 work distributed
      the header discount into `lineTotal`, so the document showed reduced line amounts *and* a
      discount row — the same reduction twice, and the printed amounts no longer summed to the
      printed subtotal. The distribution now goes into a separate `discountShare`, which is what
      margin and §4's floor warning read. The document states **full subtotal → less discount (with
      the percentage) → subtotal after discount**, which is what the company asked for and what a
      customer can check with a calculator. A test asserts the printed line amounts sum to the
      printed subtotal.
- [x] **Recording an RFQ response in another currency saves, and that is the intended flow** — the
      company asked. Writing down what a supplier quoted is a fact about the outside world and is
      always allowed; the exchange rate is only needed to turn it into *AIES's* cost, which is what
      **Apply** does and where the refusal lives. The surprise was that the refusal arrived at the
      end, so the panel now says it at the moment the currency is chosen.
- [x] **A customer PO can be recorded against a quotation with no inquiry.** The company hit this
      with a sent quotation that never appeared in the pipeline's Sent column. The cause was not the
      column: **the pipeline is an *inquiry* board**, and that quotation had no inquiry — it was
      raised straight from the Quotations screen, which §9's duplicate also produces. With no card
      there was nothing to drag, and the PO form lived only on the card. `CustomerPO.inquiryId` was
      optional in the model from the start; the service was the thing insisting on it. Now a PO can
      be recorded from the quotation's own record, and it still moves the card when there is one.
- [x] **The series restarted so the next real quotation is `AIESLQ260002`.** Three test quotations
      (`AIESLQ261148 rev0`, `AIESLQ261149 rev0` and `rev1`) went out through
      `deleteQuotationService` rather than a raw `UPDATE` — same soft delete, same audit rows, same
      refusals — via `clear-test-quotations.ts`. `reset-numbering-counters.ts` then took
      `quotation_local` scope 26 from 1465 → 1, which needed one change: **the counter floor now
      ignores deleted quotations**, because a number nobody can see is not in use. The honest caveat
      is printed rather than buried — a deleted row keeps its number in the unique index, so the
      counter would collide with `AIESLQ261148`/`261149` if it ever climbed back to them. That is
      1,146 quotations away, and the alternative is holding every future number hostage to a test
      record.
- [x] `inspect-business-data.ts` was reporting 4 quotations where the app showed 1: it counted
      soft-deleted rows. Every query in it now filters `deletedAt: null`, so the inventory means what
      the screens mean. Verified final state — 1 account (ACC-0001 A4One), 1 inquiry
      (INQ-2608-0001), 1 live quotation (AIESLQ260001), 1 principal, 1 customer PO, 4 stored files.

### Module 02's review gate — passed, with one defect found and fixed

specs/02-quotation.md read end to end against what exists, in the shape module 00's gate used.

**§12's seven named tests all exist and are real** (checked by name, not by assumption):

| §12 asks for | Lives in |
| --- | --- |
| Sent quotations reject edits at the service layer | `quotation-flow`, `revisions` |
| R0 → R1 → R2 keeps one root, supersedes, diff accurate | `revisions` |
| Margin maths table-driven with fixed expected values | `costing` |
| Every quotation routes to the VP; none sent unapproved | `approval-flow` |
| 24 working hours → president, recorded as a fallback | `approval-flow` |
| `finance.view_cost` denial strips cost from the payload | `quotation-flow`, `cost-preservation` |
| Concurrent edit conflicts rather than overwrites | `revisions` |

**The gate found one thing, and it was worth running for.** §4 asks that a "header-level discount
distributes proportionally across lines and recomputes margin". The header total was always right,
but per-line margins were computed *before* the discount — so a quotation discounted twenty per cent
still showed healthy line margins, and §4's floor warning stayed silent on lines that were by then
underwater. The floor is a safety mechanism for exactly that case. Now distributed by share of line
total, with the rounding remainder given to the largest line so the parts sum exactly, and optional
lines left alone because they are not in the subtotal the discount came from. Four tests, one of
which is the case above stated directly: at list price the line clears the floor, after the discount
it does not.

**Sections, against the spec's own list:** §2 data model ✓ · §3 supplier RFQ, all six numbered items
✓ · §4 costing, FX, margin panel, VAT modes ✓ · §5 revisions, diff, reasons ✓ · §6 approval with
§4.4's fallback ✓ · §7 issuance and auto-expire ✓ (outbound email is module 10's, documented in
DECISIONS #27) · §8 negotiation and what-if ✓ · §9 duplicate, templates, self-building catalogue ✓ ·
§10 all eleven events emitted ✓ · §11 permissions ✓ · §12 tests ✓.

**Tagged `module-02-complete`.**

### A second batch from using the app — twelve items, before module 03

The company worked through the running app and came back with a list. Nothing here is from a spec;
all of it is from somebody trying to do their job with what was built. Grouped by what it touched.

**The site inspection could ask for photographs and had nowhere to put them.** §5 has listed
"photos, tag list, measurements" as required outputs since session 2, and the panel printed
"Bring back: photos" under every request — with no upload control anywhere on the page. Fixed by
building the half of module 00's storage that was missing rather than a one-off: uploading has
worked since session 4, but nothing could **list** what had been uploaded, so every attachment in
the app was a single id stored on its parent row. That is right for a certificate and useless for
eleven photographs.

- [x] `registerFileManageChecker` beside the existing read registry — a second registry rather than
      a flag, because reading and removing are different questions. Every read checker written so
      far is permission-based, so folding removal in would have handed deletion to everyone who can
      look. The default is uploader-only.
- [x] `files.forEntity` / `files.remove`, both **ungated by any `p("…")`** and deliberately: "who
      may see the files on this record" is a different answer for a certificate, a supplier's
      quotation and a site photograph, and each module already answers it. A permission here would
      either override those answers or lock out the people they exist to admit.
- [x] `?download=1` on `/api/files/[id]`, which asks Supabase for a `Content-Disposition:
      attachment` signed URL under the original filename. Inline stays the default — the company
      asked for both, and they are different actions.
- [x] An `Attachments` component: thumbnails from the `-web` derivative the upload path has always
      generated, full size in a lightbox on click, a download control per file, and a remove control
      that appears only when the server says this person may.
- [x] Removal **refuses when a parent record still points at the file** — a principal's
      `priceListFileId`, an accreditation certificate. The alternative is a dangling id whose only
      symptom is a broken link on a page nobody opens until it matters.
- [x] Site video gets §7.2's higher 200 MB ceiling, which is the case that section names by hand.

**Supplier pricing assumed one supplier per job.**

- [x] **Several principals at once.** The company's reason is the ordinary one the spec did not
      anticipate: a skid is a flowmeter from one manufacturer, a valve from another and a gauge from
      a third. One RFQ *per* supplier, not one shared — each gets its own number, its own clock and
      its own document, because a supplier must never see that they are being compared or against
      whom. Not transactional across suppliers: if the second of three fails, the first is a real
      numbered sendable request and rolling it back would burn a number for nothing.
- [x] **The comparison matrix can now cost one line from one supplier.** `applyRfq` already took a
      line list; the UI only ever applied whole RFQs, which on a three-manufacturer job would
      overwrite a line another supplier had won.
- [x] **The RFQ document asked for four columns and printed three.** It said "complete the four
      right-hand columns" over unit price, lead time and valid until. The missing one was
      **currency** — one of the four things §3.2 says a response must contain, demoted to a footnote,
      so a supplier who filled in the table had answered three of four questions and omitted the one
      that is most expensive to get wrong. Now a column, and the footnote asks only about ex-works
      versus delivered.
- [x] "Request supplier pricing" and the pipeline's "Record customer PO" are **blue**, at the
      company's request. Spec.md §6.3 gives blue to "every primary action" and both of these are the
      only action on the thing they sit on; a ghost button on a white card reads as a label.

**Principals.**

- [x] **Only EA and KJ can appoint**, through a new `principal.appoint` permission. EM keeps the
      pipeline — every other stage is a note about how a conversation is going — but appointing
      commits AIES to represent a manufacturer, converts into a module 03 supplier, and is what
      unlocks quoting from them. The button is hidden rather than shown-and-refused, with a line
      saying why.
- [x] **The service refuses when the permission set is absent**, rather than skipping the check.
      `ActorMeta.permissions` is optional so sweeps need not fabricate one, and the acknowledgement
      check reads absence as "not a person, skip". That default is wrong here: nothing appoints a
      principal automatically, so the safe reading of a missing permission set is no. A test pins it.
- [x] **The agreement requirement can be set aside**, for the case the company gave — "sometimes
      these are not needed for small suppliers". Same permission, a written reason of at least ten
      characters, recorded on the prospect *and* in its own audit row, because "who appointed this
      principal without an agreement and what did they say" is a question an ISO 9001 auditor asks
      by itself. Passing a reason when the documents were there all along does **not** mark an
      override — a false entry in an audit trail is worse than none.
- [x] **Uploaded files are visible and removable.** The agreement and price-list blocks now show an
      on-file badge, view, download and "wrong file — detach"; a third section lists everything else
      on the prospect, including files detached from those two roles — which is the point, since an
      unreferenced file was previously invisible and still in the bucket.

**Accounts.**

- [x] **Contacts can be added, edited and removed, several per customer and per plant.** The model
      has supported this since session 2; the only writer was `setPrimaryContact`, which creates
      exactly one. So a customer with four plants had one name against it and the other three lived
      in somebody's phone. Grouped by plant on the page, because the question is never "who do we
      know here" but "who do I ring about Plant 2". Numbers and addresses are tappable — §6.6
      expects this on a phone in a plant.
- [x] **Exactly one primary per account**, enforced in the transaction rather than by a partial
      unique index: demoting the incumbent in the same statement is the same guarantee with a better
      failure mode. Removing the primary leaves the account with **none** rather than promoting
      somebody — which of four plant engineers speaks for the company is not a question software
      should answer alphabetically.
- [x] **"Accounts not contacted" is now "Accounts with no activity"**, and it means something wider.
      The old list read the `Activity` log alone, so a customer who had placed an order last week
      appeared on a chase list because nobody had typed a call into the CRM. Now a purchase order, a
      quotation going out and an inquiry arriving all count, and the row says *which* — "last order
      84 days ago" and "last call 84 days ago" are different problems. Editing a record still counts
      for nothing.
- [x] **A customer goes dormant after 500 days with no purchase order**, and wakes when one arrives.
      This is the only thing in the build that changes a business record's status with nobody behind
      it, so three guards: `blacklisted` is never touched (that status is somebody's decision with a
      reason, and replacing it with a milder one erases that on the day it counts); only accounts the
      sweep itself parked are revived, which is what the new `autoDormantAt` column distinguishes;
      and every change writes an audit row as `System` with `actorId: null`.
- [x] **A quotation that has gone quiet for seven days raises a follow-up.** §6 asked for "quotes
      expiring this week" and module 01 could not provide it. This is the better question — expiry is
      the *end* of the silence and by then the customer has moved on. "No feedback" is read from the
      record rather than from anybody remembering to log it: still `sent`, no negotiation round, no
      PO. It fires on day seven and then weekly, and names the specific document rather than
      collapsing into "you have 3 quiet quotations".
- [x] **Accreditation certificate upload and expiry — the service was built, and unreachable.** The
      first answer given to the company was that §5b was already done, which was true of everything
      *except the way in*. They asked where to upload a certificate, and there was no answer: the
      register at `/crm/accreditations` lists records that already exist, and its empty state said to
      go to the customer's account and start one — where the accreditation card was **read-only**.
      Two screens each pointing at the other, and no way to create the first record, upload a
      certificate or type an expiry date anywhere in the app. `AccreditationPanel` had carried a
      "Start accreditation" button since session 3; it was only ever rendered inside a row that
      could not exist yet.
- [x] Fixed at both ends. The register gained a "Start tracking a customer" panel — customers
      already tracked are filtered out rather than offered and refused, since the model allows one
      live accreditation each. The account card now renders the panel inline, gated on
      `accreditation.manage`.
- [x] Everything behind it *was* built and is untouched: certificate on the record, expiry typed by
      the accountable person rather than parsed off a scan, status derived from the date so a record
      still saying `accredited` with a past expiry reads as expired, and `renewal_due` with
      acknowledgement plus a 30/45/60-day escalation to EA and KJ.
- [x] **Worth generalising:** a service with tests and a panel with no route to it passes typecheck,
      lint and 609 tests. Every "already built" claim in this file is a claim about code, not about
      whether anybody can reach it. The module 00 gate's "not visually verified" list exists for
      exactly this and did not catch it, because the panel *was* on a screen — just not on one that
      could ever show it.

**Quotations.**

- [x] **Archived 14 days after the customer PO arrives.** Not on receipt, deliberately: the
      fortnight after a PO is exactly when people still open the quotation, to check what was quoted
      against what the PO says. Archiving then would hide the document during the only period it is
      still in daily use.
- [x] **Archived is not deleted and not a status.** `deletedAt` means the record should not have
      existed; `status` is what the customer did, and an archived quotation still reports `accepted`.
      It is a statement about which screen a finished document belongs on, so it is its own column,
      its own permission (`quotation.view_archive`, EA and KJ), and a filter the *service* applies
      rather than a flag the UI hides.
- [x] The default is the working list **for everybody, including the two who can see the archive** —
      nobody opens Quotations to look at last year's closed business. A salesperson who asks for
      `archived: true` silently gets the working list rather than an error, because an error would
      confirm an archive exists.
- [x] **The record still opens by id** for anybody who could open it before. A link in an email from
      last year should not break.
- [x] `unarchive`, because the sweep is automatic and therefore occasionally wrong — a PO gets
      cancelled. It says plainly that tonight's sweep will take it again unless the PO itself
      changes, since fixing that is module 03's job and does not exist yet.

**Also:** `AIESLQ261148` and `AIESLQ261149` were destroyed outright at the company's word — rows
gone, not flagged. `scripts/purge-quotations.ts` is the tool and it is deliberately **not** the
delete button: it exists for records created to try the app out, which never reached a customer, and
it refuses anything with a customer PO behind it. Their numbers left the unique index, so the
caveat the counter reset printed is gone.

**Migration** `20260815040030_company_feedback_batch_two`: `CustomerAccount.autoDormantAt`,
`PrincipalProspect.appointmentOverride{Reason,By,At}`, `Quotation.archivedAt`. Two new permissions
seeded — `principal.appoint` and `quotation.view_archive`, both president and vice-president.

### A third batch — including a security header that hid every photograph

- [x] **No photograph in the app could ever be displayed, and the cause was CSP.**
      `/api/files/[id]` checks permission and then **redirects** to a short-lived signed URL on the
      storage host, which is exactly the shape specs/00-foundation.md §7.2 asks for. CSP evaluates
      `img-src` against the URL a request *ends* at, not the one it starts at — so `img-src 'self'`
      blocked every image, silently, with nothing in the server log and only a console violation.
      Reported as "the uploaded photo does not show when clicked"; it was never the upload.
      Certificates appeared to work because "View" is a link, and `img-src` does not govern
      navigation, so the fault stayed invisible until something rendered bytes inline. Fixed by
      allowing the configured storage origin — derived from `SUPABASE_URL`, so it is our own bucket
      and nothing else.
- [x] **Plants can be added to a customer.** The third instance of the same shape as contacts and
      accreditation: `Site` was modelled properly in session 2, inquiries and quotations and
      inspections all point at one, and every picker was empty because nothing could create one.
      Access notes get their own field and their own emphasis, since §2 names gate pass, PPE and
      induction and the cost of missing them is a lost day at a gate. Removal refuses while an
      inquiry, quotation or inspection still names the plant; contacts attached to it survive and
      simply stop being tied to a building.
- [x] **Each supplier is asked about its own lines.** The company: "make it so, that a line item is
      requested to a selected supplier." Yesterday's multi-supplier work sent the same line set to
      everybody, and their own data shows what that produces — two requests where each supplier
      priced its item and wrote a zero against the other's. The form is now one block per principal
      with its lines nested inside it, which is the only shape that can express the real pattern.
- [x] **A recorded price now reaches the quotation lines by itself, when there is nothing to
      decide.** The company asked whether applying should be manual "since the response is also
      manually recorded", and they were right to ask: §3.5's Apply was a second button on a panel
      that gave no sign it was waiting, so prices sat on the request and the lines stayed at zero.
      Uncontested lines are carried on save; contested ones still wait for a person, because with
      two offers on one line there is a genuine purchasing decision and §3.6's matrix exists so
      somebody makes it. When a carry cannot happen — a foreign-currency price with no rate, a sent
      quotation — the response is still recorded and the screen is told why.
- [x] A request whose price has not reached the quotation now says so on the row, in orange. That
      state was previously indistinguishable from a finished one.
- [x] **Revise is blue.** §5 makes a sent quotation immutable, so once one is with a customer this
      is the only way to change anything on it — a ghost button on the sole permitted action reads
      as decoration.

**Found while checking the above, and worth its own line:** the two full-suite runs burned ~330
quotation numbers from the **live** counter, because tests call `createQuotationService`, which
allocates from the same `DocumentSequence` the app uses. The company's own "Test sale" quotation
came out as `AIESLQ260332`. Nothing is corrupt and no number was reused, but the series no longer
reads like a young company's. See "Known issues" — the fix is isolation, not another renumber.

### A fourth batch — three of the five were bugs, and two were invisible

- [x] **The supplier's price *was* reaching the database and never reaching the screen.** Yesterday's
      carry wrote the cost correctly; `LineEditor` never re-read it. It seeds its rows from
      `initialLines` with `useState`, so React takes that value once and ignores every later one —
      right for a form, since it is what lets typing survive a background refetch, and silently
      wrong for anything that changes the lines from *outside* the editor. The page refetched, the
      data was correct, and the component went on rendering the zero it was born with until somebody
      reloaded the browser. Now keyed on `version`, which `saveQuotationLinesService` bumps on every
      write — so it remounts exactly when the stored lines move and never otherwise.
- [x] **The comparison panel appeared "sometimes".** It was deterministic; the condition measured
      the wrong thing. `comparison.data.length > 1` reads like "more than one supplier" and is not —
      the array holds **one row per quotation line**, so the panel only appeared once two different
      lines had offers. A one-line job with three manufacturers competing, which is precisely what
      §3.6 exists for, never showed it.
- [x] **"Use this" appeared to be missing on one supplier and aligned on another.** Every offer for
      a line was a free-flowing flex row inside a single cell, so each button landed wherever that
      offer's text happened to end — after a lead time on one, after a "cheapest" badge on the next.
      Now a real table: one row per offer, fixed columns, and the action column always present even
      when it holds a "costed" badge instead of a button.
- [x] **A plant can be chosen when logging an inquiry, and it carries to the site inspection** —
      which is what the company asked for and why: "so that the technician assigned will know which
      plant to go to." The inspection form defaults to the inquiry's plant and shows that plant's
      access notes inline, so gate pass and PPE are read before somebody leaves rather than at the
      gate. Both dropdowns stay hidden for a customer with no plants, because a picker offering only
      "not sure yet" is a field to skip past on every intake.
- [x] **A pipeline card no longer shows the intake guess forever.** It reports the best-known figure
      and names which it is — **purchase order** beats **quoted** beats **estimate**. The specific
      gap: the card's quotation query looked only at `sent`/`under_negotiation`, and recording a PO
      flips the quotation to `accepted`, so the card fell back to the guess at the exact moment it
      knew the most. Five tests pin the ladder, including that a card with no estimate shows blank
      rather than zero — "0" reads as a job worth nothing.

### Clearing the four standing caveats

The company asked what should be done about each of the four risks this file had been carrying.

- [x] **No UI had ever been systematically reviewed → the end-to-end suite now signs in for real.**
      The reason nothing automated had seen a single screen was the mandatory TOTP gate. `otpauth`
      was already a dependency — the server uses it to *verify* codes, and the same library
      generates them — so a Playwright test can compute a valid second factor from a seeded secret
      and log in exactly as a person does. 14 tests: every route renders, resolves its loading state
      and raises no CSP violation, plus two written as regressions for bugs that shipped (a customer
      record must offer "Add a plant", "Add a contact" and the accreditation control; the quotation
      panels must read Details → Lines → Supplier pricing → Terms). Runs in CI after the build.
      docs/DECISIONS.md #38.
- [x] **The suite burning real document numbers → renumber by hand, deliberately.** The company's
      call, and the right one: isolating the suite in its own schema was built, verified working and
      reverted because the cost had outgrown the problem. They will name trial records "test …", so
      `purge-deal.ts` gained `--prefix test` to clear a whole set in one command.
- [x] **Vercel → after module 03, not now and not at the very end.** Nothing in the build depends on
      it, so deferring costs nothing today; what stays untested until then is the nightly cron, which
      has never once run on a schedule. Module 03 is the point where the app covers a whole business
      flow — inquiry to quotation to order — and so becomes worth putting in front of people on
      their own phones, which is where every useful piece of feedback so far has come from.
- [x] **The permanent TOTP lockout → recovery codes**, and explicitly not an admin reset, which
      would trade a lockout risk for a total-compromise one. docs/DECISIONS.md #37.

**Migration** `20260815130136_recovery_codes`: one `RecoveryCode` table.

### Next concrete step

**Module 03 — Customer PO, Sales Order, Procurement and Delivery.**

Its opening act is already in place: `CustomerPO`, its manifest and `customer_po.received` were
pulled forward in session 3 for the pipeline's Received PO column, and module 02 already reacts to
that event by marking a quotation `accepted`. What specs/03-order-procurement.md adds is the rest of
§2's models — `SalesOrder`, `SalesOrderLine`, `Supplier`, `SupplierPO`, `GoodsReceipt` — and §1's
fan-out into finance, procurement and operations, which it is explicit should be **independent
workstreams rather than one status chain**.

Two things to carry in:

1. ~~`SupplierQuoteRequest.supplierId` and `PrincipalProspect.supplierId` are plain ids waiting for
   module 03's `Supplier` to exist.~~ **Done in module 03 session 1** — both are foreign keys, the
   live rows were backfilled first, and the RFQ flow reads real suppliers.
2. `po_received → won` is still system-set with nothing setting it. A received PO is not a delivered
   job; module 03 is where that becomes decidable — session 3, when delivery exists.

**Small and still open in module 02:** the line editor shows the raw cost but has no field for the
FX rate, so a foreign-currency line can only be costed through the RFQ flow today.

*Both of the items this section used to list are done:* §9's quote templates are built (a separate
`QuoteTemplate` model, not an `isTemplate` flag — a flag would have to be excluded from every
quotation query, and the first one that forgot would show a template to a customer as a live
quotation), and the review gate above has been run.

*Still wanting a human eye:* the RFQ panel, the negotiation panel and the reuse panel were verified
by server tests and a clean production build, not on screen — all three sit behind the TOTP login.
The RFQ PDF was rendered from a throwaway record and its props asserted.

**State at this stop.** Working tree clean, tagged `module-02-complete`. **628 tests** across 74
files pass on a clean run with the dev server stopped; lint and typecheck clean. Everything is ahead of `origin/main` and
**unpushed** — push it, or don't, but know that it is only on this machine.

Module 02 is finished, sessions 3 and 4 both: §6's approval and its queue, §7's auto-expire, the
working-hours fallback window, §3's supplier RFQ, §8's negotiation and what-if, §9's reuse and
templates — and, added at the company's request rather than from the spec's running order, the
pipeline's Sent and Received PO columns, four document corrections, and the five items above.

*The database now holds only real work*, after a second clear-out on 2026-08-15: two customer
deals — `INQ-2608-0001` → `AIESLQ260001` → PO 123456798, and `INQ-2608-0002` → `AIESLQ260002` →
PO 321654987 with `RFQ-26-0001` behind it — on `ACC-0001` A4One, plus two appointed principals and
one accreditation. Counters sit at the floor: inquiry 2, quotation_local 2, supplier_rfq 1, account
1, so the next of each is `0003`/`0003`/`0002`/`ACC-0002`.

Three trial deals ("Test sale", "test sale 2", "test sale 3") were destroyed outright with
`scripts/purge-deal.ts`, which takes inquiry numbers and removes the whole chain — inquiry, every
quotation revision, the customer PO, the supplier RFQs, the inspections and the files. It exists
because `purge-quotations.ts` deliberately *refuses* when a PO points at a quotation, which is right
when the order is real and wrong when the entire deal was a test. Do not run `npm run demo:crm`
again unless demo data is wanted back.

*Still wanting a human eye:* the PDFs were verified by measurement and by asserting the assembled
props, **not** by looking at them — no PDF renderer exists in this environment. The approval queue
and the PO dialog were verified by server tests and a clean compile, not on screen, because both sit
behind a TOTP login. Worth ten minutes with a browser before the first real quotation goes out.

*What session 4 set out to do, for reference:*

1. **§3's supplier RFQ sub-flow.** `SupplierQuoteRequest` and `SupplierQuoteLine` are in the schema
   from session 1 and have no service behind them. PD owns this (`supplier_rfq.manage` is already
   seeded to `admin_manager`): raise a request against a quotation, record what came back, and let a
   quotation line point at the supplier line it was costed from — `QuotationLine.supplierQuoteLineId`
   already exists for it.
2. **§8's negotiation.** Status `under_negotiation` with a structured round log: the customer's
   counter-position, AIES's response, who authorised it, and the resulting revision.
3. **§8's what-if calculator.** `discountForTargetTotal` in `costing.ts` is already written and
   tested — this is the UI on top of it, plus "does this breach the margin floor, and shall I raise
   the approval in place?".
4. **§9's reuse**: duplicate a quotation with a refresh-costs prompt for stale supplier pricing,
   quote templates, and the product catalogue building itself from real lines.

**Settled:** the standard terms are now AIES's own, in
`src/server/core/quotation/terms.ts`. They still move to module 09's settings when that exists,
alongside `getCompanyDetails()` — at which point that file becomes the *default* set a new quotation
is seeded from, which is what it already is in everything but storage.

Notes for whoever picks this up:
  - **Never pass a real database URL as `--shadow-database-url`.** Prisma wipes it. docs/
    DECISIONS.md #24.
  - **`prisma migrate dev` offering to reset the schema is not proof that anything is wrong with it.**
    It says "all data will be lost" for any checksum disagreement, including a rolled-back row left
    by `migrate resolve --rolled-back` and a CRLF→LF normalisation by `git add`. Run
    `npx tsx scripts/check-migration-checksums.ts` first; `--fix` repairs those two cases and refuses
    everything else. docs/DECISIONS.md #44.
  - Use **`npm run build:check`**, not `npm run build`, while a dev server is running.
    docs/DECISIONS.md #17.
  - **Never use `Promise.all` inside a Prisma interactive transaction** — one connection, and the
    failure reads as "Can't reach database server".
  - A client component importing a *service* fails `next build` and not typecheck; the lint rule in
    `eslint.config.mjs` catches it now. Shared constants live in the pure rules files.
  - `allocateNumber` takes no transaction client, so a rollback burns a number. Gaps are permitted
    by Spec.md §5, but quotations are customer-facing — revisit before module 02 issues QTN numbers.
  - The repo lives at `C:\dev\aies`, deliberately outside OneDrive.
  - **Nothing in `instrumentation.ts` may touch Prisma, the file system or a `node:` builtin.** Next
    compiles that file for the edge runtime too, and a `NEXT_RUNTIME` guard is a runtime check
    against a compile-time problem. docs/DECISIONS.md #28.
  - `.tsx` outside Next's own compilation (the PDF documents) needs the automatic JSX runtime
    configured explicitly — `vitest.config.ts` sets it; plain `tsx` scripts cannot import them.
  - **The pre-commit hook rewrites your files.** `.husky/pre-commit` runs `lint-staged`, which runs
    `eslint --fix` and `prettier --write` over everything staged — so what lands in a commit is not
    byte-for-byte what was staged, and every commit in this build has been reformatted on the way in.
    It stashes first and restores after, so if a commit is interrupted, check `git stash list` before
    concluding that work was lost. Treat `.husky/` as reviewable code: it is one line today, and a
    hook is arbitrary code running with your permissions and access to `.env`.
  - **Run nothing else against the dev database while the suite runs** — no dev server, and no
    second `vitest` invocation. It is now *safe* rather than merely discouraged: `relayOutboxToJobs`
    skips a row that vanishes mid-pass instead of throwing (2026-08-15), so the dev drainer no
    longer 500s when a test deletes an outbox row underneath it. The rule stands anyway, because
    test data still lands in whatever screen you have open. Both have produced a red run that
    looked like a regression:
    `queue.test.ts` once failed asserting `dead` on a job the dev drainer had already claimed, and
    `relay.test.ts` once failed because `relayOutboxToJobs` relays *every* unrelayed outbox row, so
    it picked up a row belonging to a concurrently running test file which then deleted it
    mid-transaction. The suite is single-file-serial (docs/DECISIONS.md #7) but it is not isolated
    from anything outside itself.
  - Approval windows count **working** hours (docs/DECISIONS.md #29), so any test of an elapsed-time
    rule must pin a holiday provider and use fixed Manila instants. Offsets from `Date.now()` mean
    what they say only on a working day, and would silently invert if the suite ran on a Saturday.
  - `ActorMeta.permissions` is **optional**, and the acknowledgement check is skipped when it is
    absent. That is deliberate — event subscribers, sweeps and scripts have no permission set and
    pass `bySystem` instead — but it means a *new* router that forgets to populate `actorMeta` would
    silently lose the check. The crm router populates it; anything new must too.

## In progress — Module 03, Customer PO, Sales Order, Procurement and Delivery

### Session 1 — the supplier directory, §3's three-way check, and the sales order

§1 calls this module's opening "where the deal stops being a sales artifact and becomes an
obligation". This session builds that spine and nothing downstream of it.

- [x] **§2's `Supplier`, and the RFQ cutover it unblocked.** `SupplierQuoteRequest.supplierId` and
      `PrincipalProspect.supplierId` were plain ids waiting for this model; both are foreign keys
      now, the two existing prospects were backfilled into SUP-0001 and SUP-0002, and
      `rfq-service.ts` reads real suppliers rather than appointed principals. The RFQ flow no longer
      pretends a prospect is a vendor.
- [x] **§5c's conversion, finally wired.** Module 01 has emitted `principal.appointed` with a
      complete payload since its session 3, and `createSupplierFromPrincipalService` sat waiting for
      a caller. The order manifest is the caller. Idempotent, because the job queue guarantees
      at-least-once and not exactly-once; the prospect's `supplierId` is the guard and the database
      enforces it.
- [x] **ISO 9001 clause 8.4 approval**, on its own permission — the control this build has listed as
      owed since module 01. docs/DECISIONS.md #41.
- [x] **`/suppliers`**: a searchable, sortable, exportable table, a fast-and-forgiving create form
      (name is the only required field, as §2 insists), and a record panel carrying the approval
      decision and its audit trail.
- [x] **§3's three-way check** as a pure function — currency, amount, line quantities, missing and
      extra lines — with the blocking/advisory split argued out in docs/DECISIONS.md #39. Twelve unit
      tests, no database.
- [x] **Verification is a decision somebody explains.** `verifyCustomerPoService` refuses to record a
      verification with differences unless a reason is given, and writes that reason to the record as
      well as to the log.
- [x] **§3's sales order**: four independent status columns per §1's "independent workstreams rather
      than one status chain", lines copied rather than referenced, `requiresExecution` set from
      `itemType`, and `sales_order.created` emitted with per-line flags for module 04.
      docs/DECISIONS.md #40.
- [x] **The check has a screen**, on the quotation record beside the PO it compares — findings first,
      then the note, then the button that raises the order. A service with no route to it is the
      failure this build shipped three times (docs/DECISIONS.md #38); `/suppliers` is likewise
      covered by the e2e sweep and by the nav-integrity test.

**Migrations** `20260815140000_module_03_supplier_sales_order` (`Supplier`, `SalesOrder`,
`SalesOrderLine`, and `PrincipalProspect.supplierId`) and `20260815150000_rfq_supplier_fk`, kept
separate on purpose: the foreign key from `SupplierQuoteRequest` could only be added *after*
`scripts/backfill-suppliers-from-principals.ts` had given every live RFQ a supplier row to point at.
Adding both at once would have failed against real data.

**State at this stop.** **678 tests** across 78 files pass on a clean run with the dev server
stopped; typecheck, lint and `build:check` clean; committed and pushed. One thing worth knowing about
that run: the two failures it started with were in `principal-flow.test.ts`, which had been passing
`"sup_1"` and `"sup_2"` as supplier ids since module 01 — fine while `supplierId` was a plain string,
rejected now that it is a foreign key. The fixture was fixed to create real supplier rows, **not** the
constraint relaxed: the whole promise of §5c is that an appointed principal has a supplier record,
and a link to a fictional one keeps the letter of the rule while breaking the point of it.

### Session 2 — §4's downpayment gate and §5's supplier PO

- [x] **`SupplierPO` and `SupplierPOLine`**, with the landed-cost columns §5 insists on and the two
      override records §4 asks for.
- [x] **§5's "select lines → group by supplier → generate draft POs"** — one call, one PO per
      distinct supplier. Costs default from the sales order line, which carries the quotation's cost,
      which came from the supplier quote.
- [x] **Both gates, at send, both overridable with a reason by an officer, neither silent.**
      docs/DECISIONS.md #42. This is where session 1's clause 8.4 approval finally stops something.
- [x] **§5's approval through the generic engine** — one step, no conditions, its own
      `ApprovalRule` key. No `if (total > x)` and no role name in a conditional, the same shape
      module 02 §6 uses. The rule row is created on first use as well as seeded, because relying on
      the seed alone means an un-reseeded database throws a raw Prisma error on the approve button.
- [x] **§5's landed cost**, allocated by value in integer centavos with the remainder to the largest
      line, so it sums exactly to the charge. docs/DECISIONS.md #43.
- [x] **The branded PO PDF and the draft email text** (§5's "issue manually"), with the customer's
      name and the landed total deliberately absent from both.
- [x] **§5's expediting view** at `/procurement`: every open commitment, days late, and whose
      delivery it holds up.
- [x] **`/sales-orders` and `/sales-orders/[id]`** — closing session 1's own dead end, where
      `listSalesOrders` and `getSalesOrder` existed with no route to them. The record shows §1's
      three workstreams as three blocks, and §4's gate indicator "so nobody has to ask finance in a
      chat app".
- [x] Fixed two things found on the way: the RFQ PDF had been resolving its supplier through
      `PrincipalProspect` since the session 1 cutover and so addressed every document to "Supplier";
      and the sidebar's `truck` icon was never added to `AppShell`'s map, so the suppliers entry has
      been rendering a blank placeholder since session 1.

**Migration** `20260816000130_module_03_supplier_po`.

**Still to build in module 03:** goods receipt (§6) with its mandatory incoming inspection, delivery
(§7), and the §1 fan-out into finance and operations. `po_received → won` is still system-set with
nothing setting it — a received PO is not a delivered job, and that becomes decidable once delivery
exists.

**State at this stop.** **734 tests** across 81 files pass on a clean run with the dev server
stopped; typecheck, lint and `build:check` clean. `npm run seed` was run, because the three new
permissions and the `supplier_po.approve` rule only reach the database through it — a manifest
permission that never reaches the seed leaves every procedure gated on it permanently 403 with
nothing visibly wrong.

**Deliberately not built:** `downpayment.required` is not emitted and `financeStatus` still starts at
`not_required`, because `PaymentTerm.downpaymentPct` is module 05's and there is nothing to read. The
gate is built, tested and inert; it starts working the day a term carries a percentage.

## Not started
- [ ] Modules 04–10
- [ ] Module 03 session 3 — goods receipt with its mandatory ISO 9001 clause 8.4.2 incoming
      inspection, delivery receipts, and the finance and operations fan-out. `goods_receipt.*` and
      `delivery.create` are **not** yet declared in the manifest, and neither are their events: a
      permission that appears later means a role assignment that has to be redone, but an *event*
      declared before anything emits it lets a later module subscribe to something that never fires,
      which fails silently. Declare each in the change that emits it.

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
- docs/DECISIONS.md #42-#44: module 03 session 2 (both procurement gates refuse by default and can
  be overridden by an officer with a reason, never silently, and never at draft time; the supplier PO
  prints the goods total rather than the landed total, and allocation rounds in integer centavos with
  the remainder to the largest line; a rolled-back migration row can make `prisma migrate dev` offer
  to destroy the database, and `scripts/check-migration-checksums.ts` exists so that is diagnosable).
- docs/DECISIONS.md #39-#41: module 03 session 1 (§3's check reports everything and blocks almost
  nothing — currency and an unquoted line, and nothing else; the sales order copies the quotation
  lines rather than referencing them, because the obligation is to what was ordered on the day;
  approving a supplier under clause 8.4 is a narrower permission than maintaining the directory, and
  the expiry is derived at read time rather than swept).
- docs/DECISIONS.md #18-#19: module 01 (the CRM account model is `CustomerAccount` because Auth.js
  already owns `Account` and its adapter calls `prisma.account` by name; accreditation records the
  outcome only — certificate and expiry — because AIES's own documents live on each customer's
  portal, and duplicating them made one mayor's permit into N expiry dates to maintain).

## Not visually verified

**Every route in this list is now loaded, signed in, by `tests/e2e/screens.spec.ts`** — it asserts
the page renders, resolves its loading state, raises no CSP violation, and shows the control that is
the reason to open it. That closes the gap that let three "the service works and nothing reaches it"
bugs ship.

What it does **not** do is look at anything. Alignment, spacing, colour, whether a table is readable
on a phone in a plant — none of that is asserted, and the module 00 manual pass found six defects
that 186 automated tests did not. So the list below stays, with its meaning narrowed: these render
and function; nobody has judged how they *look*.

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
- **Module 03's surfaces**: `/suppliers`, `/sales-orders`, `/sales-orders/[id]`, `/procurement`,
  `/procurement/[id]`, and the three-way-check block on the quotation record. The three list screens
  are in the e2e sweep, so they load and render their headings; the record screens and the check
  block are not, because reaching them needs a quotation with a recorded PO and the suite must not
  create one. Their server sides have 71 tests against the real database. **Nobody has looked at the
  gate block, the per-line supplier picker, the landed-cost column or the expediting table on
  screen.**
- **The supplier PO PDF** was verified by asserting its assembled props — no PDF renderer exists in
  this environment, the same limit module 02's documents have.
- `docker/docker-compose.yml` has never been executed at all (no Docker on this machine) — the
  `self-host-fallback` CI job is its first real run.

## Known issues / to revisit
- **The test suite allocates real document numbers**, and for now the answer is to renumber by hand
  rather than to isolate. `createQuotationService` and its siblings call `allocateNumber`, which
  increments the one `DocumentSequence` row the running app uses — and the suite creates a few
  hundred quotations per run against the same dev database. Runs on 2026-08-15 took the local
  quotation counter from 2 to 564. Nothing is corrupt and Spec.md §5 is not violated (no number was
  reused), but the series misrepresents the company's volume.

  **A separate `aies_test` schema was built and then reverted, at the company's instruction** — the
  fix had grown out of proportion to the problem. It worked, and was verified: `public`'s counters
  did not move for eight minutes while the suite drove `aies_test`'s from 32 to 88. What made it
  expensive was one detail — `pg_trgm`. Prisma's migration engine requires `?schema=`, which pins
  the search path to a single schema, so `similarity()`, the `%` operator and `gin_trgm_ops` all
  became unreachable; making that work needed the extension relocated to `extensions`, a
  failure-tolerant two-pass deploy, and `migrate resolve` either side of three hand-written
  `CREATE INDEX` statements. For a five-person company that renumbers a handful of records now and
  then, that is the wrong trade. See docs/DECISIONS.md — the near-miss it produced is worth reading
  before anybody tries again.

  **If it is attempted again**, the two things that cost the most time: `?schema=` and
  `options=-c search_path=` are not interchangeable (Prisma overrides the latter with the former,
  and `db push` silently diffs against `public` without the former), and a `search_path` fallback
  does not fail on a missing table — it finds a different one. Assert the schema was actually built
  before trusting any "success" message.

  The standing rule therefore still applies: **run nothing else against the dev database while the
  suite runs**, and renumber afterwards with `renumber-to-restart-series.ts` and
  `reset-numbering-counters.ts`.
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
  drain` and `/api/cron/nightly` are built and tested but have never been invoked by a real cron
  scheduler. **In development the drain half is covered** by `src/instrumentation.ts`, which relays
  and drains every 5s; the nightly sweeps still have to be triggered by hand
  (`curl -X POST http://localhost:3000/api/cron/nightly`). Configuring the real scheduler is a
  deployment concern.
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
- ~~**Losing an authenticator locks a user out permanently.**~~ **Fixed** — ten single-use recovery
  codes, issued at enrolment and shown once (docs/DECISIONS.md #37). Redeeming one signs the user in
  *and revokes the enrolment*, so the factor is restored rather than skipped, which is what keeps it
  compatible with §4.1's "no opt-out". Deliberately **not** an admin reset: letting a signed-in
  president clear somebody else's second factor would mean one compromised officer account could
  take over every other account without knowing a password. `npm run reset:credentials` remains the
  last resort for the case where the codes are gone too. 12 tests, most of them refusals.
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
