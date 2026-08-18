-- CreateTable
CREATE TABLE "ChecklistTemplate" (
    "id" TEXT NOT NULL,
    "key" TEXT NOT NULL,
    "version" INTEGER NOT NULL DEFAULT 1,
    "name" TEXT NOT NULL,
    "description" TEXT,
    "stage" TEXT NOT NULL,
    "sections" JSONB NOT NULL DEFAULT '[]',
    "status" TEXT NOT NULL DEFAULT 'draft',
    "publishedAt" TIMESTAMP(3),
    "publishedById" TEXT,
    "retiredAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "deletedAt" TIMESTAMP(3),
    "deletedBy" TEXT,

    CONSTRAINT "ChecklistTemplate_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ChecklistResponse" (
    "id" TEXT NOT NULL,
    "templateId" TEXT NOT NULL,
    "templateKey" TEXT NOT NULL,
    "templateVersion" INTEGER NOT NULL,
    "snapshot" JSONB NOT NULL DEFAULT '{}',
    "ticketId" TEXT,
    "projectId" TEXT,
    "entityType" TEXT,
    "entityId" TEXT,
    "answers" JSONB NOT NULL DEFAULT '{}',
    "status" TEXT NOT NULL DEFAULT 'draft',
    "startedById" TEXT,
    "startedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "completedById" TEXT,
    "completedAt" TIMESTAMP(3),
    "signatureFileId" TEXT,
    "signedByName" TEXT,
    "signedByPosition" TEXT,
    "version" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "deletedAt" TIMESTAMP(3),
    "deletedBy" TEXT,

    CONSTRAINT "ChecklistResponse_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "ChecklistTemplate_key_status_idx" ON "ChecklistTemplate"("key", "status");

-- CreateIndex
CREATE INDEX "ChecklistTemplate_stage_status_idx" ON "ChecklistTemplate"("stage", "status");

-- CreateIndex
CREATE UNIQUE INDEX "ChecklistTemplate_key_version_key" ON "ChecklistTemplate"("key", "version");

-- CreateIndex
CREATE INDEX "ChecklistResponse_ticketId_status_idx" ON "ChecklistResponse"("ticketId", "status");

-- CreateIndex
CREATE INDEX "ChecklistResponse_projectId_status_idx" ON "ChecklistResponse"("projectId", "status");

-- CreateIndex
CREATE INDEX "ChecklistResponse_templateKey_completedAt_idx" ON "ChecklistResponse"("templateKey", "completedAt");

-- CreateIndex
CREATE INDEX "ChecklistResponse_entityType_entityId_idx" ON "ChecklistResponse"("entityType", "entityId");

-- AddForeignKey
ALTER TABLE "ChecklistResponse" ADD CONSTRAINT "ChecklistResponse_templateId_fkey" FOREIGN KEY ("templateId") REFERENCES "ChecklistTemplate"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
