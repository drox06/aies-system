-- CreateTable
CREATE TABLE "SiteInspection" (
    "id" TEXT NOT NULL,
    "number" TEXT NOT NULL,
    "ticketId" TEXT,
    "projectId" TEXT,
    "inquiryId" TEXT,
    "inspectionRequestId" TEXT,
    "siteId" TEXT,
    "inspectedAt" TIMESTAMP(3),
    "inspectedByIds" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "findings" TEXT,
    "existingConditions" JSONB NOT NULL DEFAULT '{}',
    "measurements" JSONB NOT NULL DEFAULT '[]',
    "tagNumbers" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "accessConstraints" TEXT,
    "permitsRequired" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "hazards" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "utilitiesAvailable" JSONB NOT NULL DEFAULT '{}',
    "photoFileIds" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "sketchFileIds" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "status" TEXT NOT NULL DEFAULT 'scheduled',
    "scopeChangeIdentified" BOOLEAN NOT NULL DEFAULT false,
    "scopeChangeNotes" TEXT,
    "scopeChangeReportedAt" TIMESTAMP(3),
    "requestedById" TEXT,
    "scheduledFor" TIMESTAMP(3),
    "completedAt" TIMESTAMP(3),
    "approvedById" TEXT,
    "approvedAt" TIMESTAMP(3),
    "version" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "deletedAt" TIMESTAMP(3),
    "deletedBy" TEXT,

    CONSTRAINT "SiteInspection_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "SiteInspection_number_key" ON "SiteInspection"("number");

-- CreateIndex
CREATE UNIQUE INDEX "SiteInspection_inspectionRequestId_key" ON "SiteInspection"("inspectionRequestId");

-- CreateIndex
CREATE INDEX "SiteInspection_status_scheduledFor_idx" ON "SiteInspection"("status", "scheduledFor");

-- CreateIndex
CREATE INDEX "SiteInspection_ticketId_idx" ON "SiteInspection"("ticketId");

-- CreateIndex
CREATE INDEX "SiteInspection_inquiryId_idx" ON "SiteInspection"("inquiryId");

-- AddForeignKey
ALTER TABLE "SiteInspection" ADD CONSTRAINT "SiteInspection_ticketId_fkey" FOREIGN KEY ("ticketId") REFERENCES "Ticket"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SiteInspection" ADD CONSTRAINT "SiteInspection_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "Project"("id") ON DELETE SET NULL ON UPDATE CASCADE;
