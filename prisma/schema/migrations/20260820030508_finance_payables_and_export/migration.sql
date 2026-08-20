-- CreateTable
CREATE TABLE "SupplierInvoice" (
    "id" TEXT NOT NULL,
    "number" TEXT NOT NULL,
    "supplierId" TEXT NOT NULL,
    "supplierPOId" TEXT,
    "supplierRef" TEXT NOT NULL,
    "invoiceDate" TIMESTAMP(3) NOT NULL,
    "dueDate" TIMESTAMP(3),
    "amount" DECIMAL(14,2) NOT NULL,
    "vatAmount" DECIMAL(14,2),
    "currency" TEXT NOT NULL DEFAULT 'PHP',
    "status" TEXT NOT NULL DEFAULT 'draft',
    "matchFindings" JSONB NOT NULL DEFAULT '[]',
    "disputeOverrideReason" TEXT,
    "receiptFileIds" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "notes" TEXT,
    "recordedById" TEXT NOT NULL,
    "approvedById" TEXT,
    "approvedAt" TIMESTAMP(3),
    "paidAt" TIMESTAMP(3),
    "version" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "deletedAt" TIMESTAMP(3),

    CONSTRAINT "SupplierInvoice_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AccountingExport" (
    "id" TEXT NOT NULL,
    "number" TEXT NOT NULL,
    "dataset" TEXT NOT NULL,
    "preset" TEXT NOT NULL,
    "periodStart" TIMESTAMP(3) NOT NULL,
    "periodEnd" TIMESTAMP(3) NOT NULL,
    "rowCount" INTEGER NOT NULL,
    "contentHash" TEXT NOT NULL,
    "exportedById" TEXT NOT NULL,
    "exportedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "AccountingExport_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "SupplierInvoice_number_key" ON "SupplierInvoice"("number");

-- CreateIndex
CREATE INDEX "SupplierInvoice_supplierId_status_idx" ON "SupplierInvoice"("supplierId", "status");

-- CreateIndex
CREATE INDEX "SupplierInvoice_supplierPOId_idx" ON "SupplierInvoice"("supplierPOId");

-- CreateIndex
CREATE INDEX "SupplierInvoice_status_dueDate_idx" ON "SupplierInvoice"("status", "dueDate");

-- CreateIndex
CREATE UNIQUE INDEX "AccountingExport_number_key" ON "AccountingExport"("number");

-- CreateIndex
CREATE INDEX "AccountingExport_dataset_periodStart_idx" ON "AccountingExport"("dataset", "periodStart");
