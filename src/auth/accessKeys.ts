/**
 * Access-key authentication for the MCP endpoint.
 *
 * Keys live in the `access_keys` table as SHA-256 hashes. Plain SHA-256 is the right
 * primitive here — a key is 32 random bytes, so there is no dictionary to run and no
 * human-chosen password to stretch. Hashing exists so a database dump does not hand
 * over live keys.
 */

import { createHash, timingSafeEqual } from "node:crypto";
import type pg from "pg";

import {
  findAccessKeyByHash,
  touchAccessKey,
  countUsableAccessKeys,
} from "../db/queries.js";

/** Label used for the pre-migration shared MCP_ACCESS_KEY. */
export const LEGACY_KEY_LABEL = "legacy-shared";

export type AuthDenialReason = "missing" | "unknown" | "revoked" | "expired";

export type AuthResult =
  | { ok: true; keyId: string | null; label: string }
  | { ok: false; reason: AuthDenialReason };

export interface AuthOptions {
  /** MCP_ACCESS_KEY — the bootstrap fallback, matched only when no row matches. */
  legacyKey?: string;
  now?: Date;
}

export function hashAccessKey(key: string): string {
  return createHash("sha256").update(key, "utf8").digest("hex");
}

function hashesMatch(a: string, b: string): boolean {
  const left = Buffer.from(a, "hex");
  const right = Buffer.from(b, "hex");
  return left.length === right.length && timingSafeEqual(left, right);
}

/**
 * Resolve a presented key to a named row, falling back to MCP_ACCESS_KEY.
 * Fail-closed: anything not positively matched is denied.
 */
export async function authenticateAccessKey(
  pool: pg.Pool,
  presented: string | null | undefined,
  options: AuthOptions = {}
): Promise<AuthResult> {
  if (!presented) return { ok: false, reason: "missing" };

  const now = options.now ?? new Date();
  const presentedHash = hashAccessKey(presented);
  const row = await findAccessKeyByHash(pool, presentedHash);

  if (row) {
    if (row.revoked_at) return { ok: false, reason: "revoked" };
    if (row.expires_at && row.expires_at.getTime() <= now.getTime()) {
      return { ok: false, reason: "expired" };
    }
    await touchAccessKey(pool, row.id);
    return { ok: true, keyId: row.id, label: row.label };
  }

  const legacyKey = options.legacyKey ?? "";
  if (legacyKey && hashesMatch(presentedHash, hashAccessKey(legacyKey))) {
    return { ok: true, keyId: null, label: LEGACY_KEY_LABEL };
  }

  return { ok: false, reason: "unknown" };
}

export interface KeySourceReport {
  namedKeys: number;
  hasLegacyKey: boolean;
  usable: boolean;
}

/**
 * Boot-time check. With neither a named key nor MCP_ACCESS_KEY there is nothing to
 * authenticate against, and the endpoint is public — so the server must refuse to
 * serve rather than accept everything.
 */
export async function checkKeySources(
  pool: pg.Pool,
  legacyKey: string
): Promise<KeySourceReport> {
  const namedKeys = await countUsableAccessKeys(pool);
  const hasLegacyKey = legacyKey.length > 0;
  return { namedKeys, hasLegacyKey, usable: namedKeys > 0 || hasLegacyKey };
}
