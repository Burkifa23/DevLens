import type { Span } from "./span";

/**
 * The only attributes DevLens keeps. Anything else (request bodies, headers,
 * custom payloads) is dropped, because an allowlist cannot leak a field nobody
 * thought of — a blocklist can.
 */
const ALLOWED_ATTRIBUTES = new Set(["method", "path", "httpStatus", "model", "operation", "commitSha"]);

const MAX_STRING = 500;

// Best-effort free-text redaction. It cannot catch every piece of personal
// data, so SDK callers must still use static span names and safe messages.
const EMAIL = /[^\s@()<>"'`]+@[^\s@()<>"'`]+\.[^\s@()<>"'`]+/g;
const BEARER = /\bBearer\s+\S+/gi;
// "password=hunter2", "session: abc" -> keep the key, hide the value.
const SENSITIVE_PAIR = /(\b\w*(?:pass|secret|token|auth|cookie|session|email|card)\w*\s*[:=]\s*)[^\s,;&]+/gi;

function redact(text: string): string {
  return text
    .replace(EMAIL, "[email]")
    .replace(BEARER, "Bearer [redacted]")
    .replace(SENSITIVE_PAIR, "$1[redacted]")
    .slice(0, MAX_STRING);
}

/** Keeps only the path of a URL: no origin, userinfo, query string or fragment (where tokens hide). */
function stripUrl(value: string): string {
  try {
    return new URL(value).pathname; // absolute URL, e.g. https://user:pw@host/a?b
  } catch {
    return value.split(/[?#]/, 1)[0] ?? ""; // relative path, e.g. /a?b#c
  }
}

/**
 * A source file must be repo-relative: no absolute paths (which reveal the
 * server's folders), no `..` traversal, no URL schemes, no control characters.
 */
function isSafeSourceFile(file: string): boolean {
  return (
    !file.startsWith("/") &&
    !file.includes("\\") &&
    !/^[a-z][a-z0-9+.-]*:/i.test(file) && // C:, file:, http: ...
    !file.split("/").includes("..") &&
    // eslint-disable-next-line no-control-regex -- matching control characters is the point
    !/[\u0000-\u001f\u007f]/.test(file)
  );
}

/**
 * Removes sensitive or unsafe data from a span before it is stored.
 *
 * Runs on the server at the ingest trust boundary (Task 4), so a modified SDK
 * cannot skip it. Generic so that a `StoredSpan` keeps its server-derived
 * `ingestSource`. Returns a new object; the input is not modified.
 *
 * - attributes: allowlist only; `path` loses query/fragment/origin; strings redacted
 * - name, errorMessage: emails, bearer tokens and `secret=value` pairs redacted; max 500 chars
 * - source: dropped unless it is a safe repo-relative path with a positive line
 */
export function sanitizeSpan<T extends Span>(span: T): T {
  const attributes: Span["attributes"] = {};
  for (const [key, value] of Object.entries(span.attributes)) {
    if (!ALLOWED_ATTRIBUTES.has(key)) continue;
    attributes[key] = typeof value === "string" ? redact(key === "path" ? stripUrl(value) : value) : value;
  }

  const { source, errorMessage, ...rest } = span;
  const safeSource =
    source && Number.isInteger(source.line) && source.line > 0 && isSafeSourceFile(source.file) ? source : undefined;

  return {
    ...rest,
    name: redact(span.name),
    attributes,
    ...(errorMessage !== undefined && { errorMessage: redact(errorMessage) }),
    ...(safeSource && { source: { file: safeSource.file, line: safeSource.line } }),
  } as T;
}
