-- CreateTable
CREATE TABLE "MaterialRequest" (
    "id" TEXT NOT NULL,
    "number" TEXT NOT NULL,
    "ticketId" TEXT NOT NULL,
    "projectId" TEXT,
    "requestedById" TEXT NOT NULL,
    "requestedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "neededBy" TIMESTAMP(3),
    "status" TEXT NOT NULL DEFAULT 'draft',
    "approvedById" TEXT,
    "approvedAt" TIMESTAMP(3),
    "rejectionReason" TEXT,
    "issuedById" TEXT,
    "issuedAt" TIMESTAMP(3),
    "returnDueAt" TIMESTAMP(3),
    "returnedAt" TIMESTAMP(3),
    "version" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "deletedAt" TIMESTAMP(3),
    "deletedBy" TEXT,

    CONSTRAINT "MaterialRequest_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "MaterialRequestLine" (
    "id" TEXT NOT NULL,
    "requestId" TEXT NOT NULL,
    "lineNo" INTEGER NOT NULL,
    "itemType" TEXT NOT NULL,
    "stockItemId" TEXT,
    "productId" TEXT,
    "description" TEXT NOT NULL,
    "quantity" DECIMAL(14,3) NOT NULL,
    "unit" TEXT NOT NULL DEFAULT 'pc',
    "source" TEXT NOT NULL DEFAULT 'stock',
    "qtyIssued" DECIMAL(14,3) NOT NULL DEFAULT 0,
    "qtyReturned" DECIMAL(14,3) NOT NULL DEFAULT 0,
    "qtyConsumed" DECIMAL(14,3) NOT NULL DEFAULT 0,
    "calibrationAssetId" TEXT,
    "status" TEXT NOT NULL DEFAULT 'pending',
    "notes" TEXT,

    CONSTRAINT "MaterialRequestLine_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "StockItem" (
    "id" TEXT NOT NULL,
    "sku" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "category" TEXT NOT NULL DEFAULT 'consumable',
    "unit" TEXT NOT NULL DEFAULT 'pc',
    "qtyOnHand" DECIMAL(14,3) NOT NULL DEFAULT 0,
    "reorderLevel" DECIMAL(14,3) NOT NULL DEFAULT 0,
    "location" TEXT,
    "lastCountedAt" TIMESTAMP(3),
    "calibrationDueAt" TIMESTAMP(3),
    "version" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "deletedAt" TIMESTAMP(3),
    "deletedBy" TEXT,

    CONSTRAINT "StockItem_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "StockMovement" (
    "id" TEXT NOT NULL,
    "stockItemId" TEXT NOT NULL,
    "type" TEXT NOT NULL,
    "quantity" DECIMAL(14,3) NOT NULL,
    "ticketId" TEXT,
    "requestId" TEXT,
    "reference" TEXT,
    "byId" TEXT NOT NULL,
    "at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "StockMovement_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "MaterialRequest_number_key" ON "MaterialRequest"("number");

-- CreateIndex
CREATE INDEX "MaterialRequest_ticketId_idx" ON "MaterialRequest"("ticketId");

-- CreateIndex
CREATE INDEX "MaterialRequest_status_neededBy_idx" ON "MaterialRequest"("status", "neededBy");

-- CreateIndex
CREATE INDEX "MaterialRequestLine_stockItemId_idx" ON "MaterialRequestLine"("stockItemId");

-- CreateIndex
CREATE INDEX "MaterialRequestLine_calibrationAssetId_idx" ON "MaterialRequestLine"("calibrationAssetId");

-- CreateIndex
CREATE UNIQUE INDEX "MaterialRequestLine_requestId_lineNo_key" ON "MaterialRequestLine"("requestId", "lineNo");

-- CreateIndex
CREATE UNIQUE INDEX "StockItem_sku_key" ON "StockItem"("sku");

-- CreateIndex
CREATE INDEX "StockItem_category_name_idx" ON "StockItem"("category", "name");

-- CreateIndex
CREATE INDEX "StockMovement_stockItemId_at_idx" ON "StockMovement"("stockItemId", "at");

-- CreateIndex
CREATE INDEX "StockMovement_ticketId_idx" ON "StockMovement"("ticketId");

-- AddForeignKey
ALTER TABLE "MaterialRequest" ADD CONSTRAINT "MaterialRequest_ticketId_fkey" FOREIGN KEY ("ticketId") REFERENCES "Ticket"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "MaterialRequest" ADD CONSTRAINT "MaterialRequest_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "Project"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "MaterialRequestLine" ADD CONSTRAINT "MaterialRequestLine_requestId_fkey" FOREIGN KEY ("requestId") REFERENCES "MaterialRequest"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "MaterialRequestLine" ADD CONSTRAINT "MaterialRequestLine_stockItemId_fkey" FOREIGN KEY ("stockItemId") REFERENCES "StockItem"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "StockMovement" ADD CONSTRAINT "StockMovement_stockItemId_fkey" FOREIGN KEY ("stockItemId") REFERENCES "StockItem"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
