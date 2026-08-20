#!/usr/bin/env node
/**
 * Access key management CLI.
 *
 *   npm run key -- mint --label toby-laptop [--expires 2026-12-31]
 *   npm run key -- seed-legacy          # store the current MCP_ACCESS_KEY as key zero
 *   npm run key -- list
 *   npm run key -- revoke --id <uuid>
 *
 * A minted key is printed exactly once and only its SHA-256 hash is stored, so an
 * existing key can never be reprinted or recovered — mint a replacement instead.
 */

import { randomBytes } from "node:crypto";
import { parseArgs } from "node:util";

import { getPool, closePool } from "../db/connection.js";
import {
  insertAccessKey,
  listAccessKeys,
  revokeAccessKey,
  type AccessKeyRow,
} from "../db/queries.js";
import { hashAccessKey, LEGACY_KEY_LABEL } from "../auth/accessKeys.js";

const USAGE = `Usage:
  key mint --label <name> [--expires <YYYY-MM-DD>]
  key seed-legacy [--label <name>]
  key list
  key revoke --id <uuid>`;

function parseExpiry(value: string | undefined): Date | undefined {
  if (!value) return undefined;
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    throw new Error(`--expires is not a valid date: ${value}`);
  }
  return date;
}

function printRow(row: AccessKeyRow): void {
  const state = row.revoked_at
    ? `revoked ${row.revoked_at.toISOString().slice(0, 10)}`
    : row.expires_at && row.expires_at.getTime() <= Date.now()
      ? `expired ${row.expires_at.toISOString().slice(0, 10)}`
      : "active";
  const lastUsed = row.last_used_at ? row.last_used_at.toISOString() : "never";
  console.log(
    `${row.id}  ${row.label.padEnd(20)}  ${state.padEnd(20)}  last used: ${lastUsed}`
  );
}

async function main(): Promise<void> {
  const { values, positionals } = parseArgs({
    args: process.argv.slice(2),
    allowPositionals: true,
    options: {
      label: { type: "string" },
      expires: { type: "string" },
      id: { type: "string" },
    },
  });

  const command = positionals[0];
  const pool = getPool();

  switch (command) {
    case "mint": {
      if (!values.label) throw new Error("mint requires --label\n\n" + USAGE);
      const key = randomBytes(32).toString("hex");
      const row = await insertAccessKey(
        pool,
        values.label,
        hashAccessKey(key),
        parseExpiry(values.expires)
      );
      console.log(`\nMinted key "${row.label}" (${row.id})`);
      if (row.expires_at) console.log(`Expires: ${row.expires_at.toISOString()}`);
      console.log("\nShown once — it cannot be recovered:\n");
      console.log(`  ${key}\n`);
      console.log("Give it to the client as the x-brain-key header.\n");
      break;
    }

    case "seed-legacy": {
      const legacy = process.env.MCP_ACCESS_KEY ?? "";
      if (!legacy) throw new Error("MCP_ACCESS_KEY is not set — nothing to seed");
      const row = await insertAccessKey(
        pool,
        values.label ?? LEGACY_KEY_LABEL,
        hashAccessKey(legacy)
      );
      console.log(`Stored the current MCP_ACCESS_KEY as "${row.label}" (${row.id}).`);
      console.log("The key itself was not printed and is unchanged — clients keep working.");
      break;
    }

    case "list": {
      const rows = await listAccessKeys(pool);
      if (rows.length === 0) {
        console.log("No named keys. Mint one with: key mint --label <name>");
        break;
      }
      rows.forEach(printRow);
      break;
    }

    case "revoke": {
      if (!values.id) throw new Error("revoke requires --id (see: key list)\n\n" + USAGE);
      const row = await revokeAccessKey(pool, values.id);
      if (!row) throw new Error(`No key with id ${values.id}`);
      console.log(`Revoked "${row.label}" (${row.id}) at ${row.revoked_at?.toISOString()}.`);
      break;
    }

    default:
      console.log(USAGE);
      process.exitCode = command ? 1 : 0;
  }
}

main()
  .catch((err: unknown) => {
    console.error(`\n[key] ${err instanceof Error ? err.message : String(err)}`);
    process.exitCode = 1;
  })
  .finally(closePool);
