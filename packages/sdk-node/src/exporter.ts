import { sanitizeSpan, type Span } from "@devlens/shared";

/** Where and how an exporter delivers spans. `configure()` maps `secretKey` to `key`. */
export interface ExporterOptions {
  /** Full URL of the dashboard's `POST /api/ingest`. */
  endpoint: string;
  /** Project key sent in the batch envelope (the secret `sk_` key on the server). */
  key: string;
  /** Injected for tests; defaults to the global `fetch` at send time. */
  fetch?: typeof fetch;
}

/** A bounded span queue that delivers batches to the ingest endpoint. See {@link createExporter}. */
export interface Exporter {
  /** Sanitizes, serializes and queues one span. Never throws; drops the span if a limit is hit. */
  push(span: Span): void;
  /** Sends at most one batch (with at most one retry). Resolves within ~5 s and never rejects. */
  flush(): Promise<void>;
  /** How many spans were dropped (limits, oversize, rejected or failed batches). Local diagnostics only. */
  readonly droppedCount: number;
}

// The SDK delivery policy from the plan. Fixed on purpose: no configuration knobs.
const MAX_SPAN_BYTES = 16 * 1024;
const MAX_RETAINED_SPANS = 500;
const MAX_RETAINED_BYTES = 1024 * 1024;
const MAX_BATCH_SPANS = 100;
const MAX_BATCH_BYTES = 48 * 1024;
const FLUSH_DELAY_MS = 2_000;
const REQUEST_TIMEOUT_MS = 2_000;
const RETRY_DELAY_MS = 1_000;
const RATE_LIMIT_PAUSE_MS = 60_000;

/** A queued span, already serialized so its byte size is known exactly. */
type Entry = { json: string; bytes: number };
type Outcome = "sent" | "retry" | "rejected";

const encoder = new TextEncoder();
const byteLength = (text: string) => encoder.encode(text).length;

/**
 * Creates the Node SDK's span exporter.
 *
 * Telemetry must never hurt the instrumented app, so everything here is
 * bounded: at most 500 spans / 1 MiB held in memory (including the batch in
 * flight), at most 100 spans / 48 KiB per request, one request at a time,
 * a 2 s timeout, one retry, and a 60 s pause after a 429. When a limit is hit
 * the newest span is dropped and `droppedCount` goes up — nothing is retried
 * forever and nothing is reported back as more telemetry.
 *
 * The exporter calls `fetch` directly. The Node SDK never patches `fetch`, so
 * delivery requests can't create spans about themselves (no recursion).
 */
export function createExporter(opts: ExporterOptions): Exporter {
  const queue: Entry[] = [];
  let inFlight = 0; // spans taken from the queue but not yet released
  let retainedBytes = 0; // bytes of queued + in-flight spans
  let dropped = 0;
  let pausedUntil = 0;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let pending: Promise<void> | undefined;
  const envelopeBytes = byteLength(`{"key":${JSON.stringify(opts.key)},"spans":[]}`);

  /** Arms the single flush timer (if not armed). `unref` so it never keeps the process alive. */
  function schedule(delay = FLUSH_DELAY_MS): void {
    if (timer !== undefined) return;
    timer = setTimeout(() => {
      timer = undefined;
      void flush();
    }, delay);
    (timer as { unref?: () => void }).unref?.();
  }

  function push(span: Span): void {
    try {
      // Sanitize before queueing so secrets never sit in memory longer than needed.
      const json = JSON.stringify(sanitizeSpan(span));
      const bytes = byteLength(json);
      const full = queue.length + inFlight >= MAX_RETAINED_SPANS || retainedBytes + bytes > MAX_RETAINED_BYTES;
      if (bytes > MAX_SPAN_BYTES || full) {
        dropped++; // drop newest; never emit telemetry about dropping
        return;
      }
      queue.push({ json, bytes });
      retainedBytes += bytes;
      schedule();
    } catch {
      dropped++; // e.g. a value JSON cannot serialize
    }
  }

  /** Takes up to 100 spans that fit in one 48 KiB envelope from the front of the queue. */
  function takeBatch(): Entry[] {
    const batch: Entry[] = [];
    let size = envelopeBytes;
    while (queue.length > 0 && batch.length < MAX_BATCH_SPANS) {
      const next = queue[0]!;
      const added = next.bytes + (batch.length > 0 ? 1 : 0); // +1 for the comma
      if (size + added > MAX_BATCH_BYTES) {
        if (batch.length > 0) break;
        // Could never fit in any envelope (only possible with a huge key): discard it.
        queue.shift();
        retainedBytes -= next.bytes;
        dropped++;
        continue;
      }
      queue.shift();
      batch.push(next);
      size += added;
    }
    return batch;
  }

  /** One POST, abandoned after 2 s even if the fetch implementation ignores the abort signal. */
  async function attempt(body: string): Promise<Outcome> {
    const controller = new AbortController();
    let timeout: ReturnType<typeof setTimeout> | undefined;
    try {
      // Call as a plain function, not `opts.fetch(...)`: browsers throw "Illegal invocation"
      // when fetch runs with `this` set to another object.
      const fetchImpl = opts.fetch ?? globalThis.fetch;
      const request = fetchImpl(opts.endpoint, {
        method: "POST",
        // text/plain keeps this a CORS "simple request" (no preflight); the body is still JSON.
        headers: { "content-type": "text/plain" },
        body,
        signal: controller.signal,
      });
      request.catch(() => {}); // if the timeout wins the race, a late rejection must not go unhandled
      const timedOut = new Promise<never>((_, reject) => {
        timeout = setTimeout(() => {
          controller.abort();
          reject(new Error("DevLens export timed out"));
        }, REQUEST_TIMEOUT_MS);
      });
      const res = await Promise.race([request, timedOut]);
      if (res.status === 429) pausedUntil = Date.now() + RATE_LIMIT_PAUSE_MS;
      if (res.ok) return "sent";
      return res.status >= 500 ? "retry" : "rejected"; // other 4xx will not succeed on retry
    } catch {
      return "retry"; // network error or timeout
    } finally {
      clearTimeout(timeout);
    }
  }

  /** Sends the current batch with at most one retry, then releases it whatever happened. */
  async function send(): Promise<void> {
    if (Date.now() < pausedUntil) {
      if (queue.length > 0) schedule(pausedUntil - Date.now());
      return;
    }
    const batch = takeBatch();
    if (batch.length === 0) return;
    inFlight += batch.length;
    try {
      // Re-sending the same body keeps the original span ids, so ingest de-duplicates.
      const body = `{"key":${JSON.stringify(opts.key)},"spans":[${batch.map((e) => e.json).join(",")}]}`;
      let outcome = await attempt(body);
      if (outcome === "retry") {
        await new Promise((resolve) => setTimeout(resolve, RETRY_DELAY_MS));
        outcome = await attempt(body);
      }
      if (outcome !== "sent") dropped += batch.length;
    } catch {
      dropped += batch.length;
    } finally {
      // Release memory after success or final failure: no persistent queue, no drain loop.
      for (const entry of batch) retainedBytes -= entry.bytes;
      inFlight -= batch.length;
      if (queue.length > 0) schedule();
    }
  }

  function flush(): Promise<void> {
    // Overlapping calls share the one request in flight.
    pending ??= send()
      .catch(() => {})
      .finally(() => {
        pending = undefined;
      });
    return pending;
  }

  return {
    push,
    flush,
    get droppedCount() {
      return dropped;
    },
  };
}
