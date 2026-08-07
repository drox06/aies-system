# Module 01 — CRM and Inquiry Intake

**Depends on:** 00. **Blocks:** 02, 10.
**Definition of done:** a salesperson can log an inquiry from a phone call, attach it to a new
or existing account, qualify it, and hand it to quotation — and a manager can see the pipeline.

---

## 1. Domain notes

AIES generates inquiries through **networking and customer relations**, not inbound marketing.
The CRM must therefore be strong on *relationship history and follow-up discipline* and weak on
lead-scoring theatre. A salesperson's real question is "who haven't I talked to in 60 days, and
what's stuck?" Design for that question.

Accounts are industrial: a water district, a power plant, a food manufacturer. Each has plants,
each plant has equipment, and the same account may run several unrelated inquiries at once
through different engineers. Model the hierarchy properly.

---

## 2. Data model

```prisma
model Account {
  id, code, name, legalName?, tin?, industry, accountType   // customer | prospect | both
  website?, phone?, email?
  billingAddress Json, shippingAddress Json
  paymentTermsId?, creditLimit?, currency
  ownerId                                   // account manager
  status          // active | dormant | blacklisted
  parentAccountId?                          // for group companies
  customFields Json
}

model Site {                                // a plant / facility of an account
  id, accountId, name, address Json, geo Json?
  accessNotes String?                       // gate pass, PPE, induction requirements
  contactId?
}

model Contact {
  id, accountId, siteId?, firstName, lastName, position, department
  email?, mobile?, phone?, isPrimary, isDecisionMaker, notes
}

model Inquiry {
  id, number, accountId?, siteId?, contactId?
  source        // email | website | linkedin | phone | walk_in | referral | existing_customer | trade_show
  sourceRef?    // message-id, form submission id
  receivedAt, subject, description
  requirements Json          // structured capture, see §4
  industry, estimatedValue?, currency
  requiredByDate?
  status        // new | acknowledged | evaluating | inspection_required | quoting | quoted | won | lost | disqualified
  ownerId, assignedAt?
  qualification Json?        // budget, authority, need, timeline — light BANT, optional
  lostReason?, lostToCompetitor?
  customFields Json
}

model InquiryItem {          // what the customer asked for, pre-costing
  id, inquiryId, lineNo
  description, quantity, unit
  manufacturer?, modelNumber?, specifications Json?
  serviceType?              // supply | installation | commissioning | calibration | pm | corrective | inspection
  notes
}

model Activity {             // calls, meetings, site visits — the relationship record
  id, entityType, entityId  // polymorphic: account, contact, inquiry, quotation
  type                      // call | meeting | site_visit | email | note | demo
  subject, body, occurredAt, durationMin?
  participantIds String[], contactIds String[]
  outcome?, nextStepDue?
  createdById
}
```

New accounts get a code from the numbering service: `ACC-{####}`.

---

## 3. Inquiry lifecycle

```
new ──> acknowledged ──> evaluating ──┬──> inspection_required ──> evaluating
                                      ├──> quoting ──> quoted ──┬──> won
                                      │                          └──> lost
                                      └──> disqualified
```

Rules:
- `new → acknowledged` must happen within an SLA (default 1 business day, configurable). An
  overdue unacknowledged inquiry escalates to the `vice_president` and `president`. This directly addresses the
  "inquiries get lost" problem.
- Moving to `quoting` creates a linked Quotation draft (module 02) and emits
  `inquiry.quoting_started`.
- `won` / `lost` are set by the quotation outcome, not manually — the inquiry mirrors its
  quotation. `lostReason` is a required, configurable picklist. Without enforced loss reasons
  the pipeline reports are worthless.
- Any status change writes to the audit log and the activity feed.

---

## 4. Requirements capture

The single most valuable thing this module does is stop the "what exactly did they ask for?"
round-trip that currently happens over chat.

Build a **requirements checklist template per service type**, editable in settings. When an
inquiry is created with `serviceType = installation`, the form presents that template's
questions (process conditions, line size, connection type, power supply, hazardous area
classification, existing equipment tag numbers, site access constraints, required documentation).
Answers land in `Inquiry.requirements` as JSONB.

Show a **completeness indicator**: an inquiry cannot move to `quoting` until required fields for
its service types are answered, or the user explicitly overrides with a reason (logged).

Seed templates for: instrumentation supply, valve supply, installation & commissioning,
calibration, preventive maintenance, corrective maintenance/troubleshooting, site inspection.

---

## 5. Inspection request

Per the described process, sales sometimes needs the technical team to inspect a site before a
quotation can be completed.

- From an inquiry, `sales` can raise an **Inspection Request** with: site, requested date
  window, purpose, specific questions to answer, and required outputs (photos, tag list,
  measurements).
- Emits `inspection.requested`. Module 04 subscribes and creates a scheduled field task; module
  06 notifies the operations lead. Until module 04 exists, the request is a task assigned to a
  user with a due date.
- The completed inspection report attaches back to the inquiry and its findings are pulled into
  the quotation's scope of work.
- Inquiry status is `inspection_required` while open; SLA clock pauses.

---

## 5b. Customer accreditation (Admin Manager — PD)

