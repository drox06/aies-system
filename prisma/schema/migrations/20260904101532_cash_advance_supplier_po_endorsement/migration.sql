-- AlterTable
ALTER TABLE "CashAdvance" ADD COLUMN     "endorsedAt" TIMESTAMP(3),
ADD COLUMN     "endorsedById" TEXT;

-- AlterTable
ALTER TABLE "SupplierPO" ADD COLUMN     "endorsedAt" TIMESTAMP(3),
ADD COLUMN     "endorsedById" TEXT;
