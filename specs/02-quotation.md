# Module 02 — Quotation

**Depends on:** 00, 01. **Blocks:** 03.
**Definition of done:** the sales team can abandon their quotation spreadsheet. A quote can be
costed from supplier pricing, approved against margin rules, issued as a branded PDF, revised
under version control, and negotiated — with full history.

---

## 1. Why this module is the centre of gravity

Everything AIES sells is quoted individually. The quotation is where margin is decided, where
scope is defined, and where the company's technical credibility is expressed. It is also where
the current spreadsheet process fails hardest: no version history, no margin visibility, no
record of what the supplier actually quoted, and no way to reuse last year's quote for the same
water district.

Design accordingly. This module deserves more care than any other.

---

## 2. Data model

```prisma
model Quotation {
  id, number, revision Int @default(0)      // QTN-2608-0042 R2
  parentQuotationId?                        // revision chain root
  inquiryId?, accountId, siteId?, contactId?
  title, scopeOfWork String                 // rich text — the technical narrative
  exclusions String?, assumptions String?
  status        // draft | pending_approval | approved | sent | under_negotiation | accepted | rejected | expired | superseded | cancelled
  currency, fxRate Decimal                  // rate used to convert supplier FX cost to PHP
  validUntil Date
  deliveryTermIncoterm?, deliveryLeadTime?
  paymentTermsId
  warrantyTerms String?
  subtotal, discountAmount, vatMode, vatAmount, total Decimal
  totalCost Decimal, marginAmount Decimal, marginPct Decimal   // permission-gated
  preparedById, approvedById?, approvedAt?
  sentAt?, sentToContactIds String[]
  decisionAt?, rejectionReason?
  version Int                               // optimistic lock
  customFields Json
}

model QuotationLine {
  id, quotationId, lineNo, groupLabel?      // group by "Supply" / "Installation" / "Spares"
  itemType         // product | service | labour | travel | freight | misc
  productId?, description, longDescription?
  manufacturer?, modelNumber?, partNumber?
  quantity, unit
  unitCost, costCurrency, costFxRate        // as quoted by the principal
  markupPct?, unitPrice, lineDiscountPct?
  lineTotal, lineCost, lineMargin
  supplierQuoteLineId?
  leadTimeDays?
  isOptional Boolean                        // optional/alternate lines excluded from total
  notes
}

model SupplierQuoteRequest {                // RFQ sent to a principal
  id, number, quotationId?, inquiryId?, supplierId
  status        // draft | sent | responded | declined | expired
  sentAt?, dueBy?, respondedAt?
  requestBody, responseNotes?
  currency?, validUntil?, leadTimeDays?
}

model SupplierQuoteLine {
  id, requestId, lineNo, description, manufacturer?, modelNumber?
  quantity, unit, unitCost, currency, leadTimeDays?, notes
}

model Product {                             // a light catalogue that grows from usage
  id, sku?, name, description, manufacturer, modelNumber?
  categoryId, unit, defaultSupplierId?
  lastCost?, lastCostCurrency?, lastCostAt?, defaultMarkupPct?
  datasheetFileId?, isActive
}

model PaymentTerm { id, name, downpaymentPct, balanceTrigger, netDays, description }
```

---

## 3. Supplier RFQ sub-flow

Per the stated process: *"Sales team will coordinate with principal supplier for items to be
quoted."* Make that coordination a first-class record instead of an email nobody can find.

1. From a quotation draft, select lines → **Request Supplier Pricing** → pick supplier(s).
2. System generates an RFQ document (PDF + email body) with line items, quantities, and required
   response fields. **Confirmed: this is emailed manually by a person — the Admin Manager (PD)
   handles supplier price inquiries.** The system produces the document and the draft text, and
   records that the RFQ was sent; it does not send automatically. Provide a "copy to clipboard"
   and "download PDF" action, and a "mark as sent" step that starts the response clock.
3. Status tracked: sent → responded. Overdue RFQs (past `dueBy`) surface in a dashboard list and
   notify the owner.
4. Response captured either by manual entry or by pasting/uploading the supplier's quote; the
   supplier's PDF is attached as a controlled document.
5. **Apply to quotation:** one action pulls supplier costs into the matching quotation lines,
   setting `unitCost`, `costCurrency`, `leadTimeDays`, and linking `supplierQuoteLineId`. The
   link is what lets anyone later answer "where did this cost come from?"
6. Multi-supplier comparison view when the same lines were sent to several principals: a matrix
   of cost, lead time, and validity with a "select winner per line" action.

---

## 4. Costing, pricing, and FX

- Supplier costs are frequently USD or EUR. Store `unitCost` in `costCurrency` **and** the
  `costFxRate` used at the time of quoting. Never overwrite a historical rate.
- FX rate source: manual entry with a settings-configured default rate, plus an optional
  buffer percentage (e.g. quote at BSP rate + 3%) since the order may be placed weeks later.
  Show the buffer explicitly — it is a margin decision, not a hidden fudge.
- Pricing modes per line: markup on cost (`unitPrice = unitCost * fx * (1 + markup)`) or direct
  price entry with computed implied margin. Support both; engineers think in price, finance
  thinks in margin.
- Header-level discount distributes proportionally across lines and recomputes margin.
- **Margin panel** (gated by `finance.view_cost`): total cost, total price, gross margin amount
  and percent, per-line margin heat colouring, and a warning when any line is below the
  configured floor.
