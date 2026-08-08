/**
 * Database connection pool using node-postgres (pg).
 * Singleton pool with pgvector support.
 */

import pg from "pg";

const { Pool } = pg;

let pool: pg.Pool | null = null;

export function getPool(): pg.Pool {
  if (!pool) {
    const useSSL = (process.env.DB_SSL ?? "false").toLowerCase() === "true";

    pool = new Pool({
      host: process.env.DB_HOST ?? "openbrain-postgres",
      port: parseInt(process.env.DB_PORT ?? "5432", 10),
      database: process.env.DB_NAME ?? "openbrain",
      user: process.env.DB_USER ?? "openbrain",
      password: process.env.DB_PASSWORD ?? "changeme",
      ssl: useSSL ? { rejectUnauthorized: false } : false,
      min: 2,
      max: 10,
      idleTimeoutMillis: 30_000,
      connectionTimeoutMillis: 5_000,
    });

    pool.on("error", (err) => {
      console.error("[db] Unexpected pool error:", err.message);
    });

    console.log(
      `[db] Pool created → ${process.env.DB_HOST ?? "openbrain-postgres"}:${process.env.DB_PORT ?? "5432"}/${process.env.DB_NAME ?? "openbrain"}`
    );
  }
  return pool;
}

/** Milliseconds to wait before each successive connection attempt. */
export const STARTUP_RETRY_DELAYS_MS = [250, 500, 1_000, 2_000, 4_000, 8_000];

async function connectWithRetry(db: pg.Pool): Promise<pg.PoolClient> {
  const attempts = STARTUP_RETRY_DELAYS_MS.length + 1;
  for (let i = 0; i < attempts; i++) {
    try {
      return await db.connect();
    } catch (err) {
      const last = i === attempts - 1;
      const message = err instanceof Error ? err.message : String(err);
      if (last) {
        console.error(`[db] Could not connect after ${attempts} attempts: ${message}`);
        throw err;
      }
      const wait = STARTUP_RETRY_DELAYS_MS[i] ?? 1_000;
      console.warn(`[db] Connect failed (${message}). Retrying in ${wait}ms…`);
      await new Promise((resolve) => setTimeout(resolve, wait));
    }
  }
  // Unreachable: the loop either returns a client or throws on the last attempt.
  throw new Error("[db] connectWithRetry exhausted without result");
}

export async function initializeDatabase(): Promise<void> {
  const db = getPool();
  // Retries because the first connection can lose a race that has nothing to do
  // with the database. Under a NetworkPolicy engine the pod's IP is not in the
  // allowed-sources set for the first second or so of its life, so a connection
  // opened immediately is refused; a second later it succeeds. Connecting once
  // and exiting made that a crash on every single rollout, 100% reproducible.
  // The same window covers an ordinary Postgres restart or a cold cluster boot.
  const client = await connectWithRetry(db);
  try {
    await client.query("CREATE EXTENSION IF NOT EXISTS vector");
    const result = await client.query("SELECT COUNT(*) FROM thoughts");
    console.log(`[db] Connected. ${result.rows[0]?.count ?? 0} thoughts in database.`);
  } finally {
    client.release();
  }
}

export async function closePool(): Promise<void> {
  if (pool) {
    await pool.end();
    pool = null;
    console.log("[db] Pool closed.");
  }
}
