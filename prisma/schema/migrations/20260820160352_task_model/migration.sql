-- CreateTable
CREATE TABLE "Task" (
    "id" TEXT NOT NULL,
    "number" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "description" TEXT,
    "entityType" TEXT,
    "entityId" TEXT,
    "boardId" TEXT,
    "columnId" TEXT,
    "position" INTEGER NOT NULL DEFAULT 0,
    "assigneeId" TEXT,
    "watcherIds" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "status" TEXT NOT NULL DEFAULT 'todo',
    "priority" TEXT NOT NULL DEFAULT 'normal',
    "dueAt" TIMESTAMP(3),
    "startAt" TIMESTAMP(3),
    "completedAt" TIMESTAMP(3),
    "assignedAt" TIMESTAMP(3),
    "estimateHours" DECIMAL(6,2),
    "actualHours" DECIMAL(6,2),
    "labels" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "checklist" JSONB NOT NULL DEFAULT '[]',
    "parentTaskId" TEXT,
    "blockedByTaskIds" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "recurrenceRule" TEXT,
    "createdByTemplate" TEXT,
    "createdById" TEXT NOT NULL,
    "version" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "deletedAt" TIMESTAMP(3),
    "deletedBy" TEXT,

    CONSTRAINT "Task_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "Task_number_key" ON "Task"("number");

-- CreateIndex
CREATE INDEX "Task_assigneeId_status_dueAt_idx" ON "Task"("assigneeId", "status", "dueAt");

-- CreateIndex
CREATE INDEX "Task_entityType_entityId_idx" ON "Task"("entityType", "entityId");

-- CreateIndex
CREATE INDEX "Task_boardId_columnId_position_idx" ON "Task"("boardId", "columnId", "position");

-- CreateIndex
CREATE INDEX "Task_status_dueAt_idx" ON "Task"("status", "dueAt");
