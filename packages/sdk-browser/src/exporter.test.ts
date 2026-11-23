import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { sanitizeSpan, type IngestBatch, type Span } from "@devlens/shared";
import { createExporter } from "./exporter";

const endpoint = "http://ingest.test/api/ingest";
let n = 0;

/** A small valid span; `fileLength` pads `source.file` to make it big. */
function mk(fileLength = 0): Span {
  return {
    id: (++n).toString(16).padStart(16, "0"),
    traceId: "4bf92f3577b34da6a3ce929d0e0e4736",
    name: "s",
    kind: "function",
    startTime: "2026-11-23T10:00:00.000Z",
    durationMs: 1,
    status: "ok",
    attributes: {},
    ...(fileLength > 0 && { source: { file: "f".repeat(fileLength), line: 1 } }),
  };
}

const bytesOf = (s: Span) => new TextEncoder().encode(JSON.stringify(sanitizeSpan(s))).length;

/** A fake ingest endpoint that answers each call with the next status (last one repeats). */
function fakeIngest(...statuses: number[]) {
  const bodies: string[] = [];
  const inits: RequestInit[] = [];
  const fetch = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
    bodies.push(String(init?.body));
    inits.push(init ?? {});
    const status = statuses[Math.min(bodies.length - 1, statuses.length - 1)] ?? 202;
    return new Response(null, { status });
  });
  const batches = () => bodies.map((b) => JSON.parse(b) as IngestBatch);
  return { fetch: fetch as unknown as typeof globalThis.fetch, calls: fetch, bodies, inits, batches };
}

beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

test("sends a text/plain JSON envelope with the key after the 2 s flush timer", async () => {
  const ingest = fakeIngest(202);
  const ex = createExporter({ endpoint, key: "sk_x", fetch: ingest.fetch });
  const span = mk();
  ex.push(span);
  await vi.advanceTimersByTimeAsync(1999);
  expect(ingest.calls).not.toHaveBeenCalled();
  await vi.advanceTimersByTimeAsync(1);
  expect(ingest.calls).toHaveBeenCalledOnce();
  expect(ingest.calls.mock.calls[0]![0]).toBe(endpoint);
  expect(new Headers(ingest.inits[0]!.headers).get("content-type")).toBe("text/plain");
  expect(ingest.batches()[0]).toEqual({ key: "sk_x", spans: [span] });
});

test("sanitizes on enqueue", async () => {
  const ingest = fakeIngest(202);
  const ex = createExporter({ endpoint, key: "sk_x", fetch: ingest.fetch });
  ex.push({ ...mk(), errorMessage: "dup a@b.co", attributes: { password: "p", httpStatus: 409 } });
  await ex.flush();
  expect(ingest.batches()[0]!.spans[0]).toMatchObject({ errorMessage: "dup [email]", attributes: { httpStatus: 409 } });
  expect(ingest.bodies[0]).not.toContain("a@b.co");
});

test("the 501st retained span is dropped", () => {
  const ex = createExporter({ endpoint, key: "sk_x", fetch: fakeIngest(202).fetch });
  for (let i = 0; i < 500; i++) ex.push(mk());
  expect(ex.droppedCount).toBe(0);
  ex.push(mk());
  expect(ex.droppedCount).toBe(1);
});

test("large spans hit the 1 MiB byte cap before the 500-span cap", () => {
  const ex = createExporter({ endpoint, key: "sk_x", fetch: fakeIngest(202).fetch });
  const size = bytesOf(mk(15_000));
  const fits = Math.floor((1024 * 1024) / size);
  for (let i = 0; i < 100; i++) ex.push(mk(15_000));
  expect(fits).toBeLessThan(100);
  expect(ex.droppedCount).toBe(100 - fits);
});

test("spans over 16 KiB serialized are dropped", async () => {
  const ingest = fakeIngest(202);
  const ex = createExporter({ endpoint, key: "sk_x", fetch: ingest.fetch });
  ex.push(mk(17_000));
  expect(ex.droppedCount).toBe(1);
  await ex.flush();
  expect(ingest.calls).not.toHaveBeenCalled();
});

test("each request is at most 100 spans and 48 KiB including the envelope", async () => {
  const ingest = fakeIngest(202);
  const ex = createExporter({ endpoint, key: "sk_x", fetch: ingest.fetch });
  for (let i = 0; i < 250; i++) ex.push(mk());
  for (let i = 0; i < 20; i++) ex.push(mk(15_000));
  for (let i = 0; i < 15; i++) await ex.flush();
  const counts = ingest.batches().map((b) => b.spans.length);
  expect(counts.reduce((a, b) => a + b, 0)).toBe(270);
  expect(Math.max(...counts)).toBeLessThanOrEqual(100);
  for (const body of ingest.bodies) expect(new TextEncoder().encode(body).length).toBeLessThanOrEqual(48 * 1024);
});

