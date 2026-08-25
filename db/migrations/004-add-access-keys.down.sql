-- Rollback Migration 004: Remove the named access keys table.
-- This destroys every named key permanently (hashes cannot be reversed, so the keys
-- themselves are unrecoverable). Confirm MCP_ACCESS_KEY is set before running this,
-- or the server will refuse to boot with no key source configured.

BEGIN;
DROP TABLE IF EXISTS access_keys;
COMMIT;
