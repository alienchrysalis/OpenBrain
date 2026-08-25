/**
 * Unit tests for src/auth/accessKeys.ts
 * Uses a mocked pg.Pool — the SQL itself is covered by the integration suite.
 */

import { describe, it, expect, vi } from "vitest";
import type pg from "pg";

import {
  hashAccessKey,
  authenticateAccessKey,
  checkKeySources,
  LEGACY_KEY_LABEL,
} from "../accessKeys.js";

const LEGACY_KEY = "a".repeat(64);
const NAMED_KEY = "b".repeat(64);
const BOGUS_KEY = "c".repeat(64);

interface KeyRowShape {
  id: string;
  label: string;
  created_at: Date;
  last_used_at: Date | null;
  revoked_at: Date | null;
  expires_at: Date | null;
}

function keyRow(overrides: Partial<KeyRowShape> = {}): KeyRowShape {
  return {
    id: "11111111-1111-4111-8111-111111111111",
    label: "toby-laptop",
    created_at: new Date("2026-01-01T00:00:00Z"),
    last_used_at: null,
    revoked_at: null,
    expires_at: null,
    ...overrides,
  };
}

/** Pool that returns `row` for the key-hash lookup and records every query. */
function poolReturning(row: KeyRowShape | null) {
  const mockQuery = vi.fn(async (sql: string, _params?: unknown[]) => {
    if (sql.includes("FROM access_keys WHERE key_hash")) {
      return { rows: row ? [row] : [] };
    }
    if (sql.includes("COUNT(*) AS count")) {
      return { rows: [{ count: row ? "1" : "0" }] };
    }
    return { rows: [] };
  });
  return { pool: { query: mockQuery } as unknown as pg.Pool, mockQuery };
}

/** Pool whose access_keys queries fail as if migration 004 has not run. */
function poolWithoutTable() {
  const mockQuery = vi.fn(async () => {
    throw Object.assign(new Error('relation "access_keys" does not exist'), {
      code: "42P01",
    });
  });
  return { pool: { query: mockQuery } as unknown as pg.Pool, mockQuery };
}

describe("hashAccessKey", () => {
  it("is SHA-256 hex", () => {
    // Known vector: sha256("test")
    expect(hashAccessKey("test")).toBe(
      "9f86d081884c7d659a2feaa0c55ad015a3bf4f1b2b0b822cd15d6c15b0f00a08"
    );
  });

  it("never returns the key itself", () => {
    expect(hashAccessKey(NAMED_KEY)).not.toContain(NAMED_KEY);
  });
});

