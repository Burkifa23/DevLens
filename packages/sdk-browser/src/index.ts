/**
 * `@devlens/sdk-browser` — records user actions, their `fetch` calls and
 * uncaught errors as `browser` spans, and sends them to the DevLens dashboard
 * with the public key. See packages/sdk-browser/README.md.
 */
import { formatTraceparent, newSpanId, newTraceId, type Span } from "@devlens/shared";
import { createExporter, type BrowserExporter } from "./exporter";

export { createExporter, type BrowserExporter, type Exporter, type ExporterOptions } from "./exporter";

/** Options for {@link init}. */
export interface InitOptions {
  /** Full URL of the dashboard's `POST /api/ingest`. */
  endpoint: string;
  /** The project's public `pk_` key. It can only submit `browser` spans from an allowed Origin. */
  publicKey: string;
  /**
   * Exact cross-origin application API origins (e.g. `"https://api.example.com"`)
   * that may receive the `traceparent` header. Same-origin requests always do.
   * Each listed API must allow `traceparent` in its CORS preflight. This list is
   * not the dashboard's ingest allowed-origins setting.
   */
  traceOrigins?: string[];
}

type FetchFn = typeof window.fetch;

/** A span that has started but not ended yet. Browser spans are always `kind: "browser"`. */
type ActiveSpan = { traceId: string; id: string; parentSpanId?: string; name: string; startTime: string; started: number };

let exporter: BrowserExporter | undefined;
let traceOrigins = new Set<string>();
let listening = false;

/**
 * Sets up the browser SDK. Call once when the app loads (e.g. in a client
 * component). Also listens for uncaught errors and unhandled promise
 * rejections, recording each as a standalone root span named
 * `"uncaught error"` — not linked to any action, because the browser cannot
 * tell which action (if any) caused it. On `pagehide` it sends one last
 * batch of queued spans (best effort: closing a tab can still lose spans).
 */
export function init(opts: InitOptions): void {
  exporter = createExporter({ endpoint: opts.endpoint, key: opts.publicKey });
  traceOrigins = new Set();
  for (const origin of opts.traceOrigins ?? []) {
    try {
      traceOrigins.add(new URL(origin).origin); // normalizes "https://API.test/" to "https://api.test"
    } catch {
      // An invalid entry approves nothing.
    }
  }
  if (listening || typeof window === "undefined") return;
  listening = true; // init() may run again (e.g. React strict mode); never double-count errors or beacons
  // Always the *current* exporter, so a re-initialised SDK still sends at most one batch.
  window.addEventListener("pagehide", () => safely(() => exporter?.sendOnPageHide()));
  window.addEventListener("error", (event) =>
    safely(() => recordUncaught(event.error instanceof Error ? event.error.message : event.message)),
  );
  window.addEventListener("unhandledrejection", (event) => safely(() => recordUncaught(messageOf(event.reason))));
}

/**
 * Records one user action as a root `browser` span and hands `fn` a traced
 * `fetch` for the requests that action makes.
 *
 * Each call to the supplied `fetch` becomes a child span named
 * `"fetch <METHOD> <path>"` (no query string) and, for same-origin or
 * `traceOrigins` destinations, sends `traceparent` with that child's id so the
 * server's spans join this trace. The context travels with this particular
 * `fetch` function, not in a global, so two overlapping actions can never
 * mix up their spans.
 *
 * Behaves exactly like the app's own code: returns what `fn` returns, rejects
 * with what it throws, and the supplied `fetch` resolves/rejects as `fetch`
 * does. The root is `error` if `fn` throws or any of its requests failed.
 *
 * @example await track("Submit registration", (fetch) => fetch("/api/register", { method: "POST", body }))
 */
export async function track<T>(name: string, fn: (fetch: FetchFn) => Promise<T>): Promise<T> {
  let root: ActiveSpan | undefined;
  try {
    if (exporter) root = startSpan(name, undefined);
  } catch {
    root = undefined;
  }
  // Not initialised (or capture failed): plain pass-through, no header, nothing recorded.
  if (!root) return fn((input, init) => globalThis.fetch(input, init));
  const running = root;

  let childFailed = false;
  const tracedFetch: FetchFn = (input, init) =>
    fetchAsChild(running, input, init, () => {
      childFailed = true;
    });

  let value: T;
  try {
    value = await fn(tracedFetch);
  } catch (err) {
    safely(() => endSpan(running, { status: "error", errorMessage: messageOf(err) }));
    throw err;
  }
  // A failed child flags the root, but no exception message is invented for it.
  safely(() => endSpan(running, { status: childFailed ? "error" : "ok" }));
  return value;
}

