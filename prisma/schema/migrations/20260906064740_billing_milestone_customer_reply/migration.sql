-- AlterTable
ALTER TABLE "BillingMilestone" ADD COLUMN     "customerConfirmedAt" TIMESTAMP(3),
ADD COLUMN     "customerPreferredDeliveryDate" TIMESTAMP(3),
ADD COLUMN     "customerReplyNotes" TEXT;
