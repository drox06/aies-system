-- Module 03's CustomerPO, pulled forward for the pipeline's "Received PO" column.
-- Purely additive: a new table and three foreign keys. Nothing existing changes shape, and the new
-- inquiry status `po_received` needs no DDL because `Inquiry.status` is a plain string enforced by
-- inquiry-lifecycle.ts rather than a database enum.

-- CreateTable
CREATE TABLE "CustomerPO" (
    "id" TEXT NOT NULL,
    "accountId" TEXT NOT NULL,
    "quotationId" TEXT,
    "inquiryId" TEXT,
    "poNumber" TEXT NOT NULL,
    "poDate" TIMESTAMP(3) NOT NULL,
    "amount" DECIMAL(14,2) NOT NULL,
    "currency" TEXT NOT NULL DEFAULT 'PHP',
    "fileId" TEXT NOT NULL,
    "receivedById" TEXT NOT NULL,
    "receivedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "status" TEXT NOT NULL DEFAULT 'received',
    "discrepancyNotes" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "deletedAt" TIMESTAMP(3),

    CONSTRAINT "CustomerPO_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "CustomerPO_accountId_receivedAt_idx" ON "CustomerPO"("accountId", "receivedAt");

-- CreateIndex
CREATE INDEX "CustomerPO_quotationId_idx" ON "CustomerPO"("quotationId");

-- CreateIndex
CREATE INDEX "CustomerPO_inquiryId_idx" ON "CustomerPO"("inquiryId");

-- AddForeignKey
ALTER TABLE "CustomerPO" ADD CONSTRAINT "CustomerPO_accountId_fkey" FOREIGN KEY ("accountId") REFERENCES "CustomerAccount"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CustomerPO" ADD CONSTRAINT "CustomerPO_quotationId_fkey" FOREIGN KEY ("quotationId") REFERENCES "Quotation"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CustomerPO" ADD CONSTRAINT "CustomerPO_inquiryId_fkey" FOREIGN KEY ("inquiryId") REFERENCES "Inquiry"("id") ON DELETE SET NULL ON UPDATE CASCADE;
