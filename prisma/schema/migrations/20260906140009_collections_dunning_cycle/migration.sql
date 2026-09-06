-- AlterTable
ALTER TABLE "CustomerAccount" DROP COLUMN "collectionRemindersEnabled",
DROP COLUMN "collectionRemindersOffReason";

-- DropTable
DROP TABLE "CollectionReminder";

-- CreateTable
CREATE TABLE "CollectionCycle" (
    "id" TEXT NOT NULL,
    "statementId" TEXT NOT NULL,
    "accountId" TEXT NOT NULL,
    "state" TEXT NOT NULL DEFAULT 'matured',
    "maturedNotifiedAt" TIMESTAMP(3),
    "weeklyNotifiedCount" INTEGER NOT NULL DEFAULT 0,
    "lastWeeklyNotifiedAt" TIMESTAMP(3),
    "timelinePromptOpenedAt" TIMESTAMP(3),
    "expectedPaymentDate" TIMESTAMP(3),
    "expectedPaymentSetAt" TIMESTAMP(3),
    "expectedPaymentSetById" TEXT,
    "missedDateCount" INTEGER NOT NULL DEFAULT 0,
    "lastEscalationNotifiedAt" TIMESTAMP(3),
    "closedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "CollectionCycle_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "CollectionCycle_statementId_key" ON "CollectionCycle"("statementId");

-- CreateIndex
CREATE INDEX "CollectionCycle_state_idx" ON "CollectionCycle"("state");

-- CreateIndex
CREATE INDEX "CollectionCycle_accountId_state_idx" ON "CollectionCycle"("accountId", "state");