describe("authenticateAccessKey", () => {
  it("accepts a named key and stamps last_used_at", async () => {
    const { pool, mockQuery } = poolReturning(keyRow());

    const result = await authenticateAccessKey(pool, NAMED_KEY);

    expect(result).toEqual({
      ok: true,
      keyId: "11111111-1111-4111-8111-111111111111",
      label: "toby-laptop",
    });
    const update = mockQuery.mock.calls.find(([sql]) =>
      (sql as string).includes("SET last_used_at")
    );
    expect(update).toBeDefined();
  });

  it("looks the key up by hash, never by the key itself", async () => {
    const { pool, mockQuery } = poolReturning(keyRow());

    await authenticateAccessKey(pool, NAMED_KEY);

    const params = mockQuery.mock.calls[0]![1] ?? [];
    expect(params[0]).toBe(hashAccessKey(NAMED_KEY));
    expect(params).not.toContain(NAMED_KEY);
  });

  it("rejects a revoked key", async () => {
    const { pool, mockQuery } = poolReturning(
      keyRow({ revoked_at: new Date("2026-02-01T00:00:00Z") })
    );

    const result = await authenticateAccessKey(pool, NAMED_KEY);

    expect(result).toEqual({ ok: false, reason: "revoked" });
    expect(
      mockQuery.mock.calls.some(([sql]) => (sql as string).includes("SET last_used_at"))
    ).toBe(false);
  });

  it("rejects a revoked key even when the legacy key would match", async () => {
    const { pool } = poolReturning(keyRow({ revoked_at: new Date() }));

    const result = await authenticateAccessKey(pool, LEGACY_KEY, {
      legacyKey: LEGACY_KEY,
    });

    expect(result).toEqual({ ok: false, reason: "revoked" });
  });

  it("rejects an expired key", async () => {
    const { pool } = poolReturning(
      keyRow({ expires_at: new Date("2026-01-02T00:00:00Z") })
    );

    const result = await authenticateAccessKey(pool, NAMED_KEY, {
      now: new Date("2026-03-01T00:00:00Z"),
    });

    expect(result).toEqual({ ok: false, reason: "expired" });
  });

  it("accepts a key that has not expired yet", async () => {
    const { pool } = poolReturning(
      keyRow({ expires_at: new Date("2026-12-31T00:00:00Z") })
    );

    const result = await authenticateAccessKey(pool, NAMED_KEY, {
      now: new Date("2026-03-01T00:00:00Z"),
    });

    expect(result.ok).toBe(true);
  });

  it("rejects a bogus 64-char key", async () => {
    const { pool } = poolReturning(null);

    const result = await authenticateAccessKey(pool, BOGUS_KEY, {
      legacyKey: LEGACY_KEY,
    });

    expect(result).toEqual({ ok: false, reason: "unknown" });
  });

  it("rejects a missing key", async () => {
    const { pool } = poolReturning(null);

    expect(await authenticateAccessKey(pool, null)).toEqual({
      ok: false,
      reason: "missing",
    });
    expect(await authenticateAccessKey(pool, "")).toEqual({
      ok: false,
      reason: "missing",
    });
  });

  it("falls back to MCP_ACCESS_KEY when no row matches", async () => {
    const { pool } = poolReturning(null);

    const result = await authenticateAccessKey(pool, LEGACY_KEY, {
      legacyKey: LEGACY_KEY,
    });

    expect(result).toEqual({ ok: true, keyId: null, label: LEGACY_KEY_LABEL });
  });

  it("fails closed when no key source is configured", async () => {
    const { pool } = poolReturning(null);

    const result = await authenticateAccessKey(pool, BOGUS_KEY, { legacyKey: "" });

    expect(result).toEqual({ ok: false, reason: "unknown" });
  });

  it("falls back to MCP_ACCESS_KEY when migration 004 has not been applied", async () => {
    const { pool } = poolWithoutTable();

    const result = await authenticateAccessKey(pool, LEGACY_KEY, {
      legacyKey: LEGACY_KEY,
    });

    expect(result).toEqual({ ok: true, keyId: null, label: LEGACY_KEY_LABEL });
  });
});

describe("checkKeySources", () => {
  it("is usable with named keys and no legacy key", async () => {
    const { pool } = poolReturning(keyRow());

    expect(await checkKeySources(pool, "")).toEqual({
      namedKeys: 1,
      hasLegacyKey: false,
      usable: true,
    });
  });

  it("is usable with a legacy key and no named keys", async () => {
    const { pool } = poolReturning(null);

    expect(await checkKeySources(pool, LEGACY_KEY)).toEqual({
      namedKeys: 0,
      hasLegacyKey: true,
      usable: true,
    });
  });

  it("is unusable with neither — the server must refuse to serve", async () => {
    const { pool } = poolReturning(null);

    expect(await checkKeySources(pool, "")).toEqual({
      namedKeys: 0,
      hasLegacyKey: false,
      usable: false,
    });
  });

  it("reports zero named keys when migration 004 has not been applied", async () => {
    const { pool } = poolWithoutTable();

    expect(await checkKeySources(pool, LEGACY_KEY)).toEqual({
      namedKeys: 0,
      hasLegacyKey: true,
      usable: true,
    });
  });
});
