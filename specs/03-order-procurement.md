# Module 03 — Customer PO, Sales Order, Procurement and Delivery

**Depends on:** 00, 02. **Blocks:** 04, 05.
**Definition of done:** a customer PO can be received against a quotation, a sales order raised,
a supplier PO issued to the principal, goods received and delivered, with the handover to
operations automatic.

---

## 1. The pivot point

This module is where the deal stops being a sales artifact and becomes an obligation. Per the
stated process, three things fan out from PO receipt, sometimes in parallel:

1. **Finance** may need a downpayment before anything is ordered.
2. **Procurement** places the order with the principal supplier.
3. **Operations** generates **tickets** from the PO — this is the first box in the operations
   flowchart. See module 04 §4. Ticket generation is proposed by this module and confirmed by
   operations; it is never silent.

Model this as a sales order with **independent workstreams**, not a linear status chain. A
single status field cannot represent "goods received, downpayment still unpaid, installation
scheduled."

---

## 2. Data model

```prisma
model CustomerPO {
  id, accountId, quotationId?, poNumber, poDate
  amount, currency, fileId                 // scanned PO is mandatory
  receivedById, receivedAt
  status        // received | verified | discrepancy | cancelled
  discrepancyNotes?                        // PO vs quotation mismatch
}

model SalesOrder {
  id, number, accountId, siteId?, quotationId, customerPOId
  orderDate, requiredByDate?
  currency, subtotal, vatAmount, total, totalCost, marginAmount
  paymentTermsId, downpaymentPct, downpaymentAmount
  status        // open | in_progress | partially_delivered | delivered | in_execution | completed | closed | cancelled
  procurementStatus  // not_required | pending | ordered | partially_received | received
  financeStatus      // awaiting_downpayment | downpayment_received | partially_billed | fully_billed | paid
  executionStatus    // not_required | pending | scheduled | in_progress | completed
  ownerId, projectManagerId?
  closedAt?, version Int
}

model SalesOrderLine {
  id, salesOrderId, lineNo, quotationLineId
  itemType, productId?, description, quantity, unit
  unitPrice, lineTotal, unitCost
  qtyOrdered, qtyReceived, qtyDelivered     // running fulfilment counters
  requiresExecution Boolean                 // this line implies field work
  status        // pending | ordered | received | delivered | executed | cancelled
}

model Supplier {
  id, code, name, isPrincipal Boolean, country, currency
  // Confirmed: this directory is maintained by users, not by any integration.
  // Make the create/edit form fast and forgiving — it is the only way suppliers get in.
  contactName?, email?, phone?, address Json
  paymentTerms?, leadTimeDaysTypical?, incoterm?
  productLines String[]                     // brands represented
  rating?, isApproved Boolean, approvedAt?, approvalExpiry?   // ISO 8.4 supplier control
  notes
}

model SupplierPO {
  id, number, supplierId, salesOrderId?
  poDate, currency, fxRate, subtotal, freight?, duties?, otherCharges?, total
  status        // draft | pending_approval | approved | sent | acknowledged | partially_received | received | cancelled
  expectedShipDate?, expectedArrivalDate?
  incoterm?, shipmentMode?                  // air | sea | land | courier
  trackingRef?, supplierRef?                // supplier's own order number
  approvedById?, approvedAt?, sentAt?
}

model SupplierPOLine {
  id, supplierPOId, lineNo, salesOrderLineId?
  productId?, description, manufacturer?, modelNumber?
  quantity, unit, unitCost, lineTotal, qtyReceived, leadTimeDays?
}

model GoodsReceipt {
  id, number, supplierPOId, receivedAt, receivedById
  status        // draft | inspected | accepted | partially_rejected | rejected
  packingListRef?, invoiceRef?, waybillRef?
  inspectionNotes?, photoFileIds String[]
}

model GoodsReceiptLine {
  id, goodsReceiptId, supplierPOLineId
  qtyReceived, qtyAccepted, qtyRejected, rejectionReason?
  serialNumbers String[], batchNo?, calibrationCertFileId?
}

model DeliveryReceipt {
  id, number, salesOrderId, siteId, deliveryDate, deliveredById
  status        // draft | in_transit | delivered | acknowledged
  vehicle?, driverName?
  receivedByName?, receivedByPosition?, signatureFileId?, photoFileIds String[]
}

model DeliveryReceiptLine { id, deliveryReceiptId, salesOrderLineId, quantity, serialNumbers String[] }
```