Industrial and utility customers in the Philippines require suppliers to be **accredited** before
they will issue a PO: submission of company documents, periodic revalidation, and renewal on a
cycle. This is real recurring work owned by the Admin Manager, and today it lives in someone's
memory and a folder.

```prisma
model AccreditationRecord {
  id, accountId, status      // not_started | preparing | submitted | under_review | accredited | rejected | expired | renewal_due
  submittedAt?, accreditedAt?, expiresAt?, referenceNumber?
  customerPortalUrl?, customerContactId?
  requirements Json   // [{ document, required, providedFileId, submittedAt, acceptedAt, expiresAt, notes }]
  rejectionReason?, notes, ownerId
}
```

- **Requirement checklist per customer**, since every one asks for a slightly different set:
  SEC registration, BIR 2303, mayor's/business permit, company profile, audited financials,
  DTI, PhilGEPS registration, PCAB licence, ISO certificates, safety programme, list of
  clients, sample certificates. Seed a template and let PD add per-account items.
- Documents come from the DMS (module 07). Each has its own expiry — a mayor's permit expires
  annually and quietly invalidates an accreditation. Track expiry **per document**, not just
  per accreditation.
- **Renewal reminders** at 90/60/30 days to PD.
- **Accreditation status shows on the account and on the inquiry.** Quoting a customer who cannot
  issue you a PO is wasted effort, and the salesperson should see that before writing the quote,
  not after.

---

## 5c. Principal supplier and product acquisition (Marketing Manager — EM)

EM's job includes acquiring new products and new principal suppliers. That is a pipeline, and it
deserves the same treatment as the sales pipeline rather than living in an inbox.

```prisma
model PrincipalProspect {
  id, companyName, country, website?, productLines String[]
  contactName?, email?, phone?
  stage     // identified | contacted | in_discussion | samples_pricing | agreement_draft | appointed | declined | dormant
  ownerId, targetIndustries String[]
  competingBrands String[], estimatedOpportunity?
  distributorAgreementFileId?, agreementSignedAt?, agreementExpiresAt?
  exclusivity      // none | territory | segment
  priceListFileId?, priceListReceivedAt?, priceListValidUntil?
  trainingStatus?, technicalContactId?, notes, nextFollowUpAt?
}
```

- On `stage = appointed`, the prospect converts into a `Supplier` (module 03) with
  `isPrincipal = true`, carrying the agreement, price list, and contacts across. No re-keying.
- **Price list expiry tracking.** A quotation costed from a lapsed price list is a margin
  incident waiting to happen; module 02 already warns on stale supplier costs, and this feeds it.
- Distributor agreement expiry and exclusivity terms with renewal reminders.
- Simple attribution: revenue and margin by principal, so EM can see which appointments actually
  earned their keep.

---

## 6. Pipeline and views

- **Kanban pipeline** by inquiry status, drag to advance, card shows account, value, owner, age,
  and a red flag if the SLA is breached.
- **My Day** view for a salesperson: overdue follow-ups, inquiries awaiting my action, quotes
  expiring this week, accounts not contacted in N days.
- **Account 360 page:** contacts, sites, open inquiries, quotation history with win rate, orders,
  open AR balance (permission-gated), installed equipment (populated by module 04), service
  history, all activities, all documents.
- **Follow-up engine:** every inquiry and quotation carries a `nextFollowUpAt`. A daily job
  emails each salesperson their list. Nothing is allowed to sit with no next step — a record
  with no `nextFollowUpAt` and status not terminal appears in a "Needs a next step" list.

---

## 7. Duplicate and merge

Industrial customers get entered three times with three spellings. Provide:
- Fuzzy duplicate detection on create (name trigram + TIN + domain of contact email).
- An admin merge tool that repoints all child records and writes a merge audit entry.

---

## 8. Events

**Emits:** `inquiry.created`, `inquiry.acknowledged`, `inquiry.assigned`, `inquiry.status_changed`,
`inquiry.quoting_started`, `inquiry.lost`, `inspection.requested`, `account.created`,
`activity.logged`.

**Consumes:** `quotation.sent`, `quotation.accepted`, `quotation.rejected` (to mirror status).

Inquiries are **entered manually** — inbound email and website ingest were removed from scope
(Spec.md §3.4). Keep the `source` enum complete so nothing changes when they return. Make the
manual quick-create form genuinely fast: it is now the only way inquiries enter the system.

---

## 9. Permissions

`crm.view` · `crm.view_all` · `crm.create` · `crm.edit` · `crm.delete` · `crm.merge` ·
`crm.export` · `inquiry.assign` · `inquiry.disqualify` · `inspection.request` ·
`accreditation.manage` · `principal_prospect.manage`

`accreditation.manage` sits with `admin_manager`; `principal_prospect.manage` with
`marketing_manager`. Both are visible to `president` and `vice_president`.

---

## 10. Tests

- SLA escalation fires at the right time and not before; pauses during `inspection_required`.
- Record scoping: salesperson A cannot read salesperson B's inquiry without `crm.view_all`.
- Requirements gate blocks `quoting` transition until complete or overridden with a reason.
- Merge repoints inquiries, contacts, sites, and activities with no orphans.
- Accreditation: a document expiring flips the record to `renewal_due` and notifies; an expired
  accreditation shows a warning on the account and on any new inquiry for it.
- Appointing a principal prospect creates exactly one supplier carrying agreement and price list.
