import fs from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { createExporter as createBrowserExporter, init, track } from "@devlens/sdk-browser";
import { configure, createExporter, instrumentPrisma, withDevLens } from "@devlens/sdk-node";
import { newSpanId, newTraceId, type Span } from "@devlens/shared";
import { prisma } from "@/lib/db";
import { handleIngest } from "@/lib/ingest";
import { createProject } from "@/lib/projects";
import { registerUser } from "./fixtures/sdk-demo-service";

/**
 * Tasks 5–6 against the real Task 4 endpoint: both SDKs deliver to
 * `handleIngest`, which writes to the real test database. Only the network is
 * simulated (fetch calls the handler in-process); a real browser's CORS and
 * pagehide behaviour still belong to Task 11.
 */

const REPO_ROOT = path.resolve(__dirname, "../../..");
const APP_ORIGIN = "http://localhost:3001";
const INGEST = "http://localhost:3000/api/ingest";

let pk: string;
let sk: string;

// setup.ts empties the database before each test; a fresh project also gives a fresh rate-limit window.
beforeEach(async () => {
  const owner = await prisma.user.create({ data: { email: "owner@devlens.test", passwordHash: "x" } });
  const { project, secretKey } = await createProject(owner.id, "Demo", [APP_ORIGIN]);
  pk = project.publicKey;
  sk = secretKey;
});

afterEach(() => vi.unstubAllGlobals());

/** An SDK's fetch, delivered to the real ingest handler. A browser adds the Origin header itself. */
function toIngest(origin?: string): typeof fetch {
  return (async (input: RequestInfo | URL, reqInit?: RequestInit) => {
    const headers = new Headers(reqInit?.headers);
    if (origin) headers.set("origin", origin);
    return handleIngest(new Request(String(input), { ...reqInit, headers }));
  }) as typeof fetch;
}

const serverSpan = (): Span => ({
  id: newSpanId(),
  traceId: newTraceId(),
  name: "job",
  kind: "function",
  startTime: new Date().toISOString(),
  durationMs: 1,
  status: "ok",
  attributes: {},
});

/** 1-based line in the fixture that contains `marker`. */
function fixtureLine(marker: string): number {
  const lines = fs.readFileSync(path.join(__dirname, "fixtures/sdk-demo-service.ts"), "utf8").split("\n");
  return lines.findIndex((l) => l.includes(marker)) + 1;
}

test("browser → server → Prisma: a duplicate registration is stored as one linked trace", async () => {
  configure({ endpoint: INGEST, secretKey: sk, repoRoot: REPO_ROOT, fetch: toIngest() });
  const db = instrumentPrisma(prisma);
  const route = withDevLens("POST /api/register", async (req: Request) => {
    const { email } = (await req.json()) as { email: string };
    try {
      await registerUser(db, email);
      return new Response(null, { status: 201 });
    } catch (err) {
      if ((err as { code?: string }).code === "P2002") return Response.json({ error: "Email already registered" }, { status: 409 });
      throw err;
    }
  });

  // The page is the demo app; its same-origin fetch reaches the wrapped route, ingest goes to handleIngest.
  vi.stubGlobal("location", new URL(APP_ORIGIN + "/"));
  vi.stubGlobal("fetch", async (input: RequestInfo | URL, reqInit?: RequestInit) => {
    const url = new URL(input instanceof Request ? input.url : String(input), APP_ORIGIN);
    if (url.href === INGEST) return toIngest(APP_ORIGIN)(input, reqInit);
    return route(new Request(url, reqInit), {});
  });
  init({ endpoint: INGEST, publicKey: pk });

  const submit = () =>
    track("Submit registration", (f) =>
      f("/api/register", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ email: "dup@example.com" }) }),
    );
  expect((await submit()).status).toBe(201);
  expect((await submit()).status).toBe(409);

  // Browser spans go out on the 2 s timer; server spans right after each response.
  await vi.waitFor(async () => expect(await prisma.span.count()).toBe(10), { timeout: 10_000, interval: 200 });

  const failedDb = await prisma.span.findFirstOrThrow({ where: { kind: "database", status: "error" } });
  const trace = await prisma.span.findMany({ where: { traceId: failedDb.traceId } });
  const childOf = (parentId: string | null) => trace.find((s) => s.parentSpanId === parentId)!;
  const root = childOf(null);
  const fetchSpan = childOf(root.id);
  const http = childOf(fetchSpan.id);
  const fn = childOf(http.id);
  const dbSpan = childOf(fn.id);
  console.info("duplicate-registration trace:\n" + JSON.stringify(trace, null, 2));

  expect(trace).toHaveLength(5);
  expect([root, fetchSpan, http, fn, dbSpan].map((s) => s.kind)).toEqual(["browser", "browser", "http", "function", "database"]);
  expect([root, fetchSpan].every((s) => s.ingestSource === "browser-public")).toBe(true);
  expect([http, fn, dbSpan].every((s) => s.ingestSource === "server-secret")).toBe(true);

  // HTTP status policy end to end: a handled 409 is an unsuccessful request, not an exception.
  expect(root).toMatchObject({ name: "Submit registration", status: "error", errorMessage: null });
  expect(fetchSpan).toMatchObject({ name: "fetch POST /api/register", status: "error", errorMessage: null, attributes: { httpStatus: 409 } });
  expect(http).toMatchObject({ status: "ok", errorMessage: null, attributes: { method: "POST", path: "/api/register", httpStatus: 409 } });
  expect(fn).toMatchObject({ name: "RegistrationService.registerUser", status: "error" });
  expect(dbSpan).toMatchObject({ name: "User.create", status: "error", attributes: { model: "User", operation: "create" } });
  expect(dbSpan.errorMessage).toMatch(/^P2002: Unique constraint failed/);
  // The same Prisma error passing through span() must not store Prisma's code excerpt or absolute paths.
  expect(fn.errorMessage).toBe(dbSpan.errorMessage);

  // Source locations (Amy's question): function span = where span() is called; database span = from Prisma's error stack.
  const fixture = "apps/dashboard/test/fixtures/sdk-demo-service.ts";
  expect({ file: fn.sourceFile, line: fn.sourceLine }).toEqual({ file: fixture, line: fixtureLine('span("RegistrationService') });
  expect({ file: dbSpan.sourceFile, line: dbSpan.sourceLine }).toEqual({ file: fixture, line: fixtureLine("DB_CALL_LINE") });

  // No query arguments or personal data reach storage.
  expect(JSON.stringify(trace)).not.toContain("dup@example.com");
});

