import { parseTraceparent, type Span } from "@devlens/shared";
import {
  contextOf,
  endSpan,
  messageOf,
  safely,
  scheduleFlush,
  spanContext,
  startSpan,
  type ActiveSpan,
  type SpanContext,
} from "./context";
import { sourceFromStack } from "./stack";

/**
 * Wraps a Next.js route handler so each request becomes an `http` span.
 *
 * - Continues the browser's trace when the request has a valid `traceparent`
 *   header; otherwise starts a new trace (a malformed header is ignored).
 * - Runs the handler inside the span's AsyncLocalStorage context, so `span()`
 *   and Prisma calls made during this request become its children.
 * - Status (the plan's HTTP status policy): returned 5xx → `error`; returned
 *   4xx → `ok` (the app answered on purpose, e.g. a 409); a thrown exception →
 *   `error` with its message and source frame, then rethrown unchanged.
 * - Records only `method`, `path` (no query string) and `httpStatus`: never
 *   bodies, headers or cookies.
 * - Starts delivery after the response without awaiting it, so a slow or
 *   broken ingest endpoint never delays or fails the response.
 *
 * @example export const POST = withDevLens("POST /api/register", async (req) => { … });
 */
export function withDevLens<C>(
  name: string,
  handler: (req: Request, ctx: C) => Promise<Response>,
): (req: Request, ctx: C) => Promise<Response> {
  return async (req, ctx) => {
    let active: ActiveSpan | undefined;
    let attributes: Span["attributes"] = {};
    try {
      const incoming = parseTraceparent(req.headers.get("traceparent"));
      const parent: SpanContext | undefined = incoming ? { traceId: incoming.traceId, spanId: incoming.parentSpanId } : undefined;
      attributes = { method: req.method, path: new URL(req.url).pathname };
      active = startSpan(name, "http", parent);
    } catch {
      active = undefined; // capture failed: run the app untraced rather than break it
    }
    if (!active) return handler(req, ctx);
    const running = active;

    let res: Response;
    try {
      res = await spanContext.run(contextOf(running), () => handler(req, ctx));
    } catch (err) {
      safely(() =>
        endSpan(running, {
          status: "error",
          errorMessage: messageOf(err),
          source: err instanceof Error ? sourceFromStack(err.stack) : undefined,
          attributes,
        }),
      );
      safely(scheduleFlush);
      throw err;
    }
    safely(() =>
      endSpan(running, {
        status: res.status >= 500 ? "error" : "ok",
        attributes: { ...attributes, httpStatus: res.status },
      }),
    );
    safely(scheduleFlush);
    return res;
  };
}
