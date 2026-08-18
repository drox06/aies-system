-- AlterTable
ALTER TABLE "CustomerAccount" ADD COLUMN     "ewtRate" DECIMAL(7,4) NOT NULL DEFAULT 2,
ADD COLUMN     "isGovernment" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "withholdsEWT" BOOLEAN NOT NULL DEFAULT false;

-- CreateTable
CREATE TABLE "BillingStatement" (
    "id" TEXT NOT NULL,
    "number" TEXT NOT NULL,
    "type" TEXT NOT NULL DEFAULT 'progress',
    "accountId" TEXT NOT NULL,
    "salesOrderId" TEXT,
    "projectId" TEXT,
    "ticketId" TEXT,
    "milestoneId" TEXT,
    "statementDate" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "dueDate" TIMESTAMP(3) NOT NULL,
    "currency" TEXT NOT NULL DEFAULT 'PHP',
    "subtotal" INTEGER NOT NULL,
    "vatMode" TEXT NOT NULL DEFAULT 'exclusive',
    "vatAmount" INTEGER NOT NULL DEFAULT 0,
    "total" INTEGER NOT NULL,
    "expectedWithholdingAmount" INTEGER NOT NULL DEFAULT 0,
    "expectedNetCollectible" INTEGER NOT NULL DEFAULT 0,
    "amountPaid" INTEGER NOT NULL DEFAULT 0,
    "balance" INTEGER NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'draft',
    "poReference" TEXT,
    "drReferences" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "srReferences" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "tcCertificateRef" TEXT,
    "notes" TEXT,
    "terms" TEXT,
    "issuedById" TEXT,
    "issuedAt" TIMESTAMP(3),
    "cancelledById" TEXT,
    "cancelledAt" TIMESTAMP(3),
    "cancelledReason" TEXT,
    "version" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "deletedAt" TIMESTAMP(3),

    CONSTRAINT "BillingStatement_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "BillingStatementLine" (
    "id" TEXT NOT NULL,
    "statementId" TEXT NOT NULL,
    "lineNo" INTEGER NOT NULL,
    "salesOrderLineId" TEXT,
    "description" TEXT NOT NULL,
    "quantity" DECIMAL(14,3) NOT NULL DEFAULT 1,
    "unit" TEXT NOT NULL DEFAULT 'pc',
    "unitPrice" INTEGER NOT NULL,
    "lineTotal" INTEGER NOT NULL,
    "vatable" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "BillingStatementLine_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ServiceInvoice" (
    "id" TEXT NOT NULL,
    "number" TEXT NOT NULL,
    "accountId" TEXT NOT NULL,
    "paymentId" TEXT NOT NULL,
    "billingStatementIds" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "invoiceDate" TIMESTAMP(3) NOT NULL,
    "vatableSales" INTEGER NOT NULL DEFAULT 0,
    "vatExemptSales" INTEGER NOT NULL DEFAULT 0,
    "zeroRatedSales" INTEGER NOT NULL DEFAULT 0,
    "vatAmount" INTEGER NOT NULL DEFAULT 0,
    "grossAmount" INTEGER NOT NULL,
    "withholdingTaxAmount" INTEGER NOT NULL DEFAULT 0,
    "netAmountReceived" INTEGER NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'issued',
    "cancellationReason" TEXT,
    "cancelledById" TEXT,
    "cancelledAt" TIMESTAMP(3),
    "pdfFileId" TEXT,
    "issuedById" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ServiceInvoice_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Payment" (
    "id" TEXT NOT NULL,
    "number" TEXT NOT NULL,
    "accountId" TEXT NOT NULL,
    "receivedAt" TIMESTAMP(3) NOT NULL,
    "method" TEXT NOT NULL,
    "reference" TEXT,
    "amount" INTEGER NOT NULL,
    "currency" TEXT NOT NULL DEFAULT 'PHP',
    "checkNumber" TEXT,
    "checkDate" TIMESTAMP(3),
    "clearedAt" TIMESTAMP(3),
    "bouncedAt" TIMESTAMP(3),
    "bounceReason" TEXT,
    "withholdingTaxAmount" INTEGER NOT NULL DEFAULT 0,
    "form2307FileId" TEXT,
    "form2307ReceivedAt" TIMESTAMP(3),
    "proofFileId" TEXT,
    "recordedById" TEXT NOT NULL,
    "notes" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "deletedAt" TIMESTAMP(3),

    CONSTRAINT "Payment_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "PaymentAllocation" (
    "id" TEXT NOT NULL,
    "paymentId" TEXT NOT NULL,
    "billingStatementId" TEXT NOT NULL,
    "amount" INTEGER NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "PaymentAllocation_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "BillingStatement_number_key" ON "BillingStatement"("number");

-- CreateIndex
CREATE INDEX "BillingStatement_accountId_status_idx" ON "BillingStatement"("accountId", "status");

-- CreateIndex
CREATE INDEX "BillingStatement_status_dueDate_idx" ON "BillingStatement"("status", "dueDate");

-- CreateIndex
CREATE INDEX "BillingStatement_salesOrderId_idx" ON "BillingStatement"("salesOrderId");

-- CreateIndex
CREATE UNIQUE INDEX "BillingStatementLine_statementId_lineNo_key" ON "BillingStatementLine"("statementId", "lineNo");

-- CreateIndex
CREATE UNIQUE INDEX "ServiceInvoice_number_key" ON "ServiceInvoice"("number");

-- CreateIndex
CREATE UNIQUE INDEX "ServiceInvoice_paymentId_key" ON "ServiceInvoice"("paymentId");

-- CreateIndex
CREATE INDEX "ServiceInvoice_accountId_invoiceDate_idx" ON "ServiceInvoice"("accountId", "invoiceDate");

-- CreateIndex
CREATE INDEX "ServiceInvoice_status_idx" ON "ServiceInvoice"("status");

-- CreateIndex
CREATE UNIQUE INDEX "Payment_number_key" ON "Payment"("number");

-- CreateIndex
CREATE INDEX "Payment_accountId_receivedAt_idx" ON "Payment"("accountId", "receivedAt");

-- CreateIndex
CREATE INDEX "Payment_clearedAt_idx" ON "Payment"("clearedAt");

-- CreateIndex
CREATE INDEX "Payment_withholdingTaxAmount_form2307ReceivedAt_idx" ON "Payment"("withholdingTaxAmount", "form2307ReceivedAt");

-- CreateIndex
CREATE INDEX "PaymentAllocation_billingStatementId_idx" ON "PaymentAllocation"("billingStatementId");

-- CreateIndex
CREATE UNIQUE INDEX "PaymentAllocation_paymentId_billingStatementId_key" ON "PaymentAllocation"("paymentId", "billingStatementId");

-- AddForeignKey
ALTER TABLE "BillingStatementLine" ADD CONSTRAINT "BillingStatementLine_statementId_fkey" FOREIGN KEY ("statementId") REFERENCES "BillingStatement"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ServiceInvoice" ADD CONSTRAINT "ServiceInvoice_paymentId_fkey" FOREIGN KEY ("paymentId") REFERENCES "Payment"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PaymentAllocation" ADD CONSTRAINT "PaymentAllocation_paymentId_fkey" FOREIGN KEY ("paymentId") REFERENCES "Payment"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PaymentAllocation" ADD CONSTRAINT "PaymentAllocation_billingStatementId_fkey" FOREIGN KEY ("billingStatementId") REFERENCES "BillingStatement"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
