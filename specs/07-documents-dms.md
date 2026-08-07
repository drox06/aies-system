# Module 07 — Document Management (NAS-backed)

**Depends on:** 00. **Blocks:** 08.
**Definition of done:** every file the company produces or receives has one authoritative
location, a revision number, an owner, and an access rule — and controlled documents follow an
approval lifecycle.

---

## 1. Two kinds of documents

Do not conflate these. They have different lifecycles.

| | **Records** (evidence) | **Controlled Documents** (instructions) |
|---|---|---|
| Examples | Customer PO, service report, delivery receipt, calibration certificate, invoice, cash advance liquidation, QA record, T&C certificate | Quality manual, SOPs, work instructions, forms, checklists, quotation templates, **project methodologies** |
| Lifecycle | Created once, immutable, retained | Drafted → reviewed → approved → published → revised → obsoleted |
| Versioning | Not revised; superseded by a new record | Revision-controlled, only one current revision |
| ISO clause | 7.5.3 control of documented information (records) | 7.5.2, 7.5.3 (documents) |

Both live in the same DMS with a `documentClass` discriminator, but only controlled documents
carry the approval workflow.

---

## 2. Data model

```prisma
model DocumentFolder { id, parentId?, name, path, ownerId?, permissionRule Json?, isSystem }

model Document {
  id, folderId, documentClass       // record | controlled
  documentNumber?                   // AIES-OPS-SOP-012 for controlled
  title, description?, categoryId, tags String[]
  currentRevisionId
  entityType?, entityId?            // link to the business record it belongs to
  accountId?, projectId?
  ownerId, status                   // draft | in_review | approved | published | obsolete | archived
  confidentiality                   // public | internal | confidential | restricted
  retentionUntil?, reviewDueAt?     // periodic review for controlled docs
  createdById
}

model DocumentRevision {
  id, documentId, revision            // "0", "1", "2" or "A", "B"
  fileId, fileName, mimeType, sizeBytes, sha256
  changeSummary, effectiveFrom?
  preparedById, reviewedById?, approvedById?, approvedAt?
  status                              // draft | in_review | approved | superseded | obsolete
  isCurrent Boolean
}

model DocumentAccess    { id, documentId, principalType, principalId, level }   // read | comment | edit | manage
model DocumentReadReceipt { id, documentId, revisionId, userId, acknowledgedAt } // "I have read the current SOP"
model DocumentLink      { id, documentId, entityType, entityId, linkType }       // one doc, many records
```

---

## 3. Storage on the Synology NAS

- Physical root: shared folder `/volume1/aies-data/files`, bound into the container at
  `/data/files`.
- **Content-addressed layout:** `files/{sha256[0:2]}/{sha256[2:4]}/{sha256}`. The friendly name
  and folder path live only in the database. This means: automatic deduplication, renames and
  moves are free, and a corrupted database never leaves you unable to identify a file (a
  checksum manifest is written alongside).
- Never serve the share directly over HTTP. All access goes through `/api/files/[id]` with a
  permission check and an audit entry for confidential and restricted documents.
- **Btrfs snapshots** on this share (hourly, per `docs/DEPLOYMENT.md`) are the first line of
  recovery. Document the DSM restore procedure for a single file, because that is what people
  will actually need.
- **Hyper Backup** carries this share plus the nightly `pg_dump` off-site. Restore is only
  meaningful if both are from the same night — the backup script must write a manifest with the
  DB dump's timestamp and the share's snapshot ID so the pair can be identified.
- Storage quota monitoring: the app reports free space on `/data/files` via `/api/health` and
  raises an in-app warning to admins below 15% free. A 2-bay NAS full of site photos and video
  will fill faster than anyone expects — module 04's image compression matters here.
- **Optional Synology Drive publication:** a read-only mirror folder `Published Documents` on the
  NAS, refreshed by a job whenever a controlled document is published, so staff can access the
  current SOP set from Synology Drive on a laptop even if the app is down. One-way only. Never
  treat the Drive copy as authoritative.

---

## 3b. Methodologies as controlled documents

The operations flowchart makes **Methodology** a required deliverable for every new project
(module 04 §6.2). It is a controlled document, not a text field, because it is revision-managed,
approved by named people, sometimes submitted to the client for approval, and reused across
projects.

- Numbered `AIES-OPS-MTH-{###}` and filed under `Quality/Methodologies/` **and** linked to the
  project via `DocumentLink`.
- Same lifecycle as any controlled document (§4), with one addition: a
  `submitted_to_client` → `client_approved` pair of states, since the customer's approval is what
  actually unblocks mobilization for some accounts.
- **Methodology library:** a filtered view of approved methodologies by work type, so the next
  project of the same kind starts from the last one rather than a blank page. This is the single
  cheapest way for the company to accumulate institutional knowledge instead of losing it when
  someone leaves.
- Revising a methodology mid-project supersedes the prior revision and notifies the crew, who
  must acknowledge the current revision before continuing. Crews working to a superseded method
  statement is exactly the failure ISO document control exists to prevent.

