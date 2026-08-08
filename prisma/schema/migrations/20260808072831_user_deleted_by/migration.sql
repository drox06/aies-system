-- DropIndex
DROP INDEX "SearchIndex_body_trgm_idx";

-- DropIndex
DROP INDEX "SearchIndex_title_trgm_idx";

-- AlterTable
ALTER TABLE "User" ADD COLUMN     "deletedBy" TEXT;
