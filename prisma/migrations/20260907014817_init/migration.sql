-- CreateEnum
CREATE TYPE "Role" AS ENUM ('admin', 'manager', 'supervisor', 'user');

-- CreateEnum
CREATE TYPE "PunchEventType" AS ENUM ('IN', 'OUT', 'BREAK_START', 'BREAK_END', 'LUNCH_START', 'LUNCH_END');

-- CreateEnum
CREATE TYPE "EventSource" AS ENUM ('WIDGET', 'SUPERVISOR', 'SYSTEM', 'IMPORT');

-- CreateEnum
CREATE TYPE "EventStatus" AS ENUM ('ACTIVE', 'SUPERSEDED', 'PENDING_APPROVAL', 'REJECTED');

-- CreateEnum
CREATE TYPE "ExceptionType" AS ENUM ('ORPHAN_IN', 'ORPHAN_BREAK', 'ORPHAN_LUNCH', 'LATE_MEAL', 'SHORT_MEAL', 'MISSED_MEAL', 'MISSED_REST');

-- CreateEnum
CREATE TYPE "ExceptionStatus" AS ENUM ('OPEN', 'PENDING_APPROVAL', 'RESOLVED', 'DISMISSED');

-- CreateEnum
CREATE TYPE "OutboxStatus" AS ENUM ('PENDING', 'SUBMITTED', 'DELIVERED', 'FAILED', 'NOT_SUPPORTED');

-- CreateEnum
CREATE TYPE "ScheduleKind" AS ENUM ('WORK', 'TRAINING', 'HOLIDAY', 'VACATION', 'PTO', 'SICK', 'LEAVE', 'OFF');

