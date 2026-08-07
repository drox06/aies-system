# Module 10 — Outbound Email, Directories, Exports and NAS Sync

**Depends on:** 00, 01. **Blocks:** nothing.
**Definition of done:** documents can be emailed from any record, the supplier directory is
usable, the accountant gets a clean export, and last night's backup is sitting on the NAS.

> ⚠️ **Scope was deliberately cut.** Inbound email ingest (decision 24), the website form webhook
> (decision 25), AI extraction of RFQs (decision 29), and SMS notification (decision 30) are all
> **out of scope**. Do not build them. This module is much smaller than it was.

---

## 1. What was removed, and what to leave behind

| Removed | Leave in place |
|---|---|
| IMAP poller on `sales@aieselectromech.com` | `Inquiry.source` enum keeps its `email` value |
| `POST /api/webhooks/website-inquiry` | `Inquiry.source` keeps `website`; `sourceRef` field stays |
| LLM extraction of RFQ documents | Nothing — remove entirely |
| SMS adapter | Nothing — remove entirely |

Leaving the enum values costs nothing and means adding ingest later is a feature, not a
migration. **Do not leave dead code, stub endpoints, or disabled cron entries** — an endpoint
that exists but does nothing is a security surface and a source of confusion. Delete the code;
keep the data shape.

Inquiries are now entered by hand (module 01). With five people and manual entry, the quick-create
form is the single most-used screen in the CRM — treat its speed as a feature, not a detail.

---

## 2. Outbound email

This stays, because sending a quotation is core to the business.

- **Provider:** Resend, or SMTP via `nodemailer` against Google Workspace. Resend is simpler on
  Vercel and gives delivery logs; either is acceptable. Record the choice in `docs/DECISIONS.md`.
- **Templates** with merge fields for: quotation, supplier RFQ, supplier PO, delivery receipt,
  billing statement, service invoice, service report, payment reminder, statement of account.
  Editable in settings by an admin, previewed before send.
- **Send from a record**, never from a generic compose screen. Recipients default from the
  account's contacts. The body is editable before sending. The sent copy is stored and appears in
  the record's activity feed — this is what replaces "did anyone send that quote?"
- **Manual-send actions where the company works manually.** Supplier RFQs and supplier POs are
  emailed by a person (decisions 19 and the module 02/03 specs). Provide *generate PDF*, *copy
  draft text*, and *mark as sent* — do not auto-send to suppliers.
- **Deliverability:** document SPF, DKIM, and DMARC alignment for the sending domain in
  `docs/DEPLOYMENT.md`. A quotation silently landing in a customer's spam folder is a lost deal
  that nobody ever attributes to email configuration.
- **Rate limiting and a suppression list**, so a loop in a reminder job cannot mail a customer
  fifty times.
- Bounce and complaint handling: a hard bounce flags the contact's email as invalid on the
  account, so the next person doesn't send to a dead address.

---

## 3. Directories maintained by users

Confirmed: suppliers are entered and maintained by people, not by an integration. The same is
true of laboratories and couriers. These are small tables, but they are the ones that get
abandoned if entry is tedious.

- **Supplier directory** (module 03 owns the model): fast create, duplicate detection on name and
  email domain, bulk CSV import, and inline creation from a quotation line so nobody has to leave
  what they're doing.
- **Laboratory directory** (module 08 §3): accreditation number, scope, certificate, expiry.
- **Courier directory**: name, contact, typical rates or a rate card file, tracking URL pattern
  so a waybill number becomes a working link.
- Every directory record shows its usage — POs raised, spend, on-time performance — so it is
  obvious which entries are real and which were typed once and abandoned.

**Extension point for later:** a `SupplierConnector` interface with `requestQuote`,
`checkOrderStatus`, and `fetchPricing`. Ship only the manual implementation. If a principal ever
offers an API, a new connector drops in without touching the quotation module. Build the
interface; do not build a second implementation speculatively.

---

## 4. LinkedIn

