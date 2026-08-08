-- CreateTable
CREATE TABLE "AccreditationRecord" (
    "id" TEXT NOT NULL,
    "accountId" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'not_started',
    "submittedAt" TIMESTAMP(3),
    "accreditedAt" TIMESTAMP(3),
    "expiresAt" TIMESTAMP(3),
    "referenceNumber" TEXT,
    "customerPortalUrl" TEXT,
    "customerContactId" TEXT,
    "requirements" JSONB NOT NULL DEFAULT '[]',
    "rejectionReason" TEXT,
    "notes" TEXT,
    "ownerId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "deletedAt" TIMESTAMP(3),
    "deletedBy" TEXT,

    CONSTRAINT "AccreditationRecord_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "AccreditationRecord_status_expiresAt_idx" ON "AccreditationRecord"("status", "expiresAt");

-- CreateIndex
CREATE INDEX "AccreditationRecord_ownerId_idx" ON "AccreditationRecord"("ownerId");

-- CreateIndex
CREATE UNIQUE INDEX "AccreditationRecord_accountId_deletedAt_key" ON "AccreditationRecord"("accountId", "deletedAt");

-- AddForeignKey
ALTER TABLE "AccreditationRecord" ADD CONSTRAINT "AccreditationRecord_accountId_fkey" FOREIGN KEY ("accountId") REFERENCES "CustomerAccount"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
