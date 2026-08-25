/**
 * Open Brain — Entry Point
 *
 * Starts both:
 * 1. Hono REST API server (port 8000)
 * 2. MCP server via raw Node.js HTTP (port 8080), serving two transports:
 *    - Streamable HTTP on /mcp (current spec — one endpoint, POST+GET+DELETE)
 *    - SSE on /sse + /messages (2024-11-05 spec — kept for older clients:
 *      Claude Desktop's built-in connector still only speaks SSE)
 *
 * The REST API provides direct HTTP access for testing, Slack webhooks,
 * and any non-MCP integrations.
 *
 * The MCP server is the primary interface for AI tools (Claude, ChatGPT, etc).
 * Both transports run over a raw Node.js HTTP server because SSEServerTransport
 * requires Node.js ServerResponse objects (not Web API), and sharing one server
 * for both keeps a single port/auth/CORS surface instead of two.
 */

import http from "node:http";
import { randomUUID } from "node:crypto";
import { serve } from "@hono/node-server";

import { initializeDatabase, closePool, getPool } from "./db/connection.js";
import { createApi } from "./api/routes.js";
import { createMcpServer } from "./mcp/server.js";
import { authenticateAccessKey, checkKeySources } from "./auth/accessKeys.js";
import { recordMcpHandshake, type KeySource } from "./api/metrics.js";
import { safeLogValue, describeRequestHeaders, clientAddress } from "./mcp/requestLog.js";
import { SSEServerTransport } from "@modelcontextprotocol/sdk/server/sse.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { isInitializeRequest } from "@modelcontextprotocol/sdk/types.js";

/** An SSE session plus the identity of the key that opened it. */
interface McpSession {
  transport: SSEServerTransport;
  keyId: string | null;
  keyLabel: string;
}

/** A Streamable HTTP session plus the identity of the key that opened it. */
interface StreamableSession {
  transport: StreamableHTTPServerTransport;
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

  // ── MCP Server (Streamable HTTP + legacy SSE, over raw Node.js HTTP) ──

  const mcpPort = parseInt(process.env.MCP_PORT ?? "8080", 10);

  // Track active sessions for cleanup, one map per transport since a
  // session ID from one is meaningless to the other.
  const sessions = new Map<string, McpSession>();
  const streamableSessions = new Map<string, StreamableSession>();

