-- CreateTable
CREATE TABLE "CashAdvance" (
    "id" TEXT NOT NULL,
    "number" TEXT NOT NULL,
    "ticketId" TEXT,
    "projectId" TEXT,
    "requestedById" TEXT NOT NULL,
    "requestedFor" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "purpose" TEXT NOT NULL,
    "breakdown" JSONB NOT NULL DEFAULT '[]',
    "amountRequested" DECIMAL(14,2) NOT NULL,
    "amountApproved" DECIMAL(14,2),
    "currency" TEXT NOT NULL DEFAULT 'PHP',
    "neededBy" TIMESTAMP(3) NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'draft',
    "approvedById" TEXT,
    "approvedAt" TIMESTAMP(3),
    "rejectionReason" TEXT,
    "extensions" JSONB NOT NULL DEFAULT '[]',
    "releasedById" TEXT,
    "releasedAt" TIMESTAMP(3),
    "releaseMethod" TEXT,
    "liquidationDueAt" TIMESTAMP(3),
    "liquidatedAt" TIMESTAMP(3),
    "amountLiquidated" DECIMAL(14,2),
    "amountReturned" DECIMAL(14,2),
    "amountReimbursed" DECIMAL(14,2),
    "version" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "deletedAt" TIMESTAMP(3),
    "deletedBy" TEXT,

    CONSTRAINT "CashAdvance_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "CashAdvanceLiquidation" (
    "id" TEXT NOT NULL,
    "cashAdvanceId" TEXT NOT NULL,
    "submittedById" TEXT NOT NULL,
    "submittedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "lines" JSONB NOT NULL DEFAULT '[]',
    "totalSpent" DECIMAL(14,2) NOT NULL DEFAULT 0,
    "balanceReturned" DECIMAL(14,2) NOT NULL DEFAULT 0,
    "balanceReimbursable" DECIMAL(14,2) NOT NULL DEFAULT 0,
    "status" TEXT NOT NULL DEFAULT 'submitted',
    "reviewedById" TEXT,
    "reviewedAt" TIMESTAMP(3),
    "remarks" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "CashAdvanceLiquidation_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "CashAdvance_number_key" ON "CashAdvance"("number");

-- CreateIndex
CREATE INDEX "CashAdvance_status_liquidationDueAt_idx" ON "CashAdvance"("status", "liquidationDueAt");

-- CreateIndex
CREATE INDEX "CashAdvance_ticketId_idx" ON "CashAdvance"("ticketId");

-- CreateIndex
CREATE INDEX "CashAdvance_requestedById_status_idx" ON "CashAdvance"("requestedById", "status");

-- CreateIndex
CREATE INDEX "CashAdvanceLiquidation_cashAdvanceId_submittedAt_idx" ON "CashAdvanceLiquidation"("cashAdvanceId", "submittedAt");

-- CreateIndex
CREATE INDEX "CashAdvanceLiquidation_status_idx" ON "CashAdvanceLiquidation"("status");

-- AddForeignKey
ALTER TABLE "CashAdvance" ADD CONSTRAINT "CashAdvance_ticketId_fkey" FOREIGN KEY ("ticketId") REFERENCES "Ticket"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CashAdvance" ADD CONSTRAINT "CashAdvance_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "Project"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CashAdvanceLiquidation" ADD CONSTRAINT "CashAdvanceLiquidation_cashAdvanceId_fkey" FOREIGN KEY ("cashAdvanceId") REFERENCES "CashAdvance"("id") ON DELETE CASCADE ON UPDATE CASCADE;
