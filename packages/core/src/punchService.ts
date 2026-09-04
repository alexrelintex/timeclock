/**
 * Punch service — the single write path for punch events.
 * Enforces the state machine, appends the event, and (for IN/OUT) enqueues
 * the canonical outbox row in the SAME transaction (transactional outbox).
 * Persistence is injected; a Prisma implementation lives in apps/api.
 */

import {
  AgentStatus,
  canTransition,
  InvalidTransitionError,
  projectShift,
  PunchEventLike,
  PunchEventType,
} from './stateMachine';

export interface AgentContext {
  agentId: string;
  tenantId: string;
  timezone: string;
  hrisEmployeeId: string | null;
}

export interface AppendResult {
  eventId: string;
  newStatus: AgentStatus;
  enqueuedToHris: boolean;
}

export interface PunchStore {
  /** Today's ACTIVE events for the agent, chronological. */
  loadOpenStream(agentId: string): Promise<(PunchEventLike & { id: string })[]>;
  /**
   * Append event + optional outbox row atomically.
   * Returns the new event id.
   */
  appendWithOutbox(args: {
    tenantId: string;
    agentId: string;
    eventType: PunchEventType;
    eventTime: Date;
    source: 'WIDGET' | 'SUPERVISOR' | 'SYSTEM';
    sessionId?: string;
    note?: string;
    createdById: string;
    outbox: null | {
      kind: 'PUNCH';
      payload: unknown; // CanonicalPunch
    };
  }): Promise<string>;
}

const HRIS_SYNCED: ReadonlySet<PunchEventType> = new Set(['IN', 'OUT']);

export class PunchService {
  constructor(private readonly store: PunchStore) {}

  async punch(
    agent: AgentContext,
    eventType: PunchEventType,
    opts: { sessionId?: string; note?: string; now?: Date } = {},
  ): Promise<AppendResult> {
    const now = opts.now ?? new Date();
    const stream = await this.store.loadOpenStream(agent.agentId);
    const { status } = projectShift(stream, now);

    if (!canTransition(status, eventType)) {
      throw new InvalidTransitionError(status, eventType);
    }

    const syncs = HRIS_SYNCED.has(eventType) && agent.hrisEmployeeId !== null;
    const eventId = await this.store.appendWithOutbox({
      tenantId: agent.tenantId,
      agentId: agent.agentId,
      eventType,
      eventTime: now,
      source: 'WIDGET',
      sessionId: opts.sessionId,
      note: opts.note,
      createdById: agent.agentId,
      outbox: syncs
        ? {
            kind: 'PUNCH',
            payload: {
              punchEventId: 'SELF', // store impl replaces with the new event id
              agentId: agent.agentId,
              hrisEmployeeId: agent.hrisEmployeeId,
              type: eventType,
              timeUtc: now,
              agentTimezone: agent.timezone,
              ...(opts.note ? { note: opts.note } : {}),
            },
          }
        : null,
    });

    const next = projectShift(
      [...stream, { eventType, eventTime: now, status: 'ACTIVE' }],
      now,
    );
    return { eventId, newStatus: next.status, enqueuedToHris: syncs };
  }
}
