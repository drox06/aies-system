# AIES Operations Platform — Spec Pack

**Status: all 34 clarifying questions answered and folded in.** Ready to build.

## Read in this order

1. `docs/DECISIONS-CONFIRMED.md` — the company's own answers. **Authoritative.** Where anything
   else could be read as disagreeing with this, this wins.
1b. `docs/BUILD-PROTOCOL.md` — how to work through the pack across many sessions.
2. `Spec.md` — master spec: business flow, operations flowchart, architecture, roles, design
   system, deployment, build order.
3. `specs/00-foundation.md` — then one module at a time.

| File | Purpose |
|---|---|
| `specs/00-foundation.md` | Auth + mandatory 2FA, RBAC, audit, event bus, job queue, storage, design system, Vercel/Supabase deployment |
| `specs/01-crm-inquiry.md` | Accounts, contacts, inquiries, pipeline, **customer accreditation** (PD), **principal acquisition** (EM) |
| `specs/02-quotation.md` | Supplier RFQ (manual send), costing, quote builder, revisions, **VP approves all**, negotiation |
| `specs/03-order-procurement.md` | Customer PO, sales order, supplier PO, goods receipt, delivery receipt |
| `specs/04-operations-projects.md` | **Tickets**, cash advance gate, site inspection, methodology (client-approved), material request gate, mobilization, **client QA gate**, T&C, warranty gate, delivery lane (own vehicle + courier), close-out, offline field app |
| `specs/05-finance-billing.md` | **Billing statement → payment → Service Invoice**, EWT/2307, collections, cash advances, project P&L |
| `specs/06-collaboration.md` | Tasks/boards, channels, calendar, announcements, meetings |
| `specs/07-documents-dms.md` | Document management, revision control, controlled documents, methodology library |
| `specs/08-qms-iso9001.md` | NCR/CAPA, **outsourced calibration**, competence, audits, management review, clause matrix |
| `specs/09-reporting-admin.md` | Dashboards for the five actual people, KPIs, **compliance register**, admin, data import |
| `specs/10-integrations.md` | Outbound document email, directories, accounting export, NAS backup sync |

## How to run it in Claude Code

**Read `docs/BUILD-PROTOCOL.md` first** — it covers session management, what to do when you hit a
usage limit, where to split the two oversized modules, and the review gates between modules.

1. Create an empty folder, drop this pack in at the root, and run `git init`.
2. Open Claude Code in that folder.
3. First prompt:
   > Read `docs/DECISIONS-CONFIRMED.md`, then `Spec.md` in full, then `specs/00-foundation.md`
   > and `docs/BUILD-PROTOCOL.md`.
   > Create `docs/PROGRESS.md` and keep it current as you work.
   > Implement module 00, session 1 only (bootstrap, Prisma, CI, module manifest system).
   > Do not start any other module or session. Commit as you go.
4. Every session after that starts with the standard opener in `BUILD-PROTOCOL.md` §3.

## The eight decisions that reversed an earlier default

Skim-reading the specs will get these wrong, so they're worth knowing before you start:

1. **Not hosted on the NAS.** Vercel + Supabase + GitHub. The NAS is backup and archive.
2. **Service Invoice is issued on payment**, not on billing. A billing statement demands payment;
   the VAT document follows the money.
3. **The client approves the methodology** before mobilization. Always.
4. **The client performs QA.** The Operations Manager records the outcome and uploads the
   client's documentation — and cannot mark it approved without evidence attached.
5. **Calibration is outsourced** to an accredited ISO/IEC 17025 laboratory.
6. **The VP approves everything** — every quotation at any value, every cash advance, payment
   terms, liquidation extensions.
7. **No inbound email ingest, no website webhook, no SMS.** Inquiries are keyed by hand.
8. **Five users, all managers.** Cost and margin visible to two of them only.
9. **EA is the automatic fallback approver** — no nomination step. Cash advances escalate after
   4 working hours, quotations after 24.

## Brand

`brand/aies-logo-source.jpg` is the master logo. The palette in `Spec.md` §6.2 was **sampled from
that file and contrast-checked** — it is confirmed, not a placeholder.

Navy `#012076` · Blue `#003999` (UI primary) · Brand red `#EE010C` · Orange accent `#FD5E13`

**Read §6.3 before building any component.** Brand red and semantic danger red are deliberately
different colours, and that difference must not be "fixed" later.

## Still needed from you

- **The calibration laboratory's accreditation details** — name, number, scope, expiry.
- **Company registered details** — legal name, address, TIN, landline. Entered manually at setup.
- **EWT rate per customer**, if any customer deviates from the standard 2%.
- **Petty cash fund size and custodian.**

None of these block the build. All are settings-screen data entered at first run.