-- CreateTable
CREATE TABLE "Tenant" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "timezone" TEXT NOT NULL DEFAULT 'America/New_York',
    "breakMinutes" INTEGER NOT NULL DEFAULT 10,
    "lunchMinMinutes" INTEGER NOT NULL DEFAULT 30,
    "lunchMaxMinutes" INTEGER NOT NULL DEFAULT 60,
    "coverageThresholdPct" INTEGER NOT NULL DEFAULT 70,
    "mealAlertTiers" JSONB NOT NULL DEFAULT '[60,30,15]',
    "caMealRulesEnabled" BOOLEAN NOT NULL DEFAULT true,
    "hrisProvider" TEXT,
    "hrisConfig" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Tenant_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Agent" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "displayName" TEXT NOT NULL,
    "department" TEXT NOT NULL DEFAULT 'General',
    "locationState" TEXT NOT NULL DEFAULT 'CA',
    "timezone" TEXT NOT NULL,
    "role" "Role" NOT NULL DEFAULT 'user',
    "isSupervisor" BOOLEAN NOT NULL DEFAULT false,
    "managedDepartments" TEXT[],
    "hostUserId" TEXT NOT NULL,
    "email" TEXT,
    "hrisEmployeeId" TEXT,
    "hrisDepartmentId" TEXT,
    "hrisActivityTypeId" TEXT,
    "mealWaiverOnFile" BOOLEAN NOT NULL DEFAULT false,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "deactivatedAt" TIMESTAMP(3),
    "archivedAt" TIMESTAMP(3),
    "scheduledStart" TIMESTAMP(3),
    "scheduledEnd" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Agent_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "PunchEvent" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "agentId" TEXT NOT NULL,
    "eventType" "PunchEventType" NOT NULL,
    "eventTime" TIMESTAMP(3) NOT NULL,
    "source" "EventSource" NOT NULL,
    "sessionId" TEXT,
    "status" "EventStatus" NOT NULL DEFAULT 'ACTIVE',
    "correctionOfId" TEXT,
    "note" TEXT,
    "createdById" TEXT NOT NULL,
    "approvedById" TEXT,
    "approvedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "prevHash" TEXT,
    "selfHash" TEXT,

    CONSTRAINT "PunchEvent_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ComplianceException" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "agentId" TEXT NOT NULL,
    "workDate" TIMESTAMP(3) NOT NULL,
    "type" "ExceptionType" NOT NULL,
    "status" "ExceptionStatus" NOT NULL DEFAULT 'OPEN',
    "detectedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "relatedEventIds" TEXT[],
    "premiumHourPayable" BOOLEAN NOT NULL DEFAULT false,
    "premiumDelivered" BOOLEAN NOT NULL DEFAULT false,
    "resolution" TEXT,
    "resolvedById" TEXT,
    "resolvedAt" TIMESTAMP(3),

    CONSTRAINT "ComplianceException_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "HrisOutbox" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "punchEventId" TEXT,
    "kind" TEXT NOT NULL,
    "payload" JSONB NOT NULL,
    "status" "OutboxStatus" NOT NULL DEFAULT 'PENDING',
    "trackingId" TEXT,
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "lastError" TEXT,
    "submittedAt" TIMESTAMP(3),
    "resolvedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "HrisOutbox_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "SchedulePattern" (
    "id" TEXT NOT NULL,
    "agentId" TEXT NOT NULL,
    "weekday" INTEGER NOT NULL,
    "kind" "ScheduleKind" NOT NULL DEFAULT 'WORK',
    "startTime" TEXT,
    "endTime" TEXT,
    "lunchTime" TEXT,
    "lunchMinutes" INTEGER,

    CONSTRAINT "SchedulePattern_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ScheduleException" (
    "id" TEXT NOT NULL,
    "agentId" TEXT NOT NULL,
    "date" TEXT NOT NULL,
    "kind" "ScheduleKind" NOT NULL,
    "startTime" TEXT,
    "endTime" TEXT,
    "lunchTime" TEXT,
    "lunchMinutes" INTEGER,
    "note" TEXT,

    CONSTRAINT "ScheduleException_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "Agent_tenantId_hrisEmployeeId_idx" ON "Agent"("tenantId", "hrisEmployeeId");

-- CreateIndex
CREATE INDEX "Agent_tenantId_department_idx" ON "Agent"("tenantId", "department");

-- CreateIndex
CREATE UNIQUE INDEX "Agent_tenantId_hostUserId_key" ON "Agent"("tenantId", "hostUserId");

-- CreateIndex
CREATE INDEX "PunchEvent_tenantId_agentId_eventTime_idx" ON "PunchEvent"("tenantId", "agentId", "eventTime");

-- CreateIndex
CREATE INDEX "PunchEvent_tenantId_status_idx" ON "PunchEvent"("tenantId", "status");

-- CreateIndex
CREATE INDEX "ComplianceException_tenantId_agentId_workDate_idx" ON "ComplianceException"("tenantId", "agentId", "workDate");

-- CreateIndex
CREATE INDEX "ComplianceException_tenantId_status_idx" ON "ComplianceException"("tenantId", "status");

-- CreateIndex
CREATE INDEX "HrisOutbox_tenantId_status_idx" ON "HrisOutbox"("tenantId", "status");

-- CreateIndex
CREATE INDEX "HrisOutbox_trackingId_idx" ON "HrisOutbox"("trackingId");

-- CreateIndex
CREATE UNIQUE INDEX "SchedulePattern_agentId_weekday_key" ON "SchedulePattern"("agentId", "weekday");

-- CreateIndex
CREATE UNIQUE INDEX "ScheduleException_agentId_date_key" ON "ScheduleException"("agentId", "date");

-- AddForeignKey
ALTER TABLE "Agent" ADD CONSTRAINT "Agent_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PunchEvent" ADD CONSTRAINT "PunchEvent_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PunchEvent" ADD CONSTRAINT "PunchEvent_agentId_fkey" FOREIGN KEY ("agentId") REFERENCES "Agent"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PunchEvent" ADD CONSTRAINT "PunchEvent_correctionOfId_fkey" FOREIGN KEY ("correctionOfId") REFERENCES "PunchEvent"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ComplianceException" ADD CONSTRAINT "ComplianceException_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ComplianceException" ADD CONSTRAINT "ComplianceException_agentId_fkey" FOREIGN KEY ("agentId") REFERENCES "Agent"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "HrisOutbox" ADD CONSTRAINT "HrisOutbox_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "HrisOutbox" ADD CONSTRAINT "HrisOutbox_punchEventId_fkey" FOREIGN KEY ("punchEventId") REFERENCES "PunchEvent"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SchedulePattern" ADD CONSTRAINT "SchedulePattern_agentId_fkey" FOREIGN KEY ("agentId") REFERENCES "Agent"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ScheduleException" ADD CONSTRAINT "ScheduleException_agentId_fkey" FOREIGN KEY ("agentId") REFERENCES "Agent"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
