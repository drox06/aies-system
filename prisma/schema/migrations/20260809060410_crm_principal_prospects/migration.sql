-- CreateTable
CREATE TABLE "PrincipalProspect" (
    "id" TEXT NOT NULL,
    "companyName" TEXT NOT NULL,
    "country" TEXT,
    "website" TEXT,
    "productLines" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "contactName" TEXT,
    "email" TEXT,
    "phone" TEXT,
    "stage" TEXT NOT NULL DEFAULT 'identified',
    "ownerId" TEXT NOT NULL,
    "targetIndustries" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "competingBrands" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "estimatedOpportunity" DECIMAL(14,2),
    "distributorAgreementFileId" TEXT,
    "agreementSignedAt" TIMESTAMP(3),
    "agreementExpiresAt" TIMESTAMP(3),
    "exclusivity" TEXT NOT NULL DEFAULT 'none',
    "priceListFileId" TEXT,
    "priceListReceivedAt" TIMESTAMP(3),
    "priceListValidUntil" TIMESTAMP(3),
    "trainingStatus" TEXT,
    "technicalContactId" TEXT,
    "notes" TEXT,
    "nextFollowUpAt" TIMESTAMP(3),
    "supplierId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "deletedAt" TIMESTAMP(3),
    "deletedBy" TEXT,

    CONSTRAINT "PrincipalProspect_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "PrincipalProspect_stage_ownerId_idx" ON "PrincipalProspect"("stage", "ownerId");

-- CreateIndex
CREATE INDEX "PrincipalProspect_ownerId_nextFollowUpAt_idx" ON "PrincipalProspect"("ownerId", "nextFollowUpAt");

-- CreateIndex
CREATE INDEX "PrincipalProspect_agreementExpiresAt_idx" ON "PrincipalProspect"("agreementExpiresAt");

-- CreateIndex
CREATE INDEX "PrincipalProspect_priceListValidUntil_idx" ON "PrincipalProspect"("priceListValidUntil");
