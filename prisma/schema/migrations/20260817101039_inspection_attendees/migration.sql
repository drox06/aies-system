-- AlterTable
ALTER TABLE "SiteInspection" ADD COLUMN     "attendees" JSONB NOT NULL DEFAULT '[]';
