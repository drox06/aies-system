-- CreateTable
CREATE TABLE "FieldSubmission" (
    "id" TEXT NOT NULL,
    "clientUuid" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "operation" TEXT NOT NULL,
    "payloadHash" TEXT NOT NULL,
    "status" TEXT NOT NULL,
    "result" JSONB,
    "rejectionReason" TEXT,
    "entityType" TEXT,
    "entityId" TEXT,
    "acknowledgedAt" TIMESTAMP(3),
    "capturedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "FieldSubmission_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "FieldSubmission_clientUuid_key" ON "FieldSubmission"("clientUuid");

-- CreateIndex
CREATE INDEX "FieldSubmission_userId_status_idx" ON "FieldSubmission"("userId", "status");

-- CreateIndex
CREATE INDEX "FieldSubmission_userId_acknowledgedAt_idx" ON "FieldSubmission"("userId", "acknowledgedAt");

-- CreateIndex
CREATE INDEX "FieldSubmission_operation_createdAt_idx" ON "FieldSubmission"("operation", "createdAt");
