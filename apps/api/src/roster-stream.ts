/**
 * Supervisor live feed.
 *
 * Two transports, same events:
 *
 *   Supabase Realtime  The RPCs call realtime.send() on the private topics
 *                      tc:tenant:<id> and tc:agent:<id>. A supervisor panel can
 *                      subscribe straight from the browser; RLS on
 *                      realtime.messages (migration 80) is the authorization.
 *                      Preferred when Realtime is provisioned — no fan-out state
 *                      in this process.
 *
 *   SSE (this file)    The same RPCs also pg_notify('tc_roster', ...). One
 *                      LISTEN connection per API instance multiplexes to connected
 *                      supervisors, filtered by tenant. This is the fallback for
 *                      self-hosted Postgres, and it keeps the panel working if
 *                      Realtime is unavailable.
 *
 * Payloads carry identifiers only (NOTIFY caps at 8000 bytes): a client receiving
 * an event re-reads tc_api.roster(). That also means a missed event self-heals on
 * the next one, and no roster data ever travels outside RLS.
 */

import { Client } from 'pg';

export interface RosterEvent {
  tenantId: string;
  event: string;
  payload: Record<string, unknown>;
}

type Sink = (e: RosterEvent) => void;

export class RosterStream {
  private client: Client | null = null;
  private readonly subscribers = new Map<string, Set<Sink>>();
  private reconnectDelayMs = 1_000;
  private stopped = false;

  constructor(
    private readonly databaseUrl: string | undefined,
    private readonly log: { info(m: string, x?: unknown): void; error(m: string, x?: unknown): void },
  ) {}

  get enabled(): boolean {
    return Boolean(this.databaseUrl);
  }

  subscribe(tenantId: string, sink: Sink): () => void {
    let set = this.subscribers.get(tenantId);
    if (!set) {
      set = new Set();
      this.subscribers.set(tenantId, set);
    }
    set.add(sink);
    return () => {
      set?.delete(sink);
      if (set && set.size === 0) this.subscribers.delete(tenantId);
    };
  }

  async start(): Promise<void> {
    if (!this.databaseUrl) {
      this.log.info('roster SSE disabled (no DATABASE_URL); use Supabase Realtime instead');
      return;
    }
    await this.connect();
  }

  private async connect(): Promise<void> {
    if (this.stopped) return;
    const client = new Client({ connectionString: this.databaseUrl });
    client.on('error', (e) => {
      this.log.error('roster LISTEN connection error', { message: e.message });
      this.scheduleReconnect();
    });
    client.on('notification', (msg) => {
      if (!msg.payload) return;
      let evt: RosterEvent;
      try {
        evt = JSON.parse(msg.payload) as RosterEvent;
      } catch {
        return;
      }
      for (const sink of this.subscribers.get(evt.tenantId) ?? []) {
        try {
          sink(evt);
        } catch {
          /* a broken client must not break the fan-out */
        }
      }
    });
    try {
      await client.connect();
      await client.query('listen tc_roster');
      this.client = client;
      this.reconnectDelayMs = 1_000;
      this.log.info('roster SSE listening on tc_roster');
    } catch (e) {
      this.log.error('roster LISTEN failed', { message: (e as Error).message });
      this.scheduleReconnect();
    }
  }

  private scheduleReconnect(): void {
    if (this.stopped) return;
    const old = this.client;
    this.client = null;
    void old?.end().catch(() => undefined);
    const delay = this.reconnectDelayMs;
    this.reconnectDelayMs = Math.min(30_000, delay * 2);
    setTimeout(() => void this.connect(), delay).unref?.();
  }

  async stop(): Promise<void> {
    this.stopped = true;
    const c = this.client;
    this.client = null;
    await c?.end().catch(() => undefined);
  }
}