test("flush handles only the current batch", async () => {
  const ingest = fakeIngest(202);
  const ex = createExporter({ endpoint, key: "sk_x", fetch: ingest.fetch });
  for (let i = 0; i < 150; i++) ex.push(mk());
  await ex.flush();
  expect(ingest.calls).toHaveBeenCalledOnce();
  expect(ingest.batches()[0]!.spans).toHaveLength(100);
});

test("a hanging fetch is aborted at 2 s, retried once after 1 s, and flush settles by 5 s", async () => {
  const signals: AbortSignal[] = [];
  const hang = ((_url: string, init?: RequestInit) => {
    signals.push(init!.signal!);
    return new Promise(() => {}); // never settles, even when aborted
  }) as unknown as typeof fetch;
  const ex = createExporter({ endpoint, key: "sk_x", fetch: hang });
  ex.push(mk());
  let settled = false;
  const done = ex.flush().then(() => (settled = true));

  await vi.advanceTimersByTimeAsync(1999);
  expect(signals[0]!.aborted).toBe(false);
  await vi.advanceTimersByTimeAsync(1);
  expect(signals[0]!.aborted).toBe(true);
  expect(signals).toHaveLength(1);
  await vi.advanceTimersByTimeAsync(1000);
  expect(signals).toHaveLength(2);
  await vi.advanceTimersByTimeAsync(2000);
  expect(settled).toBe(true);
  expect(signals).toHaveLength(2);
  expect(signals[1]!.aborted).toBe(true);
  expect(ex.droppedCount).toBe(1);
  await done;
});

test("overlapping flush calls coalesce into one in-flight request", async () => {
  const ingest = fakeIngest(202);
  const ex = createExporter({ endpoint, key: "sk_x", fetch: ingest.fetch });
  ex.push(mk());
  const a = ex.flush();
  const b = ex.flush();
  expect(a).toBe(b);
  await a;
  expect(ingest.calls).toHaveBeenCalledOnce();
});

test.each([
  ["a network error", "network"],
  ["a 503", 503],
] as const)("retries once after %s with the original span ids", async (_label, first) => {
  const bodies: string[] = [];
  const fetch = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
    bodies.push(String(init?.body));
    if (bodies.length === 1 && first === "network") throw new TypeError("fetch failed");
    return new Response(null, { status: bodies.length === 1 ? (first as number) : 202 });
  });
  const ex = createExporter({ endpoint, key: "sk_x", fetch: fetch as unknown as typeof globalThis.fetch });
  ex.push(mk());
  const done = ex.flush();
  await vi.advanceTimersByTimeAsync(999);
  expect(fetch).toHaveBeenCalledOnce();
  await vi.advanceTimersByTimeAsync(1);
  await done;
  expect(fetch).toHaveBeenCalledTimes(2);
  expect(bodies[1]).toBe(bodies[0]);
  expect(ex.droppedCount).toBe(0);
});

test("at most one retry: a second 5xx discards the batch", async () => {
  const ingest = fakeIngest(500, 500, 500);
  const ex = createExporter({ endpoint, key: "sk_x", fetch: ingest.fetch });
  ex.push(mk());
  const done = ex.flush();
  await vi.advanceTimersByTimeAsync(5000);
  await done;
  expect(ingest.calls).toHaveBeenCalledTimes(2);
  expect(ex.droppedCount).toBe(1);
});

test.each([400, 401, 403, 413])("a %i is discarded without retry", async (status) => {
  const ingest = fakeIngest(status);
  const ex = createExporter({ endpoint, key: "sk_x", fetch: ingest.fetch });
  ex.push(mk());
  ex.push(mk());
  await ex.flush();
  await vi.advanceTimersByTimeAsync(5000);
  expect(ingest.calls).toHaveBeenCalledOnce();
  expect(ex.droppedCount).toBe(2);
});

test("a 429 discards the batch and pauses sending for 60 s while caps still apply", async () => {
  const ingest = fakeIngest(429, 202);
  const ex = createExporter({ endpoint, key: "sk_x", fetch: ingest.fetch });
  ex.push(mk());
  await ex.flush();
  expect(ex.droppedCount).toBe(1);

  for (let i = 0; i < 501; i++) ex.push(mk());
  expect(ex.droppedCount).toBe(2); // the queue cap still applies during the pause
  await ex.flush();
  await vi.advanceTimersByTimeAsync(59_000);
  expect(ingest.calls).toHaveBeenCalledOnce();
  await vi.advanceTimersByTimeAsync(1_000);
  expect(ingest.calls).toHaveBeenCalledTimes(2);
  expect(ingest.batches()[1]!.spans).toHaveLength(100);
});

