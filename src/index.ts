/**
 * Open Brain — Entry Point
 *
 * Starts both:
 * 1. Hono REST API server (port 8000)
 * 2. MCP SSE server via raw Node.js HTTP (port 8080)
 *
 * The REST API provides direct HTTP access for testing, Slack webhooks,
 * and any non-MCP integrations.
 *
 * The MCP server is the primary interface for AI tools (Claude, ChatGPT, etc).
 * It uses SSE transport over a raw Node.js HTTP server because
 * SSEServerTransport requires Node.js ServerResponse objects (not Web API).
 */

import http from "node:http";
import { serve } from "@hono/node-server";

import { initializeDatabase, closePool, getPool } from "./db/connection.js";
import { createApi } from "./api/routes.js";
import { createMcpServer } from "./mcp/server.js";
import { authenticateAccessKey, checkKeySources } from "./auth/accessKeys.js";
import { recordMcpHandshake, type KeySource } from "./api/metrics.js";
import { safeLogValue, describeRequestHeaders, clientAddress } from "./mcp/requestLog.js";
import { SSEServerTransport } from "@modelcontextprotocol/sdk/server/sse.js";

/** An SSE session plus the identity of the key that opened it. */
interface McpSession {
  transport: SSEServerTransport;
  keyId: string | null;
  keyLabel: string;
}

