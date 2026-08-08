-- CreateTable
CREATE TABLE "FileObject" (
    "id" TEXT NOT NULL,
    "entityType" TEXT NOT NULL,
    "entityId" TEXT NOT NULL,
    "storageKey" TEXT NOT NULL,
    "webDerivativeKey" TEXT,
    "filename" TEXT NOT NULL,
    "mimeType" TEXT NOT NULL,
    "size" INTEGER NOT NULL,
    "sha256" TEXT NOT NULL,
    "uploaderId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "deletedAt" TIMESTAMP(3),

    CONSTRAINT "FileObject_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "FileObject_storageKey_key" ON "FileObject"("storageKey");

-- CreateIndex
CREATE INDEX "FileObject_entityType_entityId_idx" ON "FileObject"("entityType", "entityId");

-- CreateIndex
CREATE UNIQUE INDEX "FileObject_entityType_entityId_sha256_key" ON "FileObject"("entityType", "entityId", "sha256");
