-- AlterTable
ALTER TABLE "AccreditationRecord" ADD COLUMN     "renewalAcknowledgedAt" TIMESTAMP(3),
ADD COLUMN     "renewalAcknowledgedBy" TEXT;
