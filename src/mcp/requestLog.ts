/**
 * Log-safe formatting for MCP request metadata.
 *
 * Split out of index.ts so it can be tested: index.ts calls main() at module
 * scope, so importing it would start a server.
 */

/** User-Agent is caller-controlled, and a newline in a log line forges a record. */
export function safeLogValue(value: string | undefined): string {
  if (!value) return "unknown";
  return value.replace(/[\p{Cc}\p{Cf}]/gu, " ").slice(0, 80);
}

/**
 * Headers whose values may be logged. Everything else is reported by name only —
 * `x-brain-key` arrives on this request, and a diagnostic that printed every header
 * would write the access key into the log it exists to secure.
 */
export const LOGGABLE_ADDRESS_HEADERS = [
  "x-forwarded-for",
  "x-real-ip",
  "cf-connecting-ip",
  "true-client-ip",
  "forwarded",
];

/**
 * Answers one question: does a real client address survive
 * Cloudflare → Tailscale Funnel → pod? See issue #18.
 */
export function describeRequestHeaders(
  headers: NodeJS.Dict<string | string[]>,
  remoteAddress: string | undefined
): string {
  const names = Object.keys(headers).sort().join(",");
  const values = LOGGABLE_ADDRESS_HEADERS.filter((h) => headers[h] !== undefined)
    .map((h) => `${h}=${safeLogValue(String(headers[h]))}`)
    .join(" ");
  return `names=[${names}] ${values} remoteAddress=${remoteAddress ?? "?"}`;
}
