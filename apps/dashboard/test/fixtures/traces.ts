/**
 * Shared trace fixtures for the Task 9 graph and context tests.
 *
 * WAITING ON TASK 1: these need the `StoredSpan` type from @devlens/shared. Members 1 and 4
 * own them together (AGENTS.md), so check the span names, parents and HTTP status semantics
 * with Member 1 before filling them in. Until then each export is an empty placeholder, and
 * only skipped tests use them.
 *
 * Planned content (from the plan's tests and the architecture walkthrough, section 4):
 *
 * - `registrationTrace`: a duplicate-email registration, 5 spans in one chain, root first:
 *     1. "Submit registration"              kind browser,  status error, ingestSource browser-public
 *     2. "fetch POST /api/register"         kind browser,  status error, httpStatus 409, browser-public
 *     3. "POST /api/register"               kind http,     status ok,    httpStatus 409, server-secret
 *     4. "RegistrationService.registerUser" kind function, status error, server-secret
 *     5. "DemoUser.create"                  kind database, status error, server-secret,
 *        source { file: "apps/demo-app/services/registration.ts", line: 14 }
 *   Spans 1–2 have no exception message or source: a 409 response is not an exception.
 *   Span 5 has NO commitSha, so the test can add one to check source links.
 *   startTimes increase down the chain, so the waterfall depths come out as [0, 1, 2, 3, 4].
 *
 * - `networkFailTrace`: the request never reached the server. There are only 2 browser
 *   spans, and the fetch span ("fetch POST /api/register") is the deepest error. It has an
 *   errorMessage but no source.
 *
 * - `serverOnlyTrace`: spans 3–5 of the registration trace. The browser batch was lost, so
 *   the http span's parentSpanId points at a span that is not in the set (an orphan root).
 *
 * - `okTrace`: a successful registration. Every status is ok, so the failure path is empty.
 *
 * - `syntheticTrace(n, { failingLeaf })`: n spans arranged as a wide tree (a root with
 *   several children, each with its own children, so >50 spans have successful subtrees to
 *   collapse). With `failingLeaf`, one deep leaf is the only error.
 */
import type { StoredSpan } from "@devlens/shared";

/** Duplicate-email registration: browser → http → function → database (fails). TODO(Task 1). */
export const registrationTrace: StoredSpan[] = [];

/** Network/CORS failure: browser-only trace ending at the failed fetch. TODO(Task 1). */
export const networkFailTrace: StoredSpan[] = [];

/** Server spans whose browser parent never arrived (orphan root). TODO(Task 1). */
export const serverOnlyTrace: StoredSpan[] = [];

/** Successful registration with no error anywhere. TODO(Task 1). */
export const okTrace: StoredSpan[] = [];

/** Generates a large tree of `n` spans for the collapse/performance test. TODO(Task 1). */
export function syntheticTrace(n: number, opts: { failingLeaf: boolean }): StoredSpan[] {
  void n;
  void opts;
  throw new Error("syntheticTrace: waiting on the Task 1 StoredSpan contract");
}
