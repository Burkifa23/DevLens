import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { formatTraceparent, IngestBatchSchema, type IngestBatch, type Span } from "@devlens/shared";
import { init, track } from "./index";

const ENDPOINT = "http://dashboard.test/api/ingest";
const API = "http://api.test"; // a cross-origin application API (jsdom's page is http://localhost:3000)

type Call = { input: RequestInfo | URL; init?: RequestInit };
let appCalls: Call[];
let ingestCalls: Call[];
let respond: (url: string, call: Call) => Promise<Response>;

const urlOf = (input: RequestInfo | URL) => (input instanceof Request ? input.url : String(input));
/** The headers fetch would actually send: init.headers replace a Request's own headers. */
const headersOf = (c: Call) => new Headers(c.init?.headers ?? (c.input instanceof Request ? c.input.headers : undefined));
const lastRequestHeaders = () => headersOf(appCalls.at(-1)!);

/** Lets the exporter's 2 s timer fire, then returns every span the fake ingest endpoint received. */
async function flushedSpans(): Promise<Span[]> {
  await vi.advanceTimersByTimeAsync(2000);
  return ingestCalls.flatMap((c) => (JSON.parse(String(c.init!.body)) as IngestBatch).spans);
}
/** jsdom's Blob has no .text(); FileReader works but settles on a (fake) timer. */
async function readBlob(blob: Blob): Promise<string> {
  const reader = new FileReader();
  const text = new Promise<string>((resolve) => (reader.onload = () => resolve(String(reader.result))));
  reader.readAsText(blob);
  await vi.advanceTimersByTimeAsync(1);
  return text;
}

const mockFetchStatus = (status: number) => (respond = async () => new Response(null, { status }));
const mockFetchReject = (err: Error) => (respond = async () => Promise.reject(err));

/**
 * A fake cross-origin API that behaves like a browser's CORS check: a request
 * carrying `traceparent` fails with "Failed to fetch" unless the API's
 * preflight (Access-Control-Allow-Headers) allows it.
 */
const corsApi = (allowHeaders: string[]) =>
  (respond = async (url, call) => {
    const nonSafelisted: string[] = [];
    headersOf(call).forEach((_, h) => h !== "content-type" && nonSafelisted.push(h));
    if (url.startsWith(API) && nonSafelisted.some((h) => !allowHeaders.includes(h)))
      throw new TypeError("Failed to fetch");
    return new Response("{}", { status: 200 });
  });

beforeEach(() => {
  vi.useFakeTimers();
  appCalls = [];
  ingestCalls = [];
  mockFetchStatus(200);
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL, reqInit?: RequestInit) => {
      const call = { input, init: reqInit };
      if (urlOf(input) === ENDPOINT) {
        ingestCalls.push(call);
        return new Response(null, { status: 202 });
      }
      appCalls.push(call);
      return respond(urlOf(input), call);
    }),
  );
  init({ endpoint: ENDPOINT, publicKey: "pk_test", traceOrigins: [API + "/"] });
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

test("fetch inside track propagates traceparent from the fetch span", async () => {
  await track("Submit registration", (f) => f("/api/register", { method: "POST" }));
  const hdr = lastRequestHeaders().get("traceparent")!;
  const [fetchSpan, root] = await flushedSpans();
  expect(hdr).toBe(formatTraceparent(root!.traceId, fetchSpan!.id));
  expect(fetchSpan).toMatchObject({ parentSpanId: root!.id, name: "fetch POST /api/register", traceId: root!.traceId });
  expect(fetchSpan!.attributes).toEqual({ method: "POST", path: "/api/register", httpStatus: 200 });
  expect(root).toMatchObject({ name: "Submit registration", status: "ok" });
  expect(root!.parentSpanId).toBeUndefined();
});

test("409 resolves normally and flags an unsuccessful request, not an exception", async () => {
  mockFetchStatus(409);
  expect((await track("a", (f) => f("/x"))).status).toBe(409);
  const spans = await flushedSpans();
  expect(spans.map((s) => s.status)).toEqual(["error", "error"]);
  expect(spans[0]!.attributes.httpStatus).toBe(409);
  expect(spans.every((s) => s.errorMessage === undefined)).toBe(true);
});

