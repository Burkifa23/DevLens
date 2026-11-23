# DevLens MVP Implementation Plan

> **For agentic workers:** Follow `AGENTS.md` first. Execute task-by-task; workflow skills are optional when available. Steps use checkbox (`- [ ]`) syntax for tracking. Commit checkpoints below are suggestions, subject to human authorization under `AGENTS.md`; they never authorize a push or merge.

**Goal:** A developer instruments a Next.js app with the DevLens SDKs, reproduces a failure, opens the trace in an interactive React Flow explorer, isolates the failing path, and exports it as structured JSON context for an AI coding agent.

**Architecture:** pnpm monorepo. `packages/shared` holds the span schema, W3C `traceparent` helpers and the sanitizer. `packages/sdk-browser` and `packages/sdk-node` record spans and POST them to the dashboard's ingest endpoint. `apps/dashboard` (Next.js) stores spans in PostgreSQL, authenticates users, lists traces and renders the explorer. `apps/demo-app` is the instrumented sample app with two intentional failures. Spans are the only stored telemetry; traces are a `GROUP BY traceId`; visualizations use stored spans; AI exports use one server-side builder after authorization and sanitization.

**Tech Stack:** TypeScript (strict), Next.js App Router, React, Tailwind CSS, PostgreSQL 16, Prisma, Auth.js v5 (Credentials + bcryptjs), zod, `@xyflow/react` + `@dagrejs/dagre`, Vitest, Playwright, pnpm workspaces, Docker Compose (local Postgres), GitHub Actions.

**Authority:** `AGENTS.md` → `docs/architecture.md` → this plan. `chat.md` is historical only. Resolve conflicts before implementation; update affected interfaces, fixtures and tests together.

## Global Constraints

- Stack is Next.js + TypeScript end to end; no PHP/Laravel. TypeScript `strict: true` in every package.
- Every route handler sets `export const runtime = "nodejs"`; no Edge runtime.
- Hosting: dashboard and demo each run as one long-lived Node service (Render web service); PostgreSQL on Neon. Never serverless (e.g. Vercel functions): the SDK sends spans after the response, and a frozen function drops them. Prisma uses Neon's pooled URL as `DATABASE_URL` and the direct URL as `DIRECT_URL` (`directUrl`, for migrations). One instance per app, because the rate limiter is in memory.
- Database: PostgreSQL via Prisma. Styling: Tailwind. Auth: Auth.js. Tests: Vitest + Playwright.
- Trace propagation uses the W3C Trace Context `traceparent` header: `00-<32 hex traceId>-<16 hex spanId>-01`.
- Primary renderer is React Flow. No Mermaid in this plan.
- Never store passwords, raw request bodies, cookies, session tokens, `Authorization` values, or personal data. Database spans record model, operation, duration and status only — never query arguments.
- Source locations come only from captured stack frames. Never infer or fabricate one; omit the field instead.
- Telemetry failures (ingest down, bad key, network error) must not change application results or propagate exporter failures into business logic. Capture and delivery have measurable overhead; keep it bounded by the SDK delivery policy below, never claim zero overhead.
- The browser may only ever hold the **public** key; the public key may only submit spans with `kind: "browser"` with an allowed Origin header. This is browser policy, not client authentication: non-browser clients can forge Origin and fabricate browser spans/trace IDs. Server SDK uses the **secret** key. Secret keys are stored hashed (SHA-256) and shown once.
- **Documentation is part of done** (the viva is 50% of the grade — every member must be able to explain every file):
  - Every exported function, type and React component gets a TSDoc comment: what it does, why it exists, and any non-obvious rule it enforces (e.g. "public key may only submit browser spans — see Security model").
  - Inline comments explain *why*, never restate *what*. Every security check and every `ponytail:` shortcut is commented.
  - Each task updates the README named in the Documentation map below with three sections for its part: **How it works** (short prose, the flow in order), **Key files** (path → one-line role), **Viva questions** (3–5 questions with short answers a member must be able to give).
  - If a task changes the end-to-end flow, data model, or security model, it updates `docs/architecture.md` in the same commit.
  - A task's reviewer rejects it if any of the above is missing.
- Out of scope (separate future plans): MCP server, Graphify enrichment, AI root-cause analysis, autonomous fixes, WebSocket live streaming, non-Next.js frameworks, arbitrary code execution.

## SDK delivery policy (Tasks 5–6)

Both exporters share these fixed MVP limits; do not add configuration knobs:

- Sanitize and serialize on enqueue; drop spans over 16 KiB serialized UTF-8. Retain at most 500 spans AND 1 MiB total serialized span bytes, including any in-flight batch; drop newest on overflow and keep only a numeric local dropped counter (never recursively emit telemetry about it).
- Batch at most 100 spans and 48 KiB including the complete JSON/key envelope; discard a span that cannot fit. One request in flight, one 2 s flush timer; overlapping flush calls coalesce. Node request wrappers schedule delivery without awaiting it. Exporter requests bypass instrumentation to avoid recursive spans.
- Abort each exporter request after 2 s. At most one retry, after 1 s, for network/timeout/5xx only. Other 4xx are discarded; on 429 discard the batch and pause sending for 60 s while queue caps still apply. Retain original IDs for idempotency. Release every batch after success or final failure; no persistent queue or unbounded drain loop. `flush()` handles only the current batch and resolves after at most two attempts plus backoff (5 s); it never rejects.
- On pagehide, send at most one 48 KiB batch by beacon; use keepalive fetch only if beacon returns false, then no retries. Beacon acceptance is not delivery acknowledgment. Page close, process exit, queue pressure and outages can lose spans; incomplete traces must remain usable.
- Use fake timers and a hanging fetch to verify limits, abort, retry count, dropped counters, coalescing, 429 pause, shutdown loss and unchanged application results. Measure overhead with instrumentation on/off on the demo and record workload/timing; this is not a zero-cost guarantee.

## HTTP status policy (Tasks 5–6, 8–10)

`SpanStatus` remains `ok | error`; it is a DevLens display flag, not the full OpenTelemetry status enum. Record `httpStatus` for received responses. Server HTTP spans: returned 4xx stay `ok`, returned 5xx are `error`; a thrown exception is `error`, with captured error/source, and is rethrown unchanged. Function/database spans mark actual throws as `error`, even when the route later handles them as a 409. Browser fetch spans flag 4xx/5xx as `error` to show unsuccessful requests, but do not invent an exception message/source for a response; fetch still resolves. Network rejection records the actual exception and still rejects. A tracked root reflects a thrown callback or failed child, without fabricating an exception. Inspector/export must distinguish an HTTP response status from captured exception evidence; an error flag alone is not proof of an unhandled bug or root cause.

