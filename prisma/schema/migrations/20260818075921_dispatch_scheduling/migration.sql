-- AlterTable
ALTER TABLE "Ticket" ADD COLUMN     "scheduledEnd" TIMESTAMP(3),
ADD COLUMN     "scheduledStart" TIMESTAMP(3);

-- CreateTable
CREATE TABLE "TechnicianAvailability" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "fromDate" DATE NOT NULL,
    "toDate" DATE NOT NULL,
    "kind" TEXT NOT NULL,
    "notes" TEXT,
    "recordedById" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "deletedAt" TIMESTAMP(3),

    CONSTRAINT "TechnicianAvailability_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "TechnicianAvailability_userId_fromDate_idx" ON "TechnicianAvailability"("userId", "fromDate");

-- CreateIndex
CREATE INDEX "TechnicianAvailability_fromDate_toDate_idx" ON "TechnicianAvailability"("fromDate", "toDate");

-- CreateIndex
CREATE INDEX "Ticket_scheduledStart_idx" ON "Ticket"("scheduledStart");