/** One request made through a tracked action's `fetch`. */
async function fetchAsChild(
  parent: ActiveSpan,
  input: RequestInfo | URL,
  init: RequestInit | undefined,
  onFailure: () => void,
): Promise<Response> {
  let child: ActiveSpan | undefined;
  let attributes: Span["attributes"] = {};
  let sendInit = init;
  try {
    const request = input instanceof Request ? input : undefined;
    const url = new URL(request ? request.url : String(input), location.href);
    const method = (init?.method ?? request?.method ?? "GET").toUpperCase();
    attributes = { method, path: url.pathname };
    child = startSpan(`fetch ${method} ${url.pathname}`, parent);
    if (shouldPropagate(url, init?.mode ?? request?.mode)) {
      // init.headers replace a Request's own headers in fetch, so start from
      // whichever fetch would have used, then add ours.
      const headers = new Headers(init?.headers ?? request?.headers);
      headers.set("traceparent", formatTraceparent(child.traceId, child.id));
      sendInit = { ...init, headers };
    }
  } catch {
    child = undefined;
    sendInit = init; // capture failed: send the request exactly as the app wrote it
  }
  if (!child) return globalThis.fetch(input, sendInit);
  const running = child;

  let res: Response;
  try {
    res = await globalThis.fetch(input, sendInit);
  } catch (err) {
    // The request never got a response (offline, DNS, blocked CORS preflight…):
    // this is real exception evidence. Rethrown unchanged, never retried.
    onFailure();
    safely(() => endSpan(running, { status: "error", errorMessage: messageOf(err), attributes }));
    throw err;
  }
  safely(() => {
    // 4xx/5xx are flagged as unsuccessful, but the response is not an exception:
    // no errorMessage is invented, and fetch still resolves.
    if (!res.ok) onFailure();
    endSpan(running, { status: res.ok ? "ok" : "error", attributes: { ...attributes, httpStatus: res.status } });
  });
  return res;
}

/**
 * Same-origin requests and approved `traceOrigins` get the header. Never for
 * `no-cors` (the browser would strip or reject it) and never for other
 * origins: `traceparent` is not CORS-safelisted, so it would trigger a
 * preflight that an unprepared API rejects, and it would leak trace ids to
 * third parties.
 */
function shouldPropagate(url: URL, mode: RequestMode | undefined): boolean {
  if (mode === "no-cors") return false;
  return url.origin === location.origin || traceOrigins.has(url.origin);
}

function recordUncaught(message: string): void {
  if (!exporter) return;
  endSpan(startSpan("uncaught error", undefined), { status: "error", errorMessage: message });
}

function startSpan(name: string, parent: ActiveSpan | undefined): ActiveSpan {
  return {
    traceId: parent?.traceId ?? newTraceId(),
    id: newSpanId(),
    ...(parent && { parentSpanId: parent.id }),
    name,
    startTime: new Date().toISOString(),
    started: performance.now(),
  };
}

function endSpan(
  active: ActiveSpan,
  outcome: { status: Span["status"]; errorMessage?: string; attributes?: Span["attributes"] },
): void {
  const { started, ...ids } = active;
  exporter?.push({
    ...ids,
    kind: "browser", // the public key may only submit browser spans
    durationMs: Math.max(0, Math.round(performance.now() - started)),
    status: outcome.status,
    ...(outcome.errorMessage !== undefined && { errorMessage: outcome.errorMessage }),
    attributes: outcome.attributes ?? {},
  });
}

const messageOf = (err: unknown): string => (err instanceof Error ? err.message : String(err));

/** Telemetry code must never change what the app returns or throws. */
function safely(fn: () => void): void {
  try {
    fn();
  } catch {
    // Deliberately ignored: see above.
  }
}
