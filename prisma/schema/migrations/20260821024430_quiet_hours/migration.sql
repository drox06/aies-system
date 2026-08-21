-- AlterTable
ALTER TABLE "Notification" ADD COLUMN     "heldUntil" TIMESTAMP(3);

-- CreateTable
CREATE TABLE "NotificationSchedule" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "quietFromMinutes" INTEGER,
    "quietToMinutes" INTEGER,
    "quietHoursOn" BOOLEAN NOT NULL DEFAULT true,
    "digestAtMinutes" INTEGER NOT NULL DEFAULT 420,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "NotificationSchedule_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "NotificationSchedule_userId_key" ON "NotificationSchedule"("userId");

-- CreateIndex
CREATE INDEX "Notification_heldUntil_idx" ON "Notification"("heldUntil");
