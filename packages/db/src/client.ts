/**
 * Supabase access layer.
 *
 * Two identities, deliberately never mixed:
 *
 *   agent(jwt)  A per-request client carrying the short-lived session JWT that
 *               apps/api minted. PostgREST switches to the `authenticated` role
 *               and publishes the claims into request.jwt.claims, so every RPC
 *               runs under RLS. This is the path all agent/supervisor traffic
 *               takes — including traffic from apps/api itself.
 *
 *   admin()     The service_role client. BYPASSRLS, used only by the outbox
 *               worker, the reconciler and the identity map. It cannot rewrite
 *               punch history: UPDATE/DELETE on punch_event are revoked from
 *               service_role at the privilege level (migration 20/30).
 *
 * Only the `tc_api` schema is exposed to the Data API; `timeclock` (the tables)
 * is unreachable from either client.
 * Ref: https://supabase.com/docs/guides/api/using-custom-schemas
 */

import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import type {
  Ledger,
  PunchResult,
  ResolvedIdentity,
  Roster,
  StatusSnapshot,
  MissingEventType,
  PunchEventType,
  ExceptionType,
  CorrectionResult,
} from './contract';
import { toTcError, TcError } from './errors';

export const EXPOSED_SCHEMA = 'tc_api';

export interface TimeclockDbConfig {
  url: string;
  anonKey: string;
  serviceRoleKey: string;
  /** Max per-JWT clients to keep around. Clients are cheap; this just avoids churn. */
  clientCacheSize?: number;
}

type AnyClient = SupabaseClient<any, any, any>;

export class TimeclockDb {
  private readonly adminClient: AnyClient;
  private readonly cache = new Map<string, AnyClient>();
  private readonly cacheMax: number;

  constructor(private readonly cfg: TimeclockDbConfig) {
    this.cacheMax = cfg.clientCacheSize ?? 200;
    this.adminClient = createClient(cfg.url, cfg.serviceRoleKey, {
      db: { schema: EXPOSED_SCHEMA },
      auth: { persistSession: false, autoRefreshToken: false },
    });
  }

  admin(): AnyClient {
    return this.adminClient;
  }

  /** Client bound to one session JWT. Reused per token so a burst of punches from
   *  the same widget does not allocate a client per request. */
  agent(sessionJwt: string): AnyClient {
    const hit = this.cache.get(sessionJwt);
    if (hit) return hit;
    const client = createClient(this.cfg.url, this.cfg.anonKey, {
      db: { schema: EXPOSED_SCHEMA },
      auth: { persistSession: false, autoRefreshToken: false },
      global: { headers: { Authorization: `Bearer ${sessionJwt}` } },
    });
    if (this.cache.size >= this.cacheMax) {
      // Session JWTs live <= 5 minutes; simple FIFO eviction is sufficient.
      const oldest = this.cache.keys().next();
      if (!oldest.done) this.cache.delete(oldest.value);
    }
    this.cache.set(sessionJwt, client);
    return client;
  }

  // ------------------------------------------------------------------ agent RPCs

  async status(jwt: string): Promise<StatusSnapshot> {
    return this.call<StatusSnapshot>(this.agent(jwt), 'status', {});
  }

  async punch(
    jwt: string,
    args: { eventType: PunchEventType; clientUuid: string; note?: string; sessionId?: string },
  ): Promise<PunchResult> {
    return this.call<PunchResult>(this.agent(jwt), 'punch', {
      p_event_type: args.eventType,
      p_client_uuid: args.clientUuid,
      p_note: args.note ?? null,
      p_session_id: args.sessionId ?? null,
    });
  }

  async submitCorrection(
    jwt: string,
    args: {
      missingEventType: MissingEventType;
      attestation: string;
      clientUuid: string;
      proposedTimeUtc?: string;
      proposedMinutes?: number;
    },
  ): Promise<CorrectionResult> {
    return this.call<CorrectionResult>(this.agent(jwt), 'submit_correction', {
      p_missing_event_type: args.missingEventType,
      p_attestation: args.attestation,
      p_client_uuid: args.clientUuid,
      p_proposed_time_utc: args.proposedTimeUtc ?? null,
      p_proposed_minutes: args.proposedMinutes ?? null,
    });
  }

  async ledger(jwt: string, days = 7): Promise<Ledger> {
    return this.call<Ledger>(this.agent(jwt), 'my_ledger', { p_days: days });
  }

  // ------------------------------------------------------------- supervisor RPCs

  async roster(jwt: string): Promise<Roster> {
    return this.call<Roster>(this.agent(jwt), 'roster', {});
  }

  async decideCorrection(
    jwt: string,
    args: { eventId: string; approve: boolean; note?: string },
  ): Promise<{ eventId: string; approved: boolean; enqueuedToHris: boolean; agent: StatusSnapshot }> {
    return this.call(this.agent(jwt), 'decide_correction', {
      p_event_id: args.eventId,
      p_approve: args.approve,
      p_note: args.note ?? null,
    });
  }