test("network failure is captured without a server span and the original error still rejects", async () => {
  const err = new TypeError("Failed to fetch");
  mockFetchReject(err);
  await expect(track("a", (f) => f("/x"))).rejects.toBe(err);
  const spans = await flushedSpans();
  expect(spans[0]).toMatchObject({ status: "error", errorMessage: "Failed to fetch", name: "fetch GET /x" });
  expect(spans[0]!.attributes.httpStatus).toBeUndefined();
  expect(appCalls).toHaveLength(1); // never retried
});

test("overlapping actions get separate traces", async () => {
  await Promise.all([track("a", (f) => f("/x")), track("b", (f) => f("/y"))]);
  const spans = await flushedSpans();
  expect(new Set(spans.map((s) => s.traceId)).size).toBe(2);
  for (const root of spans.filter((s) => !s.parentSpanId)) {
    const child = spans.find((s) => s.parentSpanId === root.id)!;
    expect(child.traceId).toBe(root.traceId);
    expect(child.name).toBe(root.name === "a" ? "fetch GET /x" : "fetch GET /y");
  }
  const sentHeaders = appCalls.map((c) => headersOf(c).get("traceparent")!.split("-")[1]);
  expect(new Set(sentHeaders).size).toBe(2);
});

test("only kind 'browser' is ever emitted", async () => {
  await track("a", (f) => f("/x"));
  expect((await flushedSpans()).every((s) => s.kind === "browser")).toBe(true);
});

test("an approved cross-origin API that allows traceparent in its preflight receives it", async () => {
  corsApi(["traceparent"]);
  const res = await track("a", (f) => f(API + "/orders", { method: "PUT", headers: { "content-type": "application/json" } }));
  expect(res.status).toBe(200);
  expect(lastRequestHeaders().get("traceparent")).toMatch(/^00-[0-9a-f]{32}-[0-9a-f]{16}-01$/);
  expect(lastRequestHeaders().get("content-type")).toBe("application/json");
  expect((await flushedSpans())[0]).toMatchObject({ name: "fetch PUT /orders", status: "ok" });
});

test("an approved API whose preflight omits traceparent fails as a network error, without retry", async () => {
  corsApi([]);
  await expect(track("a", (f) => f(API + "/orders"))).rejects.toThrow("Failed to fetch");
  expect(appCalls).toHaveLength(1);
  const [fetchSpan, root] = await flushedSpans();
  expect(fetchSpan).toMatchObject({ status: "error", errorMessage: "Failed to fetch" });
  expect(root!.status).toBe("error");
});

test("an unapproved origin gets no trace header but is still recorded", async () => {
  corsApi([]);
  await track("a", (f) => f("http://other.test/data?q=secret"));
  expect(lastRequestHeaders().get("traceparent")).toBeNull();
  const [fetchSpan] = await flushedSpans();
  expect(fetchSpan).toMatchObject({ name: "fetch GET /data", status: "ok", attributes: { path: "/data" } });
});

test("no-cors requests never get a trace header, even same-origin", async () => {
  await track("a", (f) => f("/x", { mode: "no-cors" }));
  expect(lastRequestHeaders().get("traceparent")).toBeNull();
});

test("existing Request and init headers, method and body are preserved", async () => {
  const request = new Request("http://localhost:3000/api/items", { method: "POST", headers: { "x-app": "1" } });
  await track("a", (f) => f(request));
  expect(appCalls[0]!.input).toBe(request);
  expect(lastRequestHeaders().get("x-app")).toBe("1");
  expect(lastRequestHeaders().get("traceparent")).not.toBeNull();

  const body = JSON.stringify({ name: "n" });
  await track("b", (f) => f("/api/items", { method: "post", body, headers: [["content-type", "application/json"]] }));
  expect(appCalls[1]!.init!.body).toBe(body);
  expect(appCalls[1]!.init!.method).toBe("post");
  expect(lastRequestHeaders().get("content-type")).toBe("application/json");

  const names = (await flushedSpans()).filter((s) => s.parentSpanId).map((s) => s.name);
  expect(names).toEqual(["fetch POST /api/items", "fetch POST /api/items"]);
});

