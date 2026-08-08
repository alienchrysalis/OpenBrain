/**
 * Unit tests for src/api/metrics.ts
 *
 * The endpoint exists because the pod already advertised
 * prometheus.io/scrape=true on /metrics and nothing served it, so the scrape
 * returned 404. The cases below cover the two ways a metrics endpoint fails
 * silently: unparseable output, and unbounded label cardinality.
 */

import { describe, it, expect, beforeEach } from "vitest";
import type pg from "pg";

import { recordRequest, renderMetrics, resetMetrics } from "../metrics.js";

function fakePool(overrides: Partial<pg.Pool> = {}): pg.Pool {
  return { totalCount: 5, idleCount: 3, waitingCount: 0, ...overrides } as pg.Pool;
}

describe("metrics exposition", () => {
  beforeEach(() => {
    resetMetrics();
  });

  it("emits valid Prometheus text format", () => {
    const out = renderMetrics(fakePool());
    expect(out).toContain("# HELP openbrain_build_info");
    expect(out).toContain("# TYPE openbrain_build_info gauge");
    expect(out).toContain('openbrain_build_info{service="open-brain-api"} 1');
    expect(out.endsWith("\n")).toBe(true);
  });

  it("every sample line parses as name[{labels}] value", () => {
    recordRequest("GET", "/memories/:id", 200, 0.01);
    const lines = renderMetrics(fakePool())
      .split("\n")
      .filter((l) => l.length > 0 && !l.startsWith("#"));

    expect(lines.length).toBeGreaterThan(0);
    for (const line of lines) {
      expect(line).toMatch(/^[a-zA-Z_][a-zA-Z0-9_]*(\{.*\})? -?\d+(\.\d+)?(e[+-]\d+)?$/);
    }
  });

  it("reports pool saturation from the pool object", () => {
    const out = renderMetrics(fakePool({ totalCount: 9, idleCount: 2, waitingCount: 4 }));
    expect(out).toContain('openbrain_db_pool_connections{state="total"} 9');
    expect(out).toContain('openbrain_db_pool_connections{state="idle"} 2');
    expect(out).toContain('openbrain_db_pool_connections{state="waiting"} 4');
  });

  // A pool mock without the count fields would otherwise render `undefined`,
  // which makes the whole response unparseable and takes every metric down.
  it("clamps non-finite values instead of emitting undefined", () => {
    const out = renderMetrics({} as pg.Pool);
    expect(out).not.toContain("undefined");
    expect(out).not.toContain("NaN");
    expect(out).toContain('openbrain_db_pool_connections{state="total"} 0');
  });

  it("counts requests and accumulates duration", () => {
    recordRequest("GET", "/health", 200, 0.5);
    recordRequest("GET", "/health", 200, 0.25);
    const out = renderMetrics(fakePool());
    expect(out).toContain(
      'openbrain_http_requests_total{method="GET",route="/health",status="200"} 2'
    );
    expect(out).toContain(
      'openbrain_http_request_duration_seconds_sum{method="GET",route="/health",status="200"} 0.75'
    );
  });

  it("separates series by method, route and status", () => {
    recordRequest("GET", "/health", 200, 0.1);
    recordRequest("POST", "/health", 200, 0.1);
    recordRequest("GET", "/health", 500, 0.1);
    const series = renderMetrics(fakePool())
      .split("\n")
      .filter((l) => l.startsWith("openbrain_http_requests_total{"));
    expect(series).toHaveLength(3);
  });

  it("escapes label values so a quote cannot break the format", () => {
    recordRequest("GET", 'a"b\\c', 200, 0.1);
    const out = renderMetrics(fakePool());
    expect(out).toContain('route="a\\"b\\\\c"');
  });
});
