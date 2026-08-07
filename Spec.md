# AIES Operations Platform — Master Specification

> **How to use this file.** Paste this document into Claude Code as your first prompt. It is the
> master spec. It defines the product, the architecture, the conventions, and the build order.
> Each module has its own spec under `specs/`. Build them in the order given in
> [§9 Build Order](#9-build-order). Do not attempt to build everything at once.

---

## 0. Prompt to Claude Code

You are building an internal ERP + CRM + collaboration platform for **AIES Electromechanical
Corporation**, a Philippine industrial sales and services company.

Work as follows:

-1. Read `docs/BUILD-PROTOCOL.md`. It governs how you work: maintain `docs/PROGRESS.md`, commit
   after every chunk, and stop at the session boundaries listed there rather than running until
   you run out of context.
0. Read `docs/DECISIONS-CONFIRMED.md` first. Those are the company's own answers, not defaults.
   Where this spec and that file could be read as disagreeing, that file wins.
1. Read this entire master spec before writing any code.
2. Read `specs/00-foundation.md` and implement it completely. Stop and let me review.
3. Then implement modules one at a time in the order in §9. After each module: run the test
   suite, run the linter, run the migration, and stop for review.
4. Never break a previously completed module. If a later module requires changing an earlier
   one, write a migration and update that module's spec file in the same commit.
5. If a requirement in this spec is ambiguous, do not guess silently. Implement the most
   conservative interpretation, and add an entry to `docs/DECISIONS.md` stating the ambiguity,
   what you chose, and why.
6. Every module must ship with: Prisma schema changes, migration, seed data, server logic,
   UI, RBAC rules, audit logging, and tests. A module with no tests is not done.

---

## 1. The Business

AIES supplies industrial instrumentation and electromechanical equipment and performs
inspection, installation, commissioning, calibration, preventive and corrective maintenance,
and after-sales support. Industries served: power, water and wastewater, food and beverage,
manufacturing, laboratories, oil and gas.

Every customer has different requirements. There is no standard product catalogue that covers
most revenue — most deals are engineered-to-order and quoted individually against a principal
supplier's price. **The system must treat the quotation as the central engineering artifact,
not as a line-item invoice generator.**

### 1.1 The end-to-end flow the system must model

```
INQUIRY ──> EVALUATION ──> SUPPLIER RFQ ──┐
   │             │                        │
   │             └──> SITE INSPECTION ─────┤ (when scope is unclear)
   │                                       │
   └──────────────────────> QUOTATION <────┘
                                │
                    ┌───────────┴───────────┐
                    │                       │
              NEGOTIATION              CUSTOMER PO
                    │                       │
                    └───────────> SALES ORDER
                                        │
              ┌─────────────────────────┼─────────────────────────┐
              │                         │                         │
        DOWNPAYMENT              SUPPLIER PO            TICKET GENERATION
        (if terms require)             │                         │
              │                   GOODS RECEIPT                   │
              │                        │                          │
              │                        └──────> (see §1.2 operations flow)
              │                                              │
              └──────────────> FINAL BILLING <───────────────┘
                                     │
                                 COLLECTION
                                     │
                              AFTER-SALES / PM
```

### 1.2 Operations flow (from `FLOWCHART - OPERATIONS.pdf` — authoritative)

A customer PO generates one or more **tickets**. The ticket type determines the route. Two gates
sit before mobilization and two after execution.

```
                            PO
                             │
                    TICKET GENERATION
                             │
              CASH ADVANCE REQUIRED? (Y/N)  ──N──> Cash Advance ──┐
                             │ Y                                  │
                             │◄─────────────────────────────────  ┘
        ┌──────────────┬─────┴──────────────┬──────────────┐
   NEW PROJECT    INSTALLATION         AFTER SALES      DELIVERY
        │              │                    │              │
  SITE INSPECTION      │                    │          DR REQUEST
        │              │                    │              │
   METHODOLOGY         │                    │           DR issued?
        │              │                    │              │
        └──────────────┴────────┬───────────┘         MOBILIZATION
                                │                          │
              MATERIAL REQUEST? (Y / N/A / N)         Look for contact
                                │                          │
                          MOBILIZATION              Item delivered? ─N─┐
                                │                          │ Y         │
                        PROJECT EXECUTION ◄──┐        DR SIGNED? ─N────┤
                                │            │             │ Y   (retry loop)
                            QA GATE ──fail───┤             │
                                │ pass       │             │
                    T&C (Testing & Comm.)    │             │
                                │            │             │
                        WARRANTY GATE ──claim┘             │
                                │ no claim                 │
                         SERVICE REPORT                    │
                                │                          │
                        PROJECT CLOSE OUT                  │
                                │                          │
                                └────► DEMOBILIZATION ◄────┘
                                              │
                                        FINAL BILLING
```

Four things in this flow drive the design and were not obvious from the narrative process:

1. **Ticket** is the company's own unit of operational work. Use that word everywhere.
2. **Cash advance is a blocking gate**, not an expense afterthought. A crew that mobilizes
   without cash loses a day.
3. **Material request is a blocking gate** with a legitimate `N/A` answer that must still be
   recorded as a decision.
4. **Delivery is a separate lane** with its own mobilization, demobilization, and retry loops —
   not a step inside a project.

### 1.2 What is broken today

| Problem | Consequence the system must remove |
|---|---|
| Quotes, expenses, project monitoring all in Excel/Sheets | No single source of truth; version conflicts; no history |
| All communication on external apps | Context lost; nothing tied to the deal or project |
| Work assigned verbally in meetings | No accountability, no record, ISO 9001 non-conformity |
| No CRM or pipeline tool | No forecast, no follow-up discipline, lost inquiries |
| No project tool | Field work invisible until it goes wrong |
| Everyone does everything | Needs role clarity in software, not org restructuring |

### 1.3 ISO 9001:2015 posture

The company intends to conform to ISO 9001. The platform is the QMS's operational backbone.
Design requirement: **every record that constitutes objective evidence must be immutable once
approved, attributable to a named person, and timestamped.** Module `08-qms-iso9001` maps
clauses to features, but the foundation module must make this possible from day one via the
audit log and document control primitives.

---

## 2. Product Principles

1. **One object graph.** An inquiry becomes a quotation becomes a sales order becomes a
   project becomes an invoice. These are linked records, not re-keyed documents. Any screen
   must be able to walk to any related record in one click.
2. **The activity feed is the app.** Every record has a threaded discussion with @mentions and
   file attachments. This is what replaces the external chat apps. Discussion lives *on the
   record*, not in a parallel channel.
3. **Nothing is assigned in a meeting.** Every unit of work is a task with an assignee, a due
   date, and a parent record. If it isn't in the system, it wasn't assigned.
4. **Documents are controlled, not attached.** Files live in a versioned DMS on the NAS with
   revision numbers and approval state. "Attachments" are references to controlled documents.
5. **Offline-tolerant field work.** Technicians work in plants with no signal. Field forms must
   capture offline and sync later. This constrains the mobile UI architecture — see module 04.
6. **Boring, auditable technology.** This is a small company running on a 2-bay NAS. Prefer a
   monolith with clear module boundaries over microservices. Prefer Postgres over anything
   exotic. Every dependency added must be justified in `docs/DECISIONS.md`.

---

## 3. Architecture

### 3.1 Hosting decision — read this before anything else

The Synology DS220+ was the intended host. **It is not viable for this application as configured,
and the platform will deploy to managed cloud instead.** The NAS keeps a real and useful job —
see §7.

Why the NAS was ruled out:

- The DS220+ has **2 GB of RAM and it is not being upgraded**. DSM itself uses roughly 700 MB–1 GB
  at idle. Postgres, a Node server, and a job worker do not fit in what remains without constant
  swapping to a 2-bay HDD array, which is slow and shortens drive life.
- A Next.js production build alone typically needs 2–4 GB. You would have to build elsewhere and
  ship an image, which removes most of the simplicity that made self-hosting attractive.
- The app must be reachable **from the open internet**. Exposing a home or office NAS to the
  public internet makes AIES responsible for TLS, patching, intrusion detection, rate limiting,
  and DDoS — on the same box that holds the company's files. That is a poor trade for a
  five-person team with no dedicated IT staff.

**Target deployment: GitHub → Vercel (app) + Supabase (Postgres, storage) + Synology NAS (backup
and archive).** At five users this costs roughly USD 25–45/month and can start on free tiers.

Design for portability anyway: keep Docker Compose working for local development and as a
self-host target, so that if AIES later upgrades the NAS to 6 GB or moves to a VPS, the same
stack lifts across. **Do not use a managed-service feature that has no self-hosted equivalent.**

### 3.2 Stack

| Layer | Choice | Rationale |
|---|---|---|
| Repo / CI | GitHub + GitHub Actions | Migrations, tests, and lint run on PR |
| Hosting | Vercel | Next.js native, preview deploys per PR, TLS and DDoS handled |
| Framework | Next.js 15, App Router, TypeScript strict | One deployable; server components keep the client light |
| API | tRPC v11 | End-to-end types, no OpenAPI maintenance for an internal app |
| DB | Supabase Postgres 16 | Managed, backed up, `pg_trgm` + `pg_cron` available |
| ORM | Prisma | Reviewable migrations, which matters for ISO change control |
| Files | Supabase Storage (S3-compatible) | Signed, short-lived URLs; synced nightly to the NAS |
| Jobs | **Postgres-backed queue table + Vercel Cron drain endpoint** | No Redis. Serverless-compatible. `pg_cron` for schedules. |
| Auth | Auth.js (NextAuth) v5, credentials + mandatory TOTP | Portable; not tied to Supabase Auth, so self-hosting stays possible |
| Realtime | Supabase Realtime | SSE does not work well on serverless functions |
| UI | Tailwind CSS + shadcn/ui + Radix | Fast to build, accessible primitives |
| PDF | `@react-pdf/renderer` | Quotations, DRs, invoices, service reports as reviewable templates |
| Email (outbound) | Resend or SMTP via `nodemailer` | Sending documents only — **no inbound ingest, see §3.4** |
| Search | Postgres `tsvector` + `pg_trgm` | No separate search service |
| Tests | Vitest (unit), Playwright (E2E) | |

**Do not add:** Redis, a microservice, Kafka, Elasticsearch, Kubernetes, a native mobile app, or
an SMS gateway. The field app is a PWA.

### 3.3 Job queue without Redis

Serverless functions cannot hold a long-running worker, so a Redis-backed worker library is out.

```prisma
model Job {
  id, queue, payload Json, runAt DateTime, attempts Int, maxAttempts Int
  status        // pending | running | succeeded | failed | dead
  lockedAt?, lockedBy?, lastError?, idempotencyKey?
  @@index([status, runAt])
}
```

- `POST /api/cron/drain` is hit by Vercel Cron every minute. It claims a batch with
  `SELECT ... FOR UPDATE SKIP LOCKED`, runs the handlers, and releases.
- Long jobs (close-out pack assembly, bulk export, PDF batches) split into chunks that each fit
  inside the function timeout, re-enqueueing the remainder.
- Scheduled work (nightly fact refresh, reminder sweeps, backup trigger) is enqueued by
  `pg_cron` or a second Vercel Cron entry.
- Idempotency key on every job. A duplicate cron invocation must not send an email twice.
- Dead-lettered jobs surface in the admin UI. Silent job failure is the main risk of this design;
  make failure loud.

### 3.4 Scope removed at the company's request

**Inbound email ingest and the website form webhook are out of scope for v1** (decisions 24, 25).
Inquiries are entered manually. SMS notification is out entirely (decision 30). Module 10 retains
outbound document email, the supplier directory, the accounting export, and the NAS backup sync.

Do not build the IMAP poller. Do not build the webhook endpoint. Leave the `Inquiry.source` field
and its `email` / `website` values in place so nothing has to change when these return.

### 3.5 Repository layout

```
aies-platform/
├─ Spec.md
├─ specs/
├─ docs/
│  ├─ DECISIONS-CONFIRMED.md    # the company's answers — authoritative
│  ├─ DECISIONS.md              # ADR log for ambiguities you resolve
│  ├─ DEPLOYMENT.md             # Vercel + Supabase + NAS runbook
│  └─ ISO-9001-MATRIX.md
├─ prisma/schema/               # split schema, one file per module
├─ src/
│  ├─ app/                      # routes grouped by module
│  ├─ server/
│  │  ├─ modules/<module>/      # router.ts, service.ts, policy.ts, events.ts, manifest.ts
│  │  ├─ core/                  # audit, rbac, numbering, events, storage, notify, jobs
│  │  └─ jobs/                  # queue handlers
│  ├─ components/
│  └─ lib/
├─ tests/
├─ scripts/                     # backup-to-nas, restore, seed
├─ docker/                      # local dev + future self-host
└─ .env.example
```

### 3.6 Module boundary rules

- A module owns its Prisma models. Cross-module reads go through the owning module's service
  layer, never by importing another module's client directly.
- Cross-module side effects go through the **domain event bus** (`src/server/core/events`), using
  a transactional outbox written in the same transaction as the business change, then drained by
  the job runner. This guarantees an event is never lost or double-delivered.
- Every module exports a `manifest.ts` declaring models owned, events emitted, events consumed,
  permissions defined, and nav entries contributed. Navigation and the permission matrix are
  assembled from these. **Build this in module 00.**

### 3.7 Core cross-cutting services (module 00 owns all of these)

| Service | Responsibility |
|---|---|
| `rbac` | Role + permission checks, record-level scoping, cost-field stripping |
| `audit` | Append-only log of every create/update/delete/approve with actor, before/after, IP |
| `numbering` | Document number generation (§5) |
| `events` | Domain event bus with transactional outbox |
| `jobs` | The queue in §3.3 |
| `storage` | Supabase Storage read/write with authz, checksum, NAS sync hook |
| `notify` | In-app + email + digest with per-user preferences |
| `customFields` | JSONB-backed user-defined fields on any entity |
| `approvals` | Generic multi-step approval attachable to any record |
| `attachments` | Links records to controlled documents in the DMS |
| `comments` | Threaded activity feed with @mentions on any record |

## 4. Roles and Permissions

AIES currently has **five people**, all of them managers, and every one of them wears several
hats. Model roles around the real people, and seed the future roles unassigned.

### 4.1 Active roles

| Person | Role key | Scope |
|---|---|---|
| EA | `president` | Everything. Full read and write, all approvals, all financials. |
| KJ | `vice_president` | Quotations, pricing, cost and margin, expenses. **Approves every quotation, every cash advance, every payment term, and liquidation extensions.** |
| PD | `admin_manager` | Customer accreditation, supplier price inquiry, government and statutory compliance, general admin |
| DJ | `operations_manager` | Tickets, projects, scheduling, dispatch, records client QA outcomes, close-out |
| EM | `marketing_manager` | Principal supplier and product acquisition, social media, customer relations, CRM |

### 4.2 Seeded but unassigned

`technician` (field execution, own tickets only), `sales` (own accounts and inquiries),
`finance_officer` (billing, collections, no approval authority), `viewer` (read-only, scoped).
These exist so the first hire takes five minutes, not a schema change.

### 4.3 Rules

- Users hold **multiple roles**. A five-person company has no clean separation of duties, and
  pretending otherwise means people share logins — which destroys the audit trail entirely.
- Permissions are strings namespaced by module: `quotation.approve`, `ticket.dispatch`.
- **Cost and margin are visible only to `president` and `vice_president`.** `finance.view_cost`
  is granted to those two roles only. Enforced by stripping the fields in the service layer, not
  by hiding them in the UI.
- Every permission check is enforced **server-side in the tRPC procedure**. Hiding a button is
  not access control.
- **Because the app is on the open internet with five accounts that between them can do
  everything, TOTP two-factor is mandatory for all users.** Not optional, not admin-only.
- Where a separation-of-duties rule cannot be satisfied by five people (preparer ≠ reviewer ≠
  approver), make it a two-person rule with a configurable, logged exception rather than a rule
  everyone routinely overrides. A control that is bypassed daily is worse than no control,
  because it produces false assurance.

### 4.4 Approval fallback — confirmed

**The President (EA) is the automatic fallback approver for everything the Vice President
approves**: quotations, supplier POs, cash advances, liquidation extensions, payment terms.

Automatic means automatic — no nomination step, no "delegate" button someone has to remember to
press before going on leave. Implement it as an escalation on the approval service:

```
ApprovalRule {
  primaryApproverRole: vice_president
  fallbackApproverRole: president
  escalateAfterHours: <configurable per approval type>
  escalationMode: parallel        // both may act after the window; first decision wins
}
```

- Before the window elapses, only the VP sees it in "Awaiting my approval". After it elapses,
  it appears in the President's queue too and **either may decide**. The VP's queue does not
  clear — this is a fallback, not a handoff, and the VP should still see what is outstanding.
- Default windows: cash advances **4 working hours** (a crew is waiting to mobilize), quotations
  **24 working hours**, everything else 24. Configurable per type in settings.
- The President can always act immediately, without waiting for the window, on anything.
- **Every fallback approval is recorded as such** — approver, that it was a fallback, and the
  elapsed time. The audit trail must never show a fallback approval as though the VP made it.
- Report on fallback frequency. If the President is routinely approving cash advances because the
  window keeps elapsing, that is a real operational signal — either the window is wrong or the
  approval load is on the wrong person — and it should be visible rather than absorbed.

## 5. Document Numbering

Configurable per document type in system settings. Defaults:

| Type | Format | Example |
|---|---|---|
| Inquiry | `INQ-{YY}{MM}-{####}` | INQ-2608-0042 |
| Quotation | `QTN-{YY}{MM}-{####}` + `R{n}` for revisions | QTN-2608-0042R2 |
| Sales Order | `SO-{YY}-{#####}` | SO-26-00142 |
| Supplier PO | `PO-{YY}-{#####}` | PO-26-00087 |
| Ticket | `TKT-{YY}-{#####}` | TKT-26-00061 |
| Cash Advance | `CA-{YY}-{#####}` | CA-26-00034 |
| Material Request | `MR-{YY}-{#####}` | MR-26-00052 |
| Methodology | `MTH-{YY}-{###}` | MTH-26-018 |
| Delivery Receipt | `DR-{YY}-{#####}` | DR-26-00099 |
| Service Report | `SR-{YY}-{#####}` | SR-26-00110 |
| Billing Statement | `BS-{YY}-{#####}` | BS-26-00133 |
| Service Invoice | `SI-{YY}-{#####}` | SI-26-00121 |
| Calibration Job | `CAL-{YY}-{####}` | CAL-26-0077 |
| NCR | `NCR-{YY}-{###}` | NCR-26-004 |
| Controlled Doc | `AIES-{DEPT}-{TYPE}-{###}` | AIES-OPS-SOP-012 |

Sequences are allocated in a Postgres transaction with row locking. **Numbers are never
reused, never reordered, and gaps are permitted and logged** — this is an ISO expectation.

---

## 6. Design System

The application must look like it belongs to AIES. **The brand palette below was sampled directly
from the supplied logo file and contrast-checked — it is confirmed, not a placeholder.**

### 6.1 The logo

`brand/aies-logo-source.jpg` is the master asset: the AIES wordmark in blue-to-red gradient with
an electrical bolt in the "A", a chrome gear glyph, and "ELECTROMECHANICAL CORPORATION" beneath.
Content aspect ratio is roughly **2.6 : 1**.

Produce these derivatives in `public/brand/` as a first task:

| File | Purpose | Notes |
|---|---|---|
| `aies-logo.svg` | Primary, all UI use | Trace or rebuild from the JPG. Vector matters — this logo appears at 24 px in a sidebar and at 300 dpi in a PDF header. |
| `aies-logo-mono-white.svg` | Dark headers, navy backgrounds | Solid white. The gradient wordmark is illegible on navy. |
| `aies-logo-mono-dark.svg` | Faxed / photocopied documents | Solid `--aies-navy-800`. |
| `aies-mark.svg` | Favicon, PWA icon, collapsed sidebar | **The gear glyph alone**, not the full lockup — the wordmark is unreadable below ~120 px. |
| `favicon.ico`, `icon-192.png`, `icon-512.png`, `apple-touch-icon.png` | Browser and PWA | From `aies-mark.svg`. |

Rules: never re-colour the wordmark, never stretch it, never place the gradient version on a
coloured background, and keep clear space of at least the cap-height of the "A" on all sides.
The JPG has a white background — **the SVG must have a transparent one**.

### 6.2 Colour tokens — sampled from the logo

```css
:root {
  /* Brand — deep navy through blue, from the wordmark's left side and the gear */
  --aies-navy-900:   #011860;   /* darkest wordmark shadow */
  --aies-navy-800:   #012076;   /* primary dark — app bar, PDF headers */
  --aies-navy-700:   #002983;
  --aies-blue-600:   #003999;   /* PRIMARY — buttons, links, active states */
  --aies-blue-500:   #0050B1;
  --aies-blue-400:   #0674CC;   /* hover, focus ring */
  --aies-sky-400:    #0994E3;   /* gear highlight — decorative only, fails text contrast */

  /* Brand red — from the "ES" of the wordmark */
  --aies-red-600:    #DB000B;
  --aies-red-500:    #EE010C;   /* the brand red */
  --aies-red-400:    #FF1D0E;   /* decorative only */
  --aies-orange-500: #FD5E13;   /* gradient midpoint — decorative accents only */

  /* Semantic — deliberately NOT the brand red. See §6.3. */
  --aies-danger:     #B3261E;
  --aies-warning:    #B26A00;
  --aies-success:    #1E7A46;
  --aies-info:       var(--aies-blue-500);

  /* Neutrals */
  --aies-bg:         #F5F7FA;
  --aies-surface:    #FFFFFF;
  --aies-surface-2:  #EEF2F7;
  --aies-border:     #DCE3EB;
  --aies-text:       #0F1B2A;
  --aies-text-muted: #5A6B7D;
  --aies-text-invert:#FFFFFF;
}
```

Measured contrast against white (WCAG 2.1):

| Token | Ratio | Verdict |
|---|---|---|
| `navy-800` | 14.3 | Body text, large text, white-on-it — all pass |
| `blue-600` | 10.3 | Primary button with white label — passes comfortably |
| `blue-400` | 4.8 | Passes AA text; use for focus rings and hover |
| `red-500` | 4.5 | Passes AA text at exactly the threshold — **use only at 16 px+ / bold** |
| `red-400`, `sky-400`, `orange-500` | 3.9 / 3.3 / 3.1 | **Fail AA text.** Decorative, borders, and large display only. Never body copy, never a small label. |
| `danger #B3261E` | 6.5 | Error text and destructive buttons |
| `text-muted` | 5.5 | Secondary text passes AA |

### 6.3 The red problem — read this before building components

The brand's second colour is a vivid red, and in a business application red already means
*destructive*, *overdue*, *failed*, *stop*. If the "Save" button and the "Delete" button are both
brand red, people will hesitate over both, and eventually they will misclick on something that
matters — a cancelled invoice, a deleted quotation revision.

So the resolution is:

- **Blue is the UI primary.** Every primary action, link, active tab, and selected row uses
  `--aies-blue-600`. This is the workhorse and it carries the brand perfectly well.
- **Brand red is reserved for identity**: the logo, the PDF header rule, the sidebar accent bar,
  section dividers, and the active-nav indicator. It signals "this is AIES", not "click me".
- **Semantic red is `--aies-danger` (#B3261E)** — visibly deeper and less saturated than the
  brand red. Destructive buttons, error states, overdue badges. The difference is deliberate and
  should not be "corrected" to match the brand later.
- **Never** use brand red for a primary CTA on the same screen as a destructive action.

The orange (`#FD5E13`) is the wordmark's gradient midpoint. It is genuinely useful as the
**"needs your attention"** accent — blocked gates, awaiting-your-approval badges — because it is
on-brand, distinct from both blue and danger red, and pre-attentive. Use it for exactly that and
nothing else.

### 6.4 Applying it

- **App bar / sidebar:** `--aies-navy-800` background with `aies-logo-mono-white.svg`. Active nav
  item marked with a 3 px `--aies-red-500` left bar — the one place brand red earns its keep in
  the chrome.
- **Content area:** `--aies-bg`, cards on `--aies-surface` with `--aies-border`.
- **Status badges:** draft grey · pending `--aies-orange-500` · approved `--aies-success` ·
  sent/active `--aies-blue-600` · overdue/failed `--aies-danger` · cancelled muted grey.
- **Gate indicators** (module 04): released/issued green, awaiting orange, blocked danger red.
- **PDF templates:** `aies-logo.svg` top-left, company block top-right, a 2 px rule in
  `--aies-red-500` under the header, `--aies-navy-800` for section headings, black body text.
  Controlled-document footer with `Doc No. / Rev. / Page x of y`.
- **Focus ring:** 2 px `--aies-blue-400` with a 2 px offset, visible on every interactive element.
  Never remove the outline.

### 6.5 Typography

The logo's wordmark is a custom italic display face and the tagline is a geometric sans. Do not
attempt to source either for UI use.

- **UI:** Inter (variable). Weights 400 / 500 / 600. Neutral, dense, excellent at small sizes.
- **Numerals:** `font-variant-numeric: tabular-nums` on every currency, quantity, and date column.
  Non-tabular figures in a money column are the fastest way to make a table look amateur.
- **Headings:** Inter 600 in `--aies-navy-800`. No display face — this is a working tool.
- **PDF:** Inter, or a metrics-compatible fallback that embeds cleanly.
- Base size 14 px for dense tables, 16 px for forms and body. Never below 12 px.

### 6.6 Interface rules

- Tone: **industrial, dense, legible.** Used on a laptop in an office and a phone in a plant. No
  hero images, no decorative whitespace.
- Tables are the primary UI: compact rows, sticky headers, column visibility toggles, saved
  views, inline editing where safe, filter chips, CSV export, bulk actions.
- Layout: persistent left sidebar, top bar (global search, create button, notifications, user
  menu). Record pages are two-column — fields left, activity feed right.
- **Currency:** PHP is base. Display `₱1,234,567.89`. Never a bare number without its currency.
- **Dates:** `DD MMM YYYY` display, ISO in exports. `Asia/Manila` fixed; store UTC.
- **Mobile:** field views usable one-handed with gloves. Minimum 44 px touch targets, no
  hover-dependent interactions, high contrast for outdoor screens.
- Accessibility: keyboard-navigable, WCAG AA contrast (the tokens above are pre-checked), visible
  focus rings.
- **Dark mode: not in scope for v1.** Do not build it.

## 7. Deployment — Vercel, Supabase, and the NAS

### 7.1 Topology

```
        GitHub (source of truth, CI)
              │  push to main
              ▼
        Vercel  ── app, cron, TLS, public internet
              │
              ├──► Supabase Postgres   (data)
              └──► Supabase Storage    (files)
                        │
                        │  nightly, one-way
                        ▼
        Synology DS220+  ── backup + archive + local mirror
```

### 7.2 What the NAS does now

It is no longer the host, but it is doing something more valuable than it would have been: it is
the copy of the business that AIES controls outright.

| NAS capability | Used for |
|---|---|
| **Nightly backup target** | `pg_dump` of Supabase + `rclone sync` of Supabase Storage, pulled by DSM Task Scheduler. If a cloud account is ever lost, suspended, or billed into oblivion, the company still has its data. |
| **Btrfs snapshots** | Hourly snapshots of the backup share. Protects the backups themselves from ransomware and mistakes. |
| **Hyper Backup** | Second-hop encrypted copy off-site (C2, another NAS, or Google Drive). Three copies, two media, one off-site. |
| **Long-term media archive** | Field photos and video older than 12 months move from Supabase Storage to the NAS on a lifecycle job, keeping cloud storage costs flat. The app keeps the metadata and serves an "archived — request retrieval" state. |
| **Synology Drive mirror** | Read-only local copy of published controlled documents and close-out packs, so the current SOP set is reachable from the office even if the internet is down. |
| **DSM 2FA + firewall + auto-block** | The NAS itself stays off the public internet. Access over LAN or VPN only. |
| **Future self-host target** | If RAM is upgraded to 6 GB later, `docker/docker-compose.yml` brings the whole stack back in-house. Keep it working. |

**The NAS is never the authoritative copy while the platform runs on Supabase.** One direction
only. A two-way sync between a cloud database and a NAS is a data-loss incident waiting for a
quiet weekend.

### 7.3 Environments

| Environment | Vercel | Supabase | Purpose |
|---|---|---|---|
| Production | `erp.aieselectromech.com` | production project | Live |
| Preview | auto per PR | branch database | Review before merge |
| Local | `localhost:3000` | Docker Compose Postgres | Development |

Migrations run in CI on merge, never by hand against production.

### 7.4 Security — this app is on the public internet

Because access is open rather than VPN-only, the perimeter is the app itself. Non-negotiable:

- **Mandatory TOTP 2FA for all five accounts.** No exceptions, no "later".
- Argon2id password hashing, 12-character minimum, zxcvbn score ≥ 3, breach-list check.
- Login throttling: 5 failures → 15-minute lockout, logged, with an email to the president.
- Session: database-backed, 12-hour idle timeout, 30-day absolute, device list with revoke-all.
- Rate limiting on all mutation endpoints and on file downloads.
- Strict CSP, HSTS, `X-Frame-Options: DENY`, secure and `SameSite=Lax` cookies.
- File downloads via short-lived signed URLs generated after a server-side permission check —
  never a public bucket, never a guessable path.
- **Optional IP allow-list for the office network** on the admin and finance areas, configurable
  and off by default. Worth offering; five people rarely need to approve a quotation from an
  airport.
- Dependabot on, `npm audit` in CI, and a documented monthly patch window.
- Audit-log alerting on: permission changes, user creation, cost-field access by a new role,
  and any override of a blocking gate.

### 7.5 Backup and restore runbook (`docs/DEPLOYMENT.md`)

Write this for a competent person who is not a DevOps engineer, with exact DSM menu paths.

1. GitHub repo setup, branch protection, required checks.
2. Vercel project, environment variables, custom domain, cron entries.
3. Supabase project, connection pooling settings, storage buckets and policies, `pg_cron`.
4. Supabase's own PITR/daily backups — enable them; they are the first line of recovery.
5. `scripts/backup-to-nas.sh`: `pg_dump -Fc` + `rclone sync` of storage → writes to
   `/volume1/aies-backups/{YYYY-MM-DD}/` with a manifest recording the dump timestamp and the
   storage sync marker, so the pair can be identified at restore time.
6. DSM Task Scheduler entry, nightly, with email on failure.
7. Btrfs snapshot schedule on the backup share; Hyper Backup to an off-site target.
8. `scripts/restore.sh`: restores a chosen dump into a scratch database and prints a row-count
   sanity report. **A backup you have not restored is not a backup.** Quarterly restore drill
   checklist, with a place to record the date it was last done — this is also ISO evidence.
9. Storage lifecycle job configuration for the 12-month media archive.
10. Synology Drive read-only mirror setup for published documents.
11. Monitoring: uptime check on `/api/health`; DSM notification on backup failure or volume
    above 80%; Vercel and Supabase alerting to the president and operations manager.
12. Cost review: what the monthly bill looks like, what makes it grow, and which lever to pull
    first if it does.
13. Self-host fallback: how to bring the stack back to a 6 GB NAS or a VPS if that becomes
    preferable.

### 7.6 Cost expectation — tell the user plainly

At five users: Vercel Pro around USD 20/month, Supabase Pro around USD 25/month. Free tiers work
for evaluation, but Supabase's free tier pauses on inactivity and has no point-in-time recovery —
do not run the company on it. Budget roughly **USD 45/month**, plus email sending (a few dollars)
and the domain. This should be stated in `docs/DEPLOYMENT.md`, not buried.

## 8. Module Index

| # | Spec file | Module | Depends on |
|---|---|---|---|
| 00 | `specs/00-foundation.md` | Foundation: auth, RBAC, audit, events, storage, design system, deployment | — |
| 01 | `specs/01-crm-inquiry.md` | CRM: accounts, contacts, inquiries, pipeline, **customer accreditation**, **principal acquisition** | 00 |
| 02 | `specs/02-quotation.md` | Quotation: evaluation, supplier RFQ, costing, quote builder, revisions, approval | 00, 01 |
| 03 | `specs/03-order-procurement.md` | Customer PO, sales order, supplier PO, goods receipt, delivery | 00, 02 |
| 04 | `specs/04-operations-projects.md` | Tickets, cash advance, methodology, material request, mobilization, QA, T&C, delivery lane, close-out | 00, 03 |
| 05 | `specs/05-finance-billing.md` | Billing statements, **Service Invoice on payment**, EWT/2307, collections, cash advances, expenses | 00, 03, 04 |
| 06 | `specs/06-collaboration.md` | Channels, tasks/boards, calendar, notifications — the Slack/Trello replacement | 00 |
| 07 | `specs/07-documents-dms.md` | NAS-backed document management, versioning, controlled documents | 00 |
| 08 | `specs/08-qms-iso9001.md` | NCR/CAPA, audits, **outsourced calibration**, competence, management review, cert readiness | 00, 04, 07 |
| 09 | `specs/09-reporting-admin.md` | Dashboards, KPIs, exports, system settings | all |
| 10 | `specs/10-integrations.md` | Outbound document email, supplier directory, accounting export, NAS backup sync | 00, 01 |

---

## 9. Build Order

Build in this sequence. Each phase ends with a working, deployable, reviewable increment.

**Phase 1 — Foundation (module 00).** Nothing else can start. Ends with: users can log in, an
empty shell app deploys to the NAS over HTTPS, audit log works, brand tokens applied.

**Phase 2 — Revenue path (01 → 02 → 03).** This is the highest-value slice: an inquiry can
become a quotation can become a sales order can become a supplier PO. Ends with the sales team
able to abandon their quotation spreadsheet.

**Phase 3 — Delivery path (04 → 05).** Tickets, gates, field reports, billing. Ends with the
technical team able to abandon their project-monitoring sheet, and finance able to bill from
the system.

**Phase 4 — Collaboration and documents (06 → 07).** The Slack/Trello/Drive replacement. Built
late deliberately: by now the object graph exists, so discussions and files have something real
to attach to.

**Phase 5 — Quality and insight (08 → 09 → 10).** ISO machinery, dashboards, and the automated
inquiry intake.

> **Note on inquiry intake.** Automated email and website ingest were removed from scope
> (decisions 24, 25). Inquiries are entered by hand. This is a reasonable place to start: it
> forces data-quality habits before automation can hide them, and with five people the volume is
> manageable. Keep the `source` field and its unused values so ingest can be added later without
> a migration.

---

## 10. Cross-Cutting Non-Functionals

- **Performance budget:** any list view < 800 ms server time at 50k rows. Anything slower moves
  to a queued job with a progress indicator.
- **Data retention:** nothing is hard-deleted. Soft-delete with `deletedAt` + `deletedBy`.
  Purge only via an admin tool that writes to the audit log.
- **Concurrency:** optimistic locking (`version` column) on quotations, sales orders, and job
  orders. Two salespeople editing one quote must not silently overwrite each other.
- **Localisation:** English UI. PHP currency, Philippine date conventions, 12% VAT handling
  (see module 05), TIN fields on accounts.
- **Accessibility:** keyboard-navigable, WCAG AA contrast, visible focus rings.
- **Seed data:** every module seeds realistic AIES-flavoured demo data (flow meters, pressure
  transmitters, control valves, water district and power plant customers) so the app is
  demonstrable without manual entry.

---

## 11. Decisions and Remaining Questions

**All 34 clarifying questions have been answered.** See `docs/DECISIONS-CONFIRMED.md` — that file
is authoritative and must be read before this one.

### 11.1 Decisions that reversed an earlier default

These are the ones most likely to trip up a build that skims the specs:

1. **Not on the NAS.** Vercel + Supabase + GitHub. The NAS is backup and archive only. §3.1, §7.
2. **Service Invoice is issued on payment, not on billing.** A billing statement demands payment;
   the VAT invoice follows the money. Module 05 §3.
3. **The client approves the methodology**, always, before mobilization. Module 04 §6.2.
4. **The client performs QA**, not AIES. The operations manager records the outcome and uploads
   the client's documentation. Module 04 §9.
5. **Calibration is outsourced** to an accredited ISO/IEC 17025 laboratory. AIES manages the
   subcontracted process; it does not run a lab. Module 08 §3.
6. **The VP approves everything** — quotations regardless of value, cash advances, payment terms,
   liquidation extensions. No value thresholds in v1, though the threshold machinery stays so it
   can be turned on when the company grows.
7. **No inbound email or webhook ingest, no SMS.** §3.4.
8. **Five users, all managers**, cost visibility limited to two of them. §4.
9. **EA (President) is the automatic fallback approver.** Confirmed. When the VP does not act
   within the escalation window, authority passes to the President without anyone nominating
   anybody. §4.4.
10. **Brand palette is confirmed and sampled from the logo file.** §6.2. It is not a placeholder —
    do not "improve" it, and do not substitute the brand red for the semantic danger red. §6.3
    explains why they are deliberately different.

### 11.2 Genuinely still open

1. **Registered company details** — legal name, registered address, TIN, landline. Entered
   manually in system settings at first run (decision 32). Ship the settings screen with clear
   required-field validation, since every PDF header depends on it.
2. **The accredited calibration laboratory's details** — name, accreditation number, scope, and
   certificate expiry — needed for the approved-external-provider record in module 08 §5.
3. **EWT rate per customer.** 2% is standard for services, but confirm whether any customer
   withholds at a different rate, and whether any are exempt or government (which withholds
   differently and adds withholding VAT).
4. **Petty cash fund size and custodian.** Needed to seed module 05's petty cash register.
*(Approval fallback: resolved — see §11.1 item 9.)*

### 11.3 Standing instruction

Anything ambiguous that is not in this list: implement the most conservative reading, log it in
`docs/DECISIONS.md` with the ambiguity, your choice, and your reasoning, and raise it in your
summary. Do not silently guess, and do not stall the build waiting for an answer.
