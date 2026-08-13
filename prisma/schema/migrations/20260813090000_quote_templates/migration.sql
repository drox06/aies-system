-- specs/02-quotation.md §9's quote templates: a saved quotation shape with no customer.
--
-- Two new tables and nothing else. Deliberately not an `isTemplate` flag on `Quotation` — that
-- would leave every existing query needing to remember to exclude templates, and the first one that
-- forgot would show a template to a customer as a live quotation.

-- CreateTable
CREATE TABLE "QuoteTemplate" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT,
    "quoteType" TEXT NOT NULL DEFAULT 'local',
    "currency" TEXT NOT NULL DEFAULT 'PHP',
    "scopeOfWork" TEXT NOT NULL,
    "exclusions" TEXT,
    "assumptions" TEXT,
    "deliveryTermIncoterm" TEXT,
    "deliveryLeadTime" TEXT,
    "paymentTermsText" TEXT,
    "warrantyTerms" TEXT,
    "vatMode" TEXT NOT NULL DEFAULT 'exclusive',
    "vatRatePct" DECIMAL(7,4) NOT NULL DEFAULT 12,
    "fxBufferPct" DECIMAL(7,4) NOT NULL DEFAULT 0,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "createdById" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "QuoteTemplate_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "QuoteTemplateLine" (
    "id" TEXT NOT NULL,
    "templateId" TEXT NOT NULL,
    "lineNo" INTEGER NOT NULL,
    "groupLabel" TEXT,
    "itemType" TEXT NOT NULL DEFAULT 'product',
    "productId" TEXT,
    "description" TEXT NOT NULL,
    "longDescription" TEXT,
    "manufacturer" TEXT,
    "modelNumber" TEXT,
    "partNumber" TEXT,
    "quantity" DECIMAL(14,3) NOT NULL DEFAULT 1,
    "unit" TEXT NOT NULL DEFAULT 'pc',
    "unitCost" DECIMAL(14,2) NOT NULL DEFAULT 0,
    "costCurrency" TEXT NOT NULL DEFAULT 'PHP',
    "costFxRate" DECIMAL(12,6) NOT NULL DEFAULT 1,
    "markupPct" DECIMAL(7,4),
    "lineDiscountPct" DECIMAL(7,4),
    "leadTimeDays" INTEGER,
    "isOptional" BOOLEAN NOT NULL DEFAULT false,
    "notes" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "QuoteTemplateLine_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "QuoteTemplate_name_key" ON "QuoteTemplate"("name");

-- CreateIndex
CREATE INDEX "QuoteTemplate_isActive_name_idx" ON "QuoteTemplate"("isActive", "name");

-- CreateIndex
CREATE UNIQUE INDEX "QuoteTemplateLine_templateId_lineNo_key" ON "QuoteTemplateLine"("templateId", "lineNo");

-- CreateIndex
CREATE INDEX "QuoteTemplateLine_templateId_idx" ON "QuoteTemplateLine"("templateId");

-- AddForeignKey
ALTER TABLE "QuoteTemplateLine" ADD CONSTRAINT "QuoteTemplateLine_templateId_fkey" FOREIGN KEY ("templateId") REFERENCES "QuoteTemplate"("id") ON DELETE CASCADE ON UPDATE CASCADE;
