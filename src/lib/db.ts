import { PrismaClient } from "@prisma/client";

declare global {
  var prismaGlobal: PrismaClient | undefined;
}

/**
 * Prisma's interactive-transaction defaults are too tight for a remote database.
 *
 * `$transaction(async (tx) => …)` defaults to **2s** to acquire a pool connection (`maxWait`) and
 * **5s** for the whole callback (`timeout`). Those are sensible against a database on localhost.
 * This build talks to a Supabase pooler in another country: a single round trip is tens of
 * milliseconds, and the transactions that matter here are not one statement — raising a sales order
 * writes the order and its lines, an audit row and an outbox row, and the goods-receipt acceptance
 * touches four tables.
 *
 * The symptom was a test suite that passed twice and failed once on the same commit, inside
 * `writeAuditLog` in the middle of a transaction, and passed again in isolation. Nothing about that
 * path is non-deterministic — the load on the connection pool is. The precise error text was lost to
 * a truncated log, so which of the two limits bit is inferred rather than proven; both are raised,
 * because both are wrong for this topology.
 *
 * These are **not** a way to let a slow query pass unnoticed. A transaction that genuinely takes
 * twenty seconds is still a bug, and it still fails. What they stop is an ordinary four-statement
 * transaction failing because the pool was busy for two seconds.
 */
export const db =
  globalThis.prismaGlobal ??
  new PrismaClient({
    transactionOptions: {
      maxWait: 15_000,
      timeout: 30_000,
    },
  });

if (process.env.NODE_ENV !== "production") {
  globalThis.prismaGlobal = db;
}