  /**
   * Resolves the access key on a connection-opening request (SSE's GET /sse,
   * Streamable HTTP's session-less POST /mcp) and reports the outcome.
   * Once a session exists, its ID alone re-authenticates later requests —
   * see the /messages and /mcp session-lookup branches below.
   */
  async function authenticateEndpoint(
    req: http.IncomingMessage,
    url: URL,
    endpoint: string
  ): Promise<
    | { ok: true; keyId: string | null; label: string }
    | { ok: false; status: number; body: { error: string } }
  > {
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
        `[mcp] ${endpoint} headers ${describeRequestHeaders(req.headers, req.socket.remoteAddress)}`
      );
    }

    if (!allowKeyInQuery && keySource === "query") {
      console.warn(
        `[mcp] ${endpoint} denied: key supplied as ?key= but MCP_ALLOW_KEY_IN_QUERY is off`
      );
    }

    const auth = await authenticateAccessKey(pool, key, {
      legacyKey: mcpAccessKey,
    }).catch((err: unknown) => {
      // A key lookup that cannot run is not permission to skip it.
      console.error(
        `[mcp] ${endpoint} denied: access key lookup failed —`,
        err instanceof Error ? err.message : String(err)
      );
      return { ok: false as const, reason: "unavailable" as const };
    });

    recordMcpHandshake(keySource, auth.ok ? "ok" : auth.reason);

    if (!auth.ok) {
      console.warn(
        `[mcp] ${endpoint} denied (${auth.reason}) via=${keySource} addr=${addr} client="${client}"`
      );
      return {
        ok: false,
        status: auth.reason === "unavailable" ? 503 : 401,
        body: { error: auth.reason === "unavailable" ? "Unavailable" : "Unauthorized" },
      };
    }

    console.log(
      `[mcp] ${endpoint} authenticated (key: ${auth.label}${auth.keyId ? ` / ${auth.keyId}` : ""}) via=${keySource} addr=${addr} client="${client}"`
    );
    return { ok: true, keyId: auth.keyId, label: auth.label };
  }

  const mcpHttpServer = http.createServer(async (req, res) => {
    // CORS headers
    res.setHeader("Access-Control-Allow-Origin", "*");
    res.setHeader("Access-Control-Allow-Methods", "GET, POST, DELETE, OPTIONS");
    res.setHeader(
      "Access-Control-Allow-Headers",
      "Content-Type, x-brain-key, Mcp-Session-Id, Mcp-Protocol-Version"
    );
    res.setHeader("Access-Control-Expose-Headers", "Mcp-Session-Id");

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

    // ── Streamable HTTP — current spec, one endpoint for everything ──
    if (url.pathname === "/mcp") {
      const sessionId = req.headers["mcp-session-id"] as string | undefined;

      if (sessionId) {
        const session = streamableSessions.get(sessionId);
        if (!session) {
          res.writeHead(404, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ error: "Session not found" }));
          return;
        }
        await session.transport.handleRequest(req, res);
        return;
      }

      if (req.method !== "POST") {
        res.writeHead(400, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "Missing Mcp-Session-Id header" }));
        return;
      }

      // No session yet: this must be an initialize request. Read the body
      // up front — we need it to check that, and to authenticate — then
      // hand it to the transport pre-parsed so it doesn't re-read the stream.
      const chunks: Buffer[] = [];
      for await (const chunk of req) chunks.push(chunk as Buffer);
      const rawBody = Buffer.concat(chunks).toString("utf8");
      let parsedBody: unknown;
      try {
        parsedBody = rawBody.length > 0 ? JSON.parse(rawBody) : undefined;
      } catch {
        res.writeHead(400, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "Invalid JSON" }));
        return;
      }

      if (!isInitializeRequest(parsedBody)) {
        res.writeHead(400, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "No active session. Send an initialize request first." }));
        return;
      }

      const auth = await authenticateEndpoint(req, url, "/mcp");
      if (!auth.ok) {
        res.writeHead(auth.status, { "Content-Type": "application/json" });
        res.end(JSON.stringify(auth.body));
        return;
      }

      const transport = new StreamableHTTPServerTransport({
        sessionIdGenerator: () => randomUUID(),
        onsessioninitialized: (sid) => {
          streamableSessions.set(sid, { transport, keyId: auth.keyId, keyLabel: auth.label });
          console.log(`[mcp] Streamable session ${sid} connected (key: ${auth.label})`);
        },
      });
      transport.onclose = () => {
        if (transport.sessionId) {
          streamableSessions.delete(transport.sessionId);
          console.log(`[mcp] Streamable session ${transport.sessionId} closed`);
        }
      };

      const server = createMcpServer();
      await server.connect(transport);
      await transport.handleRequest(req, res, parsedBody);
      return;
    }

    // SSE endpoint — legacy clients connect here
    // Auth is checked here; /messages skips the key check because
    // having a valid sessionId proves the client already authenticated.
    if (url.pathname === "/sse" && req.method === "GET") {
      const auth = await authenticateEndpoint(req, url, "/sse");
      if (!auth.ok) {
        res.writeHead(auth.status, { "Content-Type": "application/json" });
        res.end(JSON.stringify(auth.body));
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
        `[mcp] SSE session ${sessionId} connected (key: ${auth.label}${auth.keyId ? ` / ${auth.keyId}` : ""})`
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
    console.log(`[mcp] MCP server listening on http://0.0.0.0:${mcpPort}`);
    console.log(`[mcp]   POST/GET/DELETE /mcp     — Streamable HTTP (current spec)`);
    console.log(`[mcp]   GET  /sse               — SSE connection (legacy spec)`);
    console.log(`[mcp]   POST /messages           — SSE's JSON-RPC calls (legacy spec)`);
    console.log(`[mcp]   GET  /health             — health check`);
    console.log("");
    console.log("[mcp] Connect AI clients to:");
    console.log(`[mcp]   http://<host>:${mcpPort}/mcp   header: x-brain-key: <KEY>   (preferred)`);
    console.log(`[mcp]   http://<host>:${mcpPort}/sse   header: x-brain-key: <KEY>   (older clients)`);
    if (allowKeyInQuery) {
      console.log(`[mcp]   ...?key=<KEY>   (header-less clients, either endpoint)`);
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
