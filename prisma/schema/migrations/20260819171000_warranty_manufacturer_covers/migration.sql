-- AlterTable
ALTER TABLE "WarrantyClaim" ADD COLUMN     "manufacturerCovers" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "manufacturerCoversReason" TEXT;
