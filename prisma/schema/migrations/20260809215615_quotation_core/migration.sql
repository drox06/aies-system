-- CreateTable
CREATE TABLE "Quotation" (
    "id" TEXT NOT NULL,
    "number" TEXT NOT NULL,
    "revision" INTEGER NOT NULL DEFAULT 0,
    "parentQuotationId" TEXT,
    "inquiryId" TEXT,
    "accountId" TEXT NOT NULL,
    "siteId" TEXT,
    "contactId" TEXT,
    "title" TEXT NOT NULL,
    "scopeOfWork" TEXT NOT NULL,
    "exclusions" TEXT,
    "assumptions" TEXT,
    "status" TEXT NOT NULL DEFAULT 'draft',
    "currency" TEXT NOT NULL DEFAULT 'PHP',
    "fxRate" DECIMAL(12,6) NOT NULL DEFAULT 1,
    "fxBufferPct" DECIMAL(7,4) NOT NULL DEFAULT 0,
    "validUntil" TIMESTAMP(3) NOT NULL,
    "deliveryTermIncoterm" TEXT,
    "deliveryLeadTime" TEXT,
    "paymentTermsId" TEXT,
    "warrantyTerms" TEXT,
    "subtotal" DECIMAL(14,2) NOT NULL DEFAULT 0,
    "discountAmount" DECIMAL(14,2) NOT NULL DEFAULT 0,
    "vatMode" TEXT NOT NULL DEFAULT 'exclusive',
    "vatRatePct" DECIMAL(7,4) NOT NULL DEFAULT 12,
    "vatAmount" DECIMAL(14,2) NOT NULL DEFAULT 0,
    "total" DECIMAL(14,2) NOT NULL DEFAULT 0,
    "totalCost" DECIMAL(14,2) NOT NULL DEFAULT 0,
    "marginAmount" DECIMAL(14,2) NOT NULL DEFAULT 0,
    "marginPct" DECIMAL(7,4) NOT NULL DEFAULT 0,
    "preparedById" TEXT NOT NULL,
    "approvedById" TEXT,
    "approvedAt" TIMESTAMP(3),
    "sentAt" TIMESTAMP(3),
    "sentToContactIds" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "decisionAt" TIMESTAMP(3),
    "rejectionReason" TEXT,
    "revisionReason" TEXT,
    "revisionNote" TEXT,
    "version" INTEGER NOT NULL DEFAULT 0,
    "customFields" JSONB NOT NULL DEFAULT '{}',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "deletedAt" TIMESTAMP(3),
    "deletedBy" TEXT,

    CONSTRAINT "Quotation_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "QuotationLine" (
    "id" TEXT NOT NULL,
    "quotationId" TEXT NOT NULL,
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
    "unitPrice" DECIMAL(14,2) NOT NULL DEFAULT 0,
    "lineDiscountPct" DECIMAL(7,4),
    "lineTotal" DECIMAL(14,2) NOT NULL DEFAULT 0,
    "lineCost" DECIMAL(14,2) NOT NULL DEFAULT 0,
    "lineMargin" DECIMAL(14,2) NOT NULL DEFAULT 0,
    "supplierQuoteLineId" TEXT,
    "leadTimeDays" INTEGER,
    "isOptional" BOOLEAN NOT NULL DEFAULT false,
    "notes" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "QuotationLine_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "SupplierQuoteRequest" (
    "id" TEXT NOT NULL,
    "number" TEXT NOT NULL,
    "quotationId" TEXT,
    "inquiryId" TEXT,
    "supplierId" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'draft',
    "sentAt" TIMESTAMP(3),
    "dueBy" TIMESTAMP(3),
    "respondedAt" TIMESTAMP(3),
    "requestBody" TEXT NOT NULL,
    "responseNotes" TEXT,
    "currency" TEXT,
    "validUntil" TIMESTAMP(3),
    "leadTimeDays" INTEGER,
    "responseFileId" TEXT,
    "requestedById" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "deletedAt" TIMESTAMP(3),
    "deletedBy" TEXT,

    CONSTRAINT "SupplierQuoteRequest_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "SupplierQuoteLine" (
    "id" TEXT NOT NULL,
    "requestId" TEXT NOT NULL,
    "lineNo" INTEGER NOT NULL,
    "description" TEXT NOT NULL,
    "manufacturer" TEXT,
    "modelNumber" TEXT,
    "quantity" DECIMAL(14,3) NOT NULL DEFAULT 1,
    "unit" TEXT NOT NULL DEFAULT 'pc',
    "unitCost" DECIMAL(14,2) NOT NULL DEFAULT 0,
    "currency" TEXT NOT NULL DEFAULT 'PHP',
    "leadTimeDays" INTEGER,
    "notes" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "SupplierQuoteLine_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Product" (
    "id" TEXT NOT NULL,
    "sku" TEXT,
    "name" TEXT NOT NULL,
    "description" TEXT,
    "manufacturer" TEXT NOT NULL,
    "modelNumber" TEXT,
    "category" TEXT,
    "unit" TEXT NOT NULL DEFAULT 'pc',
    "defaultSupplierId" TEXT,
    "lastCost" DECIMAL(14,2),
    "lastCostCurrency" TEXT,
    "lastCostAt" TIMESTAMP(3),
    "defaultMarkupPct" DECIMAL(7,4),
    "datasheetFileId" TEXT,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Product_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "PaymentTerm" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "downpaymentPct" DECIMAL(7,4) NOT NULL DEFAULT 0,
    "balanceTrigger" TEXT,
    "netDays" INTEGER NOT NULL DEFAULT 0,
    "description" TEXT,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "PaymentTerm_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "Quotation_accountId_status_idx" ON "Quotation"("accountId", "status");

-- CreateIndex
CREATE INDEX "Quotation_status_validUntil_idx" ON "Quotation"("status", "validUntil");

-- CreateIndex
CREATE INDEX "Quotation_preparedById_status_idx" ON "Quotation"("preparedById", "status");

-- CreateIndex
CREATE INDEX "Quotation_inquiryId_idx" ON "Quotation"("inquiryId");

-- CreateIndex
CREATE UNIQUE INDEX "Quotation_number_revision_key" ON "Quotation"("number", "revision");

-- CreateIndex
CREATE INDEX "QuotationLine_quotationId_idx" ON "QuotationLine"("quotationId");

-- CreateIndex
CREATE INDEX "QuotationLine_productId_idx" ON "QuotationLine"("productId");

-- CreateIndex
CREATE UNIQUE INDEX "QuotationLine_quotationId_lineNo_key" ON "QuotationLine"("quotationId", "lineNo");

-- CreateIndex
CREATE UNIQUE INDEX "SupplierQuoteRequest_number_key" ON "SupplierQuoteRequest"("number");

-- CreateIndex
CREATE INDEX "SupplierQuoteRequest_supplierId_status_idx" ON "SupplierQuoteRequest"("supplierId", "status");

-- CreateIndex
CREATE INDEX "SupplierQuoteRequest_status_dueBy_idx" ON "SupplierQuoteRequest"("status", "dueBy");

-- CreateIndex
CREATE INDEX "SupplierQuoteRequest_quotationId_idx" ON "SupplierQuoteRequest"("quotationId");

-- CreateIndex
CREATE INDEX "SupplierQuoteLine_requestId_idx" ON "SupplierQuoteLine"("requestId");

-- CreateIndex
CREATE UNIQUE INDEX "SupplierQuoteLine_requestId_lineNo_key" ON "SupplierQuoteLine"("requestId", "lineNo");

-- CreateIndex
CREATE UNIQUE INDEX "Product_sku_key" ON "Product"("sku");

-- CreateIndex
CREATE INDEX "Product_manufacturer_modelNumber_idx" ON "Product"("manufacturer", "modelNumber");

-- CreateIndex
CREATE INDEX "Product_isActive_name_idx" ON "Product"("isActive", "name");

-- CreateIndex
CREATE UNIQUE INDEX "PaymentTerm_name_key" ON "PaymentTerm"("name");

-- AddForeignKey
ALTER TABLE "Quotation" ADD CONSTRAINT "Quotation_accountId_fkey" FOREIGN KEY ("accountId") REFERENCES "CustomerAccount"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Quotation" ADD CONSTRAINT "Quotation_inquiryId_fkey" FOREIGN KEY ("inquiryId") REFERENCES "Inquiry"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Quotation" ADD CONSTRAINT "Quotation_siteId_fkey" FOREIGN KEY ("siteId") REFERENCES "Site"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Quotation" ADD CONSTRAINT "Quotation_contactId_fkey" FOREIGN KEY ("contactId") REFERENCES "Contact"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Quotation" ADD CONSTRAINT "Quotation_parentQuotationId_fkey" FOREIGN KEY ("parentQuotationId") REFERENCES "Quotation"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "QuotationLine" ADD CONSTRAINT "QuotationLine_quotationId_fkey" FOREIGN KEY ("quotationId") REFERENCES "Quotation"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "QuotationLine" ADD CONSTRAINT "QuotationLine_productId_fkey" FOREIGN KEY ("productId") REFERENCES "Product"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SupplierQuoteRequest" ADD CONSTRAINT "SupplierQuoteRequest_quotationId_fkey" FOREIGN KEY ("quotationId") REFERENCES "Quotation"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SupplierQuoteLine" ADD CONSTRAINT "SupplierQuoteLine_requestId_fkey" FOREIGN KEY ("requestId") REFERENCES "SupplierQuoteRequest"("id") ON DELETE CASCADE ON UPDATE CASCADE;

