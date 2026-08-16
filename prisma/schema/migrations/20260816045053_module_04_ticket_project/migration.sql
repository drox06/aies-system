-- CreateTable
CREATE TABLE "Ticket" (
    "id" TEXT NOT NULL,
    "number" TEXT NOT NULL,
    "salesOrderId" TEXT,
    "customerPOId" TEXT,
    "accountId" TEXT NOT NULL,
    "siteId" TEXT,
    "type" TEXT NOT NULL,
    "subType" TEXT,
    "priority" TEXT NOT NULL DEFAULT 'normal',
    "title" TEXT NOT NULL,
    "scopeOfWork" TEXT NOT NULL,
    "specialInstructions" TEXT,
    "status" TEXT NOT NULL DEFAULT 'generated',
    "projectId" TEXT,
    "raisedById" TEXT NOT NULL,
    "raisedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "assignedLeadId" TEXT,
    "assignedUserIds" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "requiredByDate" TIMESTAMP(3),
    "holdReason" TEXT,
    "cashAdvanceRequired" BOOLEAN NOT NULL DEFAULT false,
    "materialRequestStatus" TEXT NOT NULL DEFAULT 'not_applicable',
    "billable" BOOLEAN NOT NULL DEFAULT true,
    "justification" TEXT,
    "customFields" JSONB NOT NULL DEFAULT '{}',
    "version" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "deletedAt" TIMESTAMP(3),
    "deletedBy" TEXT,

    CONSTRAINT "Ticket_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "TicketSalesOrderLine" (
    "id" TEXT NOT NULL,
    "ticketId" TEXT NOT NULL,
    "salesOrderLineId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "TicketSalesOrderLine_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Project" (
    "id" TEXT NOT NULL,
    "code" TEXT NOT NULL,
    "salesOrderId" TEXT,
    "accountId" TEXT NOT NULL,
    "siteId" TEXT,
    "name" TEXT NOT NULL,
    "description" TEXT,
    "scopeOfWork" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'planning',
    "plannedStart" TIMESTAMP(3),
    "plannedEnd" TIMESTAMP(3),
    "actualStart" TIMESTAMP(3),
    "actualEnd" TIMESTAMP(3),
    "projectManagerId" TEXT,
    "teamMemberIds" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "contractValue" DECIMAL(14,2) NOT NULL DEFAULT 0,
    "budgetCost" DECIMAL(14,2) NOT NULL DEFAULT 0,
    "actualCost" DECIMAL(14,2) NOT NULL DEFAULT 0,
    "progressPct" INTEGER NOT NULL DEFAULT 0,
    "riskLevel" TEXT NOT NULL DEFAULT 'low',
    "holdReason" TEXT,
    "customFields" JSONB NOT NULL DEFAULT '{}',
    "version" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "deletedAt" TIMESTAMP(3),
    "deletedBy" TEXT,

    CONSTRAINT "Project_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "Ticket_number_key" ON "Ticket"("number");

-- CreateIndex
CREATE INDEX "Ticket_accountId_status_idx" ON "Ticket"("accountId", "status");

-- CreateIndex
CREATE INDEX "Ticket_salesOrderId_idx" ON "Ticket"("salesOrderId");

-- CreateIndex
CREATE INDEX "Ticket_status_requiredByDate_idx" ON "Ticket"("status", "requiredByDate");

-- CreateIndex
CREATE INDEX "Ticket_assignedLeadId_status_idx" ON "Ticket"("assignedLeadId", "status");

-- CreateIndex
CREATE INDEX "TicketSalesOrderLine_salesOrderLineId_idx" ON "TicketSalesOrderLine"("salesOrderLineId");

-- CreateIndex
CREATE UNIQUE INDEX "TicketSalesOrderLine_ticketId_salesOrderLineId_key" ON "TicketSalesOrderLine"("ticketId", "salesOrderLineId");

-- CreateIndex
CREATE UNIQUE INDEX "Project_code_key" ON "Project"("code");

-- CreateIndex
CREATE INDEX "Project_accountId_status_idx" ON "Project"("accountId", "status");

-- CreateIndex
CREATE INDEX "Project_status_plannedStart_idx" ON "Project"("status", "plannedStart");

-- AddForeignKey
ALTER TABLE "Ticket" ADD CONSTRAINT "Ticket_accountId_fkey" FOREIGN KEY ("accountId") REFERENCES "CustomerAccount"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Ticket" ADD CONSTRAINT "Ticket_siteId_fkey" FOREIGN KEY ("siteId") REFERENCES "Site"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Ticket" ADD CONSTRAINT "Ticket_salesOrderId_fkey" FOREIGN KEY ("salesOrderId") REFERENCES "SalesOrder"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Ticket" ADD CONSTRAINT "Ticket_customerPOId_fkey" FOREIGN KEY ("customerPOId") REFERENCES "CustomerPO"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Ticket" ADD CONSTRAINT "Ticket_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "Project"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TicketSalesOrderLine" ADD CONSTRAINT "TicketSalesOrderLine_ticketId_fkey" FOREIGN KEY ("ticketId") REFERENCES "Ticket"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Project" ADD CONSTRAINT "Project_accountId_fkey" FOREIGN KEY ("accountId") REFERENCES "CustomerAccount"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Project" ADD CONSTRAINT "Project_siteId_fkey" FOREIGN KEY ("siteId") REFERENCES "Site"("id") ON DELETE SET NULL ON UPDATE CASCADE;
