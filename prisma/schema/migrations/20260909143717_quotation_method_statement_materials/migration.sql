-- AlterTable
ALTER TABLE "Quotation" ADD COLUMN     "materialsNotes" TEXT,
ADD COLUMN     "materialsPreparedAtQuoting" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "methodStatementFileId" TEXT,
ADD COLUMN     "methodStatementNotes" TEXT,
ADD COLUMN     "needsMethodStatement" BOOLEAN NOT NULL DEFAULT false;
