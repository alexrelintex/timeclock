/**
 * Store factory — selects the persistence driver from STORE_DRIVER (default
 * 'memory'). Every driver implements the same `Store` contract, so the API and
 * domain are identical regardless of backend. See ADR 0001.
 *
 *   memory    in-process, volatile (dev/demo; resets on restart)
 *   postgres  durable: in-memory projection + write-through to Postgres via
 *             Prisma, hydrated on boot (store/postgres). Needs DATABASE_URL and a
 *             generated Prisma client — see store/postgres/README.md.
 *   embedded  self-contained durable (PGlite/SQLite) — planned.
 */
import { MemoryDb } from '../db.js';
import type { Store, StoreDriver } from './contract.js';
import { PostgresStore } from './postgres/postgresStore.js';

export type { Store, StoreDriver } from './contract.js';

export function createStore(
  driver: StoreDriver = (process.env.STORE_DRIVER as StoreDriver) || 'memory',
): Store {
  switch (driver) {
    case 'memory':
      return new MemoryDb();
    case 'postgres':
      // Constructed eagerly (sync); the DB connection + hydration happen in
      // init(), which the server awaits before listening. A missing DATABASE_URL
      // or ungenerated Prisma client surfaces there as a clear boot error.
      return new PostgresStore();
    case 'embedded':
      throw new Error(
        "STORE_DRIVER='embedded' is not implemented yet — a self-contained durable driver " +
          '(PGlite/SQLite) is planned (see docs/adr/0001-storage-drivers-and-crm-isolation.md). ' +
          'Use STORE_DRIVER=memory or STORE_DRIVER=postgres.',
      );
    default:
      throw new Error(`Unknown STORE_DRIVER='${driver}' (expected: memory | postgres | embedded)`);
  }
}
