/**
 * W3C Trace Context helpers (https://www.w3.org/TR/trace-context/).
 *
 * The `traceparent` header is how a browser request tells the server which
 * trace it belongs to: `00-<32 hex traceId>-<16 hex parent span id>-01`.
 * Using the standard (rather than a custom header) is what OpenTelemetry does,
 * so DevLens traces could later be exported to Grafana/Jaeger.
 */

/** Random lowercase hex string of `bytes` bytes. Works in browsers and Node 19+. */
function randomHex(bytes: number): string {
  const buf = crypto.getRandomValues(new Uint8Array(bytes));
  return Array.from(buf, (b) => b.toString(16).padStart(2, "0")).join("");
  // ponytail: an all-zero result (invalid per W3C) has probability 2^-64 or less; not worth a retry loop.
}

/** New 32-hex-char trace id (16 random bytes). */
export const newTraceId = (): string => randomHex(16);

/** New 16-hex-char span id (8 random bytes). */
export const newSpanId = (): string => randomHex(8);

/**
 * Builds a version-00 `traceparent` value. Flags are always `01` (sampled):
 * DevLens records every span it creates.
 */
export function formatTraceparent(traceId: string, spanId: string): string {
  return `00-${traceId}-${spanId}-01`;
}

const TRACEPARENT = /^00-([0-9a-f]{32})-([0-9a-f]{16})-[0-9a-f]{2}$/;
const ALL_ZERO = /^0+$/;

/**
 * Reads an incoming `traceparent` header. Returns `null` for anything that is
 * not a valid version-00 value, so the caller starts a fresh trace instead of
 * joining a malformed one. Uppercase hex and all-zero ids are invalid per W3C.
 *
 * Security note: this header comes from the client and can be forged, so a
 * trace id is a correlation hint, never proof of who sent a request.
 */
export function parseTraceparent(header: string | null): { traceId: string; parentSpanId: string } | null {
  const match = header?.trim().match(TRACEPARENT);
  if (!match) return null;
  const [, traceId, parentSpanId] = match as [string, string, string];
  if (ALL_ZERO.test(traceId) || ALL_ZERO.test(parentSpanId)) return null;
  return { traceId, parentSpanId };
}
