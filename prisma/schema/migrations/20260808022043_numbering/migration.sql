-- CreateTable
CREATE TABLE "NumberingFormat" (
    "documentType" TEXT NOT NULL,
    "format" TEXT NOT NULL,
    "label" TEXT NOT NULL,

    CONSTRAINT "NumberingFormat_pkey" PRIMARY KEY ("documentType")
);

-- CreateTable
CREATE TABLE "DocumentSequence" (
    "id" TEXT NOT NULL,
    "documentType" TEXT NOT NULL,
    "scopeKey" TEXT NOT NULL,
    "counter" INTEGER NOT NULL DEFAULT 0,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "DocumentSequence_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "DocumentSequence_documentType_scopeKey_key" ON "DocumentSequence"("documentType", "scopeKey");
