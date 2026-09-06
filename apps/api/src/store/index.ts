/**
 * Store factory — selects the persistence driver from STORE_DRIVER (default
 * 'memory'). All drivers implement the same `Store` contract, so the API and
 * domain are identical regardless of backend. See ADR 0001.
 */
import { MemoryDb } from '../db.js';
import type { Store, StoreDriver } from './contract.js';

export type { Store, StoreDriver } from './contract.js';

export function createStore(driver: StoreDriver = (process.env.STORE_DRIVER as StoreDriver) || 'memory'): Store {
  switch (driver) {
    case 'memory':
      return new MemoryDb();
    case 'postgres':
      throw new Error(
        "STORE_DRIVER='postgres' is not implemented yet — a durable driver behind the " +
          'Store contract is planned (see docs/adr/0001-storage-drivers-and-crm-isolation.md). ' +
          "Use STORE_DRIVER=memory for now.",
      );
    case 'embedded':
      throw new Error(
        "STORE_DRIVER='embedded' is not implemented yet — a self-contained durable driver " +
          '(PGlite/SQLite) is planned (see ADR 0001). Use STORE_DRIVER=memory for now.',
      );
    default:
      throw new Error(`Unknown STORE_DRIVER='${driver}' (expected: memory | postgres | embedded)`);
  }
}
