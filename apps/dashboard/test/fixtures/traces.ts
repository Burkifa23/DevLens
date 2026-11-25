/**
 * Shared trace fixtures for the Task 9 graph and context tests.
 *
 * Members 1 and 4 own these together (AGENTS.md). Span names, kinds, attributes and HTTP
 * status semantics copy what the SDKs on `developer` actually emit:
 * - sdk-browser `track`: the root is named after the action, the fetch child is named
 *   "fetch <METHOD> <path>" with `{ method, path, httpStatus }`, and a non-2xx response
 *   flags `error` without inventing an errorMessage.
 * - sdk-node `withDevLens`: a returned 409 stays `ok` with `httpStatus: 409`.
 * - sdk-node `span`: `source` is the call site, meaning the line that called `span()` (here the
 *   route), recorded whether the function succeeds or throws.
 * - sdk-node `instrumentPrisma`: `source` is only recorded on error. It is the first app frame
 *   of the Prisma error's stack (skipping Node, node_modules and the SDK), meaning the line in
 *   the service that ran the query.
 * - Prisma errors are trimmed on every span to "<code>: <final reason line>" (Prisma 7 wording).
 * If an SDK changes one of these, update the fixture with Member 1.
 */
import type { StoredSpan } from "@devlens/shared";

const TRACE_ID = "4bf92f3577b34da6a3ce929d0e0e4736";
const T0 = Date.parse("2026-11-23T10:00:00.000Z");

/** Span id number n as 16 lowercase hex characters (never all zero, as W3C requires). */
const id = (n: number) => n.toString(16).padStart(16, "0");
/** ISO timestamp `ms` milliseconds after the trace started. */
const at = (ms: number) => new Date(T0 + ms).toISOString();

const DUPLICATE_EMAIL = "P2002: Unique constraint failed on the constraint: `DemoUser_email_key`";

/**
 * Duplicate-email registration, root first, as described in docs/architecture.md section 4:
 * browser click → fetch (409) → http (returned 409, so `ok`) → function (threw) → database (threw).
 * The database span has a captured source but no commitSha, so tests can add one.
 */
export const registrationTrace: StoredSpan[] = [
  {
    id: id(1), traceId: TRACE_ID, name: "Submit registration", kind: "browser",
    startTime: at(0), durationMs: 120, status: "error", attributes: {}, ingestSource: "browser-public",
  },
  {
    id: id(2), traceId: TRACE_ID, parentSpanId: id(1), name: "fetch POST /api/register", kind: "browser",
    startTime: at(5), durationMs: 110, status: "error",
    attributes: { method: "POST", path: "/api/register", httpStatus: 409 }, ingestSource: "browser-public",
  },
  {
    id: id(3), traceId: TRACE_ID, parentSpanId: id(2), name: "POST /api/register", kind: "http",
    startTime: at(15), durationMs: 90, status: "ok",
    attributes: { method: "POST", path: "/api/register", httpStatus: 409 }, ingestSource: "server-secret",
  },
  {
    id: id(4), traceId: TRACE_ID, parentSpanId: id(3), name: "RegistrationService.registerUser", kind: "function",
    startTime: at(20), durationMs: 70, status: "error", errorMessage: DUPLICATE_EMAIL,
    source: { file: "apps/demo-app/app/api/register/route.ts", line: 9 },
    attributes: {}, ingestSource: "server-secret",
  },
  {
    id: id(5), traceId: TRACE_ID, parentSpanId: id(4), name: "DemoUser.create", kind: "database",
    startTime: at(30), durationMs: 40, status: "error", errorMessage: DUPLICATE_EMAIL,
    source: { file: "apps/demo-app/services/registration.ts", line: 14 },
    attributes: { model: "DemoUser", operation: "create" }, ingestSource: "server-secret",
  },
];

/**
 * The request never reached the server (network or CORS failure): a browser-only trace whose
 * fetch span is the failure. It has the real exception message, but no source and no httpStatus.
 */
export const networkFailTrace: StoredSpan[] = [
  {
    id: id(11), traceId: TRACE_ID, name: "Submit registration", kind: "browser",
    startTime: at(0), durationMs: 30, status: "error", attributes: {}, ingestSource: "browser-public",
  },
  {
    id: id(12), traceId: TRACE_ID, parentSpanId: id(11), name: "fetch POST /api/register", kind: "browser",
    startTime: at(2), durationMs: 25, status: "error", errorMessage: "TypeError: Failed to fetch",
    attributes: { method: "POST", path: "/api/register" }, ingestSource: "browser-public",
  },
];

/**
 * The browser batch was lost (for example, the page closed): only the server spans arrived,
 * so the http span's parent (the fetch span) is missing and it must be drawn as an orphan root.
 */
export const serverOnlyTrace: StoredSpan[] = registrationTrace.slice(2);

/**
 * A successful registration: every span is `ok`, so there is no failure path. The function
 * span keeps its call-site source (recorded on success too); the database span has none,
 * because instrumentPrisma only records a source when the query throws.
 */
export const okTrace: StoredSpan[] = registrationTrace.map((span) => {
  const ok: StoredSpan = { ...span, status: "ok" };
  delete ok.errorMessage;
  if (span.kind !== "function") delete ok.source;
  if (typeof span.attributes.httpStatus === "number") ok.attributes = { ...span.attributes, httpStatus: 201 };
  return ok;
});

/**
 * Generates a large trace of `n` spans shaped like a tree in which each span has up to 8
 * children: span i's parent is span floor((i - 1) / 8). With `failingLeaf`, the last span
 * (a leaf several levels deep) is the only error, so every other subtree can collapse.
 */
export function syntheticTrace(n: number, opts: { failingLeaf: boolean }): StoredSpan[] {
  return Array.from({ length: n }, (_, i) => ({
    id: id(1000 + i),
    traceId: TRACE_ID,
    ...(i > 0 && { parentSpanId: id(1000 + Math.floor((i - 1) / 8)) }),
    name: `step ${i}`,
    kind: "function" as const,
    startTime: at(i),
    durationMs: 1,
    status: opts.failingLeaf && i === n - 1 ? ("error" as const) : ("ok" as const),
    attributes: {},
    ingestSource: "server-secret" as const,
  }));
}

/**
 * Malformed client claims: A's parent is B and B's parent is A, plus a span that is its own
 * parent. Traversals must stop instead of looping forever.
 */
export const cyclicTrace: StoredSpan[] = [
  {
    id: id(21), traceId: TRACE_ID, parentSpanId: id(22), name: "A", kind: "browser",
    startTime: at(0), durationMs: 10, status: "error", attributes: {}, ingestSource: "browser-public",
  },
  {
    id: id(22), traceId: TRACE_ID, parentSpanId: id(21), name: "B", kind: "browser",
    startTime: at(1), durationMs: 10, status: "ok", attributes: {}, ingestSource: "browser-public",
  },
  {
    id: id(23), traceId: TRACE_ID, parentSpanId: id(23), name: "Self", kind: "browser",
    startTime: at(2), durationMs: 10, status: "ok", attributes: {}, ingestSource: "browser-public",
  },
];