---

## 4. Controlled document lifecycle

```
draft ──> in_review ──> approved ──> published ──┬──> (new revision) draft
                │                                 └──> obsolete
                └──> (rejected) draft
```

- Preparer, reviewer, and approver must be **different people** where the roles are configured to
  require it (settings flag; realistically a small company may need to allow two).
- Publishing a new revision automatically supersedes the previous one and marks it `obsolete`,
  retained but watermarked "OBSOLETE" on view and download. Uncontrolled copies are the classic
  ISO finding; the watermark is the cheapest defence.
- **Distribution and acknowledgement:** on publish, notify the affected roles and require read
  acknowledgement. Compliance report shows who has and hasn't.
- **Periodic review:** `reviewDueAt` (default +2 years, configurable per category). Overdue
  reviews appear on the QMS dashboard and notify the owner.
- **Master document list** — a filterable register of every controlled document with number,
  title, current revision, approval date, owner, and next review date. This is the first thing an
  ISO auditor asks for; make it a one-click export.

---

## 4b. Methodologies as controlled documents

Module 04 §6.2 makes the methodology (method statement) a blocking gate before mobilization. It
is a **controlled document**, and it is the one category where the company will build real
institutional value fastest.

- Each methodology is a controlled document with its own revision chain, prepared/reviewed/
  approved by different people, and — where the customer requires it — a client approval record
  attached.
- **Methodology library:** approved methodologies are filed by work type (flow meter
  installation, control valve replacement, pump alignment, transmitter loop commissioning,
  panel retrofit) and are clonable into a new project. The second time the company does a job
  it has done before, the method statement should take twenty minutes, not two days.
- A methodology cloned from the library records its parent. When a parent is revised because
  something went wrong on site, the system lists every project that cloned it — so the lesson
  propagates instead of staying with one crew.
- Superseded methodologies watermark "OBSOLETE" like any controlled document. A crew working
  from an outdated method statement is exactly the failure the watermark exists to prevent.

---

## 5. Record filing

- Records are filed automatically by the modules that create them. Every generated PDF
  (quotation, PO, DR, SR, invoice, close-out pack) is written to the DMS with the right folder,
  entity link, and retention period — not left as a loose attachment.
- Inbound files (customer POs, supplier quotes, certificates, 2307s) are filed on upload with a
  required document category.
- Folder tree seeded by structure: `Customers/{Account}/{Project}/{Ticket}/`,
  `Suppliers/{Supplier}/`, `Quality/{Category}/`, `Quality/Methodologies/`, `HR/`,
  `Finance/{Year}/{Month}/`, `Finance/CashAdvances/{Year}/`.
- Site inspection photos, delivery attempt photos, and mobilization/demobilization photos are
  filed automatically against their ticket. Photo volume from field work is the fastest-growing
  thing on the NAS — module 04's client-side compression is what keeps this affordable on two
  bays.
- Permission inheritance from the folder, overridable per document. Confidential and restricted
  documents log every view.

---

## 6. Working with files

- Upload: drag-and-drop, multi-file, with progress and resumable chunks for large uploads over a
  poor connection.
- **Preview in browser** for PDF and images without downloading. Office formats: offer download,
  and optionally render a PDF preview if a converter is available — do **not** put LibreOffice
  in the container on a 2 GB NAS. If preview for Office formats is wanted, note it as a future
  item requiring the RAM upgrade.
- Full-text search inside PDFs: extract text on upload with `pdf-parse` into the search index.
  Queue this as a background job; it is CPU-heavy on a Celeron.
- Bulk download of a folder or a project's documents as a zip, generated as a queued job with a
  download link, never streamed synchronously.
- Every document page shows: current revision, revision history with diff of change summaries,
  linked records, access list, and the audit trail.

---

## 7. Retention

- Retention period per document category, defaulting per ISO and Philippine statutory
  requirements (accounting records: 10 years under BIR rules — **verify with the company's
  accountant, do not hard-code an assumption**).
- Nothing auto-deletes. Documents past retention appear in an admin review list; disposal is a
  deliberate, logged, permissioned action with a disposal certificate.

---

## 8. Events

**Emits:** `document.uploaded`, `document.published`, `document.revised`, `document.obsoleted`,
`document.review_due`, `document.acknowledged`.

**Consumes:** all modules' document-generating events.

---

## 9. Permissions

`document.view` · `document.upload` · `document.edit` · `document.delete` ·
`document.manage_folders` · `document.control` (create/revise controlled docs) ·
`document.approve` · `document.publish` · `document.dispose` · `document.view_confidential`

---

## 10. Tests

- Content-addressed storage deduplicates identical uploads and never collides across entities.
- Publishing revision 3 supersedes revision 2, keeps 2 downloadable, and watermarks it.
- Permission: a user without `document.view_confidential` gets 403 on both metadata and file
  stream, and the attempt is logged.
- Path traversal via filename (`../../etc/passwd`, null bytes, unicode homoglyphs) is rejected.
- Snapshot/backup manifest pairs DB dump and file share correctly.