---

## 3. Customer PO receipt and verification

- Sales uploads the customer's PO (PDF/image is **mandatory** — no PO record without the file).
- System runs a **three-way check** against the source quotation: PO amount vs quotation total,
  PO line quantities vs quotation lines, and delivery/payment terms. Discrepancies are surfaced
  on screen and must be resolved (accept, or raise a quotation revision) before the sales order
  is created. This single check prevents the most expensive category of error in this business.
- On verification: quotation → `accepted`, inquiry → `won`, emit `customer_po.received`.
- **Sales order creation** copies quotation lines. Lines whose `itemType` is service/labour, or
  whose product is flagged as requiring installation, set `requiresExecution = true`. If any
  line requires execution, `executionStatus` starts at `pending` and module 04 is signalled.
- On `sales_order.created`, module 04 proposes a ticket set: executable lines → `new_project` or
  `installation` tickets, goods-only lines → a `delivery` ticket, contract lines → scheduled
  `after_sales` tickets. Each ticket links back to the specific sales order lines it covers, so
  `qtyDelivered` and the billing milestones stay accurate.

---

## 4. Downpayment gate

Per the stated process, ordering may wait on a downpayment.

- `PaymentTerm` carries `downpaymentPct`. If > 0, the sales order starts at
  `financeStatus = awaiting_downpayment` and emits `downpayment.required` (module 05 raises the
  downpayment invoice).
- Settings flag `blockProcurementUntilDownpayment` (default **true**). When true, the supplier PO
  cannot leave `draft` until module 05 emits `payment.received` covering the downpayment.
  The `president` or `vice_president` may override with a logged reason — this happens in real
  life, and pretending otherwise means people work around the system instead of through it.
- The sales order header shows a clear gate indicator so nobody has to ask finance in a chat app.

---

## 5. Supplier PO

- Created from a sales order: select lines → group by supplier → generate draft POs.
- Costs default from the linked supplier quote (module 02). If the supplier quote has expired,
  warn prominently — the margin in the sales order was based on a stale cost.
- **Landed cost:** freight, duties, brokerage, and bank charges are captured on the PO header and
  allocated across lines by value or by weight. Landed cost feeds the true project margin in
  module 09. Without this, reported margin is fiction on imported goods.
- Approval workflow (generic service): the **Vice President approves supplier POs**, matching quotation approval. The threshold machinery stays available but unused in v1.
- **Issue manually.** As with supplier RFQs, the system generates the branded PO PDF and the
  draft email text; a person sends it and marks it sent. Track supplier acknowledgement by hand.
  No automated supplier email in v1.
- **Expediting view:** all open supplier POs with expected arrival, days late, and the customer
  commitment they support. Overdue POs notify the sales order owner, because the customer will
  ask them, not procurement.

---

## 6. Goods receipt

- Receipt against a supplier PO, partial receipts supported.
- **Incoming inspection is required** (ISO 9001 clause 8.4.2, verification of externally provided
  processes/products): quantity check, damage check, documentation check (test certificates,
  calibration certificates, datasheets, warranty), and photos.
- Serial numbers captured per unit where applicable — these become the installed-equipment
  register in module 04 and drive after-sales support.
- Rejected quantities auto-raise an NCR (module 08) against the supplier and a return-to-supplier
  task.
