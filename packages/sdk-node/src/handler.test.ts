import path from "node:path";
import { fileURLToPath } from "node:url";
import { beforeEach, expect, test } from "vitest";
import { formatTraceparent, IngestBatchSchema, type IngestBatch, type Span } from "@devlens/shared";
import { flush } from "./context";
import { configure, span, withDevLens } from "./index";

const here = path.dirname(fileURLToPath(import.meta.url));
const T = "4bf92f3577b34da6a3ce929d0e0e4736";
const P = "00f067aa0ba902b7";

let bodies: IngestBatch[];
let requests: RequestInit[];

/** Fake ingest endpoint: records every batch it receives. A fresh one per test. */
function fakeFetch(): typeof fetch {
  const mine: IngestBatch[] = (bodies = []);
  const inits: RequestInit[] = (requests = []);
  return (async (_url: string | URL | Request, init?: RequestInit) => {
    mine.push(JSON.parse(String(init?.body)) as IngestBatch);
    inits.push(init ?? {});
    return new Response(null, { status: 202 });
  }) as typeof fetch;
}

const sent = (): Span[] => bodies.flatMap((b) => b.spans);
/** Each flush sends one batch and coalesces with an in-flight one, so flush a few times. */
const flushed = async () => {
  for (let i = 0; i < 3; i++) await flush();
};
const req = (headers: Record<string, string> = {}) =>
  new Request("http://localhost:3001/api/register?email=a@b.co#x", { method: "POST", headers });
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

beforeEach(() => configure({ endpoint: "http://ingest.test/api/ingest", secretKey: "sk_test", fetch: fakeFetch() }));

test("continues the incoming trace and nests spans", async () => {
  const h = withDevLens("POST /api/register", async () => {
    await span("svc", async () => {});
    return new Response(null, { status: 201 });
  });
  await h(req({ traceparent: formatTraceparent(T, P) }), {});
  await flushed();
  const [svc, http] = sent();
  expect(http).toMatchObject({ traceId: T, parentSpanId: P, kind: "http", status: "ok", name: "POST /api/register" });
  expect(http!.attributes).toEqual({ method: "POST", path: "/api/register", httpStatus: 201 });
  expect(svc).toMatchObject({ traceId: T, parentSpanId: http!.id, kind: "function" });
});

test.each([undefined, "garbage", "00-" + "0".repeat(32) + "-" + P + "-01"])(
  "starts a fresh trace for traceparent %s",
  async (header) => {
    await withDevLens("r", async () => new Response())(req(header ? { traceparent: header } : {}), {});
    await flushed();
    expect(sent()).toHaveLength(1);
    expect(sent()[0]!.traceId).toMatch(/^[0-9a-f]{32}$/);
    expect(sent()[0]!.traceId).not.toBe(T);
    expect(sent()[0]!.parentSpanId).toBeUndefined();
  },
);

test("returned 4xx is not an exception; thrown errors still propagate", async () => {
  await withDevLens("x", async () => new Response(null, { status: 409 }))(req(), {});
  await expect(
    withDevLens("y", async () => {
      throw new TypeError("boom");
    })(req(), {}),
  ).rejects.toThrow("boom");
  await flushed();
  expect(sent().map((s) => s.status)).toEqual(["ok", "error"]);
  expect(sent()[0]!.attributes.httpStatus).toBe(409);
  expect(sent()[0]!.errorMessage).toBeUndefined();
  expect(sent()[1]!.errorMessage).toBe("boom");
  expect(sent()[1]!.attributes.httpStatus).toBeUndefined();
  expect(sent()[1]!.source?.file).toMatch(/handler\.test\.ts$/);
});

test("returned 500 is an error without a fabricated exception or source", async () => {
  const res = await withDevLens("x", async () => new Response("no", { status: 500 }))(req(), {});
  expect(res.status).toBe(500);
  await flushed();
  expect(sent()[0]).toMatchObject({ status: "error", attributes: { httpStatus: 500 } });
  expect(sent()[0]!.errorMessage).toBeUndefined();
  expect(sent()[0]!.source).toBeUndefined();
});

test("the original thrown value is rethrown unchanged", async () => {
  const err = new RangeError("exact");
  await expect(
    withDevLens("x", async () => {
      throw err;
    })(req(), {}),
  ).rejects.toBe(err);
  const notAnError = { code: 7 };
  await expect(span("s", () => Promise.reject(notAnError))).rejects.toBe(notAnError);
});

test("a function error handled as 409 keeps the function span as error and the http span ok", async () => {
  const h = withDevLens("POST /api/register", async () => {
    try {
      await span("RegistrationService.registerUser", async () => {
        throw new Error("Unique constraint failed on the fields: (`email`)");
      });
      return new Response(null, { status: 201 });
    } catch {
      return Response.json({ error: "Email already registered" }, { status: 409 });
    }
  });
  expect((await h(req(), {})).status).toBe(409);
  await flushed();
  const [fn, http] = sent();
  expect(fn).toMatchObject({ kind: "function", status: "error", errorMessage: "Unique constraint failed on the fields: (`email`)" });
  expect(http).toMatchObject({ kind: "http", status: "ok", attributes: { httpStatus: 409 } });
  expect(http!.errorMessage).toBeUndefined();
});

