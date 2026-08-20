/**
 * Unit tests for src/mcp/requestLog.ts
 *
 * The security-relevant case is the first one: `x-brain-key` arrives on the same
 * request this diagnostic describes, so a regression here would write live access
 * keys into the log.
 */

import { describe, it, expect } from "vitest";

import { safeLogValue, describeRequestHeaders, clientAddress } from "../requestLog.js";

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

describe("clientAddress", () => {
  it("uses cf-connecting-ip when Cloudflare fronted the request", () => {
    expect(
      clientAddress({ "cf-connecting-ip": "203.0.113.9" }, "10.244.4.106")
    ).toBe("203.0.113.9");
  });

  // Cloudflare appends to x-forwarded-for, so its first element is caller-supplied.
  // Reading it would let anyone write an arbitrary address into the audit log.
  it("ignores x-forwarded-for entirely", () => {
    const out = clientAddress(
      { "x-forwarded-for": "1.2.3.4, 203.0.113.9" },
      "10.244.4.106"
    );

    expect(out).not.toContain("1.2.3.4");
    expect(out).toContain("10.244.4.106");
  });

  it("does not let a spoofed x-forwarded-for override Cloudflare", () => {
    expect(
      clientAddress(
        { "cf-connecting-ip": "203.0.113.9", "x-forwarded-for": "1.2.3.4, 203.0.113.9" },
        "10.244.4.106"
      )
    ).toBe("203.0.113.9");
  });

  it("falls back to the socket peer off the Cloudflare path", () => {
    expect(clientAddress({}, "100.64.0.7")).toBe("100.64.0.7 (direct)");
  });

  it("reports unknown when there is no address at all", () => {
    expect(clientAddress({}, undefined)).toBe("unknown");
  });

  it("strips control characters so an address cannot forge a log line", () => {
    expect(clientAddress({ "cf-connecting-ip": "1.2.3.4\nforged" }, undefined)).not.toContain(
      "\n"
    );
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
