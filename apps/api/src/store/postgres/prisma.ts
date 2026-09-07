/**
 * Runtime loader + structural typing for the Prisma client.
 *
 * We do NOT statically import '@prisma/client': it is a generated, optional
 * dependency, so a static import would break `tsc` (and the memory driver) when
 * it hasn't been generated. Instead the postgres driver loads it at runtime via
 * createRequire and treats it through the `PrismaClientLike` structural type — the
 * exact subset of delegates the driver uses. Generate it with `npx prisma generate`
 * (needs only prisma/schema.prisma, no database) before selecting STORE_DRIVER=postgres.
 */
import { createRequire } from 'node:module';

/** Minimal delegate surface used by the driver (create/upsert/find/update/delete). */
export interface Delegate {
  findMany(args?: Record<string, unknown>): Promise<Record<string, any>[]>;
  create(args: { data: Record<string, unknown> }): Promise<{ id: string }>;
  createMany(args: { data: Record<string, unknown>[] }): Promise<{ count: number }>;
  upsert(args: {
    where: Record<string, unknown>;
    create: Record<string, unknown>;
    update: Record<string, unknown>;
  }): Promise<{ id: string }>;
  update(args: { where: Record<string, unknown>; data: Record<string, unknown> }): Promise<unknown>;
  updateMany(args: { where: Record<string, unknown>; data: Record<string, unknown> }): Promise<{ count: number }>;
  deleteMany(args: { where: Record<string, unknown> }): Promise<{ count: number }>;
}

export interface PrismaClientLike {
  tenant: Delegate;
  agent: Delegate;
  punchEvent: Delegate;
  complianceException: Delegate;
  hrisOutbox: Delegate;
  schedulePattern: Delegate;
  scheduleException: Delegate;
  $transaction<T>(fn: (tx: PrismaClientLike) => Promise<T>): Promise<T>;
  $disconnect(): Promise<void>;
}

export class PrismaUnavailableError extends Error {}

/**
 * Construct a PrismaClient at runtime. Throws an actionable error (not a cryptic
 * MODULE_NOT_FOUND) when the client hasn't been generated or DATABASE_URL is unset.
 */
export function loadPrismaClient(): PrismaClientLike {
  if (!process.env.DATABASE_URL) {
    throw new PrismaUnavailableError(
      "STORE_DRIVER=postgres requires DATABASE_URL (e.g. postgres://user:pass@host:5432/timeclock). " +
        'Set it, then boot again.',
    );
  }
  const require = createRequire(import.meta.url);
  let PrismaClient: new () => PrismaClientLike;
  try {
    ({ PrismaClient } = require('@prisma/client') as { PrismaClient: new () => PrismaClientLike });
  } catch {
    throw new PrismaUnavailableError(
      "STORE_DRIVER=postgres needs the generated Prisma client. Run `npm install` then " +
        '`npx prisma generate` (schema at prisma/schema.prisma), and `npx prisma migrate deploy` ' +
        'against your database. See apps/api/src/store/postgres/README.md.',
    );
  }
  return new PrismaClient();
}
