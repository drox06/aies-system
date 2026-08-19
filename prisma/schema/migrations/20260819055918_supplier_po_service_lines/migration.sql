-- AlterTable
ALTER TABLE "SupplierPOLine" ADD COLUMN     "isService" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "performedAt" TIMESTAMP(3),
ADD COLUMN     "performedById" TEXT;
