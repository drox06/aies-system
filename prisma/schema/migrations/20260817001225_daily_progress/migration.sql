-- CreateTable
CREATE TABLE "DailyProgress" (
    "id" TEXT NOT NULL,
    "ticketId" TEXT NOT NULL,
    "projectId" TEXT,
    "logDate" DATE NOT NULL,
    "stepsCompleted" INTEGER[] DEFAULT ARRAY[]::INTEGER[],
    "percentComplete" INTEGER NOT NULL DEFAULT 0,
    "manpowerOnSite" INTEGER NOT NULL DEFAULT 0,
    "hoursWorked" DECIMAL(6,2) NOT NULL DEFAULT 0,
    "weather" TEXT,
    "standbyHours" DECIMAL(6,2) NOT NULL DEFAULT 0,
    "standbyCause" TEXT,
    "standbyNotes" TEXT,
    "issuesRaised" TEXT,
    "notes" TEXT,
    "photoFileIds" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "loggedById" TEXT NOT NULL,
    "version" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "deletedAt" TIMESTAMP(3),
    "deletedBy" TEXT,

    CONSTRAINT "DailyProgress_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "DailyProgress_ticketId_logDate_idx" ON "DailyProgress"("ticketId", "logDate");

-- CreateIndex
CREATE INDEX "DailyProgress_standbyCause_idx" ON "DailyProgress"("standbyCause");

-- CreateIndex
CREATE UNIQUE INDEX "DailyProgress_ticketId_logDate_key" ON "DailyProgress"("ticketId", "logDate");

-- AddForeignKey
ALTER TABLE "DailyProgress" ADD CONSTRAINT "DailyProgress_ticketId_fkey" FOREIGN KEY ("ticketId") REFERENCES "Ticket"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "DailyProgress" ADD CONSTRAINT "DailyProgress_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "Project"("id") ON DELETE SET NULL ON UPDATE CASCADE;