- Calibration and test certificates received are filed as controlled documents (module 07) and
  linked to the serial number, so they can be re-issued to the customer years later.

---

## 7. Delivery

This module owns the **Delivery Receipt document**. Module 04 owns the **delivery execution
lane** (DR request → mobilization → contact → attempt → signature → demobilization), including
its retry loops. Keep the boundary clean: this module generates, numbers, and stores the DR;
module 04 records what happened when someone tried to deliver against it.

- Deliveries run in one of two modes — **own vehicle or courier for bulk and large items**
  (module 04 §13). This module's DR document is identical in both; only the execution differs.
- **DR request** comes from a delivery ticket (module 04 §13), not from a screen in this module.
  A DR is never issued without a ticket to execute it — the flowchart's `DR REQ` box is a real
  gate and prevents DRs floating around unassigned.
- Delivery receipt against the sales order, drawing on received stock. Partial deliveries
  supported; each generates its own DR.
- Generates a branded DR PDF with the customer's site details.
- Mobile capture at site: recipient name, position, **signature on screen**, and photos of the
  delivered goods. This is the proof-of-delivery that currently exists only as a paper copy in
  someone's bag.
- **Delivered-but-unsigned is a distinct state** and a billing risk — see module 04 §13. This
  module holds the DR in `delivered` rather than `acknowledged` until the signature arrives, and
  final billing that depends on a signed DR stays gated. **A courier proof-of-delivery does not
  satisfy this** — the signed AIES delivery receipt must come back.
- On acknowledgement, `qtyDelivered` increments; when all non-execution lines are delivered,
  emits `sales_order.goods_delivered` and `delivery.dr_signed`.

---

## 8. Inventory posture (see Spec.md open question 3)

Default implementation: **no perpetual inventory for traded goods.** Goods are received against a
supplier PO and allocated to the sales order that caused them. Track quantities on hand only as
`qtyReceived − qtyDelivered` per sales order line.

Consumables, spares, tools, and instruments **are** tracked, because the flowchart's Material
Request step requires it — but by custody and quantity, not by valuation. That register
(`StockItem`, `StockMovement`) is owned by **module 04 §7**, not here. This module contributes to
it on goods receipt when the received items are stock rather than project-allocated.

- Lines on a material request with `source = purchase` emit `material.purchase_required`. This
  module raises a purchase request against it, and the ticket stays at `material_pending` until
  the goods are received. This is the flowchart's `N` branch on the material request diamond.

If the user confirms real stock is held, this expands into a full inventory module with
locations, valuation, and stock transfers. Do not build that speculatively.

---

## 9. Events

**Emits:** `customer_po.received`, `sales_order.created`, `downpayment.required`,
`supplier_po.created`, `supplier_po.sent`, `goods.received`, `goods.rejected`,
`sales_order.goods_delivered`, `sales_order.completed`, `sales_order.closed`.

**Consumes:** `quotation.accepted`, `payment.received`, `ticket.completed`, `project.closed`,
`material.purchase_required`, `delivery.dr_signed`.

---

## 10. Permissions

`sales_order.view` · `sales_order.view_all` · `sales_order.create` · `sales_order.edit` ·
`sales_order.close` · `sales_order.cancel` · `supplier.manage` · `supplier_po.create` ·
`supplier_po.approve` · `goods_receipt.create` · `goods_receipt.inspect` · `delivery.create` ·
`procurement.override_downpayment_gate`

---

## 11. Tests

- PO-vs-quotation discrepancy detection catches amount, quantity, and terms mismatches.
- Downpayment gate blocks supplier PO send; override is permitted only with the permission and
  writes a reason to the audit log.
- Partial receipt then partial delivery keeps `qtyOrdered/Received/Delivered` consistent; over-
  receipt and over-delivery are rejected.
- Landed cost allocation by value sums exactly to the total charge (no rounding leakage).
- Rejected goods create exactly one NCR and one return task.