test("sent and failed batches release their queue space", async () => {
  const ingest = fakeIngest(202, 400);
  const ex = createExporter({ endpoint, key: "sk_x", fetch: ingest.fetch });
  for (let i = 0; i < 500; i++) ex.push(mk());
  await ex.flush(); // 202
  await ex.flush(); // 400: final failure
  expect(ex.droppedCount).toBe(100);
  for (let i = 0; i < 200; i++) ex.push(mk());
  expect(ex.droppedCount).toBe(100);
  ex.push(mk());
  expect(ex.droppedCount).toBe(101);
});

test("never rejects, even when fetch throws synchronously", async () => {
  const ex = createExporter({
    endpoint,
    key: "sk_x",
    fetch: (() => {
      throw new Error("sync");
    }) as unknown as typeof fetch,
  });
  ex.push(mk());
  const done = ex.flush();
  await vi.advanceTimersByTimeAsync(1000);
  await expect(done).resolves.toBeUndefined();
  expect(ex.droppedCount).toBe(1);
});

test("push never throws, even for a span that cannot be serialized", () => {
  const ex = createExporter({ endpoint, key: "sk_x", fetch: fakeIngest(202).fetch });
  const bad = { ...mk(), attributes: { method: 1n } } as unknown as Span; // BigInt cannot be JSON-serialized
  expect(() => ex.push(bad)).not.toThrow();
  expect(ex.droppedCount).toBe(1);
});

// ---- Browser only: pagehide delivery -------------------------------------------------------

/** jsdom's Blob has no .text(); FileReader works but settles on a (fake) timer. */
async function readBlob(blob: Blob): Promise<string> {
  const reader = new FileReader();
  const text = new Promise<string>((resolve) => (reader.onload = () => resolve(String(reader.result))));
  reader.readAsText(blob);
  await vi.advanceTimersByTimeAsync(1);
  return text;
}

/** Stubs navigator.sendBeacon and records what it was given. */
function stubBeacon(result: boolean) {
  const sent: { url: string; data: Blob }[] = [];
  vi.stubGlobal("navigator", {
    ...navigator,
    sendBeacon: (url: string, data: Blob) => {
      sent.push({ url, data });
      return result;
    },
  });
  return sent;
}

afterEach(() => vi.unstubAllGlobals());

test("pagehide sends one batch of at most 100 spans by beacon, as text/plain", async () => {
  const ingest = fakeIngest(202);
  const ex = createExporter({ endpoint, key: "pk_x", fetch: ingest.fetch });
  const beacons = stubBeacon(true);
  for (let i = 0; i < 150; i++) ex.push(mk());
  ex.sendOnPageHide();
  expect(beacons).toHaveLength(1);
  expect(beacons[0]!.url).toBe(endpoint);
  expect(beacons[0]!.data.type).toBe("text/plain");
  const body = await readBlob(beacons[0]!.data);
  expect(new TextEncoder().encode(body).length).toBeLessThanOrEqual(48 * 1024);
  expect((JSON.parse(body) as IngestBatch).spans).toHaveLength(100);
  expect(ingest.calls).not.toHaveBeenCalled();
});

test("when the beacon is refused, pagehide falls back to one keepalive fetch and never retries", async () => {
  const fetch = vi.fn(async () => {
    throw new TypeError("network");
  });
  const ex = createExporter({ endpoint, key: "pk_x", fetch: fetch as unknown as typeof globalThis.fetch });
  stubBeacon(false);
  ex.push(mk());
  ex.sendOnPageHide();
  expect(fetch).toHaveBeenCalledOnce();
  const init = (fetch.mock.calls[0] as unknown as [string, RequestInit])[1];
  expect(init.keepalive).toBe(true);
  expect(new Headers(init.headers).get("content-type")).toBe("text/plain");
  await vi.advanceTimersByTimeAsync(10_000);
  expect(fetch).toHaveBeenCalledOnce();
  // The batch was released: a fresh 500 spans fit again.
  for (let i = 0; i < 500; i++) ex.push(mk());
  expect(ex.droppedCount).toBe(0);
});

test("without sendBeacon, pagehide uses keepalive fetch", () => {
  const ingest = fakeIngest(202);
  const ex = createExporter({ endpoint, key: "pk_x", fetch: ingest.fetch });
  vi.stubGlobal("navigator", { ...navigator, sendBeacon: undefined });
  ex.push(mk());
  ex.sendOnPageHide();
  expect(ingest.calls).toHaveBeenCalledOnce();
  expect(ingest.inits[0]!.keepalive).toBe(true);
});

test("pagehide sends nothing while paused by a 429", async () => {
  const ingest = fakeIngest(429);
  const ex = createExporter({ endpoint, key: "pk_x", fetch: ingest.fetch });
  const beacons = stubBeacon(true);
  ex.push(mk());
  await ex.flush();
  ex.push(mk());
  ex.sendOnPageHide();
  expect(beacons).toHaveLength(0);
});
