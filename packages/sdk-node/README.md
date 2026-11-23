# @devlens/sdk-node

The server half of DevLens instrumentation. It records each wrapped request (`http` span), each service function you wrap (`function` span) and each Prisma query (`database` span), links them to the browser's trace through the W3C `traceparent` header, and sends them to the dashboard's ingest endpoint with the project's **secret** key.

## Usage

```ts
// lib/devlens.ts: import this once from server code
import path from "node:path";
import { configure } from "@devlens/sdk-node";

configure({
  endpoint: process.env.DEVLENS_ENDPOINT!,       // e.g. http://localhost:3000/api/ingest
  secretKey: process.env.DEVLENS_SECRET_KEY!,    // sk_…: server only, never NEXT_PUBLIC_
  repoRoot: path.resolve(process.cwd(), "../.."), // source paths become repo-relative
  commitSha: process.env.RENDER_GIT_COMMIT,      // optional: enables GitHub source links
});
```

```ts
// lib/db.ts
import { instrumentPrisma } from "@devlens/sdk-node";
export const prisma = instrumentPrisma(new PrismaClient({ adapter }));

// app/api/register/route.ts
import { span, withDevLens } from "@devlens/sdk-node";
export const runtime = "nodejs"; // AsyncLocalStorage needs the Node runtime, not Edge

export const POST = withDevLens("POST /api/register", async (req) => {
  const input = await req.json();
  try {
    await span("RegistrationService.registerUser", () => registerUser(input));
    return new Response(null, { status: 201 });
  } catch (err) {
    if (isUniqueViolation(err)) return Response.json({ error: "Email already registered" }, { status: 409 });
    throw err;
  }
});
```

Use **static** names (`"POST /api/register"`, not `` `register ${email}` ``): names are stored, and redaction is only best effort. For `.ts` source locations in production, run Node with `NODE_OPTIONS=--enable-source-maps`.

## How it works

1. **`configure`** creates the exporter and remembers `repoRoot` and `commitSha`. Before it is called, every wrapper still runs your code but records nothing.
2. **`withDevLens(name, handler)`** reads the incoming `traceparent`. If the header is valid, the new `http` span continues that trace, with the browser's fetch span as its parent. If not, it starts a new trace. It then runs the handler inside `AsyncLocalStorage.run({ traceId, spanId }, …)`.
3. Inside that run, **`span(name, fn)`** and the **Prisma hook** read `getStore()` to find their parent and run their own work in a nested `run()`. AsyncLocalStorage follows the async chain across every `await`, so each request sees only its own spans, even when many requests interleave on one thread.
4. **Status** follows the plan's HTTP status policy:
   - A returned 4xx stays `ok` with `httpStatus`, because the app chose that answer.
   - A returned 5xx is `error`, with no invented exception.
   - A thrown exception is `error`, with its message and a `source` frame from its real stack, and is rethrown unchanged.
   - Function and Prisma spans are `error` whenever their code actually threw, even if the route later turns that into a 409.
5. **Source locations** come from `sourceFromStack`, which takes the first stack frame inside `repoRoot`. It skips `node:` internals, `node_modules` and the SDK's own files, and returns a repo-relative path with `/` separators. If no frame qualifies, the field is omitted, never guessed.
6. **Prisma spans** store only `{ model, operation }`, never query arguments. Prisma error messages can print the failing call with its arguments, so the SDK keeps only the error code and the last line, e.g. `P2002: Unique constraint failed on the fields: (`email`)`.
7. **Delivery.** When a span ends it is sanitized, serialized and queued. The wrapper then starts a flush without awaiting it. The exporter follows the fixed SDK delivery policy:
   - Holds at most 500 spans / 1 MiB, and drops spans over 16 KiB.
   - Sends at most 100 spans / 48 KiB per request, one request at a time, plus a 2 s timer.
   - Aborts a request at 2 s and retries once after 1 s, for network errors and 5xx only.
   - Discards a batch on any other 4xx. On 429 it also pauses sending for 60 s.

   `droppedCount` counts the losses.
8. **Isolation.** Every piece of telemetry code runs in `try/catch`, so a capture or delivery bug can only lose spans. It never changes what the app returns or throws. The exporter uses `fetch` directly, and the SDK never patches `fetch`, so delivery can't trace itself.

## Key files

| Path | Role |
|---|---|
| `src/index.ts` | Public exports |
| `src/context.ts` | `AsyncLocalStorage` context, `configure`, `span`, and span start/end helpers |
| `src/handler.ts` | `withDevLens`: request spans, `traceparent` continuation, HTTP status policy |
| `src/prisma.ts` | `instrumentPrisma`: `$extends` query hook, argument-free database spans |
| `src/stack.ts` | `sourceFromStack`: safe repo-relative source locations from V8 stack traces |
| `src/exporter.ts` | `createExporter`: bounded queue, batching, timeout, retry, 429 pause |
| `src/*.test.ts` | Vitest tests (fake `fetch`, fake timers, a stub Prisma client) |

Run `pnpm --filter @devlens/sdk-node test`.

## Viva questions

- **How do two concurrent requests avoid mixing up spans?** `withDevLens` runs each handler inside its own `AsyncLocalStorage.run(store, …)`. Node carries that store along the async chain of that request only, so `getStore()` inside `span()` or the Prisma hook returns the right parent across `await`s. The concurrency test interleaves two requests and checks there are two traces of two spans each.
- **What happens when the incoming `traceparent` is missing or malformed?** `parseTraceparent` returns `null` and the server starts a fresh trace. A forged but well-formed header is still accepted, which is why trace ids are a correlation hint and never authorization.
- **A route catches a Prisma P2002 and returns 409. Which spans are red?** The database span, and the function span if the throw passed through it: they really threw. The `http` span stays `ok` with `httpStatus: 409`, because the server answered on purpose. The browser fetch span is flagged red as an unsuccessful request, without an invented exception.
- **Why can't the SDK break the app?** Capture code is wrapped in `try/catch` and the original value or error is always returned or rethrown. Delivery is never awaited by the wrapper. `flush()` never rejects and gives up after two attempts within about 5 s. Memory is capped at 500 spans / 1 MiB. The cost is not zero, though: it is bounded CPU, memory and network.
- **Why does the Prisma span keep only the last line of the error?** Prisma messages can echo the failing call with its arguments (e.g. an email). The plan forbids storing query arguments, so the SDK keeps the error code and the final reason line, and the server sanitizer redacts again.
