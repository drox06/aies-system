-- CreateTable
CREATE TABLE "ServiceReport" (
    "id" TEXT NOT NULL,
    "number" TEXT NOT NULL,
    "ticketId" TEXT NOT NULL,
    "projectId" TEXT,
    "workPerformed" TEXT NOT NULL,
    "findings" TEXT,
    "recommendations" TEXT,
    "partsUsed" JSONB NOT NULL DEFAULT '[]',
    "equipmentIds" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "startedAt" TIMESTAMP(3),
    "finishedAt" TIMESTAMP(3),
    "travelTimeMin" INTEGER,
    "standbyTimeMin" INTEGER,
    "status" TEXT NOT NULL DEFAULT 'draft',
    "customerSignatureFileId" TEXT,
    "customerName" TEXT,
    "customerPosition" TEXT,
    "customerRemarks" TEXT,
    "signatureWaiverReason" TEXT,
    "technicianSignatureFileId" TEXT,
    "photoFileIds" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "followUpRequired" BOOLEAN NOT NULL DEFAULT false,
    "followUpNotes" TEXT,
    "ncrRaised" BOOLEAN NOT NULL DEFAULT false,
    "preparedById" TEXT NOT NULL,
    "approvedById" TEXT,
    "approvedAt" TIMESTAMP(3),
    "version" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "deletedAt" TIMESTAMP(3),
    "deletedBy" TEXT,

    CONSTRAINT "ServiceReport_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ProjectCloseOut" (
    "id" TEXT NOT NULL,
    "projectId" TEXT NOT NULL,
    "checklist" JSONB NOT NULL DEFAULT '[]',
    "status" TEXT NOT NULL DEFAULT 'in_progress',
    "documentIds" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "submittedById" TEXT,
    "submittedAt" TIMESTAMP(3),
    "approvedById" TEXT,
    "approvedAt" TIMESTAMP(3),
    "customerAcceptanceRequired" BOOLEAN NOT NULL DEFAULT true,
    "customerAcceptanceFileId" TEXT,
    "acceptanceDate" TIMESTAMP(3),
    "acceptanceWaiverReason" TEXT,
    "lessonsLearned" TEXT,
    "version" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "deletedAt" TIMESTAMP(3),
    "deletedBy" TEXT,

    CONSTRAINT "ProjectCloseOut_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "ServiceReport_number_key" ON "ServiceReport"("number");

-- CreateIndex
CREATE INDEX "ServiceReport_ticketId_status_idx" ON "ServiceReport"("ticketId", "status");

-- CreateIndex
CREATE INDEX "ServiceReport_projectId_status_idx" ON "ServiceReport"("projectId", "status");

-- CreateIndex
CREATE UNIQUE INDEX "ProjectCloseOut_projectId_key" ON "ProjectCloseOut"("projectId");

-- CreateIndex
CREATE INDEX "ProjectCloseOut_status_idx" ON "ProjectCloseOut"("status");

-- AddForeignKey
ALTER TABLE "ServiceReport" ADD CONSTRAINT "ServiceReport_ticketId_fkey" FOREIGN KEY ("ticketId") REFERENCES "Ticket"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ServiceReport" ADD CONSTRAINT "ServiceReport_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "Project"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ProjectCloseOut" ADD CONSTRAINT "ProjectCloseOut_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "Project"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
