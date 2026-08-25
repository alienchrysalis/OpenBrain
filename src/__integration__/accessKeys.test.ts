import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { Pool } from 'pg';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { randomBytes, randomUUID } from 'node:crypto';

import {
  authenticateAccessKey,
  checkKeySources,
  hashAccessKey,
  LEGACY_KEY_LABEL,
} from '../auth/accessKeys.js';
import {
  insertAccessKey,
  listAccessKeys,
  revokeAccessKey,
  countUsableAccessKeys,
} from '../db/queries.js';

const pool = new Pool({
  host: process.env.DB_HOST_TEST ?? process.env.DB_HOST ?? 'localhost',
  port: Number(process.env.DB_PORT ?? 5432),
  user: process.env.DB_USER ?? 'openbrain',
  password: process.env.DB_PASSWORD ?? 'changeme',
  database: process.env.DB_NAME ?? 'openbrain',
});

const MIGRATION_UP = 'db/migrations/004-add-access-keys.sql';
const MIGRATION_DOWN = 'db/migrations/004-add-access-keys.down.sql';

function sqlFile(path: string): string {
  return readFileSync(join(process.cwd(), path), 'utf8');
}

/** Namespaced so a shared database is not disturbed. */
const RUN = randomUUID().slice(0, 8);
const label = (name: string) => `__test_${RUN}_${name}`;
const newKey = () => randomBytes(32).toString('hex');

beforeAll(async () => {
  for (const f of [
    'db/init.sql',
    'db/migrations/001-dev-ready-upgrade.sql',
    'db/migrations/002-add-created-by.sql',
    'db/migrations/003-add-provenance-helpers.sql',
    MIGRATION_UP,
  ]) {
    await pool.query(sqlFile(f));
  }
});

afterAll(async () => {
  await pool.query(`DELETE FROM access_keys WHERE label LIKE '__test_%'`);
  await pool.end();
});

describe('Migration 004 — access_keys table', () => {
  it('1: creates the expected columns', async () => {
    const { rows } = await pool.query<{ column_name: string; is_nullable: string }>(`
      SELECT column_name, is_nullable
      FROM information_schema.columns
      WHERE table_name = 'access_keys'
      ORDER BY column_name
    `);
    const columns = Object.fromEntries(rows.map((r) => [r.column_name, r.is_nullable]));
    expect(columns).toEqual({
      created_at: 'NO',
      expires_at: 'YES',
      id: 'NO',
      key_hash: 'NO',
      label: 'NO',
      last_used_at: 'YES',
      revoked_at: 'YES',
    });
  });

  it('2: enforces a unique key_hash', async () => {
    const hash = hashAccessKey(newKey());
    await insertAccessKey(pool, label('dup-a'), hash);
    await expect(insertAccessKey(pool, label('dup-b'), hash)).rejects.toThrow();
  });

  it('3: is idempotent — re-applying keeps existing rows', async () => {
    const before = await countUsableAccessKeys(pool);
    await pool.query(sqlFile(MIGRATION_UP));
    expect(await countUsableAccessKeys(pool)).toBe(before);
  });
});

