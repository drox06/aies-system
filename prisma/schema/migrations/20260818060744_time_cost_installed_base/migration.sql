-- CreateTable
CREATE TABLE "Timesheet" (
    "id" TEXT NOT NULL,
    "ticketId" TEXT,
    "projectId" TEXT,
    "userId" TEXT NOT NULL,
    "date" DATE NOT NULL,
    "regularHours" DECIMAL(6,2) NOT NULL DEFAULT 0,
    "overtimeHours" DECIMAL(6,2) NOT NULL DEFAULT 0,
    "travelHours" DECIMAL(6,2) NOT NULL DEFAULT 0,
    "standbyHours" DECIMAL(6,2) NOT NULL DEFAULT 0,
    "activity" TEXT,
    "notes" TEXT,
    "status" TEXT NOT NULL DEFAULT 'draft',
    "approvedById" TEXT,
    "approvedAt" TIMESTAMP(3),
    "rejectedReason" TEXT,
    "version" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "deletedAt" TIMESTAMP(3),
    "deletedBy" TEXT,

    CONSTRAINT "Timesheet_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "FieldExpense" (
    "id" TEXT NOT NULL,
    "ticketId" TEXT,
    "projectId" TEXT,
    "cashAdvanceId" TEXT,
    "userId" TEXT NOT NULL,
    "date" DATE NOT NULL,
    "category" TEXT NOT NULL,
    "amount" INTEGER NOT NULL,
    "currency" TEXT NOT NULL DEFAULT 'PHP',
    "description" TEXT NOT NULL,
    "receiptFileIds" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "status" TEXT NOT NULL DEFAULT 'draft',
    "approvedById" TEXT,
    "approvedAt" TIMESTAMP(3),
    "rejectedReason" TEXT,
    "reimbursedAt" TIMESTAMP(3),
    "version" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "deletedAt" TIMESTAMP(3),
    "deletedBy" TEXT,

    CONSTRAINT "FieldExpense_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "MaintenanceContract" (
    "id" TEXT NOT NULL,
    "number" TEXT NOT NULL,
    "accountId" TEXT NOT NULL,
    "siteId" TEXT,
    "startDate" DATE NOT NULL,
    "endDate" DATE NOT NULL,
    "visitsPerYear" INTEGER NOT NULL DEFAULT 1,
    "scheduleRule" JSONB NOT NULL DEFAULT '{}',
    "equipmentIds" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "contractValue" INTEGER NOT NULL DEFAULT 0,
    "currency" TEXT NOT NULL DEFAULT 'PHP',
    "salesOrderId" TEXT,
    "status" TEXT NOT NULL DEFAULT 'draft',
    "renewalFlaggedAt" TIMESTAMP(3),
    "renewedIntoId" TEXT,
    "version" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "deletedAt" TIMESTAMP(3),
    "deletedBy" TEXT,

    CONSTRAINT "MaintenanceContract_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "Timesheet_userId_date_idx" ON "Timesheet"("userId", "date");

-- CreateIndex
CREATE INDEX "Timesheet_ticketId_status_idx" ON "Timesheet"("ticketId", "status");

-- CreateIndex
CREATE INDEX "Timesheet_projectId_status_idx" ON "Timesheet"("projectId", "status");

-- CreateIndex
CREATE INDEX "Timesheet_status_date_idx" ON "Timesheet"("status", "date");

-- CreateIndex
CREATE UNIQUE INDEX "Timesheet_userId_date_ticketId_key" ON "Timesheet"("userId", "date", "ticketId");

-- CreateIndex
CREATE INDEX "FieldExpense_cashAdvanceId_status_idx" ON "FieldExpense"("cashAdvanceId", "status");

-- CreateIndex
CREATE INDEX "FieldExpense_ticketId_status_idx" ON "FieldExpense"("ticketId", "status");

-- CreateIndex
CREATE INDEX "FieldExpense_projectId_status_idx" ON "FieldExpense"("projectId", "status");

-- CreateIndex
CREATE INDEX "FieldExpense_userId_date_idx" ON "FieldExpense"("userId", "date");

-- CreateIndex
CREATE UNIQUE INDEX "MaintenanceContract_number_key" ON "MaintenanceContract"("number");

-- CreateIndex
CREATE INDEX "MaintenanceContract_accountId_status_idx" ON "MaintenanceContract"("accountId", "status");

-- CreateIndex
CREATE INDEX "MaintenanceContract_status_endDate_idx" ON "MaintenanceContract"("status", "endDate");

-- CreateIndex
CREATE INDEX "Equipment_status_calibrationDueAt_idx" ON "Equipment"("status", "calibrationDueAt");

-- CreateIndex
CREATE INDEX "Equipment_status_nextPMDueAt_idx" ON "Equipment"("status", "nextPMDueAt");

-- AddForeignKey
ALTER TABLE "MaintenanceContract" ADD CONSTRAINT "MaintenanceContract_accountId_fkey" FOREIGN KEY ("accountId") REFERENCES "CustomerAccount"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