  async punchForAgent(
    jwt: string,
    args: { agentId: string; eventType: PunchEventType; clientUuid: string; reason: string },
  ): Promise<PunchResult> {
    return this.call<PunchResult>(this.agent(jwt), 'punch_for_agent', {
      p_agent_id: args.agentId,
      p_event_type: args.eventType,
      p_client_uuid: args.clientUuid,
      p_reason: args.reason,
    });
  }

  async recordException(
    jwt: string,
    args: {
      agentId: string;
      workDate: string;
      type: ExceptionType;
      relatedEventIds?: string[];
      premiumHourPayable?: boolean;
      resolution?: string;
    },
  ): Promise<{ id: string; premiumHourPayable: boolean; premiumDelivered: boolean }> {
    return this.call(this.agent(jwt), 'record_exception', {
      p_agent_id: args.agentId,
      p_work_date: args.workDate,
      p_type: args.type,
      p_related_event_ids: args.relatedEventIds ?? [],
      p_premium_hour_payable: args.premiumHourPayable ?? false,
      p_resolution: args.resolution ?? null,
    });
  }

  async resolveException(
    jwt: string,
    args: { exceptionId: string; status: 'RESOLVED' | 'DISMISSED'; resolution?: string },
  ): Promise<{ id: string; status: string }> {
    return this.call(this.agent(jwt), 'resolve_exception', {
      p_exception_id: args.exceptionId,
      p_status: args.status,
      p_resolution: args.resolution ?? null,
    });
  }

  async auditTrail(
    jwt: string,
    args: { agentId: string; fromUtc: string; toUtc: string },
  ): Promise<unknown> {
    return this.call(this.agent(jwt), 'audit_trail', {
      p_agent_id: args.agentId,
      p_from: args.fromUtc,
      p_to: args.toUtc,
    });
  }

  // ----------------------------------------------------------------- admin RPCs

  async resolveIdentity(tenantSlug: string, hostUserId: string): Promise<ResolvedIdentity | null> {
    return this.call<ResolvedIdentity | null>(this.admin(), 'resolve_identity', {
      p_tenant_slug: tenantSlug,
      p_host_user_id: hostUserId,
    });
  }

  async upsertAgent(args: {
    tenantSlug: string;
    hostUserId: string;
    displayName: string;
    timezone?: string;
    isSupervisor?: boolean;
  }): Promise<ResolvedIdentity> {
    return this.call<ResolvedIdentity>(this.admin(), 'upsert_agent', {
      p_tenant_slug: args.tenantSlug,
      p_host_user_id: args.hostUserId,
      p_display_name: args.displayName,
      p_timezone: args.timezone ?? null,
      p_is_supervisor: args.isSupervisor ?? null,
    });
  }

  async mapHrisEmployee(args: {
    agentId: string;
    hrisEmployeeId: string;
    hrisDepartmentId?: string;
    hrisActivityTypeId?: string;
  }): Promise<unknown> {
    return this.call(this.admin(), 'map_hris_employee', {
      p_agent_id: args.agentId,
      p_hris_employee_id: args.hrisEmployeeId,
      p_hris_department_id: args.hrisDepartmentId ?? null,
      p_hris_activity_type_id: args.hrisActivityTypeId ?? null,
    });
  }

  async tenantHrisConfig(tenantId: string): Promise<TenantHrisConfig | null> {
    return this.call<TenantHrisConfig | null>(this.admin(), 'tenant_hris_config', {
      p_tenant_id: tenantId,
    });
  }

  async tenantsPending(): Promise<string[]> {
    return this.call<string[]>(this.admin(), 'outbox_tenants_pending', {});
  }

  async sweepOrphans(tenantId?: string): Promise<{ orphansSeen: number }> {
    return this.call(this.admin(), 'sweep_orphans', { p_tenant_id: tenantId ?? null });
  }

  async health(jwt?: string): Promise<{ contractVersion: number; transitions: number }> {
    return this.call(jwt ? this.agent(jwt) : this.admin(), 'health', {});
  }

  // ---------------------------------------------------------------------- plumbing

  async call<T>(client: AnyClient, fn: string, args: Record<string, unknown>): Promise<T> {
    const { data, error } = await client.rpc(fn, args);
    if (error) throw toTcError(error, `tc_api.${fn} failed`);
    if (data === undefined) {
      throw new TcError(500, `tc_api.${fn} returned no payload`);
    }
    return data as T;
  }
}

export interface TenantHrisConfig {
  tenantId: string;
  slug: string;
  provider: string | null;
  config: Record<string, unknown> | null;
  premiumEarningRef: string | null;
  employeeWriteConfig: Record<string, { departmentId: string | null; activityTypeId: string | null }>;
}
