/**
 * Unit tests for src/mcp/requestLog.ts
 *
 * The security-relevant case is the first one: `x-brain-key` arrives on the same
 * request this diagnostic describes, so a regression here would write live access
 * keys into the log.
 */

import { describe, it, expect } from "vitest";

import { safeLogValue, describeRequestHeaders } from "../requestLog.js";

const KEY = "a".repeat(64);

describe("describeRequestHeaders", () => {
  it("never prints the access key, only its header name", () => {
    const out = describeRequestHeaders(
      { "x-brain-key": KEY, "user-agent": "curl/8.21.0" },
      "10.244.0.1"
    );

    expect(out).not.toContain(KEY);
    expect(out).toContain("x-brain-key");
    expect(out).toContain("names=[");
  });

  it("never prints other credential-bearing headers", () => {
    const out = describeRequestHeaders(
      { authorization: "Bearer secret-token", cookie: "session=secret-cookie" },
      undefined
    );

    expect(out).not.toContain("secret-token");
    expect(out).not.toContain("secret-cookie");
    expect(out).toContain("authorization");
    expect(out).toContain("cookie");
  });

  it("prints the value of address-carrying headers", () => {
    const out = describeRequestHeaders(
      {
        "x-forwarded-for": "203.0.113.9, 172.71.0.1",
        "cf-connecting-ip": "203.0.113.9",
        "x-brain-key": KEY,
      },
      "10.244.0.1"
    );

    expect(out).toContain("x-forwarded-for=203.0.113.9, 172.71.0.1");
    expect(out).toContain("cf-connecting-ip=203.0.113.9");
    expect(out).toContain("remoteAddress=10.244.0.1");
    expect(out).not.toContain(KEY);
  });

  it("omits address headers that are absent rather than printing undefined", () => {
    const out = describeRequestHeaders({ "user-agent": "node" }, "10.0.0.1");

    expect(out).not.toContain("undefined");
    expect(out).not.toContain("x-forwarded-for");
  });

  it("reports a missing remoteAddress without breaking the line", () => {
    expect(describeRequestHeaders({}, undefined)).toContain("remoteAddress=?");
  });

  it("strips control characters so a header cannot forge a log line", () => {
    const out = describeRequestHeaders(
      { "x-forwarded-for": "1.2.3.4\n[mcp] SSE session forged connected" },
      "10.0.0.1"
    );

    expect(out).not.toContain("\n");
  });
});

describe("safeLogValue", () => {
  it("replaces control characters", () => {
    expect(safeLogValue("a\nb\rc")).toBe("a b c");
  });

  it("truncates to 80 characters", () => {
    expect(safeLogValue("x".repeat(200))).toHaveLength(80);
  });

  it("reports absent values as unknown", () => {
    expect(safeLogValue(undefined)).toBe("unknown");
    expect(safeLogValue("")).toBe("unknown");
  });
});
