-- CreateTable
CREATE TABLE "Methodology" (
    "id" TEXT NOT NULL,
    "number" TEXT NOT NULL,
    "projectId" TEXT,
    "ticketId" TEXT,
    "title" TEXT NOT NULL,
    "revision" INTEGER NOT NULL DEFAULT 0,
    "parentMethodologyId" TEXT,
    "scopeSummary" TEXT NOT NULL,
    "sequenceOfWork" JSONB NOT NULL DEFAULT '[]',
    "manpowerPlan" JSONB NOT NULL DEFAULT '[]',
    "toolsRequired" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "materialsRequired" JSONB NOT NULL DEFAULT '[]',
    "safetyPlan" TEXT,
    "jsaFileId" TEXT,
    "permitsRequired" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "environmentalConsiderations" TEXT,
    "durationDays" INTEGER,
    "mobilizationPlan" TEXT,
    "demobilizationPlan" TEXT,
    "contingencyPlan" TEXT,
    "status" TEXT NOT NULL DEFAULT 'draft',
    "preparedById" TEXT NOT NULL,
    "reviewedById" TEXT,
    "approvedById" TEXT,
    "approvedAt" TIMESTAMP(3),
    "submittedToClientAt" TIMESTAMP(3),
    "clientApprovedAt" TIMESTAMP(3),
    "clientApprovalFileId" TEXT,
    "clientRejectionNotes" TEXT,
    "clientApprovalRequired" BOOLEAN NOT NULL DEFAULT true,
    "clientApprovalWaiver" TEXT,
    "documentId" TEXT,
    "version" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "deletedAt" TIMESTAMP(3),
    "deletedBy" TEXT,

    CONSTRAINT "Methodology_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "Methodology_projectId_status_idx" ON "Methodology"("projectId", "status");

-- CreateIndex
CREATE INDEX "Methodology_ticketId_idx" ON "Methodology"("ticketId");

-- CreateIndex
CREATE INDEX "Methodology_status_submittedToClientAt_idx" ON "Methodology"("status", "submittedToClientAt");

-- CreateIndex
CREATE UNIQUE INDEX "Methodology_number_revision_key" ON "Methodology"("number", "revision");

-- AddForeignKey
ALTER TABLE "Methodology" ADD CONSTRAINT "Methodology_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "Project"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Methodology" ADD CONSTRAINT "Methodology_ticketId_fkey" FOREIGN KEY ("ticketId") REFERENCES "Ticket"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Methodology" ADD CONSTRAINT "Methodology_parentMethodologyId_fkey" FOREIGN KEY ("parentMethodologyId") REFERENCES "Methodology"("id") ON DELETE SET NULL ON UPDATE CASCADE;