test("the exact response object and callback value are returned", async () => {
  const response = new Response("ok");
  respond = async () => response;
  expect(await track("a", (f) => f("/x"))).toBe(response);
  const value = { exact: true };
  expect(await track("b", async () => value)).toBe(value);
});

test("a thrown callback marks the root as error with the real message and rethrows it", async () => {
  const err = new Error("validation failed");
  await expect(
    track("a", async () => {
      throw err;
    }),
  ).rejects.toBe(err);
  const [root] = await flushedSpans();
  expect(root).toMatchObject({ status: "error", errorMessage: "validation failed" });
});

test("query strings and fragments never reach span names or paths", async () => {
  await track("a", (f) => f("/api/reset?email=a@b.co#token"));
  const spans = await flushedSpans();
  expect(JSON.stringify(spans)).not.toContain("a@b.co");
  expect(spans[0]!.name).toBe("fetch GET /api/reset");
});

test("uncaught errors and unhandled rejections become standalone error roots", async () => {
  window.dispatchEvent(new ErrorEvent("error", { message: "Uncaught TypeError: x is undefined", error: new TypeError("x is undefined") }));
  const rejection = new Event("unhandledrejection");
  Object.defineProperty(rejection, "reason", { value: new Error("promise failed") });
  window.dispatchEvent(rejection);
  const spans = await flushedSpans();
  expect(spans).toHaveLength(2);
  for (const s of spans) {
    expect(s).toMatchObject({ name: "uncaught error", kind: "browser", status: "error" });
    expect(s.parentSpanId).toBeUndefined();
  }
  expect(spans.map((s) => s.errorMessage)).toEqual(["x is undefined", "promise failed"]);
});

test("re-initializing does not register the error listeners twice", async () => {
  init({ endpoint: ENDPOINT, publicKey: "pk_test" });
  window.dispatchEvent(new ErrorEvent("error", { message: "once" }));
  expect(await flushedSpans()).toHaveLength(1);
});

test("pagehide sends the queued spans once, even after init() ran twice", async () => {
  init({ endpoint: ENDPOINT, publicKey: "pk_test" }); // e.g. React strict mode
  const beacons: Blob[] = [];
  vi.stubGlobal("navigator", { ...navigator, sendBeacon: (_url: string, data: Blob) => beacons.push(data) > 0 });
  await track("a", (f) => f("/x"));
  window.dispatchEvent(new Event("pagehide"));
  expect(beacons).toHaveLength(1);
  expect((JSON.parse(await readBlob(beacons[0]!)) as IngestBatch).spans).toHaveLength(2);
  expect(ingestCalls).toHaveLength(0);
});

test("ingest failures never change the application's result", async () => {
  vi.stubGlobal("fetch", async (input: RequestInfo | URL) => {
    if (urlOf(input) === ENDPOINT) throw new TypeError("ingest down");
    return new Response("app ok");
  });
  const res = await track("a", (f) => f("/x"));
  expect(await res.text()).toBe("app ok");
  await vi.advanceTimersByTimeAsync(10_000);
});

test("exporter requests carry no trace header and create no spans of their own", async () => {
  await track("a", (f) => f("/x"));
  const spans = await flushedSpans();
  expect(spans).toHaveLength(2);
  expect(headersOf(ingestCalls[0]!).get("traceparent")).toBeNull();
  expect(headersOf(ingestCalls[0]!).get("content-type")).toBe("text/plain");
});

test("before init(), track is a pass-through: no header, nothing recorded", async () => {
  vi.resetModules();
  const fresh = await import("./index");
  const res = await fresh.track("a", (f) => f("/x"));
  expect(res.status).toBe(200);
  expect(lastRequestHeaders().get("traceparent")).toBeNull(); // no span would ever be sent for it
  await vi.advanceTimersByTimeAsync(5000);
  expect(ingestCalls).toHaveLength(0);
});

test("every batch sent matches the ingest contract (Task 4's IngestBatchSchema)", async () => {
  mockFetchStatus(500);
  await track("a", (f) => f("/x"));
  window.dispatchEvent(new ErrorEvent("error", { message: "boom" }));
  await flushedSpans();
  expect(ingestCalls.length).toBeGreaterThan(0);
  for (const c of ingestCalls) expect(IngestBatchSchema.safeParse(JSON.parse(String(c.init!.body))).success).toBe(true);
});
