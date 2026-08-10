-- AlterTable
ALTER TABLE "Quotation" ADD COLUMN     "downloadCount" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN     "downloadedAt" TIMESTAMP(3),
ADD COLUMN     "downloadedBy" TEXT,
ADD COLUMN     "sentConfirmedAt" TIMESTAMP(3),
ADD COLUMN     "sentConfirmedBy" TEXT;

