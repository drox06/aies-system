-- AlterTable
ALTER TABLE "Methodology" ADD COLUMN     "clientApprovedByName" TEXT,
ADD COLUMN     "clientApprovedByPosition" TEXT,
ADD COLUMN     "externalDocument" BOOLEAN NOT NULL DEFAULT false;