async function main(): Promise<void> {
  console.log("╔══════════════════════════════════════════╗");
  console.log("║           Open Brain v1.0.0              ║");
  console.log("║    Personal Semantic Memory System       ║");
  console.log("╚══════════════════════════════════════════╝");

  // Initialize database connection pool
  await initializeDatabase();

  const pool = getPool();
  const mcpAccessKey = process.env.MCP_ACCESS_KEY ?? "";
  // The key is accepted in the URL only when explicitly opted in: query strings land
  // in access logs, proxy logs and browser history. Clients that cannot set headers
  // (ChatGPT, Claude Desktop web connectors) need this on.
  const allowKeyInQuery =
    (process.env.MCP_ALLOW_KEY_IN_QUERY ?? "false").toLowerCase() === "true";
  // Diagnostic for issue #18 — see describeRequestHeaders().
  const logHeaders = (process.env.MCP_LOG_HEADERS ?? "false").toLowerCase() === "true";

  const keySources = await checkKeySources(pool, mcpAccessKey);
  if (!keySources.usable) {
    console.error("[auth] Refusing to start: no access keys configured.");
    console.error("[auth]   The MCP endpoint is reachable by anyone who can route to it,");
    console.error("[auth]   so serving with no key would make it an open memory store.");
    console.error("[auth]   Fix with either:");
    console.error("[auth]     • npm run key -- mint --label <name>   (named key, preferred)");
    console.error("[auth]     • MCP_ACCESS_KEY=<64-char hex>          (shared fallback)");
    await closePool();
    process.exit(1);
  }
  console.log(
    `[auth] ${keySources.namedKeys} named key(s); MCP_ACCESS_KEY fallback ${keySources.hasLegacyKey ? "enabled" : "not set"}.`
  );
  if (allowKeyInQuery) {
    console.warn("[auth] MCP_ALLOW_KEY_IN_QUERY=true — keys in ?key= are logged by proxies.");
  }

  // ── REST API Server (Hono) ──────────────────────────────────────

  const api = createApi();
  const apiPort = parseInt(process.env.API_PORT ?? "8000", 10);

  serve({ fetch: api.fetch, port: apiPort }, () => {
    console.log(`[api] REST API listening on http://0.0.0.0:${apiPort}`);
    console.log(`[api]   POST /memories         — capture thought`);
    console.log(`[api]   POST /memories/batch    — batch capture`);
    console.log(`[api]   POST /memories/search   — semantic search`);
    console.log(`[api]   POST /memories/list     — filtered listing`);
    console.log(`[api]   PUT  /memories/:id      — update thought`);
    console.log(`[api]   DELETE /memories/:id     — delete thought`);
    console.log(`[api]   GET  /stats             — brain statistics`);
    console.log(`[api]   GET  /health            — health check`);
  });

  // ── MCP Server (SSE over raw Node.js HTTP) ─────────────────────

  const mcpPort = parseInt(process.env.MCP_PORT ?? "8080", 10);

  // Track active SSE transports for cleanup
  const sessions = new Map<string, McpSession>();

  const mcpHttpServer = http.createServer(async (req, res) => {
    // CORS headers
    res.setHeader("Access-Control-Allow-Origin", "*");
    res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
    res.setHeader("Access-Control-Allow-Headers", "Content-Type, x-brain-key");

    if (req.method === "OPTIONS") {
      res.writeHead(204);
      res.end();
      return;
    }

    const url = new URL(req.url ?? "/", `http://localhost:${mcpPort}`);

    // Health check — no auth required
    if (url.pathname === "/health") {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ status: "healthy", service: "open-brain-mcp" }));
      return;
    }

    // SSE endpoint — AI clients connect here
    // Auth is checked here; /messages skips the key check because
    // having a valid sessionId proves the client already authenticated.
    if (url.pathname === "/sse" && req.method === "GET") {
      const headerKey = req.headers["x-brain-key"] as string | undefined;
      const queryKey = allowKeyInQuery ? url.searchParams.get("key") : null;
      const key = headerKey ?? queryKey;

      const keySource: KeySource = headerKey
        ? "header"
        : url.searchParams.has("key")
          ? "query"
          : "none";
      const client = safeLogValue(req.headers["user-agent"]);
      const addr = clientAddress(req.headers, req.socket.remoteAddress);

      if (logHeaders) {
        console.log(
          `[mcp] /sse headers ${describeRequestHeaders(req.headers, req.socket.remoteAddress)}`
        );
      }

      if (!allowKeyInQuery && keySource === "query") {
        console.warn(
          "[mcp] /sse denied: key supplied as ?key= but MCP_ALLOW_KEY_IN_QUERY is off"
        );
      }

      const auth = await authenticateAccessKey(pool, key, {
        legacyKey: mcpAccessKey,
      }).catch((err: unknown) => {
        // A key lookup that cannot run is not permission to skip it.
        console.error(
          "[mcp] /sse denied: access key lookup failed —",
          err instanceof Error ? err.message : String(err)
        );
        return { ok: false as const, reason: "unavailable" as const };
      });

      recordMcpHandshake(keySource, auth.ok ? "ok" : auth.reason);

      if (!auth.ok) {
        console.warn(
          `[mcp] /sse denied (${auth.reason}) via=${keySource} addr=${addr} client="${client}"`
        );
        res.writeHead(auth.reason === "unavailable" ? 503 : 401, {
          "Content-Type": "application/json",
        });
        res.end(
          JSON.stringify({
            error: auth.reason === "unavailable" ? "Unavailable" : "Unauthorized",
          })
        );
        return;
      }

      const transport = new SSEServerTransport("/messages", res);
      const sessionId = transport.sessionId;
      sessions.set(sessionId, {
        transport,
        keyId: auth.keyId,
        keyLabel: auth.label,
      });

      res.on("close", () => {
        sessions.delete(sessionId);
        console.log(`[mcp] SSE session ${sessionId} closed`);
      });

      const server = createMcpServer();
      await server.connect(transport);
      console.log(
        `[mcp] SSE session ${sessionId} connected (key: ${auth.label}${auth.keyId ? ` / ${auth.keyId}` : ""}) via=${keySource} addr=${addr} client="${client}"`
      );
      return;
    }

    // Messages endpoint — receives JSON-RPC calls from AI clients
    if (url.pathname === "/messages" && req.method === "POST") {
      const sessionId = url.searchParams.get("sessionId");
      const session = sessionId ? sessions.get(sessionId) : undefined;

      if (!session) {
        res.writeHead(400, { "Content-Type": "application/json" });
        res.end(
          JSON.stringify({ error: "No active session. Connect to /sse first." })
        );
        return;
      }

      await session.transport.handlePostMessage(req, res);
      return;
    }

    // 404 fallback
    res.writeHead(404, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: "Not found" }));
  });

  mcpHttpServer.listen(mcpPort, "0.0.0.0", () => {
    console.log(`[mcp] MCP SSE server listening on http://0.0.0.0:${mcpPort}`);
    console.log(`[mcp]   GET  /sse               — SSE connection`);
    console.log(`[mcp]   POST /messages           — JSON-RPC calls`);
    console.log(`[mcp]   GET  /health             — health check`);
    console.log("");
    console.log("[mcp] Connect AI clients to:");
    console.log(`[mcp]   http://<host>:${mcpPort}/sse   header: x-brain-key: <KEY>`);
    if (allowKeyInQuery) {
      console.log(`[mcp]   http://<host>:${mcpPort}/sse?key=<KEY>   (header-less clients)`);
    }
  });
}

// Graceful shutdown
process.on("SIGINT", async () => {
  console.log("\n[shutdown] Received SIGINT, closing...");
  await closePool();
  process.exit(0);
});

process.on("SIGTERM", async () => {
  console.log("\n[shutdown] Received SIGTERM, closing...");
  await closePool();
  process.exit(0);
});

main().catch((err) => {
  console.error("[fatal]", err);
  process.exit(1);
});
