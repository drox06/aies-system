-- CreateTable
CREATE TABLE "EventOutbox" (
    "id" TEXT NOT NULL,
    "event" TEXT NOT NULL,
    "payload" JSONB NOT NULL,
    "actorId" TEXT,
    "requestId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "relayedAt" TIMESTAMP(3),

    CONSTRAINT "EventOutbox_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "EventOutbox_relayedAt_createdAt_idx" ON "EventOutbox"("relayedAt", "createdAt");
