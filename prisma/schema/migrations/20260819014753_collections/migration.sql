-- AlterTable
ALTER TABLE "CustomerAccount" ADD COLUMN     "collectionRemindersEnabled" BOOLEAN NOT NULL DEFAULT true,
ADD COLUMN     "collectionRemindersOffReason" TEXT;

-- CreateTable
CREATE TABLE "CollectionActivity" (
    "id" TEXT NOT NULL,
    "statementId" TEXT NOT NULL,
    "accountId" TEXT NOT NULL,
    "type" TEXT NOT NULL,
    "contactedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "contactId" TEXT,
    "contactName" TEXT,
    "notes" TEXT NOT NULL,
    "promisedDate" TIMESTAMP(3),
    "outcome" TEXT,
    "byId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "deletedAt" TIMESTAMP(3),

    CONSTRAINT "CollectionActivity_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "CollectionReminder" (
    "id" TEXT NOT NULL,
    "statementId" TEXT NOT NULL,
    "accountId" TEXT NOT NULL,
    "offsetDays" INTEGER NOT NULL,
    "scheduledFor" TIMESTAMP(3) NOT NULL,
    "sentAt" TIMESTAMP(3),
    "suppressedAt" TIMESTAMP(3),
    "suppressedReason" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "CollectionReminder_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "CollectionActivity_statementId_contactedAt_idx" ON "CollectionActivity"("statementId", "contactedAt");

-- CreateIndex
CREATE INDEX "CollectionActivity_accountId_contactedAt_idx" ON "CollectionActivity"("accountId", "contactedAt");

-- CreateIndex
CREATE INDEX "CollectionActivity_promisedDate_idx" ON "CollectionActivity"("promisedDate");

-- CreateIndex
CREATE INDEX "CollectionReminder_scheduledFor_sentAt_idx" ON "CollectionReminder"("scheduledFor", "sentAt");

-- CreateIndex
CREATE UNIQUE INDEX "CollectionReminder_statementId_offsetDays_key" ON "CollectionReminder"("statementId", "offsetDays");
