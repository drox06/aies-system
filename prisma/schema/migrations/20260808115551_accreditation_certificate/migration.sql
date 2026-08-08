-- AlterTable
ALTER TABLE "AccreditationRecord" ADD COLUMN     "certificateFileId" TEXT,
ADD COLUMN     "certificateUploadedAt" TIMESTAMP(3);