describe('Authentication against a real database', () => {
  it('4: a minted key authenticates and stamps last_used_at', async () => {
    const key = newKey();
    const row = await insertAccessKey(pool, label('mint'), hashAccessKey(key));
    expect(row.last_used_at).toBeNull();

    const result = await authenticateAccessKey(pool, key);
    expect(result).toMatchObject({ ok: true, keyId: row.id, label: label('mint') });

    const { rows } = await pool.query<{ last_used_at: Date | null }>(
      `SELECT last_used_at FROM access_keys WHERE id = $1`,
      [row.id],
    );
    expect(rows[0]!.last_used_at).toBeInstanceOf(Date);
  });

  it('5: a revoked key is rejected and the row survives', async () => {
    const key = newKey();
    const row = await insertAccessKey(pool, label('revoked'), hashAccessKey(key));
    expect(await authenticateAccessKey(pool, key)).toMatchObject({ ok: true });

    const revoked = await revokeAccessKey(pool, row.id);
    expect(revoked?.revoked_at).toBeInstanceOf(Date);

    expect(await authenticateAccessKey(pool, key)).toEqual({
      ok: false,
      reason: 'revoked',
    });

    const { rowCount } = await pool.query(`SELECT 1 FROM access_keys WHERE id = $1`, [
      row.id,
    ]);
    expect(rowCount).toBe(1);
  });

  it('6: an expired key is rejected', async () => {
    const key = newKey();
    await insertAccessKey(
      pool,
      label('expired'),
      hashAccessKey(key),
      new Date(Date.now() - 60_000),
    );

    expect(await authenticateAccessKey(pool, key)).toEqual({
      ok: false,
      reason: 'expired',
    });
  });

  it('7: a bogus 64-char key is rejected', async () => {
    expect(await authenticateAccessKey(pool, newKey(), { legacyKey: newKey() })).toEqual({
      ok: false,
      reason: 'unknown',
    });
  });

  it('8: the legacy MCP_ACCESS_KEY still authenticates', async () => {
    const legacy = newKey();

    expect(await authenticateAccessKey(pool, legacy, { legacyKey: legacy })).toEqual({
      ok: true,
      keyId: null,
      label: LEGACY_KEY_LABEL,
    });
  });

  it('9: a seeded legacy key resolves to its named row', async () => {
    const legacy = newKey();
    const row = await insertAccessKey(pool, label('legacy-seeded'), hashAccessKey(legacy));

    expect(await authenticateAccessKey(pool, legacy, { legacyKey: legacy })).toMatchObject({
      ok: true,
      keyId: row.id,
    });
  });

  it('10: the raw key is never stored', async () => {
    const key = newKey();
    await insertAccessKey(pool, label('no-plaintext'), hashAccessKey(key));

    const { rowCount } = await pool.query(
      `SELECT 1 FROM access_keys WHERE key_hash = $1 OR label = $1`,
      [key],
    );
    expect(rowCount).toBe(0);
    const listed = await listAccessKeys(pool);
    expect(JSON.stringify(listed)).not.toContain(key);
  });
});

describe('Fail-closed configuration check', () => {
  it('11: refuses when there is neither a named key nor MCP_ACCESS_KEY', async () => {
    const empty = { query: async () => ({ rows: [{ count: '0' }] }) } as never;

    expect(await checkKeySources(empty, '')).toEqual({
      namedKeys: 0,
      hasLegacyKey: false,
      usable: false,
    });
  });

  it('12: counts only keys that could authenticate right now', async () => {
    const before = await countUsableAccessKeys(pool);
    const revokedRow = await insertAccessKey(
      pool,
      label('uncounted-revoked'),
      hashAccessKey(newKey()),
    );
    await revokeAccessKey(pool, revokedRow.id);
    await insertAccessKey(
      pool,
      label('uncounted-expired'),
      hashAccessKey(newKey()),
      new Date(Date.now() - 60_000),
    );

    expect(await countUsableAccessKeys(pool)).toBe(before);
  });
});

describe('Rollback', () => {
  it('13: the down migration drops the table, and up restores it', async () => {
    await pool.query(sqlFile(MIGRATION_DOWN));

    const gone = await pool.query<{ present: boolean }>(
      `SELECT to_regclass('public.access_keys') IS NOT NULL AS present`,
    );
    expect(gone.rows[0]!.present).toBe(false);

    // With the table gone, auth degrades to the MCP_ACCESS_KEY fallback rather than 500.
    const legacy = newKey();
    expect(await authenticateAccessKey(pool, legacy, { legacyKey: legacy })).toEqual({
      ok: true,
      keyId: null,
      label: LEGACY_KEY_LABEL,
    });
    expect(await checkKeySources(pool, legacy)).toEqual({
      namedKeys: 0,
      hasLegacyKey: true,
      usable: true,
    });

    await pool.query(sqlFile(MIGRATION_UP));
    const back = await pool.query<{ present: boolean }>(
      `SELECT to_regclass('public.access_keys') IS NOT NULL AS present`,
    );
    expect(back.rows[0]!.present).toBe(true);
  });
});
