-- Migration 004: Named access keys for MCP authentication.
-- Replaces the single shared MCP_ACCESS_KEY with a table of labelled keys that can be
-- revoked or expired one at a time. Only the SHA-256 hash is stored, so a database dump
-- does not hand over live keys.

BEGIN;

CREATE TABLE IF NOT EXISTS access_keys (
    id           UUID        DEFAULT gen_random_uuid() PRIMARY KEY,
    label        TEXT        NOT NULL,
    key_hash     TEXT        NOT NULL UNIQUE,
    created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
    last_used_at TIMESTAMPTZ,
    revoked_at   TIMESTAMPTZ,
    expires_at   TIMESTAMPTZ
);

COMMENT ON TABLE access_keys IS
  'MCP access keys. Revoke by setting revoked_at — deleting the row destroys the audit trail.';
COMMENT ON COLUMN access_keys.key_hash IS
  'SHA-256 hex of the key. The key itself is never stored and cannot be recovered.';

COMMIT;
