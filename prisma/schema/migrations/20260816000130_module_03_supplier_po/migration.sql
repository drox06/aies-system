-- CreateTable
CREATE TABLE "SupplierPO" (
    "id" TEXT NOT NULL,
    "number" TEXT NOT NULL,
    "supplierId" TEXT NOT NULL,
    "salesOrderId" TEXT,
    "poDate" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "currency" TEXT NOT NULL DEFAULT 'PHP',
    "fxRate" DECIMAL(14,6) NOT NULL DEFAULT 1,
    "subtotal" DECIMAL(14,2) NOT NULL DEFAULT 0,
    "freight" DECIMAL(14,2) NOT NULL DEFAULT 0,
    "duties" DECIMAL(14,2) NOT NULL DEFAULT 0,
    "otherCharges" DECIMAL(14,2) NOT NULL DEFAULT 0,
    "total" DECIMAL(14,2) NOT NULL DEFAULT 0,
    "status" TEXT NOT NULL DEFAULT 'draft',
    "expectedShipDate" TIMESTAMP(3),
    "expectedArrivalDate" TIMESTAMP(3),
    "incoterm" TEXT,
    "shipmentMode" TEXT,
    "trackingRef" TEXT,
    "supplierRef" TEXT,
    "approvedById" TEXT,
    "approvedAt" TIMESTAMP(3),
    "sentAt" TIMESTAMP(3),
    "acknowledgedAt" TIMESTAMP(3),
    "downpaymentOverrideById" TEXT,
    "downpaymentOverrideAt" TIMESTAMP(3),
    "downpaymentOverrideReason" TEXT,
    "unapprovedSupplierOverrideBy" TEXT,
    "unapprovedSupplierOverrideReason" TEXT,
    "notes" TEXT,
    "version" INTEGER NOT NULL DEFAULT 0,
    "createdById" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "deletedAt" TIMESTAMP(3),
    "deletedBy" TEXT,

    CONSTRAINT "SupplierPO_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "SupplierPOLine" (
    "id" TEXT NOT NULL,
    "supplierPOId" TEXT NOT NULL,
    "lineNo" INTEGER NOT NULL,
    "salesOrderLineId" TEXT,
    "productId" TEXT,
    "description" TEXT NOT NULL,
    "manufacturer" TEXT,
    "modelNumber" TEXT,
    "quantity" DECIMAL(14,3) NOT NULL DEFAULT 1,
    "unit" TEXT NOT NULL DEFAULT 'pc',
    "unitCost" DECIMAL(14,2) NOT NULL DEFAULT 0,
    "lineTotal" DECIMAL(14,2) NOT NULL DEFAULT 0,
    "qtyReceived" DECIMAL(14,3) NOT NULL DEFAULT 0,
    "leadTimeDays" INTEGER,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "SupplierPOLine_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "SupplierPO_number_key" ON "SupplierPO"("number");

-- CreateIndex
CREATE INDEX "SupplierPO_supplierId_status_idx" ON "SupplierPO"("supplierId", "status");

-- CreateIndex
CREATE INDEX "SupplierPO_salesOrderId_idx" ON "SupplierPO"("salesOrderId");

-- CreateIndex
CREATE INDEX "SupplierPO_status_expectedArrivalDate_idx" ON "SupplierPO"("status", "expectedArrivalDate");

-- CreateIndex
CREATE INDEX "SupplierPOLine_salesOrderLineId_idx" ON "SupplierPOLine"("salesOrderLineId");

-- CreateIndex
CREATE UNIQUE INDEX "SupplierPOLine_supplierPOId_lineNo_key" ON "SupplierPOLine"("supplierPOId", "lineNo");

-- AddForeignKey
ALTER TABLE "SupplierPO" ADD CONSTRAINT "SupplierPO_supplierId_fkey" FOREIGN KEY ("supplierId") REFERENCES "Supplier"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SupplierPO" ADD CONSTRAINT "SupplierPO_salesOrderId_fkey" FOREIGN KEY ("salesOrderId") REFERENCES "SalesOrder"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SupplierPOLine" ADD CONSTRAINT "SupplierPOLine_supplierPOId_fkey" FOREIGN KEY ("supplierPOId") REFERENCES "SupplierPO"("id") ON DELETE CASCADE ON UPDATE CASCADE;
