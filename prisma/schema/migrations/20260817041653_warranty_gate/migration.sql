-- CreateTable
CREATE TABLE "Equipment" (
    "id" TEXT NOT NULL,
    "accountId" TEXT NOT NULL,
    "siteId" TEXT,
    "tagNumber" TEXT,
    "serialNumber" TEXT,
    "productId" TEXT,
    "manufacturer" TEXT,
    "modelNumber" TEXT,
    "description" TEXT NOT NULL,
    "installedAt" TIMESTAMP(3),
    "installedByTicketId" TEXT,
    "salesOrderId" TEXT,
    "commissionedAt" TIMESTAMP(3),
    "commissionedByTcId" TEXT,
    "warrantyStart" TIMESTAMP(3),
    "warrantyEnd" TIMESTAMP(3),
    "warrantyTerms" TEXT,
    "calibrationDueAt" TIMESTAMP(3),
    "lastServiceAt" TIMESTAMP(3),
    "nextPMDueAt" TIMESTAMP(3),
    "location" TEXT,
    "processDescription" TEXT,
    "status" TEXT NOT NULL DEFAULT 'active',
    "documentIds" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "version" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "deletedAt" TIMESTAMP(3),
    "deletedBy" TEXT,

    CONSTRAINT "Equipment_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "WarrantyClaim" (
    "id" TEXT NOT NULL,
    "number" TEXT NOT NULL,
    "accountId" TEXT NOT NULL,
    "equipmentId" TEXT,
    "originalProjectId" TEXT,
    "originalTicketId" TEXT,
    "reportedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "reportedById" TEXT NOT NULL,
    "faultDescription" TEXT NOT NULL,
    "coverage" TEXT NOT NULL,
    "coverageDeterminedAt" TIMESTAMP(3),
    "coverageDeterminedById" TEXT,
    "coverageOverrideReason" TEXT,
    "attribution" TEXT NOT NULL DEFAULT 'undetermined',
    "rootCause" TEXT,
    "rootCauseCategory" TEXT,
    "billable" BOOLEAN NOT NULL,
    "resultingTicketId" TEXT,
    "ncrRequired" BOOLEAN NOT NULL DEFAULT false,
    "salesReferredAt" TIMESTAMP(3),
    "status" TEXT NOT NULL DEFAULT 'open',
    "remarks" TEXT,
    "version" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "deletedAt" TIMESTAMP(3),
    "deletedBy" TEXT,

    CONSTRAINT "WarrantyClaim_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "Equipment_accountId_status_idx" ON "Equipment"("accountId", "status");

-- CreateIndex
CREATE INDEX "Equipment_warrantyEnd_idx" ON "Equipment"("warrantyEnd");

-- CreateIndex
CREATE INDEX "Equipment_serialNumber_idx" ON "Equipment"("serialNumber");

-- CreateIndex
CREATE UNIQUE INDEX "WarrantyClaim_number_key" ON "WarrantyClaim"("number");

-- CreateIndex
CREATE INDEX "WarrantyClaim_accountId_status_idx" ON "WarrantyClaim"("accountId", "status");

-- CreateIndex
CREATE INDEX "WarrantyClaim_coverage_attribution_idx" ON "WarrantyClaim"("coverage", "attribution");

-- CreateIndex
CREATE INDEX "WarrantyClaim_reportedAt_idx" ON "WarrantyClaim"("reportedAt");

-- AddForeignKey
ALTER TABLE "Equipment" ADD CONSTRAINT "Equipment_accountId_fkey" FOREIGN KEY ("accountId") REFERENCES "CustomerAccount"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "WarrantyClaim" ADD CONSTRAINT "WarrantyClaim_accountId_fkey" FOREIGN KEY ("accountId") REFERENCES "CustomerAccount"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "WarrantyClaim" ADD CONSTRAINT "WarrantyClaim_equipmentId_fkey" FOREIGN KEY ("equipmentId") REFERENCES "Equipment"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "WarrantyClaim" ADD CONSTRAINT "WarrantyClaim_originalProjectId_fkey" FOREIGN KEY ("originalProjectId") REFERENCES "Project"("id") ON DELETE SET NULL ON UPDATE CASCADE;
