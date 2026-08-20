/**
 * Prometheus metrics exposition for the REST API.
 *
 * Hand-rolled rather than using prom-client: AGENTS.md asks for no new direct
 * dependencies without justification, and counters plus gauges in the text
 * format are a small amount of well-specified code.
 *
 * Deliberately does NOT report thought counts. `getThoughtStats` runs several
 * GROUP BY aggregates plus a `jsonb_array_elements_text` expansion over the
 * whole table, which is fine for an on-demand /stats call and far too expensive
 * to repeat on every scrape. Everything below is read from memory.
 */

import type pg from "pg";

type Labels = Record<string, string>;

const PROCESS_START_MS = Date.now();

/**
 * Keyed by route PATTERN, never the raw path. `/memories/:id` recorded
 * literally would mint a new time series per UUID, and unbounded label
 * cardinality is the standard way to take Prometheus down.
 */
const requestTotals = new Map<string, number>();
const durationTotals = new Map<string, number>();

/**
 * MCP `/sse` handshakes by how the key arrived. This exists to answer one
 * question with evidence rather than assumption: does anything still send the
 * key as `?key=`, so can MCP_ALLOW_KEY_IN_QUERY be turned off?
 */
const mcpHandshakeTotals = new Map<string, number>();

export type KeySource = "header" | "query" | "none";

const SEP = "\u0000";

export function recordRequest(
  method: string,
  route: string,
  status: number,
  durationSeconds: number
): void {
  const key = [method, route, String(status)].join(SEP);
  requestTotals.set(key, (requestTotals.get(key) ?? 0) + 1);
  durationTotals.set(key, (durationTotals.get(key) ?? 0) + durationSeconds);
}

export function recordMcpHandshake(source: KeySource, outcome: string): void {
  const key = [source, outcome].join(SEP);
  mcpHandshakeTotals.set(key, (mcpHandshakeTotals.get(key) ?? 0) + 1);
}

/** Test-only: clears accumulated counters so assertions start from zero. */
export function resetMetrics(): void {
  requestTotals.clear();
  durationTotals.clear();
  mcpHandshakeTotals.clear();
}

function escapeLabelValue(value: string): string {
  return value.replace(/\\/g, "\\\\").replace(/"/g, '\\"').replace(/\n/g, "\\n");
}

function renderSample(name: string, labels: Labels, value: number): string {
  const pairs = Object.entries(labels)
    .map(([k, v]) => `${k}="${escapeLabelValue(v)}"`)
    .join(",");
  // One non-finite value makes the whole response unparseable and takes every
  // other metric down with it, so it is worth clamping here rather than
  // trusting each caller.
  const safe = Number.isFinite(value) ? value : 0;
  return pairs.length > 0 ? `${name}{${pairs}} ${safe}\n` : `${name} ${safe}\n`;
}

function header(name: string, help: string, type: "counter" | "gauge"): string {
  return `# HELP ${name} ${help}\n# TYPE ${name} ${type}\n`;
}

export function renderMetrics(pool: pg.Pool): string {
  const memory = process.memoryUsage();
  let out = "";

  out += header("openbrain_build_info", "Static labels describing this process.", "gauge");
  out += renderSample("openbrain_build_info", { service: "open-brain-api" }, 1);

  out += header("openbrain_uptime_seconds", "Seconds since the API process started.", "gauge");
  out += renderSample("openbrain_uptime_seconds", {}, (Date.now() - PROCESS_START_MS) / 1000);

  // Pool saturation is the earliest warning of DB trouble, and pg exposes it in
  // memory, so it costs nothing to report.
  out += header("openbrain_db_pool_connections", "Postgres pool connections by state.", "gauge");
  out += renderSample("openbrain_db_pool_connections", { state: "total" }, pool.totalCount);
  out += renderSample("openbrain_db_pool_connections", { state: "idle" }, pool.idleCount);
  out += renderSample("openbrain_db_pool_connections", { state: "waiting" }, pool.waitingCount);

  out += header("openbrain_nodejs_heap_used_bytes", "V8 heap in use.", "gauge");
  out += renderSample("openbrain_nodejs_heap_used_bytes", {}, memory.heapUsed);

  out += header("openbrain_nodejs_resident_memory_bytes", "Resident set size.", "gauge");
  out += renderSample("openbrain_nodejs_resident_memory_bytes", {}, memory.rss);

  out += header("openbrain_http_requests_total", "HTTP requests handled.", "counter");
  for (const [key, count] of requestTotals) {
    const [method, route, status] = key.split(SEP);
    out += renderSample(
      "openbrain_http_requests_total",
      { method: method ?? "", route: route ?? "", status: status ?? "" },
      count
    );
  }

  // Sum plus the count above gives average latency. A full histogram would need
  // bucket configuration that nothing has asked for yet.
  out += header(
    "openbrain_http_request_duration_seconds_sum",
    "Cumulative request duration.",
    "counter"
  );
  for (const [key, seconds] of durationTotals) {
    const [method, route, status] = key.split(SEP);
    out += renderSample(
      "openbrain_http_request_duration_seconds_sum",
      { method: method ?? "", route: route ?? "", status: status ?? "" },
      seconds
    );
  }

  out += header(
    "openbrain_mcp_handshakes_total",
    "MCP /sse handshakes by how the access key was supplied.",
    "counter"
  );
  for (const [key, count] of mcpHandshakeTotals) {
    const [source, outcome] = key.split(SEP);
    out += renderSample(
      "openbrain_mcp_handshakes_total",
      { source: source ?? "", outcome: outcome ?? "" },
      count
    );
  }

  return out;
}