Unchanged and still worth stating plainly: **LinkedIn has no public API for receiving inquiries,
and its terms prohibit scraping.** With email ingest also removed, LinkedIn capture is entirely
manual — which is fine at this volume.

- "Log LinkedIn inquiry" quick-create with `source = linkedin` and the profile URL in `sourceRef`.
- Source attribution reporting so the channel's value is measurable: inquiries, quotations, and
  won revenue by source. EM owns this.
- Note again: the company URL supplied (`linkedin.com/in/...`) is a **personal profile** format,
  not a company page (`/company/...`). Worth fixing for credibility with procurement teams, but
  it is not a software task.

---

## 5. Accounting export

There is no accounting package, so this is how the accountant gets what they need.

- Configurable CSV/XLSX export for a period: billing statements, **service invoices** (the BIR
  documents), payments with withholding and 2307 status, expenses, cash advance liquidations, and
  supplier bills.
- Column mapping defined in settings so the accountant can specify their own layout once.
  QuickBooks and Xero layouts as presets in case AIES adopts one later.
- **Export runs are recorded** with period, timestamp, and who ran them, so the same month is not
  exported twice unnoticed and a re-export after a correction is visible.
- **VAT summary** and **withholding tax summary** per period as separate sheets — these are the
  two things the accountant will ask for first, and generating them here saves a monthly
  back-and-forth.

---

## 6. NAS backup and archive sync

The NAS is no longer the host (Spec.md §3.1, §7.2), but this is where its job is implemented.

- `scripts/backup-to-nas.sh`, run by DSM Task Scheduler nightly, pulling rather than pushing so
  the NAS holds the credentials and the cloud never has write access to the backup store:
  1. `pg_dump -Fc` of the Supabase database.
  2. `rclone sync` of Supabase Storage to `/volume1/aies-backups/files/`.
  3. Write a manifest recording the dump timestamp, the storage sync marker, row counts, and a
     sha256 of the dump — so the database and file copies can be paired at restore time.
  4. Retention: 30 daily, 12 monthly.
- **Media archive lifecycle:** a scheduled job moves field photos and video older than 12 months
  from Supabase Storage to the NAS archive share, leaving the metadata and an
  "archived — request retrieval" state in the app. Keeps cloud storage cost flat as the photo
  library grows, which it will faster than anyone expects.
- **Published document mirror:** a one-way sync of approved controlled documents and close-out
  packs into a read-only Synology Drive folder, so the current SOP set and project records are
  reachable from the office even when the internet is down.
- **One direction only, always.** Nothing on the NAS is ever written back to Supabase. A two-way
  sync between a cloud database and a NAS is a data-loss incident waiting for a quiet weekend.
- `backup.completed` / `backup.failed` events so a failure appears in the app, not only in a log
  nobody reads. Escalate to the president after two consecutive failures.

---

## 7. Integration health

An admin page showing, per job: last successful run, last failure with the error, items processed
today, and queue backlog. Plus alerts on: backup not succeeded in 26 hours, email send failure
rate above a threshold, and any dead-lettered job. Background work fails silently by nature; make
silence impossible.

---

## 8. Events

**Emits:** `email.sent`, `email.bounced`, `backup.completed`, `backup.failed`,
`archive.completed`, `export.generated`, `integration.failed`.

**Consumes:** all document-generating and notification events.

---

## 9. Permissions

`integration.view` · `integration.configure` · `email.send_as_company` · `finance.export` ·
`backup.view`

---

## 10. Tests

- Outbound suppression prevents duplicate reminders within the configured window; a hard bounce
  flags the contact.
- Manual-send actions generate the PDF and mark-as-sent without dispatching email.
- Export for a period is reproducible, and a second run of the same period is flagged.
- VAT and withholding summaries reconcile to the service invoices and payments in the period.
- Backup script produces a paired manifest; `restore.sh` restores it into a scratch database and
  reports matching row counts.
- Archive lifecycle moves a file, leaves retrievable metadata, and never deletes the only copy.
