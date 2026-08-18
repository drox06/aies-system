-- CreateTable
CREATE TABLE "DeliveryTicketFlow" (
    "id" TEXT NOT NULL,
    "ticketId" TEXT NOT NULL,
    "deliveryReceiptId" TEXT,
    "mode" TEXT NOT NULL DEFAULT 'own_vehicle',
    "drRequestedAt" TIMESTAMP(3),
    "drRequestedById" TEXT,
    "drIssuedAt" TIMESTAMP(3),
    "drIssuedById" TEXT,
    "mobilizedAt" TIMESTAMP(3),
    "demobilizedAt" TIMESTAMP(3),
    "vehicleRef" TEXT,
    "driverName" TEXT,
    "attempts" JSONB NOT NULL DEFAULT '[]',
    "courierName" TEXT,
    "waybillNumber" TEXT,
    "trackingUrl" TEXT,
    "bookedAt" TIMESTAMP(3),
    "pickedUpAt" TIMESTAMP(3),
    "courierPodFileId" TEXT,
    "courierDeliveredAt" TIMESTAMP(3),
    "courierRecipientName" TEXT,
    "freightCost" INTEGER,
    "insuredValue" INTEGER,
    "status" TEXT NOT NULL DEFAULT 'dr_requested',
    "deliveredAt" TIMESTAMP(3),
    "unsignedEscalatedAt" TIMESTAMP(3),
    "finalOutcome" TEXT,
    "completedAt" TIMESTAMP(3),
    "version" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "deletedAt" TIMESTAMP(3),
    "deletedBy" TEXT,

    CONSTRAINT "DeliveryTicketFlow_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "DeliveryReceipt" (
    "id" TEXT NOT NULL,
    "number" TEXT NOT NULL,
    "salesOrderId" TEXT NOT NULL,
    "ticketId" TEXT NOT NULL,
    "accountId" TEXT NOT NULL,
    "siteId" TEXT,
    "status" TEXT NOT NULL DEFAULT 'draft',
    "issuedAt" TIMESTAMP(3),
    "issuedById" TEXT,
    "deliveredAt" TIMESTAMP(3),
    "recipientName" TEXT,
    "recipientPosition" TEXT,
    "signatureFileId" TEXT,
    "signedAt" TIMESTAMP(3),
    "photoFileIds" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "remarks" TEXT,
    "version" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "deletedAt" TIMESTAMP(3),
    "deletedBy" TEXT,

    CONSTRAINT "DeliveryReceipt_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "DeliveryReceiptLine" (
    "id" TEXT NOT NULL,
    "deliveryReceiptId" TEXT NOT NULL,
    "salesOrderLineId" TEXT NOT NULL,
    "lineNo" INTEGER NOT NULL,
    "description" TEXT NOT NULL,
    "quantity" DECIMAL(14,3) NOT NULL DEFAULT 1,
    "unit" TEXT NOT NULL DEFAULT 'pc',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "DeliveryReceiptLine_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "DeliveryTicketFlow_ticketId_key" ON "DeliveryTicketFlow"("ticketId");

-- CreateIndex
CREATE INDEX "DeliveryTicketFlow_status_deliveredAt_idx" ON "DeliveryTicketFlow"("status", "deliveredAt");

-- CreateIndex
CREATE INDEX "DeliveryTicketFlow_mode_status_idx" ON "DeliveryTicketFlow"("mode", "status");

-- CreateIndex
CREATE UNIQUE INDEX "DeliveryReceipt_number_key" ON "DeliveryReceipt"("number");

-- CreateIndex
CREATE INDEX "DeliveryReceipt_salesOrderId_status_idx" ON "DeliveryReceipt"("salesOrderId", "status");

-- CreateIndex
CREATE INDEX "DeliveryReceipt_ticketId_idx" ON "DeliveryReceipt"("ticketId");

-- CreateIndex
CREATE INDEX "DeliveryReceipt_status_deliveredAt_idx" ON "DeliveryReceipt"("status", "deliveredAt");

-- CreateIndex
CREATE INDEX "DeliveryReceiptLine_salesOrderLineId_idx" ON "DeliveryReceiptLine"("salesOrderLineId");

-- CreateIndex
CREATE UNIQUE INDEX "DeliveryReceiptLine_deliveryReceiptId_lineNo_key" ON "DeliveryReceiptLine"("deliveryReceiptId", "lineNo");

-- AddForeignKey
ALTER TABLE "DeliveryTicketFlow" ADD CONSTRAINT "DeliveryTicketFlow_ticketId_fkey" FOREIGN KEY ("ticketId") REFERENCES "Ticket"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "DeliveryReceipt" ADD CONSTRAINT "DeliveryReceipt_salesOrderId_fkey" FOREIGN KEY ("salesOrderId") REFERENCES "SalesOrder"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "DeliveryReceiptLine" ADD CONSTRAINT "DeliveryReceiptLine_deliveryReceiptId_fkey" FOREIGN KEY ("deliveryReceiptId") REFERENCES "DeliveryReceipt"("id") ON DELETE CASCADE ON UPDATE CASCADE;