References: [W3C Trace Context, security and cross-origin risks](https://www.w3.org/TR/trace-context/#security-considerations), [OpenTelemetry HTTP status conventions](https://opentelemetry.io/docs/specs/semconv/http/http-spans/#status).

## Review Focus

1. **Concurrent actions** — two registrations submitted at the same time from one page must land in two distinct traces with no cross-linked spans. (Tests: Task 6, Task 11.)
2. **Request never reaches the server** — a network/CORS failure must produce a browser-only trace whose fetch span is the failure, rendered without crashing. (Tests: Task 6, Task 9.)
3. **Missing or late parents** — server spans can arrive before browser spans, and a browser batch can be lost on page close; a span whose parent is absent is shown as a root, flagged `orphan`. (Test: Task 9.)
4. **Sensitive data in error text** — Prisma's unique-constraint message, an `Authorization` attribute, or an email in an exception message must be redacted before storage. (Tests: Task 1, Task 4.)
5. **Oversized input** — a 5 MB batch, 10,000 spans, or a 500-span trace must be rejected (ingest) or collapsed (explorer) rather than hanging the page. (Tests: Task 4, Task 9.)

## Workstreams (5 members)

| Member | Tasks |
|---|---|
| 1 Instrumentation | 5, 6 |
| 2 Backend & security | 4, 3 |
| 3 Data & auth | 2, 8 |
| 4 Visualization | 9, 10 |
| 5 Product & integration | 1, 7, 11 |

## Documentation map

| Tasks | README they update |
|---|---|
| 1 | `packages/shared/README.md` |
| 2, 3, 4, 8, 9, 10 | `apps/dashboard/README.md` (one section per task: Auth, Projects & keys, Ingest, Trace list, Trace graph, Explorer) |
| 5 | `packages/sdk-node/README.md` (includes an install/usage snippet) |
| 6 | `packages/sdk-browser/README.md` (includes an install/usage snippet) |
| 7 | `apps/demo-app/README.md` (how to trigger each failure scenario) |
| 11 | root `README.md`, `docs/architecture.md` (deployed URLs, test results) |

Task 1 lands first; then 2→3→4 and 5/6 run in parallel; 7 needs 4–6; 8–10 need 4; 11 needs everything. Each owner walks the group through their task before merge (viva prep). Integration is shared: every task verifies its producer/consumer boundary with the adjacent owner before completion; Member 5 coordinates CI/deployment, while failures are fixed by the owning subsystem. Members 1 and 4 jointly review span fixtures, HTTP semantics and graph coverage. Tasks 5–6 may develop against Task 4 fixtures, but are not integrated until the real endpoint passes. Task 9 needs Tasks 1–2 contracts; Task 10 needs Tasks 3, 8 and 9.

---

### Task 1: Monorepo scaffold + shared trace contract

**Files:**
- Create: `package.json`, `pnpm-workspace.yaml`, `tsconfig.base.json`, `docker-compose.yml`, `docker/init.sql`, `.env.example`, `.gitignore`
- Create: `packages/shared/package.json`, `packages/shared/src/index.ts`, `packages/shared/src/span.ts`, `packages/shared/src/traceparent.ts`, `packages/shared/src/sanitize.ts`
- Test: `packages/shared/src/*.test.ts`

**Interfaces:**
- Produces (from `@devlens/shared`):
  - `SpanKind = "browser" | "http" | "function" | "database"`; `SpanStatus = "ok" | "error"`
  - `SpanSchema` (zod) and `type Span = { id: string /*16 hex*/; traceId: string /*32 hex*/; parentSpanId?: string; name: string /*1..200*/; kind: SpanKind; startTime: string /*ISO*/; durationMs: number /*int ≥0*/; status: SpanStatus; errorMessage?: string; source?: { file: string; line: number }; attributes: Record<string, string | number | boolean> }` (wire input); `StoredSpan = Span & { ingestSource: "browser-public" | "server-secret" }` for reads/visualizations/exports. The ingest server derives `ingestSource` from the verified key; reject any client-supplied provenance field.
  - `SpanSchema` and batch schema are strict (reject unknown top-level fields, including provenance); at most 20 attributes, keys ≤64 characters, string values ≤2000 characters, errorMessage ≤8000 characters and source.file ≤500 characters; request byte limit remains authoritative. Reject nonfinite durations/numbers.
  - `IngestBatchSchema` = `{ key: string; spans: Span[] /*1..500*/ }`
  - `newTraceId(): string`, `newSpanId(): string` (via `crypto.getRandomValues`, works in browser and Node)
  - `formatTraceparent(traceId, spanId): string`, `parseTraceparent(header: string | null): { traceId: string; parentSpanId: string } | null`
  - `sanitizeSpan<T extends Span>(span: T): T` — preserves server-derived provenance on StoredSpan while sanitizing telemetry fields; provenance never comes from wire input

- [x] **Step 1: Scaffold workspace**

Root `package.json` scripts: `test` → `pnpm -r test`, `typecheck` → `pnpm -r typecheck`, `lint` → `pnpm -r lint`. `docker-compose.yml`: `postgres:16` on 5432; `docker/init.sql` creates databases `devlens`, `devlens_test`, `demo`. `.env.example` lists every env var used in later tasks.

- [x] **Step 2: Write failing tests**

```ts
// traceparent.test.ts
test("round-trips", () => {
  const t = newTraceId(), s = newSpanId();
  expect(t).toMatch(/^[0-9a-f]{32}$/); expect(s).toMatch(/^[0-9a-f]{16}$/);
  expect(parseTraceparent(formatTraceparent(t, s))).toEqual({ traceId: t, parentSpanId: s });
});
test.each([null, "", "garbage", "00-" + "0".repeat(32) + "-" + "a".repeat(16) + "-01", "01-zz-zz-01"])(
  "rejects %s", (h) => expect(parseTraceparent(h)).toBeNull());   // all-zero traceId is invalid per W3C

// span.test.ts
test("rejects bad ids, unknown kind, >500 spans", () => {
  expect(SpanSchema.safeParse({ ...validSpan, id: "xyz" }).success).toBe(false);
  expect(SpanSchema.safeParse({ ...validSpan, kind: "shell" }).success).toBe(false);
  expect(IngestBatchSchema.safeParse({ key: "pk_x", spans: Array(501).fill(validSpan) }).success).toBe(false);
});

// sanitize.test.ts
test("drops sensitive attribute keys", () => {
  const s = sanitizeSpan({ ...validSpan, attributes: { authorization: "Bearer x", password: "p", cookie: "c", httpStatus: 409 } });
  expect(s.attributes).toEqual({ httpStatus: 409 });
});
test("redacts emails and bearer tokens in messages", () => {
  const s = sanitizeSpan({ ...validSpan, errorMessage: "dup a.b@x.com token Bearer abc.def" });
  expect(s.errorMessage).toBe("dup [email] token Bearer [redacted]");
});
test("unknown attributes and unsafe source are removed", () => {
  const clean = sanitizeSpan({ ...validSpan, source: { file: "../private.ts", line: 1 },
    attributes: { customPayload: "private data", httpStatus: 409 } });
  expect(clean.attributes).toEqual({ httpStatus: 409 });
  expect(clean.source).toBeUndefined();
});
test("truncates long strings to 500 chars", () => {
  expect(sanitizeSpan({ ...validSpan, errorMessage: "x".repeat(2000) }).errorMessage!.length).toBe(500);
});
```

- [x] **Step 3: Run** `pnpm --filter @devlens/shared test` — Expected: FAIL (modules missing).

- [x] **Step 4: Implement** `span.ts`, `traceparent.ts`, `sanitize.ts`. Use an explicit allowlist of diagnostic attributes (`method`, `path`, `httpStatus`, `model`, `operation`, `commitSha`); drop unknown keys, strip query/fragment/userinfo from request URLs and avoid dynamic identifiers in names/paths. Stack locations must be repo-relative, with no absolute paths, traversal, URL schemes or control characters; line must be a positive integer. Free-text redaction is best effort, not a guarantee of removing all PII; callers must use static labels and safe messages. Sensitive-key regex: `/pass|secret|token|auth|cookie|session|email|card/i`. Sanitizer applies to `name`, `errorMessage`, string attribute values.

- [x] **Step 5: Run** `pnpm --filter @devlens/shared test` — Expected: PASS.

- [ ] **Step 6: Suggested commit checkpoint (only if authorized)** `feat(shared): monorepo scaffold and trace contract`

---

### Task 2: Dashboard app, database schema, auth

**Files:**
- Create: `apps/dashboard/` via `create-next-app` (TS, Tailwind, App Router), `apps/dashboard/prisma/schema.prisma`, `apps/dashboard/prisma/seed.ts`, `apps/dashboard/lib/db.ts`, `apps/dashboard/auth.ts`, `apps/dashboard/middleware.ts`, `apps/dashboard/app/(auth)/login/page.tsx`, `apps/dashboard/app/(auth)/signup/page.tsx`, `apps/dashboard/app/(auth)/actions.ts`
- Test: `apps/dashboard/test/auth.test.ts`, `apps/dashboard/test/setup.ts`

**Interfaces:**
- Consumes: nothing beyond Task 1 scaffold.
- Produces:
  - Prisma models:
    ```prisma
    model User    { id String @id @default(cuid()); email String @unique; passwordHash String; createdAt DateTime @default(now()); projects Project[] }
    model Project { id String @id @default(cuid()); name String; ownerId String; owner User @relation(fields:[ownerId], references:[id], onDelete: Cascade)
                    publicKey String @unique; secretKeyHash String @unique; allowedOrigins String[]; repoUrl String?; createdAt DateTime @default(now()); spans Span[] }
    model Span    { projectId String; id String; traceId String; parentSpanId String?; name String; kind String; startTime DateTime; durationMs Int
                    status String; ingestSource String; errorMessage String?; sourceFile String?; sourceLine Int?; attributes Json @default("{}")
                    project Project @relation(fields:[projectId], references:[id], onDelete: Cascade)
                    @@id([projectId, id]); @@index([projectId, traceId]); @@index([projectId, startTime]) }
    ```
  - `prisma` singleton from `lib/db.ts`
  - `auth()` / `signIn` / `signOut` from `auth.ts` (JWT sessions; `session.user.id` populated)
  - `signUp(formData: FormData): Promise<{ error?: string }>` server action
  - `requireUserId(): Promise<string>` in `lib/session.ts` — redirects to `/login` when signed out
  - Test helper `resetDb()` in `test/setup.ts` (truncates all tables in `devlens_test`)

- [ ] **Step 1: Write failing tests**

```ts
test("signUp stores a bcrypt hash, never the password", async () => {
  await signUp(form({ email: "a@b.co", password: "correct horse 1" }));
  const u = await prisma.user.findUniqueOrThrow({ where: { email: "a@b.co" } });
  expect(u.passwordHash).not.toContain("correct horse");
  expect(await bcrypt.compare("correct horse 1", u.passwordHash)).toBe(true);
});
test("signUp rejects duplicate email and passwords < 10 chars", async () => {
  await signUp(form({ email: "a@b.co", password: "correct horse 1" }));
  expect(await signUp(form({ email: "a@b.co", password: "correct horse 1" }))).toEqual({ error: "Email already registered" });
  expect(await signUp(form({ email: "c@d.co", password: "short" }))).toEqual({ error: "Password must be at least 10 characters" });
});
```

- [ ] **Step 2: Run** `pnpm --filter dashboard test` — Expected: FAIL.

- [ ] **Step 3: Implement** schema (datasource `url = env("DATABASE_URL")`, `directUrl = env("DIRECT_URL")`) + `prisma migrate dev --name init`, `auth.ts` (Credentials provider, bcryptjs cost 12), `signUp`, login/signup pages, `middleware.ts` protecting `/projects/:path*`. Seed creates `demo@devlens.test` with password from `SEED_PASSWORD`.

- [ ] **Step 4: Run** `pnpm --filter dashboard test` — Expected: PASS.

- [ ] **Step 5: Suggested commit checkpoint (only if authorized)** `feat(dashboard): schema and credential auth`

---

### Task 3: Projects and API keys

**Files:**
- Create: `apps/dashboard/lib/projects.ts`, `apps/dashboard/app/projects/page.tsx`, `apps/dashboard/app/projects/actions.ts`, `apps/dashboard/app/projects/[projectId]/settings/page.tsx`
- Test: `apps/dashboard/test/projects.test.ts`

**Interfaces:**
- Consumes: `prisma`, `requireUserId()` (Task 2).
- Produces:
  - `createProject(ownerId: string, name: string, allowedOrigins: string[], repoUrl?: string): Promise<{ project: Project; secretKey: string }>` — `repoUrl` must match `^https://github\.com/[\w.-]+/[\w.-]+$` or it throws `"Invalid repository URL"` (it is later rendered as a link, so this blocks `javascript:` URLs); `publicKey = "pk_" + 24 random hex`, `secretKey = "sk_" + 32 random hex`, store `sha256(secretKey)` hex.
  - `getOwnedProject(userId: string, projectId: string): Promise<Project | null>` — the single ownership check every dashboard read uses.
  - `hashKey(key: string): string`

- [ ] **Step 1: Write failing tests**

```ts
test("secret key is returned once and stored hashed", async () => {
  const { project, secretKey } = await createProject(userA, "Demo", ["http://localhost:3001"]);
  expect(secretKey).toMatch(/^sk_[0-9a-f]{32}$/); expect(project.publicKey).toMatch(/^pk_[0-9a-f]{24}$/);
  expect(project.secretKeyHash).toBe(hashKey(secretKey)); expect(JSON.stringify(project)).not.toContain(secretKey);
});
test("another user's project is invisible", async () => {
  const { project } = await createProject(userA, "Demo", []);
  expect(await getOwnedProject(userB, project.id)).toBeNull();
});
test("rejects malformed origins", async () => {
  await expect(createProject(userA, "x", ["not a url"])).rejects.toThrow("Invalid origin");
});
test("repoUrl accepts GitHub repos only", async () => {
  await expect(createProject(userA, "x", [], "https://github.com/team/DevLens")).resolves.toBeDefined();
  for (const bad of ["javascript:alert(1)", "http://github.com/a/b", "https://evil.com/a/b", "https://github.com/a"])
    await expect(createProject(userA, "x", [], bad)).rejects.toThrow("Invalid repository URL");
});
```

- [ ] **Step 2: Run** — Expected: FAIL. **Step 3: Implement**; the create form shows the secret key once with a copy button. Origins normalized with `new URL(o).origin`. **Step 4: Run** — Expected: PASS.

- [ ] **Step 5: Suggested commit checkpoint (only if authorized)** `feat(dashboard): projects and API keys`

---

### Task 4: Ingest endpoint

**Files:**
- Create: `apps/dashboard/app/api/ingest/route.ts`, `apps/dashboard/lib/ingest.ts`, `apps/dashboard/lib/rate-limit.ts`
- Test: `apps/dashboard/test/ingest.test.ts`

**Interfaces:**
- Consumes: `IngestBatchSchema`, `sanitizeSpan` (Task 1); `prisma`, `hashKey` (Tasks 2–3).
- Produces: `POST /api/ingest`, body `IngestBatch` as JSON sent with `Content-Type: text/plain` (a CORS "simple request" — no preflight). Responses:
  - `202 { accepted: number }`; duplicate `(projectId, id)` silently skipped (`createMany({ skipDuplicates: true })`)
  - `400` invalid JSON/schema · `401` unknown key · `403` public key with disallowed `Origin` or a non-`browser` span · `413` body > 1 MiB (check `content-length` and actual byte length) · `429` over 600 spans/min per project
  - When the request had an allowed `Origin`, response carries `Access-Control-Allow-Origin: <origin>` and `Vary: Origin`, including errors after origin resolution. No credentials support or wildcard origins. This ingest POST is distinct from traced application fetch calls, which may require preflight (Task 6).
- Public-key ingestion requires a non-null exact normalized allowed Origin; missing/`null` Origin is 403. Origin is forgeable outside browsers. Assign `ingestSource: "browser-public"` or `"server-secret"` on the server after key validation, never from span attributes. Browser spans and parent/trace IDs are untrusted claims; secret-key provenance means possession of the server key, not verified truth. Do not use correlation for authorization or claim it proves causality. Preserve this label in reads, inspector and AI exports. First stored `(projectId, id)` wins: collisions cannot overwrite evidence; public claims can still pollute/collide with a trace, an explicit MVP limitation.
- Rate limit attempted spans (including duplicates) before insertion, and expire idle limiter entries. 600 spans/minute is a conservative demo default, not a validated production capacity; load-test a normal and concurrent demo workload and record accepted/dropped counts before release. Origin/schema/limits reduce abuse but do not prevent spoofing, quota exhaustion or storage growth; public internet use needs additional abuse controls/retention and key rotation beyond this MVP.
- `handleIngest(req: Request): Promise<Response>` in `lib/ingest.ts` (route just re-exports it, so tests call it directly).

- [ ] **Step 1: Write failing tests** (real `devlens_test` DB)

```ts
test("secret key stores sanitized spans", async () => {
  const res = await handleIngest(post({ key: sk, spans: [{ ...span, errorMessage: "Unique constraint failed on (email) for a@b.co" }] }));
  expect(res.status).toBe(202);
  expect((await prisma.span.findFirstOrThrow()).ingestSource).toBe("server-secret");
  expect((await prisma.span.findFirstOrThrow()).errorMessage).toBe("Unique constraint failed on (email) for [email]");
});
test("public key: allowed origin + browser kind only", async () => {
  expect((await handleIngest(post({ key: pk, spans: [browserSpan] }))).status).toBe(403);
  expect((await handleIngest(post({ key: pk, spans: [browserSpan] }, "null"))).status).toBe(403);
  expect((await handleIngest(post({ key: pk, spans: [browserSpan] }, "http://localhost:3001"))).status).toBe(202);
  expect((await handleIngest(post({ key: pk, spans: [browserSpan] }, "https://evil.example"))).status).toBe(403);
  expect((await handleIngest(post({ key: pk, spans: [{ ...browserSpan, kind: "database" }] }, "http://localhost:3001"))).status).toBe(403);
});
test("rejects unknown key, bad schema, oversize, flood", async () => {
  expect((await handleIngest(post({ key: "sk_nope", spans: [span] }))).status).toBe(401);
  expect((await handleIngest(rawPost("{not json"))).status).toBe(400);
  expect((await handleIngest(rawPost("x".repeat(5_000_000)))).status).toBe(413);
  expect((await handleIngest(post({ key: sk, spans: manySpans(500) }))).status).toBe(202);
  expect((await handleIngest(post({ key: sk, spans: manySpans(200) }))).status).toBe(429); // 700 > 600/min
});
test("provenance is server-derived even for forged Origin", async () => {
  await handleIngest(post({ key: pk, spans: [browserSpan] }, "http://localhost:3001"));
  expect((await prisma.span.findFirstOrThrow()).ingestSource).toBe("browser-public");
  expect((await handleIngest(post({ key: pk, spans: [{ ...browserSpan, ingestSource: "server-secret" }] }, "http://localhost:3001"))).status).toBe(400);
});
test("re-sent batch is idempotent", async () => {
  await handleIngest(post({ key: sk, spans: [span] })); await handleIngest(post({ key: sk, spans: [span] }));
  expect(await prisma.span.count()).toBe(1);
});
```

- [ ] **Step 2: Run** — Expected: FAIL.

- [ ] **Step 3: Implement.** Order: size → JSON → schema → key lookup (`pk_` by `publicKey`, `sk_` by `secretKeyHash`) → origin/kind → rate limit → sanitize → attach server-derived ingestSource → insert. `rate-limit.ts`: fixed 60 s window `Map<projectId, {windowStart, count}>`, marked `// ponytail: in-memory, single instance only; move to Postgres/Redis if horizontally scaled`.

- [ ] **Step 4: Run** — Expected: PASS. **Step 5: Suggested commit checkpoint (only if authorized)** `feat(dashboard): span ingest endpoint`

---

### Task 5: Node SDK

**Files:**
- Create: `packages/sdk-node/src/index.ts`, `context.ts`, `exporter.ts`, `handler.ts`, `prisma.ts`, `stack.ts`
- Test: `packages/sdk-node/src/*.test.ts`

**Interfaces:**
- Consumes: `Span`, `newSpanId`, `newTraceId`, `parseTraceparent` (Task 1); ingest contract (Task 4).
- Produces (from `@devlens/sdk-node`):
  - `configure(opts: { endpoint: string; secretKey: string; repoRoot?: string /*default process.cwd()*/; commitSha?: string; fetch?: typeof fetch }): void` — when `commitSha` is set, every span gets `attributes.commitSha` (used by the dashboard to build GitHub source links).
  - `withDevLens<C>(name: string, handler: (req: Request, ctx: C) => Promise<Response>): (req: Request, ctx: C) => Promise<Response>` — `kind: "http"` span; continues `traceparent` if valid, else new trace; `status = "error"` when handler throws or response status ≥ 500 (returned 4xx stay `ok`); attributes `{ method, path, httpStatus }`; on throw sets `errorMessage` and `source = sourceFromStack(err.stack)`, then rethrows unchanged; schedules a bounded exporter flush without awaiting it.
  - `span<T>(name: string, fn: () => Promise<T>): Promise<T>` — `kind: "function"` child of current span; captures call-site `source`.
  - `instrumentPrisma<T extends PrismaClient>(client: T): T` — `$extends` query hook; span name `"${model}.${operation}"`, `kind: "database"`, attributes `{ model, operation }` only; error message from the Prisma error.
  - `sourceFromStack(stack: string | undefined): { file: string; line: number } | undefined` — first eligible frame inside repoRoot, excluding `node_modules`, `node:`, or `sdk-node`; omit if unavailable/outside the repo; paths made relative to `repoRoot`, always with `/` separators (Windows too).
  - `createExporter(opts): { push(span: Span): void; flush(): Promise<void>; readonly droppedCount: number }` — `opts` is `{ endpoint: string; key: string; fetch?: typeof fetch }` (Node configure maps secretKey to key, browser init maps publicKey); obeys the SDK delivery policy above; never rejects; exposes a read-only numeric `droppedCount` for local diagnostics/tests.
- Context: `AsyncLocalStorage<{ traceId: string; spanId: string }>`.
- Both SDK packages test `createExporter` with fake timers/injected fetch: 501st span increments `droppedCount`; bytes hit the 1 MiB cap before count for large spans; >16 KiB spans drop; each JSON envelope ≤48 KiB and ≤100 spans. A never-resolving fetch observes AbortSignal at 2 s; at most two attempts/5 s per flush; concurrent flushes produce one in-flight request. Test network/5xx retry with original IDs, 400/401/403 discard, 429 discard + 60 s pause, no recursive instrumentation and queue memory release. Browser tests additionally cover beacon false/true, ≤one fallback and no pagehide retry. These are required tests in the existing `src/*.test.ts` files, not optional performance aspirations.
- Required wrapper tests also cover returned 500 without fabricated exception, a thrown function/Prisma error later handled as 409, identical returned response/value or original thrown Error when capture/export fails, and no waiting for a hanging exporter. SDK-internal capture failures are isolated from application failures.


- [ ] **Step 1: Write failing tests** (fake `fetch` capturing bodies)

```ts
test("continues the incoming trace and nests spans", async () => {
  const h = withDevLens("POST /api/register", async () => { await span("svc", async () => {}); return new Response(null, { status: 201 }); });
  await h(req({ traceparent: formatTraceparent(T, P) }), {}); await flushed();
  const [svc, http] = sent();
  expect(http).toMatchObject({ traceId: T, parentSpanId: P, kind: "http", status: "ok" });
  expect(svc).toMatchObject({ traceId: T, parentSpanId: http.id, kind: "function" });
});
test("returned 4xx is not an exception; thrown errors still propagate", async () => {
  await withDevLens("x", async () => new Response(null, { status: 409 }))(req(), {});
  await expect(withDevLens("y", async () => { throw new TypeError("boom"); })(req(), {})).rejects.toThrow("boom");
  await flushed();
  expect(sent().map((s) => s.status)).toEqual(["ok", "error"]);
  expect(sent()[0].attributes.httpStatus).toBe(409);
  expect(sent()[0].errorMessage).toBeUndefined();
  expect(sent()[1].source?.file).toMatch(/handler\.test\.ts$/);
});
test("concurrent requests do not share context", async () => {
  await Promise.all([1, 2].map((i) => withDevLens("r", async () => { await sleep(5 * i); await span("s" + i, async () => {}); return new Response(); })(req(), {})));
  await flushed();
  const byTrace = groupBy(sent(), "traceId");
  expect(Object.keys(byTrace)).toHaveLength(2);
  for (const spans of Object.values(byTrace)) expect(spans).toHaveLength(2);
});
test("ingest failure never surfaces to the app", async () => {
  configure({ endpoint: "http://x", secretKey: "sk_x", fetch: () => Promise.reject(new Error("down")) });
  expect((await withDevLens("r", async () => new Response("ok"))(req(), {})).status).toBe(200);
});
test("prisma spans carry no args", async () => { /* stub client; run user.create({ data: { email: "a@b.co" } }) */
  expect(JSON.stringify(sent())).not.toContain("a@b.co");
  expect(sent()[0]).toMatchObject({ name: "User.create", kind: "database", attributes: { model: "User", operation: "create" } });
});
test("source is repo-relative and spans carry commitSha", async () => {
  configure({ endpoint: "http://x", secretKey: "sk_x", repoRoot: path.resolve(__dirname, "../../.."), commitSha: "a".repeat(40), fetch: fakeFetch });
  await span("s", async () => {}); await flushed();
  expect(sent()[0].source!.file).toBe("packages/sdk-node/src/handler.test.ts");
  expect(sent()[0].attributes.commitSha).toBe("a".repeat(40));
});
```

- [ ] **Step 2: Run** `pnpm --filter @devlens/sdk-node test` — Expected: FAIL. **Step 3: Implement.** **Step 4: Run** — Expected: PASS.

- [ ] **Step 5: Suggested commit checkpoint (only if authorized)** `feat(sdk-node): request, function and prisma spans`

---

### Task 6: Browser SDK

**Files:**
- Create: `packages/sdk-browser/src/index.ts`, `packages/sdk-browser/src/exporter.ts`
- Test: `packages/sdk-browser/src/index.test.ts` (Vitest `environment: "jsdom"`)

**Interfaces:**
- Consumes: `Span`, `newTraceId`, `newSpanId`, `formatTraceparent` (Task 1); ingest contract (Task 4).
- Produces (from `@devlens/sdk-browser`):
  - `init(opts: { endpoint: string; publicKey: string; traceOrigins?: string[] }): void` — `traceOrigins` defaults to `[]` and lists exact cross-origin application API origins approved for propagation (distinct from dashboard ingest allowedOrigins); same-origin propagates by default. Also registers `window` `error` and `unhandledrejection` listeners, each recorded as a standalone root span `name: "uncaught error"`, `status: "error"`.
  - `track<T>(name: string, fn: (fetch: typeof window.fetch) => Promise<T>): Promise<T>` — root `kind: "browser"` span; the `fetch` passed in creates a child span `"fetch <METHOD> <path>"`, sets `traceparent` to that child's id only for same-origin or explicitly allowlisted destinations (never for `mode: "no-cors"`), records `httpStatus`, marks error on network failure or `!res.ok`. Root span is error if `fn` throws or any child failed. Preserve response/rejection behavior and existing Request/init headers; do not add trace headers to unapproved destinations or exporter calls.
  - Exporter follows the shared SDK delivery policy, including the pagehide beacon/keepalive limit; `Content-Type: text/plain`. Never throws. Implement/export the same `createExporter(opts)` interface as Task 5 in this package, including `droppedCount`.
- `traceparent` is not CORS-safelisted: adding it to a cross-origin application request can trigger OPTIONS preflight. The destination API owner must allow the calling origin, method and `traceparent` in `Access-Control-Allow-Headers` (plus existing headers such as `content-type`); configure credentials only if the app needs them. No automatic retry without the header: retrying business requests risks duplicate side effects. Unapproved destinations are still recorded locally but have no propagated link. Document redirects to other origins as unsupported for reliable propagation; do not trace redirecting third-party endpoints.
- Test same-origin propagation, an approved cross-origin API with successful OPTIONS, rejection when that API omits `traceparent`, and an unapproved origin receiving no added header. Real-browser preflight checks belong in Task 11; jsdom mocks alone cannot prove CORS compatibility.
- Context is passed explicitly through the `fetch` argument — no global "current span" — so overlapping actions cannot cross-link.

- [ ] **Step 1: Write failing tests**

```ts
test("fetch inside track propagates traceparent from the fetch span", async () => {
  await track("Submit registration", (f) => f("/api/register", { method: "POST" }));
  const hdr = lastRequestHeaders().get("traceparent")!;
  const [fetchSpan, root] = flushedSpans();
  expect(hdr).toBe(formatTraceparent(root.traceId, fetchSpan.id));
  expect(fetchSpan).toMatchObject({ parentSpanId: root.id, name: "fetch POST /api/register" });
});
test("409 resolves normally and flags an unsuccessful request, not an exception", async () => {
  mockFetchStatus(409);
  expect((await track("a", (f) => f("/x"))).status).toBe(409);
  expect(flushedSpans().map((s) => s.status)).toEqual(["error", "error"]);
  expect(flushedSpans()[0].attributes.httpStatus).toBe(409);
  expect(flushedSpans().every((s) => s.errorMessage === undefined)).toBe(true);
});
test("network failure is captured without a server span", async () => {
  mockFetchReject(new TypeError("Failed to fetch"));
  await expect(track("a", (f) => f("/x"))).rejects.toThrow();
  expect(flushedSpans()[0]).toMatchObject({ status: "error", errorMessage: "Failed to fetch" });
});
test("overlapping actions get separate traces", async () => {
  await Promise.all([track("a", (f) => f("/x")), track("b", (f) => f("/y"))]);
  const traces = new Set(flushedSpans().map((s) => s.traceId));
  expect(traces.size).toBe(2);
});
test("only kind 'browser' is ever emitted", async () => {
  await track("a", (f) => f("/x")); expect(flushedSpans().every((s) => s.kind === "browser")).toBe(true);
});
```

- [ ] **Step 2: Run** `pnpm --filter @devlens/sdk-browser test` — Expected: FAIL. **Step 3: Implement.** **Step 4: Run** — Expected: PASS.

- [ ] **Step 5: Suggested commit checkpoint (only if authorized)** `feat(sdk-browser): tracked actions and error capture`

---

### Task 7: Instrumented demo app

**Files:**
- Create: `apps/demo-app/` (Next.js, Tailwind), `apps/demo-app/prisma/schema.prisma` (`model DemoUser { id String @id @default(cuid()); email String @unique; name String }`), `apps/demo-app/lib/db.ts`, `apps/demo-app/lib/devlens.ts`, `apps/demo-app/services/registration.ts`, `apps/demo-app/app/api/register/route.ts`, `apps/demo-app/app/api/report/route.ts`, `apps/demo-app/app/page.tsx`, `apps/demo-app/app/devlens-init.tsx`
- Test: covered end to end by Task 11.

**Interfaces:**
- Consumes: `configure`, `withDevLens`, `span`, `instrumentPrisma` (Task 5); `init`, `track` (Task 6).
- Produces: demo on port 3001 with:
  - `POST /api/register` `{ email, name }` → `span("RegistrationService.registerUser")` → `prisma.demoUser.create`; Prisma `P2002` → `409 { error: "Email already registered" }`; success → `201`.
  - `POST /api/report` → throws `TypeError` from `services/report.ts` (unhandled → 500, has a source frame).
  - Home page: registration form (submits via `track("Submit registration", ...)`), "Generate report" button, "Register twice concurrently" button (fires two `track("Submit registration (concurrent)", ...)` calls at once with different emails — used by Task 11).
- Env: `NEXT_PUBLIC_DEVLENS_ENDPOINT`, `NEXT_PUBLIC_DEVLENS_KEY` (pk), `DEVLENS_SECRET_KEY` (sk), `DATABASE_URL` (→ `demo` db). `lib/devlens.ts` calls `configure({ endpoint, secretKey, repoRoot: path.resolve(process.cwd(), "../.."), commitSha: process.env.RENDER_GIT_COMMIT })` so source paths look like `apps/demo-app/services/registration.ts` (Render sets `RENDER_GIT_COMMIT` on deploy; locally it is unset and no links are made). `next.config.ts`: `transpilePackages: ["@devlens/sdk-browser", "@devlens/sdk-node", "@devlens/shared"]`, `experimental.serverSourceMaps: true`; start with `NODE_OPTIONS=--enable-source-maps` so `source` points at `.ts` files.

- [ ] **Step 1: Build it.** Dashboard seed (Task 2) gains a project for the demo user with origin `http://localhost:3001` and prints its keys.
- [ ] **Step 2: Verify manually:** `docker compose up -d`, run both apps, register the same email twice, then `psql devlens -c "select kind,name,status,\"sourceFile\" from \"Span\" order by \"startTime\""` — Expected: one trace containing `browser` → `browser` (fetch) → `http` → `function` → `database` (`DemoUser.create`, `error`) and `sourceFile` ending in `services/registration.ts`.
- [ ] **Step 3: Suggested commit checkpoint (only if authorized)** `feat(demo-app): instrumented sample app with failure scenarios`

---

### Task 8: Trace queries and trace list page

**Files:**
- Create: `apps/dashboard/lib/traces.ts`, `apps/dashboard/app/projects/[projectId]/page.tsx`
- Test: `apps/dashboard/test/traces.test.ts`

**Interfaces:**
- Consumes: `prisma`, `getOwnedProject`, `requireUserId` (Tasks 2–3).
- Produces:
  - `type TraceSummary = { traceId: string; rootName: string; startTime: Date; durationMs: number; spanCount: number; hasError: boolean }`
  - `listTraces(projectId: string, opts: { onlyErrors?: boolean; q?: string; before?: Date; limit?: number /*default 50, max 100*/ }): Promise<TraceSummary[]>` — newest first; `q` is a case-insensitive match on any span name; `rootName` = name of the earliest span; `durationMs` = max(start+duration) − min(start).
  - `getTraceSpans(projectId: string, traceId: string): Promise<StoredSpan[]>` — maps DB rows to `StoredSpan`, retaining server-derived provenance (`sourceFile/sourceLine` → `source`).
- Page: table of traces (status badge, root name, time, duration, span count), "Errors only" toggle, search box, "Older" pagination via `before`; all via search params. Empty and error states rendered. Responsive (cards under `md`).

- [ ] **Step 1: Write failing tests**

```ts
test("summarizes and filters traces", async () => {
  await seedSpans(projectId, [okTrace, failedRegistrationTrace]);
  const all = await listTraces(projectId, {});
  expect(all.map((t) => t.traceId)).toEqual([failedRegistrationTrace.id, okTrace.id]);
  expect(all[0]).toMatchObject({ rootName: "Submit registration", spanCount: 5, hasError: true });
  expect(await listTraces(projectId, { onlyErrors: true })).toHaveLength(1);
  expect(await listTraces(projectId, { q: "demouser.create" })).toHaveLength(1);
});
test("never leaks another project's spans", async () => {
  await seedSpans(otherProjectId, [okTrace]);
  expect(await getTraceSpans(projectId, okTrace.id)).toEqual([]);
});
```

- [ ] **Step 2: Run** — FAIL. **Step 3: Implement** (one `$queryRaw` grouped query is fine; parameterize everything). **Step 4: Run** — PASS. **Step 5: Suggested commit checkpoint (only if authorized)** `feat(dashboard): trace list`

---

### Task 9: Trace graph transforms and AI context builder

**Files:**
- Create: `apps/dashboard/lib/trace-graph.ts`, `apps/dashboard/lib/context.ts` (server-only builder and source-link helper; keep out of client imports)
- Test: `apps/dashboard/test/trace-graph.test.ts`, `apps/dashboard/test/context.test.ts`

**Interfaces:**
- Consumes: `StoredSpan` (Tasks 1–2). All graph/context fixtures include server-derived `ingestSource`; registration fixtures label the first two spans `browser-public` and the remainder `server-secret`.
- Produces:
  - `failurePath(spans: StoredSpan[]): StoredSpan[]` — guard parent traversal with visited IDs so malformed/cyclic client claims cannot hang rendering or exports; root-first path to the deepest error span (ties → earliest `startTime`); `[]` if no error.
  - `defaultCollapsed(spans: StoredSpan[]): Set<string>` — empty when `spans.length ≤ 50`; otherwise ids of every span that has children and no error in its subtree.
  - `toFlow(spans: StoredSpan[], opts: { collapsed: Set<string>; focusFailure: boolean }): { nodes: Node<SpanNodeData>[]; edges: Edge[] }` — dagre layout top→bottom, node 240×64; `SpanNodeData = { span: StoredSpan; orphan: boolean; onFailurePath: boolean; hiddenChildren: number }`; a span whose `parentSpanId` is missing from the set is a root with `orphan: true`; collapsed spans hide their descendants; `focusFailure` keeps only failure-path spans.
  - `type InvestigationContext = { traceId: string; failure: { spanId: string; operation: string; kind: SpanKind; error?: string; source?: string; sourceUrl?: string } | null; executionPath: string[]; spans: { spanId: string; ingestSource: StoredSpan["ingestSource"]; name: string; kind: SpanKind; status: SpanStatus; durationMs: number; source?: string; sourceUrl?: string; httpStatus?: number }[]; evidence: { totalDurationMs: number; spanCount: number } }`
  - `buildContext(spans: StoredSpan[], selectedIds?: string[], repoUrl?: string | null): InvestigationContext` — server-only pure builder, sanitizes again and allowlists output fields; input is an already authorized single project/trace. Use selected spans if nonempty, else failure path, else all. Compute failure from that chosen subset (null if no error) and evidence counts/duration from the subset; executionPath is its root-first ordered names. Never include unselected siblings or arbitrary attributes; `source` formatted `"file:line"` only when present; `sourceUrl` only when provenance is `server-secret` and the helper validates repo, commit and source. An explicit empty selection is rejected at the endpoint; builder defensively treats empty as default.
  - `sourceUrl(repoUrl: string | null | undefined, commitSha: string | undefined, source: { file: string; line: number } | undefined): string | undefined` → `${repoUrl}/blob/${commitSha}/${file}#L${line}` (only for a validated HTTPS GitHub repo, a full 40-hex commit SHA, a safe repo-relative captured path and positive line; encode path segments, reject traversal/absolute paths/control characters, return undefined otherwise). Only `server-secret` spans may supply source links; telemetry can claim a location, but DevLens does not verify repository contents or prove that code ran. The inspector uses this same helper on the server; no source inference.
  - `type WaterfallRow = { span: StoredSpan; depth: number; offsetPct: number; widthPct: number }`
  - `toWaterfall(spans: StoredSpan[]): WaterfallRow[]` — depth-first order (children sorted by `startTime`); offsets relative to the earliest span over the whole trace duration; `widthPct` at least `0.5` so 0 ms spans stay visible; orphans have depth 0.

- [ ] **Step 1: Write failing tests**

```ts
test("failure path for duplicate registration", () => {
  expect(failurePath(registrationTrace).map((s) => s.name)).toEqual(
    ["Submit registration", "fetch POST /api/register", "POST /api/register", "RegistrationService.registerUser", "DemoUser.create"]);
});
test("network failure: path ends at the browser fetch span", () => {
  expect(failurePath(networkFailTrace).at(-1)!.name).toBe("fetch POST /api/register");
});
test("missing parent becomes an orphan root", () => {
  const { nodes } = toFlow(serverOnlyTrace, { collapsed: new Set(), focusFailure: false });
  expect(nodes.find((n) => n.data.span.kind === "http")!.data.orphan).toBe(true);
});
test("large traces collapse successful subtrees", () => {
  const big = syntheticTrace(500, { failingLeaf: true });
  const { nodes } = toFlow(big, { collapsed: defaultCollapsed(big), focusFailure: false });
  expect(nodes.length).toBeLessThan(60);
  expect(nodes.some((n) => n.data.span.status === "error")).toBe(true);
});
test("context export matches the agreed shape and never invents source", () => {
  const c = buildContext(registrationTrace);
  expect(c.failure).toMatchObject({ operation: "DemoUser.create", kind: "database", source: "apps/demo-app/services/registration.ts:14" });
  expect(c.executionPath).toHaveLength(5);
  expect(buildContext(networkFailTrace).failure!.source).toBeUndefined();
  expect(buildContext(okTrace).failure).toBeNull();
});
test("source links only when repo, commit and source are all known", () => {
  const withSha = registrationTrace.map((s) => ({ ...s, attributes: { ...s.attributes, commitSha: "a".repeat(40) } }));
  expect(buildContext(withSha, undefined, "https://github.com/team/DevLens").failure!.sourceUrl)
    .toBe(`https://github.com/team/DevLens/blob/${"a".repeat(40)}/apps/demo-app/services/registration.ts#L14`);
  expect(buildContext(registrationTrace, undefined, "https://github.com/team/DevLens").failure!.sourceUrl).toBeUndefined();
  expect(buildContext(withSha, undefined, null).failure!.sourceUrl).toBeUndefined();
});
test("selection exports only selected sanitized evidence and provenance", () => {
  const selected = registrationTrace.at(-1)!;
  const c = buildContext(registrationTrace, [selected.id]);
  expect(c.spans.map((s) => s.spanId)).toEqual([selected.id]);
  expect(c.spans[0].ingestSource).toBe("server-secret");
  expect(c.evidence.spanCount).toBe(1);
  expect(c.executionPath).toEqual([selected.name]);
  const dirty = { ...selected, errorMessage: "dup a@b.co", attributes: { authorization: "Bearer secret" } };
  expect(JSON.stringify(buildContext([dirty]))).not.toMatch(/a@b\.co|Bearer secret|authorization/);
});
test("unsafe or browser-public source claims do not create links", () => {
  const repo = "https://github.com/team/DevLens", sha = "a".repeat(40);
  for (const file of ["../secret.ts", "/tmp/secret.ts", "https://evil.test/x", "a/../../x"])
    expect(sourceUrl(repo, sha, { file, line: 1 })).toBeUndefined();
  expect(sourceUrl(repo, "abc123", { file: "a.ts", line: 1 })).toBeUndefined();
  expect(sourceUrl("javascript:alert(1)", sha, { file: "a.ts", line: 1 })).toBeUndefined();
  const browser = { ...registrationTrace.at(-1)!, ingestSource: "browser-public" as const, attributes: { commitSha: sha } };
  expect(buildContext([browser], undefined, repo).spans[0].sourceUrl).toBeUndefined();
});
test("waterfall rows are ordered, offset and never zero-width", () => {
  const rows = toWaterfall(registrationTrace);
  expect(rows.map((r) => r.depth)).toEqual([0, 1, 2, 3, 4]);
  expect(rows[0].offsetPct).toBe(0);
  expect(rows.every((r) => r.widthPct >= 0.5 && r.offsetPct + r.widthPct <= 100.5)).toBe(true);
  expect(toWaterfall(serverOnlyTrace)[0].depth).toBe(0);
});
```

- [ ] **Step 2: Run** — FAIL. **Step 3: Implement.** **Step 4: Run** — PASS. **Step 5: Suggested commit checkpoint (only if authorized)** `feat(dashboard): trace graph transforms and context export`

---

### Task 10: Trace explorer UI and context endpoint

**Files:**
- Create: `apps/dashboard/app/projects/[projectId]/traces/[traceId]/page.tsx`, `apps/dashboard/components/trace-explorer.tsx`, `apps/dashboard/components/span-node.tsx`, `apps/dashboard/components/span-inspector.tsx`, `apps/dashboard/components/trace-waterfall.tsx`, `apps/dashboard/app/api/projects/[projectId]/traces/[traceId]/context/route.ts`
- Test: `apps/dashboard/test/context-route.test.ts`

**Interfaces:**
- Consumes: `getTraceSpans`, `getOwnedProject`, `requireUserId` (Tasks 2–3, 8); `toFlow`, `failurePath`, `defaultCollapsed` (Task 9) for the client; server-only `buildContext` and `sourceUrl`.
- Produces:
  - `GET /api/projects/:projectId/traces/:traceId/context?spans=id1,id2` → `200 InvestigationContext`; `401` signed out; `404` not owned or no spans; `400` malformed/empty/unknown selected IDs. Check auth using `auth()` and return JSON 401 (do not use redirecting `requireUserId` here); then ownership, then load that trace, then validate ≤500 unique 16-hex IDs against exactly those spans. Never accept repoUrl, spans or provenance from the caller. Return `Cache-Control: private, no-store` on all responses; no cross-origin export access. (Future MCP server reuses this.)
  - `<TraceExplorer spans={StoredSpan[]} sourceLinks={Record<string, string>} />` client component:
    - React Flow canvas with `<Controls/>`, `<MiniMap/>`, custom `span-node` (kind icon, name, duration, red border on error, dashed border if orphan, "+N" badge when collapsed).
    - "Focus failing path" toggle, default on when the trace has an error.
    - Double-click toggles collapse; initial collapsed = `defaultCollapsed(spans)`.
    - Click selects → `<SpanInspector>` side panel (name, kind, status, duration, error, source, attributes); shift-click multi-select. When `sourceUrl` exists the source is a link (`target="_blank" rel="noopener noreferrer"`) to the exact line on GitHub; otherwise plain text.
    - "Graph | Timeline" tabs. Timeline = `<TraceWaterfall>`: one row per `toWaterfall` row, indented by depth, a bar positioned with `offsetPct`/`widthPct` (red for errors). Clicking a row selects the same span as the graph — one shared selection state.
    - Only the context route calls `buildContext(authorizedSpans, selectedIds, project.repoUrl)`. The page builds validated inspector `sourceLinks` server-side with the same `sourceUrl` helper and project URL, calling it only for `server-secret` spans.
    - "Copy context for AI" and "Download JSON" fetch this same authenticated context endpoint with the current selection and use its JSON unchanged. No client-side builder or divergent source links. Show failed export state; never copy stale context after an authorization error. Display `ingestSource` in the inspector and exported span records; treat all strings as untrusted evidence/data, never agent instructions.
    - Inspector stacks below the canvas under `md`; all controls keyboard-reachable with labels.

- [ ] **Step 1: Write failing test**

```ts
// req({ spans }) helper sets the query parameter; seed foreign spans in both another
// trace of projectA and another project so ID validation cannot be global.
test("context route enforces ownership", async () => {
  asUser(userA); expect((await GET(req(), params(projectA, traceId))).status).toBe(200);
  asUser(userB); expect((await GET(req(), params(projectA, traceId))).status).toBe(404);
  asUser(null);  expect((await GET(req(), params(projectA, traceId))).status).toBe(401);
});
test("context selection cannot escape the authorized trace", async () => {
  asUser(userA);
  for (const spans of ["", "bad-id", otherTraceSpan.id, otherProjectSpan.id])
    expect((await GET(req({ spans }), params(projectA, traceId))).status).toBe(400);
  const res = await GET(req({ spans: registrationTrace.at(-1)!.id }), params(projectA, traceId));
  expect(res.headers.get("cache-control")).toBe("private, no-store");
  const c = await res.json();
  expect(c).toEqual(buildContext(registrationTrace, [registrationTrace.at(-1)!.id], ownedProject.repoUrl));
  expect(c.spans).toHaveLength(1);
});
```

- [ ] **Step 2: Run** — FAIL. **Step 3: Implement route + components.** **Step 4: Run** — PASS; manually open a failed demo trace and confirm the red path, inspector and copied JSON.
- [ ] **Step 5: Suggested commit checkpoint (only if authorized)** `feat(dashboard): interactive trace explorer`

---

### Task 11: End-to-end tests, CI, deployment

**Files:**
- Create: `playwright.config.ts`, `e2e/debug-flow.spec.ts`, `.github/workflows/ci.yml`, `README.md`, `apps/dashboard/app/api/health/route.ts`, `apps/demo-app/app/api/health/route.ts`
- Test: `apps/dashboard/test/health.test.ts`; cross-origin fixture APIs and export parity assertions in `e2e/debug-flow.spec.ts` (test-only fixtures, not new product endpoints)

**Interfaces:**
- Consumes: everything above. Playwright `webServer` starts dashboard (3000) and demo (3001) against a seeded DB.

- [ ] **Step 1: Write e2e tests**

```ts
test("duplicate registration is traceable end to end", async ({ page }) => {
  await registerOnDemo(page, "dup@test.dev"); await registerOnDemo(page, "dup@test.dev");
  await loginToDashboard(page); await page.getByRole("link", { name: "Demo" }).click();
  await page.getByLabel("Errors only").check();
  await page.getByRole("link", { name: /Submit registration/ }).first().click();
  await expect(page.getByTestId("span-node-error")).toContainText("DemoUser.create");
  await page.getByTestId("span-node-error").click();
  await expect(page.getByTestId("inspector")).toContainText("services/registration.ts");
  await expect(page.getByTestId("inspector")).not.toContainText("dup@test.dev");
});
test("concurrent registrations produce two separate traces", async ({ page }) => {
  await page.goto("http://localhost:3001"); await page.getByRole("button", { name: "Register twice concurrently" }).click();
  await expect.poll(() => countTracesNamed("Submit registration (concurrent)")).toBe(2);
});
test("signed-out users cannot open a trace", async ({ page }) => {
  await page.goto(traceUrl); await expect(page).toHaveURL(/\/login/);
});
```

- [ ] **Step 1b: Required browser integration cases.** Add real HTTP fixture APIs on a distinct origin: one allows OPTIONS with caller origin/method/`traceparent`, one denies that header. Verify same-origin and approved cross-origin trace correlation; denied preflight yields browser-only network failure and no business-request retry; an unapproved origin receives no added `traceparent` and its normal request still succeeds. Verify Request/init headers and no-cors behavior. Add explorer tests that copy and download call the same context endpoint with selected IDs, their JSON equals its response including source links/provenance, both handle 401/404 without stale output, and neither includes unselected siblings or PII. Verify cyclic parent claims terminate safely. Record demo workload (including concurrent registrations) accepted/dropped volumes at the 600/min limit and on/off SDK overhead; each owner fixes its integration failures before sign-off.

- [ ] **Step 2: Run** `pnpm exec playwright test` — Expected: PASS (fix any integration gaps in the owning task's code).
- [ ] **Step 2b: Health checks.** Both apps get `GET /api/health`: runs `SELECT 1`; `200 { ok: true, db: "up" }` or `503 { ok: false, db: "down" }`. Never includes env values, versions or error text. Test:

```ts
test("health reports db state without leaking details", async () => {
  expect(await (await GET()).json()).toEqual({ ok: true, db: "up" });
  vi.spyOn(prisma, "$queryRaw").mockRejectedValueOnce(new Error("password authentication failed"));
  const res = await GET(); expect(res.status).toBe(503);
  expect(await res.text()).not.toContain("password");
});
```
- [ ] **Step 3: CI** — `ci.yml` on push/PR: Postgres 16 service, `pnpm install --frozen-lockfile`, `prisma migrate deploy` (both apps), `pnpm typecheck`, `pnpm lint`, `pnpm test`, `pnpm exec playwright test`. Expected: green run on GitHub.
- [ ] **Step 4: Deploy** — dashboard and demo as two Render web services (`pnpm build`, start `next start`, `NODE_OPTIONS=--enable-source-maps`, health check path `/api/health`); one Neon Postgres project with databases `devlens` and `demo` (pooled → `DATABASE_URL`, direct → `DIRECT_URL`); run `prisma migrate deploy` in each build. Set env from `.env.example`; demo project's allowed origin = deployed demo URL; demo project's `repoUrl` = the team's GitHub repo. Add an uptime monitor (e.g. UptimeRobot free) on both `/api/health` URLs with a public status page linked from the README. Free Render services sleep when idle and free instance hours are capped per workspace — check the current limit before keeping both awake 24/7; ping only during demo/grading week, or upgrade for that month. README covers: architecture diagram, local setup, SDK usage snippet, security model (keys, sanitization), how to run tests, the usability study protocol (2–3 students diagnose the seeded bug with logs vs DevLens; record time and correctness).
- [ ] **Step 5: Suggested commit checkpoint (only if authorized)** `chore: e2e tests, CI and deployment docs`

---

## Follow-up plans (not in this plan)

- **MCP server (read-only):** `list_failed_traces`, `get_trace_context` wrapping Task 10's context endpoint with a per-project read token.
- **Graphify enrichment:** import graph output for the demo repo; link `source.file` to graph nodes.
- **Error grouping (PostHog/Sentry "issues"):** fingerprint failures by error span name + normalized message; show count, first seen, last seen; link to example traces.
- **OTLP export:** forward spans in OpenTelemetry format so teams can also view them in Grafana Tempo/Jaeger.
