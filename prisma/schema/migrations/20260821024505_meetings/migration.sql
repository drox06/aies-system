-- CreateTable
CREATE TABLE "Meeting" (
    "id" TEXT NOT NULL,
    "number" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "seriesKey" TEXT,
    "scheduledAt" TIMESTAMP(3) NOT NULL,
    "location" TEXT,
    "agenda" JSONB NOT NULL DEFAULT '[]',
    "attendeeIds" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "apologyIds" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "minutes" TEXT,
    "decisions" JSONB NOT NULL DEFAULT '[]',
    "status" TEXT NOT NULL DEFAULT 'scheduled',
    "heldAt" TIMESTAMP(3),
    "createdById" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "deletedAt" TIMESTAMP(3),

    CONSTRAINT "Meeting_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "Meeting_number_key" ON "Meeting"("number");

-- CreateIndex
CREATE INDEX "Meeting_scheduledAt_idx" ON "Meeting"("scheduledAt");

-- CreateIndex
CREATE INDEX "Meeting_seriesKey_scheduledAt_idx" ON "Meeting"("seriesKey", "scheduledAt");