- VAT: `vatMode` of `exclusive` | `inclusive` | `zero_rated` | `exempt`. Default from settings.
  12% rate configurable. See module 05 — get this confirmed (open question 5).

---

## 5. Revisions and version control

- A `sent` quotation is **immutable**. Changing it creates revision *n+1* in `draft`, cloned from
  *n*, sharing the base number.
- The prior revision becomes `superseded` at the moment the new one is sent.
- A **revision diff view** shows exactly what changed between R1 and R2: lines added, removed,
  quantities and prices changed, terms changed. Sales needs this in front of them during
  negotiation calls.
- Revisions require a `revisionReason` (picklist + free text): customer scope change, price
  negotiation, supplier cost change, error correction, validity extension. This is ISO 9001
  clause 8.2.4 evidence for changes to requirements for products and services.

---

## 6. Approval

**Confirmed: the Vice President approves every quotation, regardless of value or margin.**

Implement it through the generic approvals service with a single seeded rule — approver
`vice_president`, no conditions — rather than by hard-coding "VP approves". The threshold
machinery from the service stays in place, unused, so that when AIES grows to the point where
the VP cannot review everything, turning on value bands is a settings change and not a rewrite.

- Approval is required before a quotation can move to `sent`. No exceptions in v1.
- Rejection returns the quote to draft with a mandatory comment.
- **Automatic fallback to the President after 24 working hours** (Spec.md §4.4). No nomination
  step. Both may act after the window; first decision wins. The approval is stamped as a fallback
  so the audit trail is honest about who decided.
- The approval queue is a first-class screen for the VP: every quote awaiting them, with total,
  margin, customer, and age, approvable in sequence without opening each one.

## 7. Issuance

- Generate a branded PDF using the extracted AIES logo and palette (Spec.md §6). Sections:
  header block with company details and document number, customer and site block, scope of
  work narrative, line table (grouped, with optional lines clearly separated and excluded from
  the total), commercial summary, delivery lead time, payment terms, warranty, validity,
  exclusions and assumptions, standard terms and conditions, signature block.
- Line-item **cost columns must never appear** on the customer PDF. Build a separate internal
  costing sheet PDF for management, watermarked "INTERNAL".
- Send by email from the record: template with merge fields, editable before send, PDF attached,
  recipients defaulted to the inquiry contacts. Sent copy is stored and appears in the activity
  feed. Track `sentAt`; if module 10's tracking pixel is enabled, track opens (make this a
  setting, default off — it is legally sensitive).
- Auto-expire: a job flips `sent` quotes past `validUntil` to `expired` and notifies the owner
  seven days before.

---

## 8. Negotiation

Per the stated process: *"if not we leave room for negotiations."*

- Status `under_negotiation` with a structured log: each round records the customer's
  counter-position, AIES's response, who authorised it, and the resulting revision (if any).
- A **"what-if" calculator** on the quote: enter a target price or target discount and
  immediately see resulting margin, and whether it breaches the approval threshold. If it does,
  the UI offers to raise the approval request in place.
- Competitor field (optional) and a loss-reason picklist feeding win/loss analytics.

---

## 9. Reuse

- **Duplicate quotation** from any prior quote, to the same or a different account, with a
  refresh-costs prompt showing which lines have stale supplier pricing (`lastCostAt` older than
  N days).
- **Quote templates** for repeat scopes (annual PM contract, standard calibration package).
- Product catalogue auto-populates: when a quotation line uses a manufacturer + model not in
  `Product`, offer to create it. The catalogue thus builds itself from real work rather than
  requiring a data-entry project up front.

---

## 10. Events

**Emits:** `quotation.created`, `quotation.submitted_for_approval`, `quotation.approved`,
`quotation.rejected_internally`, `quotation.sent`, `quotation.revised`, `quotation.accepted`,
`quotation.rejected`, `quotation.expired`, `supplier_rfq.sent`, `supplier_rfq.responded`.

**Consumes:** `inquiry.quoting_started`, `inspection.completed` (pull findings into scope),
`customer_po.received` (module 03 → sets `accepted`).

---

## 11. Permissions

`quotation.view` · `quotation.view_all` · `quotation.create` · `quotation.edit` ·
`quotation.approve` · `quotation.send` · `quotation.revise` · `quotation.cancel` ·
`quotation.override_margin_floor` · `finance.view_cost` · `supplier_rfq.manage` ·
`product.manage` · `approval.act_as_fallback`

`quotation.approve` is held by `vice_president` and `president` only. `finance.view_cost`
likewise — cost and margin are not visible to the other three roles.

---

## 12. Tests

- Sent quotations reject edit attempts at the service layer, not just in the UI.
- Revision chain: R0 → R1 → R2 keeps one root, supersedes correctly, and the diff is accurate.
- Margin maths across FX, markup, line discount, header discount, and VAT modes — table-driven
  tests with fixed expected values.
- Every quotation, at any value, routes to the VP for approval; none can be sent unapproved.
- A quotation unapproved after 24 working hours becomes approvable by the president, and the
  resulting approval is recorded as a fallback with elapsed time — never as a VP approval.
- `finance.view_cost` denial strips cost fields from the API response payload, verified by
  inspecting the serialised response.
- Concurrent edit of one quotation by two users raises a version conflict rather than a silent
  overwrite.
