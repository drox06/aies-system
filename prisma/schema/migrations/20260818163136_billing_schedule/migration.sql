-- AlterTable
ALTER TABLE "PaymentTerm" ADD COLUMN     "milestones" JSONB NOT NULL DEFAULT '[]';

-- CreateTable
CREATE TABLE "BillingSchedule" (
    "id" TEXT NOT NULL,
    "salesOrderId" TEXT NOT NULL,
    "paymentTermId" TEXT NOT NULL,
    "termSnapshot" JSONB NOT NULL,
    "generatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "generatedById" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "deletedAt" TIMESTAMP(3),

    CONSTRAINT "BillingSchedule_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "BillingMilestone" (
    "id" TEXT NOT NULL,
    "scheduleId" TEXT NOT NULL,
    "salesOrderId" TEXT NOT NULL,
    "sequence" INTEGER NOT NULL,
    "label" TEXT NOT NULL,
    "pct" DECIMAL(7,4) NOT NULL,
    "amount" INTEGER NOT NULL,
    "trigger" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'pending',
    "readyAt" TIMESTAMP(3),
    "readyReason" TEXT,
    "dueDate" TIMESTAMP(3),
    "billingStatementId" TEXT,
    "cancelledAt" TIMESTAMP(3),
    "cancelledReason" TEXT,
    "version" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "deletedAt" TIMESTAMP(3),

    CONSTRAINT "BillingMilestone_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "BillingSchedule_salesOrderId_key" ON "BillingSchedule"("salesOrderId");

-- CreateIndex
CREATE INDEX "BillingSchedule_paymentTermId_idx" ON "BillingSchedule"("paymentTermId");

-- CreateIndex
CREATE INDEX "BillingMilestone_salesOrderId_status_idx" ON "BillingMilestone"("salesOrderId", "status");

-- CreateIndex
CREATE INDEX "BillingMilestone_status_trigger_idx" ON "BillingMilestone"("status", "trigger");

-- CreateIndex
CREATE INDEX "BillingMilestone_status_dueDate_idx" ON "BillingMilestone"("status", "dueDate");

-- CreateIndex
CREATE UNIQUE INDEX "BillingMilestone_scheduleId_sequence_key" ON "BillingMilestone"("scheduleId", "sequence");

-- AddForeignKey
ALTER TABLE "BillingSchedule" ADD CONSTRAINT "BillingSchedule_paymentTermId_fkey" FOREIGN KEY ("paymentTermId") REFERENCES "PaymentTerm"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "BillingMilestone" ADD CONSTRAINT "BillingMilestone_scheduleId_fkey" FOREIGN KEY ("scheduleId") REFERENCES "BillingSchedule"("id") ON DELETE CASCADE ON UPDATE CASCADE;
