-- CreateTable
CREATE TABLE "Mobilization" (
    "id" TEXT NOT NULL,
    "ticketId" TEXT NOT NULL,
    "projectId" TEXT,
    "type" TEXT NOT NULL,
    "plannedAt" TIMESTAMP(3),
    "actualAt" TIMESTAMP(3),
    "crewIds" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "vehicleRef" TEXT,
    "driverName" TEXT,
    "toolsChecklist" JSONB NOT NULL DEFAULT '[]',
    "ppeChecklist" JSONB NOT NULL DEFAULT '[]',
    "gatePassStatus" TEXT NOT NULL DEFAULT 'not_required',
    "permitStatus" TEXT NOT NULL DEFAULT 'not_required',
    "inductionCompleted" BOOLEAN NOT NULL DEFAULT false,
    "departureOdometer" INTEGER,
    "arrivalOdometer" INTEGER,
    "status" TEXT NOT NULL DEFAULT 'planned',
    "notes" TEXT,
    "photoFileIds" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "overrideReason" TEXT,
    "version" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "deletedAt" TIMESTAMP(3),
    "deletedBy" TEXT,

    CONSTRAINT "Mobilization_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "Mobilization_ticketId_type_idx" ON "Mobilization"("ticketId", "type");

-- CreateIndex
CREATE INDEX "Mobilization_status_plannedAt_idx" ON "Mobilization"("status", "plannedAt");

-- AddForeignKey
ALTER TABLE "Mobilization" ADD CONSTRAINT "Mobilization_ticketId_fkey" FOREIGN KEY ("ticketId") REFERENCES "Ticket"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Mobilization" ADD CONSTRAINT "Mobilization_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "Project"("id") ON DELETE SET NULL ON UPDATE CASCADE;
