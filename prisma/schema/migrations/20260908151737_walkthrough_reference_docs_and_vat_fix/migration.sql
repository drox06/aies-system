-- AlterTable
ALTER TABLE "BillingStatement" ADD COLUMN     "externalNumber" TEXT,
ADD COLUMN     "externalRefFileId" TEXT,
ADD COLUMN     "externalRefUploadedAt" TIMESTAMP(3),
ADD COLUMN     "externalRefUploadedById" TEXT;

-- AlterTable
ALTER TABLE "CustomerPO" ADD COLUMN     "vatExcluded" BOOLEAN NOT NULL DEFAULT false;

-- AlterTable
ALTER TABLE "DeliveryReceipt" ADD COLUMN     "externalNumber" TEXT,
ADD COLUMN     "externalRefFileId" TEXT;

-- AlterTable
ALTER TABLE "DeliveryTicketFlow" ADD COLUMN     "manualDeliveryAddress" TEXT;
