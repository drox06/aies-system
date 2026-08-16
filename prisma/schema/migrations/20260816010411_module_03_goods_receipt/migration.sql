-- CreateTable
CREATE TABLE "GoodsReceipt" (
    "id" TEXT NOT NULL,
    "number" TEXT NOT NULL,
    "supplierPOId" TEXT NOT NULL,
    "receivedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "receivedById" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'draft',
    "packingListRef" TEXT,
    "invoiceRef" TEXT,
    "waybillRef" TEXT,
    "quantityChecked" BOOLEAN NOT NULL DEFAULT false,
    "damageChecked" BOOLEAN NOT NULL DEFAULT false,
    "documentationChecked" BOOLEAN NOT NULL DEFAULT false,
    "photosAttached" BOOLEAN NOT NULL DEFAULT false,
    "inspectionNotes" TEXT,
    "inspectedById" TEXT,
    "inspectedAt" TIMESTAMP(3),
    "version" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "deletedAt" TIMESTAMP(3),
    "deletedBy" TEXT,

    CONSTRAINT "GoodsReceipt_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "GoodsReceiptLine" (
    "id" TEXT NOT NULL,
    "goodsReceiptId" TEXT NOT NULL,
    "supplierPOLineId" TEXT NOT NULL,
    "qtyReceived" DECIMAL(14,3) NOT NULL DEFAULT 0,
    "qtyAccepted" DECIMAL(14,3) NOT NULL DEFAULT 0,
    "qtyRejected" DECIMAL(14,3) NOT NULL DEFAULT 0,
    "rejectionReason" TEXT,
    "serialNumbers" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "batchNo" TEXT,
    "calibrationCertFileId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "GoodsReceiptLine_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "GoodsReceipt_number_key" ON "GoodsReceipt"("number");

-- CreateIndex
CREATE INDEX "GoodsReceipt_supplierPOId_receivedAt_idx" ON "GoodsReceipt"("supplierPOId", "receivedAt");

-- CreateIndex
CREATE INDEX "GoodsReceipt_status_idx" ON "GoodsReceipt"("status");

-- CreateIndex
CREATE INDEX "GoodsReceiptLine_supplierPOLineId_idx" ON "GoodsReceiptLine"("supplierPOLineId");

-- CreateIndex
CREATE UNIQUE INDEX "GoodsReceiptLine_goodsReceiptId_supplierPOLineId_key" ON "GoodsReceiptLine"("goodsReceiptId", "supplierPOLineId");

-- AddForeignKey
ALTER TABLE "GoodsReceipt" ADD CONSTRAINT "GoodsReceipt_supplierPOId_fkey" FOREIGN KEY ("supplierPOId") REFERENCES "SupplierPO"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "GoodsReceiptLine" ADD CONSTRAINT "GoodsReceiptLine_goodsReceiptId_fkey" FOREIGN KEY ("goodsReceiptId") REFERENCES "GoodsReceipt"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "GoodsReceiptLine" ADD CONSTRAINT "GoodsReceiptLine_supplierPOLineId_fkey" FOREIGN KEY ("supplierPOLineId") REFERENCES "SupplierPOLine"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
