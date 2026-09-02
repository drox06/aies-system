-- AlterTable
ALTER TABLE "SiteInspection" ADD COLUMN     "sharedWithIds" TEXT[] DEFAULT ARRAY[]::TEXT[];
