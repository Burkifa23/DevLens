import type { Span } from "@devlens/shared";
import { beforeEach, expect, test } from "vitest";
import { prisma } from "@/lib/db";
import { handleIngest } from "@/lib/ingest";
import { createProject } from "@/lib/projects";

const ORIGIN = "http://localhost:3001";
let pk: string;
let sk: string;
let projectId: string;

// A fresh user + project per test (setup.ts empties the database first), so the
// in-memory rate limiter, which counts per project, never carries over between tests.
beforeEach(async () => {
  const owner = await prisma.user.create({ data: { email: "owner@devlens.test", passwordHash: "x" } });
  const { project, secretKey } = await createProject(owner.id, "Demo", [ORIGIN]);
  pk = project.publicKey;
  sk = secretKey;
  projectId = project.id;
});

let counter = 0;
const spanId = () => (++counter).toString(16).padStart(16, "0");

const span: Span = {
  id: "00000000000000a1",
  traceId: "0af7651916cd43dd8448eb211c80319c",
  name: "POST /api/register",
  kind: "http",
  startTime: "2026-11-24T10:00:00.000Z",
  durationMs: 142,
  status: "error",
  attributes: { method: "POST", path: "/api/register", httpStatus: 409 },
};
const browserSpan: Span = { ...span, id: "00000000000000b1", name: "Submit registration", kind: "browser", attributes: {} };
const manySpans = (n: number): Span[] => Array.from({ length: n }, () => ({ ...span, id: spanId() }));

/** A POST to the ingest endpoint as the SDKs send it: JSON in a text/plain body. */
function rawPost(body: string, origin?: string): Request {
  const headers: Record<string, string> = { "content-type": "text/plain" };
  if (origin) headers.origin = origin;
  return new Request("http://localhost:3000/api/ingest", { method: "POST", headers, body });
}
const post = (body: unknown, origin?: string) => rawPost(JSON.stringify(body), origin);

test("secret key stores sanitized spans", async () => {
  const res = await handleIngest(post({ key: sk, spans: [{ ...span, errorMessage: "Unique constraint failed on (email) for a@b.co" }] }));
  expect(res.status).toBe(202);
  expect(await res.json()).toEqual({ accepted: 1 });
  const row = await prisma.span.findFirstOrThrow();
  expect(row.ingestSource).toBe("server-secret");
  expect(row.errorMessage).toBe("Unique constraint failed on (email) for [email]");
  expect(row).toMatchObject({ projectId, id: span.id, traceId: span.traceId, kind: "http", durationMs: 142, status: "error" });
  expect(row.startTime.toISOString()).toBe(span.startTime);
});

test("public key: allowed origin + browser kind only", async () => {
  expect((await handleIngest(post({ key: pk, spans: [browserSpan] }))).status).toBe(403);
  expect((await handleIngest(post({ key: pk, spans: [browserSpan] }, "null"))).status).toBe(403);
  expect((await handleIngest(post({ key: pk, spans: [browserSpan] }, ORIGIN))).status).toBe(202);
  expect((await handleIngest(post({ key: pk, spans: [browserSpan] }, "https://evil.example"))).status).toBe(403);
  expect((await handleIngest(post({ key: pk, spans: [{ ...browserSpan, kind: "database" }] }, ORIGIN))).status).toBe(403);
});

test("one non-browser span rejects the whole public-key batch", async () => {
  const res = await handleIngest(post({ key: pk, spans: [{ ...browserSpan, id: spanId() }, { ...span, id: spanId() }] }, ORIGIN));
  expect(res.status).toBe(403);
  expect(await prisma.span.count()).toBe(0);
});

test("rejects unknown key, bad schema, oversize, flood", async () => {
  expect((await handleIngest(post({ key: "sk_nope", spans: [span] }))).status).toBe(401);
  expect((await handleIngest(post({ key: "nokeyprefix", spans: [span] }))).status).toBe(401);
  expect((await handleIngest(rawPost("{not json"))).status).toBe(400);
  expect((await handleIngest(post({ key: sk, spans: [{ ...span, id: "xyz" }] }))).status).toBe(400);
  expect((await handleIngest(rawPost("x".repeat(5_000_000)))).status).toBe(413);
  expect((await handleIngest(post({ key: sk, spans: manySpans(500) }))).status).toBe(202);
  expect((await handleIngest(post({ key: sk, spans: manySpans(200) }))).status).toBe(429); // 700 > 600/min
  expect((await handleIngest(post({ key: sk, spans: manySpans(100) }))).status).toBe(202); // exactly 600
});

test("413 does not trust Content-Length: a streamed body is cut off at 1 MiB", async () => {
  const chunk = new TextEncoder().encode("x".repeat(64 * 1024));
  let sent = 0;
  const body = new ReadableStream<Uint8Array>({
    pull(controller) {
      if (sent++ < 40) controller.enqueue(chunk); // 2.5 MiB in total, no Content-Length header
      else controller.close();
    },
  });
  const req = new Request("http://localhost:3000/api/ingest", { method: "POST", body, duplex: "half" } as RequestInit);
  expect((await handleIngest(req)).status).toBe(413);
  expect(sent).toBeLessThan(40); // stopped reading early instead of buffering everything
});

test("provenance is server-derived even for forged Origin", async () => {
  await handleIngest(post({ key: pk, spans: [browserSpan] }, ORIGIN));
  expect((await prisma.span.findFirstOrThrow()).ingestSource).toBe("browser-public");
  expect((await handleIngest(post({ key: pk, spans: [{ ...browserSpan, ingestSource: "server-secret" }] }, ORIGIN))).status).toBe(400);
});

test("re-sent batch is idempotent and the first stored span wins", async () => {
  await handleIngest(post({ key: sk, spans: [span] }));
  const res = await handleIngest(post({ key: sk, spans: [{ ...span, name: "overwritten?" }] }));
  expect(await res.json()).toEqual({ accepted: 0 });
  expect(await prisma.span.count()).toBe(1);
  expect((await prisma.span.findFirstOrThrow()).name).toBe(span.name);
});

test("CORS: allowed origin is echoed with Vary, never a wildcard", async () => {
  const ok = await handleIngest(post({ key: pk, spans: [browserSpan] }, ORIGIN));
  expect(ok.headers.get("access-control-allow-origin")).toBe(ORIGIN);
  expect(ok.headers.get("vary")).toBe("Origin");
  // Errors after the origin was accepted still carry the header, so the browser SDK can read the status.
  const wrongKind = await handleIngest(post({ key: pk, spans: [{ ...browserSpan, kind: "http" }] }, ORIGIN));
  expect(wrongKind.status).toBe(403);
  expect(wrongKind.headers.get("access-control-allow-origin")).toBe(ORIGIN);

  const evil = await handleIngest(post({ key: pk, spans: [browserSpan] }, "https://evil.example"));
  expect(evil.headers.get("access-control-allow-origin")).toBeNull();
  const server = await handleIngest(post({ key: sk, spans: [span] }));
  expect(server.headers.get("access-control-allow-origin")).toBeNull();
});