test("a wrong secret key or a disallowed browser Origin loses spans, never the app's result", async () => {
  const badKey = createExporter({ endpoint: INGEST, key: "sk_wrong", fetch: toIngest() });
  badKey.push(serverSpan());
  await badKey.flush();
  expect(badKey.droppedCount).toBe(1); // 401: discarded, not retried

  const evil = createBrowserExporter({ endpoint: INGEST, key: pk, fetch: toIngest("https://evil.example") });
  evil.push({ ...serverSpan(), kind: "browser" });
  await evil.flush();
  expect(evil.droppedCount).toBe(1); // 403

  const allowed = createBrowserExporter({ endpoint: INGEST, key: pk, fetch: toIngest(APP_ORIGIN) });
  allowed.push({ ...serverSpan(), kind: "browser" });
  await allowed.flush();
  expect(allowed.droppedCount).toBe(0);
  expect(await prisma.span.findMany({ select: { ingestSource: true } })).toEqual([{ ingestSource: "browser-public" }]);

  configure({ endpoint: INGEST, secretKey: "sk_wrong", fetch: toIngest() });
  const res = await withDevLens("GET /x", async () => new Response("app ok"))(new Request("http://localhost:3001/x"), {});
  expect(await res.text()).toBe("app ok");
});

test("the real rate limiter's 429 makes the exporter drop that batch and pause", async () => {
  const calls: number[] = [];
  const ingest = toIngest();
  const ex = createExporter({
    endpoint: INGEST,
    key: sk,
    fetch: (async (input: RequestInfo | URL, reqInit?: RequestInit) => {
      const res = await ingest(input, reqInit);
      calls.push(res.status);
      return res;
    }) as typeof fetch,
  });
  for (let i = 0; i < 500; i++) ex.push(serverSpan());
  for (let i = 0; i < 5; i++) await ex.flush();
  for (let i = 0; i < 200; i++) ex.push(serverSpan());
  await ex.flush(); // 600 spans this minute: still allowed
  await ex.flush(); // 700 > 600: 429
  ex.push(serverSpan());
  await ex.flush(); // paused: no request at all

  expect(calls).toEqual([202, 202, 202, 202, 202, 202, 429]);
  expect(ex.droppedCount).toBe(100);
  expect(await prisma.span.count()).toBe(600);
});

test("a retried batch whose first response was lost is stored once (original ids)", async () => {
  const ingest = toIngest();
  let attempts = 0;
  const ex = createExporter({
    endpoint: INGEST,
    key: sk,
    fetch: (async (input: RequestInfo | URL, reqInit?: RequestInit) => {
      const res = await ingest(input, reqInit); // the spans really are stored…
      return ++attempts === 1 ? new Response(null, { status: 503 }) : res; // …but the SDK sees a 503
    }) as typeof fetch,
  });
  ex.push(serverSpan());
  await ex.flush(); // includes the 1 s retry delay
  expect(attempts).toBe(2);
  expect(ex.droppedCount).toBe(0);
  expect(await prisma.span.count()).toBe(1);
});
