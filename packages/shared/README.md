# @devlens/shared

The trace contract that every other DevLens package agrees on. The browser SDK, the Node SDK, the ingest endpoint and the explorer all import their types and rules from here, so they cannot drift apart.

## How it works

1. **The span shape** (`span.ts`). A span is one timed operation: a click, a fetch, a server request, a function call or a database query. `SpanSchema` (zod) checks a span at runtime and `Span` is its TypeScript type. The schemas are *strict*: unknown fields are rejected, which stops a client from sending its own `ingestSource`. Only the server sets that field, based on which key it verified, and it lives on `StoredSpan`.
2. **Ids and the `traceparent` header** (`traceparent.ts`). `newTraceId()` and `newSpanId()` make random lowercase hex ids with `crypto.getRandomValues`, which works in both the browser and Node. The browser SDK sends `formatTraceparent(traceId, spanId)` on each fetch; the Node SDK reads it with `parseTraceparent(header)` so that server spans join the browser's trace. Anything malformed returns `null`, and the server then starts a fresh trace.
3. **The sanitizer** (`sanitize.ts`). `sanitizeSpan(span)` runs on the server before storage. It keeps only six allowlisted attributes (`method`, `path`, `httpStatus`, `model`, `operation`, `commitSha`), strips the query string and fragment from `path`, redacts emails, bearer tokens and `password=…`-style pairs, cuts strings to 500 characters, and drops any `source` location that is not a safe repo-relative path. It returns a new object and never modifies its input.

## Key files

| Path | Role |
|---|---|
| `src/span.ts` | `SpanSchema`, `IngestBatchSchema`, `Span`, `StoredSpan`, `SpanKind`, `SpanStatus` |
| `src/traceparent.ts` | `newTraceId`, `newSpanId`, `formatTraceparent`, `parseTraceparent` |
| `src/sanitize.ts` | `sanitizeSpan` |
| `src/index.ts` | Public exports of the package |
| `src/*.test.ts` | Vitest tests; `test-fixtures.ts` holds the sample span they share |

Run the tests with `pnpm --filter @devlens/shared test`.

## Viva questions

- **What does `00-<traceId>-<spanId>-01` mean?** Version `00` of the W3C Trace Context header: the 32-hex trace id, the 16-hex id of the span that made the request (the server span's parent), and flags `01` meaning "sampled". All-zero ids and uppercase hex are invalid.
- **Why are the schemas strict?** So a client cannot add fields we never planned for. In particular, a browser cannot claim `ingestSource: "server-secret"`; provenance comes only from the key the server verified.
- **Why an attribute allowlist instead of a blocklist?** A blocklist only removes the sensitive fields someone thought of; an allowlist cannot leak a new field like `requestBody`, because unknown keys are always dropped.
- **Why sanitize on the server and not in the SDK?** The SDK runs on machines we don't control and could be modified. The ingest endpoint is the trust boundary, so that's where sanitizing must happen. SDKs may sanitize too, but the server can't rely on it.
- **Does redaction guarantee no personal data is stored?** No. Free-text redaction is best effort. That's why SDK callers must use static span names and safe messages, and why database spans never store query arguments.
- **Why reject absolute source paths?** They reveal the server's folder layout (`C:\Users\…`, `/home/…`), and `..` or URL schemes could become unsafe links in the explorer. Only repo-relative paths such as `apps/demo-app/services/registration.ts` are kept.
