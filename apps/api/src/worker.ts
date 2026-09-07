/**
 * Outbox drain + reconciler loop.
 *
 * drainTenant() itself is untouched from packages/hris/src/outboxWorker.ts — this
 * is only the scheduler and the wiring. Two ways to run it:
 *
 *   in-process   RUN_WORKER_IN_PROCESS=true (default). One interval per concern,
 *                serialised so a slow provider cannot stack up overlapping drains.
 *   external     POST /internal/outbox/drain with X-Worker-Secret, driven by
 *                pg_cron + pg_net or any scheduler. Use this when the API runs
 *                serverless. Both paths call runOnce() below.
 *
 * The reconciler sweep (orphan detection) is a pure-SQL RPC and also has a pg_cron
 * schedule of its own in migration 70, so orphans are still found if this process
 * dies. Running both is harmless: the sweep is idempotent per (agent, day, type).
 */

import { drainTenant } from '../../../packages/hris/src/outboxWorker';
import {
  SupabaseAdapterRegistry,
  SupabaseOutboxStore,
} from '../../../packages/db/src/outboxStore';
import type { TimeclockDb } from '../../../packages/db/src/client';
import type { TokenProvider } from '../../../packages/hris/src/adapter';
import type { Env } from './env';
import { ClientCredentialsTokenProvider, UnconfiguredTokenProvider } from './tokenProvider';

export interface WorkerLogger {
  info(msg: string, meta?: unknown): void;
  warn(msg: string, meta?: unknown): void;
  error(msg: string, meta?: unknown): void;
}

export interface DrainReport {
  tenants: number;
  errors: { tenantId: string; message: string }[];
  durationMs: number;
}

export class OutboxWorker {
  private readonly store: SupabaseOutboxStore;
  private readonly registry: SupabaseAdapterRegistry;
  private running = false;
  private timers: NodeJS.Timeout[] = [];

  constructor(
    private readonly db: TimeclockDb,
    private readonly env: Env,
    private readonly log: WorkerLogger,
  ) {
    this.store = new SupabaseOutboxStore(db);
    const tokenCache = new Map<string, TokenProvider>();
    const tokens = (tenantId: string): TokenProvider => {
      const hit = tokenCache.get(tenantId);
      if (hit) return hit;
      const p = env.paycor;
      const provider: TokenProvider =
        p.tokenUrl && p.clientId && p.clientSecret
          ? new ClientCredentialsTokenProvider({
              tokenUrl: p.tokenUrl,
              clientId: p.clientId,
              clientSecret: p.clientSecret,
              ...(p.scope ? { scope: p.scope } : {}),
            })
          : new UnconfiguredTokenProvider(tenantId);
      tokenCache.set(tenantId, provider);
      return provider;
    };
    this.registry = new SupabaseAdapterRegistry(db, tokens, {
      subscriptionKey: env.paycor.subscriptionKey ?? '',
    });
  }

  /** One full pass over every tenant with pending or in-flight work. */
  async runOnce(): Promise<DrainReport> {
    const started = Date.now();
    const errors: DrainReport['errors'] = [];
    if (this.running) {
      return { tenants: 0, errors: [{ tenantId: '-', message: 'drain already in progress' }], durationMs: 0 };
    }
    this.running = true;
    try {
      const tenantIds = await this.db.tenantsPending();
      for (const tenantId of tenantIds) {
        try {
          await drainTenant(tenantId, this.store, this.registry);
        } catch (e) {
          const message = (e as Error).message;
          errors.push({ tenantId, message });
          // A bad adapter config for one tenant must not stop the others.
          this.log.error('outbox drain failed', { tenantId, message });
        }
      }
      return { tenants: tenantIds.length, errors, durationMs: Date.now() - started };
    } finally {
      this.running = false;
    }
  }

  async sweepOnce(): Promise<{ orphansSeen: number }> {
    return this.db.sweepOrphans();
  }

  start(): void {
    if (!this.env.runWorkerInProcess) {
      this.log.info('worker: in-process loop disabled; drive POST /internal/outbox/drain instead');
      return;
    }
    const drain = setInterval(() => {
      void this.runOnce().then((r) => {
        if (r.tenants) this.log.info('outbox drained', r);
      });
    }, this.env.workerIntervalMs);
    const sweep = setInterval(() => {
      void this.sweepOnce()
        .then((r) => {
          if (r.orphansSeen) this.log.warn('orphans detected', r);
        })
        .catch((e) => this.log.error('orphan sweep failed', { message: (e as Error).message }));
    }, this.env.sweepIntervalMs);
    // Do not hold the process open on these alone.
    drain.unref?.();
    sweep.unref?.();
    this.timers.push(drain, sweep);
    this.log.info('worker started', {
      drainMs: this.env.workerIntervalMs,
      sweepMs: this.env.sweepIntervalMs,
    });
  }

  stop(): void {
    for (const t of this.timers) clearInterval(t);
    this.timers = [];
  }
}
