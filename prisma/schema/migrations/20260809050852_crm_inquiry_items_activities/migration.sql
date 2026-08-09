-- CreateTable
CREATE TABLE "Inquiry" (
    "id" TEXT NOT NULL,
    "number" TEXT NOT NULL,
    "accountId" TEXT,
    "siteId" TEXT,
    "contactId" TEXT,
    "source" TEXT NOT NULL DEFAULT 'phone',
    "sourceRef" TEXT,
    "receivedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "subject" TEXT NOT NULL,
    "description" TEXT,
    "requirements" JSONB NOT NULL DEFAULT '{}',
    "industry" TEXT,
    "estimatedValue" DECIMAL(14,2),
    "currency" TEXT NOT NULL DEFAULT 'PHP',
    "requiredByDate" TIMESTAMP(3),
    "status" TEXT NOT NULL DEFAULT 'new',
    "ownerId" TEXT NOT NULL,
    "assignedAt" TIMESTAMP(3),
    "qualification" JSONB,
    "lostReason" TEXT,
    "lostToCompetitor" TEXT,
    "acknowledgedAt" TIMESTAMP(3),
    "slaPausedAt" TIMESTAMP(3),
    "slaPausedMs" INTEGER NOT NULL DEFAULT 0,
    "slaEscalatedAt" TIMESTAMP(3),
    "requirementsOverrideReason" TEXT,
    "requirementsOverrideBy" TEXT,
    "requirementsOverrideAt" TIMESTAMP(3),
    "nextFollowUpAt" TIMESTAMP(3),
    "customFields" JSONB NOT NULL DEFAULT '{}',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "deletedAt" TIMESTAMP(3),
    "deletedBy" TEXT,

    CONSTRAINT "Inquiry_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "InquiryItem" (
    "id" TEXT NOT NULL,
    "inquiryId" TEXT NOT NULL,
    "lineNo" INTEGER NOT NULL,
    "description" TEXT NOT NULL,
    "quantity" DECIMAL(14,3) NOT NULL DEFAULT 1,
    "unit" TEXT NOT NULL DEFAULT 'pc',
    "manufacturer" TEXT,
    "modelNumber" TEXT,
    "specifications" JSONB,
    "serviceType" TEXT,
    "notes" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "InquiryItem_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Activity" (
    "id" TEXT NOT NULL,
    "entityType" TEXT NOT NULL,
    "entityId" TEXT NOT NULL,
    "type" TEXT NOT NULL,
    "subject" TEXT NOT NULL,
    "body" TEXT,
    "occurredAt" TIMESTAMP(3) NOT NULL,
    "durationMin" INTEGER,
    "participantIds" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "contactIds" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "outcome" TEXT,
    "nextStepDue" TIMESTAMP(3),
    "createdById" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "deletedAt" TIMESTAMP(3),
    "deletedBy" TEXT,

    CONSTRAINT "Activity_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "RequirementTemplate" (
    "id" TEXT NOT NULL,
    "serviceType" TEXT NOT NULL,
    "label" TEXT NOT NULL,
    "fields" JSONB NOT NULL DEFAULT '[]',
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "RequirementTemplate_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "InspectionRequest" (
    "id" TEXT NOT NULL,
    "inquiryId" TEXT NOT NULL,
    "siteId" TEXT,
    "purpose" TEXT NOT NULL,
    "questions" TEXT,
    "requiredOutputs" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "windowStart" TIMESTAMP(3),
    "windowEnd" TIMESTAMP(3),
    "status" TEXT NOT NULL DEFAULT 'requested',
    "assignedToId" TEXT,
    "dueAt" TIMESTAMP(3),
    "completedAt" TIMESTAMP(3),
    "reportFileId" TEXT,
    "findings" TEXT,
    "requestedById" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "deletedAt" TIMESTAMP(3),
    "deletedBy" TEXT,

    CONSTRAINT "InspectionRequest_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "Inquiry_number_key" ON "Inquiry"("number");

-- CreateIndex
CREATE INDEX "Inquiry_ownerId_status_idx" ON "Inquiry"("ownerId", "status");

-- CreateIndex
CREATE INDEX "Inquiry_status_receivedAt_idx" ON "Inquiry"("status", "receivedAt");

-- CreateIndex
CREATE INDEX "Inquiry_accountId_deletedAt_idx" ON "Inquiry"("accountId", "deletedAt");

-- CreateIndex
CREATE INDEX "Inquiry_acknowledgedAt_slaEscalatedAt_deletedAt_idx" ON "Inquiry"("acknowledgedAt", "slaEscalatedAt", "deletedAt");

-- CreateIndex
CREATE INDEX "InquiryItem_inquiryId_idx" ON "InquiryItem"("inquiryId");

-- CreateIndex
CREATE UNIQUE INDEX "InquiryItem_inquiryId_lineNo_key" ON "InquiryItem"("inquiryId", "lineNo");

-- CreateIndex
CREATE INDEX "Activity_entityType_entityId_occurredAt_idx" ON "Activity"("entityType", "entityId", "occurredAt");

-- CreateIndex
CREATE INDEX "Activity_createdById_occurredAt_idx" ON "Activity"("createdById", "occurredAt");

-- CreateIndex
CREATE UNIQUE INDEX "RequirementTemplate_serviceType_key" ON "RequirementTemplate"("serviceType");

-- CreateIndex
CREATE INDEX "InspectionRequest_inquiryId_idx" ON "InspectionRequest"("inquiryId");

-- CreateIndex
CREATE INDEX "InspectionRequest_assignedToId_status_idx" ON "InspectionRequest"("assignedToId", "status");

-- CreateIndex
CREATE INDEX "InspectionRequest_status_dueAt_idx" ON "InspectionRequest"("status", "dueAt");

-- AddForeignKey
ALTER TABLE "Inquiry" ADD CONSTRAINT "Inquiry_accountId_fkey" FOREIGN KEY ("accountId") REFERENCES "CustomerAccount"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Inquiry" ADD CONSTRAINT "Inquiry_siteId_fkey" FOREIGN KEY ("siteId") REFERENCES "Site"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Inquiry" ADD CONSTRAINT "Inquiry_contactId_fkey" FOREIGN KEY ("contactId") REFERENCES "Contact"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "InquiryItem" ADD CONSTRAINT "InquiryItem_inquiryId_fkey" FOREIGN KEY ("inquiryId") REFERENCES "Inquiry"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "InspectionRequest" ADD CONSTRAINT "InspectionRequest_inquiryId_fkey" FOREIGN KEY ("inquiryId") REFERENCES "Inquiry"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "InspectionRequest" ADD CONSTRAINT "InspectionRequest_siteId_fkey" FOREIGN KEY ("siteId") REFERENCES "Site"("id") ON DELETE SET NULL ON UPDATE CASCADE;
