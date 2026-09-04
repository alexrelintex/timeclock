// Runtime types mirroring the relevant slice of prisma/schema.prisma.
// The in-memory store uses these directly; the Prisma store maps to/from them.
import type { PunchEventType, AgentStatus } from '@timeclock/core';

export type Role = 'admin' | 'manager' | 'supervisor' | 'user';
export type EventSource = 'WIDGET' | 'SUPERVISOR' | 'SYSTEM' | 'IMPORT';
export type EventStatus = 'ACTIVE' | 'SUPERSEDED' | 'PENDING_APPROVAL' | 'REJECTED';
export type ExceptionType =
  | 'ORPHAN_IN'
  | 'ORPHAN_BREAK'
  | 'ORPHAN_LUNCH'
  | 'LATE_MEAL'
  | 'SHORT_MEAL'
  | 'MISSED_MEAL'
  | 'MISSED_REST';
export type ExceptionStatus = 'OPEN' | 'PENDING_APPROVAL' | 'RESOLVED' | 'DISMISSED';
export type OutboxStatus =
  | 'PENDING'
  | 'SUBMITTED'
  | 'DELIVERED'
  | 'FAILED'
  | 'NOT_SUPPORTED';

export interface Tenant {
  id: string;
  name: string;
  timezone: string;
  breakMinutes: number;
  lunchMinMinutes: number;
  lunchMaxMinutes: number;
  coverageThresholdPct: number;
  mealAlertTiers: number[];
  caMealRulesEnabled: boolean;
  hrisProvider: string | null;
  hrisConfig: Record<string, unknown> | null;
}

export interface Agent {
  id: string;
  tenantId: string;
  displayName: string;
  department: string; // coverage is measured per department
  locationState: string; // USPS work-state code (CA, TX, …) → wage rules
  timezone: string;
  // Role tiers: admin (full + HRIS/tenant config) > manager (board + employee ops
  // across MULTIPLE departments) > supervisor (same, but ONE department — their
  // own by default) > user (team member: widget only).
  role: Role;
  isSupervisor: boolean; // convenience: role is not 'user' (i.e. has board access)
  // Departments this role oversees. Managers may span several; a supervisor is
  // scoped to a single department (the first here, else their own). Admins see all.
  managedDepartments?: string[];
  hostUserId: string;
  hrisEmployeeId: string | null;
  hrisDepartmentId: string | null;
  hrisActivityTypeId: string | null;
  mealWaiverOnFile: boolean;
  active: boolean; // false = deactivated (soft-delete). Punch logs are NEVER deleted.
  deactivatedAt?: Date | null; // when deactivated; drives the 90-day archive rule
  archivedAt?: Date | null; // archived (hidden) after 90 days inactive; data retained
  // Scheduled shift (used by the coverage recommender; optional in real data).
  scheduledStart?: Date;
  scheduledEnd?: Date;
}

export interface PunchEvent {
  id: string;
  tenantId: string;
  agentId: string;
  eventType: PunchEventType;
  eventTime: Date;
  source: EventSource;
  sessionId?: string;
  status: EventStatus;
  correctionOfId?: string;
  note?: string;
  createdById: string;
  approvedById?: string;
  approvedAt?: Date;
  createdAt: Date;
}

export interface ComplianceException {
  id: string;
  tenantId: string;
  agentId: string;
  workDate: Date;
  type: ExceptionType;
  status: ExceptionStatus;
  detectedAt: Date;
  relatedEventIds: string[];
  premiumHourPayable: boolean;
  premiumDelivered: boolean;
  resolution?: string;
  resolvedById?: string;
  resolvedAt?: Date;
}

// --- scheduler (mirrors schedule_pattern / schedule_exception from bs5_1) ---
export type ScheduleKindT =
  | 'WORK'
  | 'TRAINING'
  | 'HOLIDAY'
  | 'VACATION'
  | 'PTO'
  | 'SICK'
  | 'LEAVE'
  | 'OFF';

export interface SchedulePatternRow {
  agentId: string;
  weekday: number; // 0 = Sunday .. 6 = Saturday
  kind: ScheduleKindT;
  startTime: string | null; // local wall clock "HH:MM"
  endTime: string | null; // "HH:MM"; <= start means it ends next day
  lunchTime: string | null;
  lunchMinutes: number | null;
}

export interface ScheduleExceptionRow {
  agentId: string;
  date: string; // YYYY-MM-DD (agent-local)
  kind: ScheduleKindT;
  startTime: string | null;
  endTime: string | null;
  lunchTime: string | null;
  lunchMinutes: number | null;
  note?: string;
}

export type { PunchEventType, AgentStatus };
