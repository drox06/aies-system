-- AlterTable
ALTER TABLE "BillingMilestone" ADD COLUMN     "readinessAskedAt" TIMESTAMP(3),
ADD COLUMN     "readinessEstimatedDate" TIMESTAMP(3),
ADD COLUMN     "readinessNotes" TEXT,
ADD COLUMN     "readinessPercentComplete" DECIMAL(5,2),
ADD COLUMN     "readinessRepliedAt" TIMESTAMP(3);