test("concurrent requests do not share context", async () => {
  await Promise.all(
    [1, 2].map((i) =>
      withDevLens("r", async () => {
        await sleep(5 * i);
        await span("s" + i, async () => {});
        return new Response();
      })(req(), {}),
    ),
  );
  await flushed();
  const byTrace = new Map<string, Span[]>();
  for (const s of sent()) byTrace.set(s.traceId, [...(byTrace.get(s.traceId) ?? []), s]);
  expect(byTrace.size).toBe(2);
  for (const spans of byTrace.values()) {
    expect(spans).toHaveLength(2);
    const http = spans.find((s) => s.kind === "http")!;
    expect(spans.find((s) => s.kind === "function")!.parentSpanId).toBe(http.id);
  }
});

test("nested function spans form a chain across awaits", async () => {
  await withDevLens("r", async () => {
    await span("outer", async () => {
      await sleep(1);
      await span("inner", async () => {});
      await span("sibling", async () => {});
    });
    return new Response();
  })(req(), {});
  await flushed();
  const byName = Object.fromEntries(sent().map((s) => [s.name, s]));
  expect(byName.inner!.parentSpanId).toBe(byName.outer!.id);
  expect(byName.sibling!.parentSpanId).toBe(byName.outer!.id);
  expect(byName.outer!.parentSpanId).toBe(byName.r!.id);
  expect(new Set(sent().map((s) => s.traceId)).size).toBe(1);
});

test("a span outside any request starts its own trace", async () => {
  await span("job", async () => {});
  await flushed();
  expect(sent()[0]).toMatchObject({ kind: "function", name: "job" });
  expect(sent()[0]!.parentSpanId).toBeUndefined();
});

test("ingest failure never surfaces to the app", async () => {
  configure({ endpoint: "http://x", secretKey: "sk_x", fetch: () => Promise.reject(new Error("down")) });
  expect((await withDevLens("r", async () => new Response("ok"))(req(), {})).status).toBe(200);
  expect(await span("s", async () => 42)).toBe(42);
});

test("the wrapper does not wait for a hanging exporter", async () => {
  configure({ endpoint: "http://x", secretKey: "sk_x", fetch: () => new Promise<Response>(() => {}) });
  const started = Date.now();
  const res = await withDevLens("r", async () => new Response("ok"))(req(), {});
  expect(res.status).toBe(200);
  expect(Date.now() - started).toBeLessThan(500);
});

test("a capture failure returns the identical response and value", async () => {
  const brokenReq = {
    method: "GET",
    url: "http://localhost/x",
    get headers(): Headers {
      throw new Error("capture failed");
    },
  } as unknown as Request;
  const response = new Response("ok");
  let seen: Request | undefined;
  const out = await withDevLens("r", async (r: Request) => {
    seen = r;
    return response;
  })(brokenReq, {});
  expect(out).toBe(response);
  expect(seen).toBe(brokenReq);

  // A handler returning something whose status cannot be read still gets it back unchanged.
  const odd = {
    get status(): number {
      throw new Error("no status");
    },
  } as unknown as Response;
  expect(await withDevLens("r", async () => odd)(req(), {})).toBe(odd);

  const value = { exact: true };
  expect(await span("s", async () => value)).toBe(value);
});

test("exporter requests carry no trace header and create no spans of their own", async () => {
  await withDevLens("r", async () => new Response())(req({ traceparent: formatTraceparent(T, P) }), {});
  await flushed();
  await flushed();
  expect(sent()).toHaveLength(1);
  const headers = new Headers(requests[0]!.headers);
  expect(headers.get("traceparent")).toBeNull();
  expect(headers.get("content-type")).toBe("text/plain");
});

test("source is repo-relative and spans carry commitSha", async () => {
  configure({
    endpoint: "http://x",
    secretKey: "sk_x",
    repoRoot: path.resolve(here, "../../.."),
    commitSha: "a".repeat(40),
    fetch: fakeFetch(),
  });
  await span("s", async () => {});
  await flushed();
  expect(sent()[0]!.source!.file).toBe("packages/sdk-node/src/handler.test.ts");
  expect(sent()[0]!.source!.line).toBeGreaterThan(0);
  expect(sent()[0]!.attributes.commitSha).toBe("a".repeat(40));
});

test("the path attribute and span carry no query string", async () => {
  await withDevLens("r", async () => new Response())(req(), {});
  await flushed();
  expect(JSON.stringify(sent())).not.toContain("a@b.co");
  expect(sent()[0]!.attributes.path).toBe("/api/register");
});

test("every batch sent matches the ingest contract (Task 4's IngestBatchSchema)", async () => {
  await withDevLens("POST /api/register", async () => {
    await span("svc", async () => {
      throw new Error("x");
    }).catch(() => {});
    return new Response(null, { status: 500 });
  })(req({ traceparent: formatTraceparent(T, P) }), {});
  await flushed();
  expect(bodies.length).toBeGreaterThan(0);
  for (const body of bodies) expect(IngestBatchSchema.safeParse(body).success).toBe(true);
});
