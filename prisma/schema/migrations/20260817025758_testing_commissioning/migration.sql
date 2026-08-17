-- CreateTable
CREATE TABLE "TestingCommissioning" (
    "id" TEXT NOT NULL,
    "number" TEXT NOT NULL,
    "ticketId" TEXT NOT NULL,
    "projectId" TEXT,
    "startedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "completedAt" TIMESTAMP(3),
    "loopChecks" JSONB NOT NULL DEFAULT '[]',
    "functionalTests" JSONB NOT NULL DEFAULT '[]',
    "performanceVerification" JSONB NOT NULL DEFAULT '[]',
    "calibrationAssetsUsed" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "witnessedByCustomer" BOOLEAN NOT NULL DEFAULT true,
    "customerWitnessName" TEXT,
    "customerWitnessPosition" TEXT,
    "punchItems" JSONB NOT NULL DEFAULT '[]',
    "result" TEXT,
    "trainingDelivered" JSONB NOT NULL DEFAULT '[]',
    "certificateFileId" TEXT,
    "recordedById" TEXT NOT NULL,
    "signedOffById" TEXT,
    "customerSignatureFileId" TEXT,
    "signedAt" TIMESTAMP(3),
    "signOffRemarks" TEXT,
    "version" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "deletedAt" TIMESTAMP(3),
    "deletedBy" TEXT,

    CONSTRAINT "TestingCommissioning_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "TestingCommissioning_number_key" ON "TestingCommissioning"("number");

-- CreateIndex
CREATE INDEX "TestingCommissioning_ticketId_startedAt_idx" ON "TestingCommissioning"("ticketId", "startedAt");

-- CreateIndex
CREATE INDEX "TestingCommissioning_result_completedAt_idx" ON "TestingCommissioning"("result", "completedAt");

-- AddForeignKey
ALTER TABLE "TestingCommissioning" ADD CONSTRAINT "TestingCommissioning_ticketId_fkey" FOREIGN KEY ("ticketId") REFERENCES "Ticket"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TestingCommissioning" ADD CONSTRAINT "TestingCommissioning_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "Project"("id") ON DELETE SET NULL ON UPDATE CASCADE;
