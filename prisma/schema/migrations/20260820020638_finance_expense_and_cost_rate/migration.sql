-- CreateTable
CREATE TABLE "Expense" (
    "id" TEXT NOT NULL,
    "number" TEXT NOT NULL,
    "category" TEXT NOT NULL,
    "vendorName" TEXT,
    "expenseDate" TIMESTAMP(3) NOT NULL,
    "amount" DECIMAL(14,2) NOT NULL,
    "currency" TEXT NOT NULL DEFAULT 'PHP',
    "vatAmount" DECIMAL(14,2),
    "description" TEXT NOT NULL,
    "salesOrderId" TEXT,
    "projectId" TEXT,
    "ticketId" TEXT,
    "paymentMethod" TEXT,
    "receiptFileIds" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "status" TEXT NOT NULL DEFAULT 'draft',
    "submittedById" TEXT NOT NULL,
    "approvedById" TEXT,
    "approvedAt" TIMESTAMP(3),
    "paidAt" TIMESTAMP(3),
    "rejectedReason" TEXT,
    "version" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "deletedAt" TIMESTAMP(3),

    CONSTRAINT "Expense_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "CostRate" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "effectiveFrom" DATE NOT NULL,
    "hourlyCost" DECIMAL(12,2) NOT NULL,
    "overtimeMultiplier" DECIMAL(5,2) NOT NULL DEFAULT 1.25,
    "travelMultiplier" DECIMAL(5,2) NOT NULL DEFAULT 1,
    "standbyMultiplier" DECIMAL(5,2) NOT NULL DEFAULT 1,
    "notes" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "deletedAt" TIMESTAMP(3),

    CONSTRAINT "CostRate_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "Expense_number_key" ON "Expense"("number");

-- CreateIndex
CREATE INDEX "Expense_projectId_status_idx" ON "Expense"("projectId", "status");

-- CreateIndex
CREATE INDEX "Expense_salesOrderId_idx" ON "Expense"("salesOrderId");

-- CreateIndex
CREATE INDEX "Expense_status_expenseDate_idx" ON "Expense"("status", "expenseDate");

-- CreateIndex
CREATE INDEX "CostRate_userId_effectiveFrom_idx" ON "CostRate"("userId", "effectiveFrom");

-- CreateIndex
CREATE UNIQUE INDEX "CostRate_userId_effectiveFrom_key" ON "CostRate"("userId", "effectiveFrom");
