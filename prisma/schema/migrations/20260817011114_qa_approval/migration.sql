-- CreateTable
CREATE TABLE "QAApproval" (
    "id" TEXT NOT NULL,
    "number" TEXT NOT NULL,
    "ticketId" TEXT NOT NULL,
    "projectId" TEXT,
    "inspectedAt" TIMESTAMP(3),
    "clientInspectorName" TEXT,
    "clientInspectorPosition" TEXT,
    "approved" BOOLEAN NOT NULL,
    "clientInspected" BOOLEAN NOT NULL DEFAULT true,
    "recordedById" TEXT NOT NULL,
    "recordedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "evidenceFileIds" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "evidenceType" TEXT,
    "remarks" TEXT,
    "defects" JSONB NOT NULL DEFAULT '[]',
    "reworkRound" INTEGER NOT NULL DEFAULT 0,
    "reworkTicketId" TEXT,
    "version" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "deletedAt" TIMESTAMP(3),
    "deletedBy" TEXT,

    CONSTRAINT "QAApproval_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "QAApproval_number_key" ON "QAApproval"("number");

-- CreateIndex
CREATE INDEX "QAApproval_ticketId_reworkRound_idx" ON "QAApproval"("ticketId", "reworkRound");

-- CreateIndex
CREATE INDEX "QAApproval_approved_recordedAt_idx" ON "QAApproval"("approved", "recordedAt");

-- AddForeignKey
ALTER TABLE "QAApproval" ADD CONSTRAINT "QAApproval_ticketId_fkey" FOREIGN KEY ("ticketId") REFERENCES "Ticket"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "QAApproval" ADD CONSTRAINT "QAApproval_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "Project"("id") ON DELETE SET NULL ON UPDATE CASCADE;
