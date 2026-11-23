import { beforeEach, expect, test } from "vitest";
import type { IngestBatch, Span } from "@devlens/shared";
import { flush } from "./context";
import { configure, instrumentPrisma, span } from "./index";

let bodies: IngestBatch[];
const sent = (): Span[] => bodies.flatMap((b) => b.spans);
const flushed = async () => {
  for (let i = 0; i < 3; i++) await flush();
};

type Hook = (p: { model: string; operation: string; args: unknown; query: (args: unknown) => Promise<unknown> }) => Promise<unknown>;

/**
 * A stand-in for a Prisma client: `$extends` returns a client whose
 * `user.create` runs through the extension's query hook, as Prisma does.
 */
function stubClient(impl: (args: unknown) => Promise<unknown>) {
  return {
    $extends(ext: { query: { $allModels: { $allOperations: Hook } } }) {
      const hook = ext.query.$allModels.$allOperations;
      return {
        $extends: this.$extends,
        user: { create: (args: unknown) => hook({ model: "User", operation: "create", args, query: impl }) },
      };
    },
    user: { create: impl },
  };
}

/** Shaped like a Prisma P2002 error: Prisma prints the call and its arguments above the reason. */
class FakeKnownRequestError extends Error {
  code = "P2002";
  constructor() {
    super(
      'Invalid `prisma.user.create()` invocation:\n\n{\n  data: {\n    email: "a@b.co"\n  }\n}\n\nUnique constraint failed on the fields: (`email`)',
    );
  }
}

beforeEach(() => {
  const mine: IngestBatch[] = (bodies = []);
  configure({
    endpoint: "http://ingest.test/api/ingest",
    secretKey: "sk_test",
    fetch: (async (_u: string | URL | Request, init?: RequestInit) => {
      mine.push(JSON.parse(String(init?.body)) as IngestBatch);
      return new Response(null, { status: 202 });
    }) as typeof fetch,
  });
});

test("prisma spans carry no args", async () => {
  const created = { id: "u1" };
  const prisma = instrumentPrisma(stubClient(async () => created));
  expect(await prisma.user.create({ data: { email: "a@b.co" } })).toBe(created);
  await flushed();
  expect(JSON.stringify(sent())).not.toContain("a@b.co");
  expect(sent()[0]).toMatchObject({ name: "User.create", kind: "database", status: "ok", attributes: { model: "User", operation: "create" } });
  expect(Object.keys(sent()[0]!.attributes).sort()).toEqual(["model", "operation"]);
});

test("a failed query is an error span with only the Prisma code and reason, and rethrows the same error", async () => {
  const err = new FakeKnownRequestError();
  const prisma = instrumentPrisma(stubClient(() => Promise.reject(err)));
  await expect(prisma.user.create({ data: { email: "a@b.co" } })).rejects.toBe(err);
  await flushed();
  expect(sent()[0]).toMatchObject({
    kind: "database",
    status: "error",
    errorMessage: "P2002: Unique constraint failed on the fields: (`email`)",
  });
  expect(JSON.stringify(sent())).not.toContain("a@b.co");
});

test("database spans are children of the current span", async () => {
  const prisma = instrumentPrisma(stubClient(async () => ({})));
  await span("RegistrationService.registerUser", async () => {
    await prisma.user.create({ data: {} });
  });
  await flushed();
  const [db, fn] = sent();
  expect(db!.parentSpanId).toBe(fn!.id);
  expect(db!.traceId).toBe(fn!.traceId);
});
