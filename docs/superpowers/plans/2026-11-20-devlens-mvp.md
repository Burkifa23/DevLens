# DevLens MVP Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A developer instruments a Next.js app with the DevLens SDKs, reproduces a failure, opens the trace in an interactive React Flow explorer, isolates the failing path, and exports it as structured JSON context for an AI coding agent.

**Architecture:** pnpm monorepo. `packages/shared` holds the span schema, W3C `traceparent` helpers and the sanitizer. `packages/sdk-browser` and `packages/sdk-node` record spans and POST them to the dashboard's ingest endpoint. `apps/dashboard` (Next.js) stores spans in PostgreSQL, authenticates users, lists traces and renders the explorer. `apps/demo-app` is the instrumented sample app with two intentional failures. Spans are the only stored telemetry; traces are a `GROUP BY traceId`; every visualization and the AI export are pure functions over `Span[]`.

**Tech Stack:** TypeScript (strict), Next.js App Router, React, Tailwind CSS, PostgreSQL 16, Prisma, Auth.js v5 (Credentials + bcryptjs), zod, `@xyflow/react` + `@dagrejs/dagre`, Vitest, Playwright, pnpm workspaces, Docker Compose (local Postgres), GitHub Actions.

**Spec:** `chat.md` (final sections: "Next.js and TypeScript", "React Flow wins", "diagnostic context engine"). Where the chat changed its mind, the latest message wins.

## Global Constraints

- Stack is Next.js + TypeScript end to end; no PHP/Laravel. TypeScript `strict: true` in every package.
- Every route handler sets `export const runtime = "nodejs"`; no Edge runtime.
- Database: PostgreSQL via Prisma. Styling: Tailwind. Auth: Auth.js. Tests: Vitest + Playwright.
- Trace propagation uses the W3C Trace Context `traceparent` header: `00-<32 hex traceId>-<16 hex spanId>-01`.
- Primary renderer is React Flow. No Mermaid in this plan.
- Never store passwords, raw request bodies, cookies, session tokens, `Authorization` values, or personal data. Database spans record model, operation, duration and status only — never query arguments.
- Source locations come only from captured stack frames. Never infer or fabricate one; omit the field instead.
- Telemetry failures (ingest down, bad key, network error) must never throw into or slow down the instrumented app.
- The browser may only ever hold the **public** key; the public key may only submit spans with `kind: "browser"` from an allowed origin. Server SDK uses the **secret** key. Secret keys are stored hashed (SHA-256) and shown once.
- **Documentation is part of done** (the viva is 50% of the grade — every member must be able to explain every file):
  - Every exported function, type and React component gets a TSDoc comment: what it does, why it exists, and any non-obvious rule it enforces (e.g. "public key may only submit browser spans — see Security model").
  - Inline comments explain *why*, never restate *what*. Every security check and every `ponytail:` shortcut is commented.
  - Each task updates the README named in the Documentation map below with three sections for its part: **How it works** (short prose, the flow in order), **Key files** (path → one-line role), **Viva questions** (3–5 questions with short answers a member must be able to give).
  - If a task changes the end-to-end flow, data model, or security model, it updates `docs/architecture.md` in the same commit.
  - A task's reviewer rejects it if any of the above is missing.
- Out of scope (separate future plans): MCP server, Graphify enrichment, AI root-cause analysis, autonomous fixes, WebSocket live streaming, non-Next.js frameworks, arbitrary code execution.

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

Task 1 lands first; then 2→3→4 and 5/6 run in parallel; 7 needs 4–6; 8–10 need 4; 11 needs everything. Each owner walks the group through their task before merge (viva prep).

---

### Task 1: Monorepo scaffold + shared trace contract

**Files:**
- Create: `package.json`, `pnpm-workspace.yaml`, `tsconfig.base.json`, `docker-compose.yml`, `docker/init.sql`, `.env.example`, `.gitignore`
- Create: `packages/shared/package.json`, `packages/shared/src/index.ts`, `packages/shared/src/span.ts`, `packages/shared/src/traceparent.ts`, `packages/shared/src/sanitize.ts`
- Test: `packages/shared/src/*.test.ts`

**Interfaces:**
- Produces (from `@devlens/shared`):
  - `SpanKind = "browser" | "http" | "function" | "database"`; `SpanStatus = "ok" | "error"`
  - `SpanSchema` (zod) and `type Span = { id: string /*16 hex*/; traceId: string /*32 hex*/; parentSpanId?: string; name: string /*1..200*/; kind: SpanKind; startTime: string /*ISO*/; durationMs: number /*int ≥0*/; status: SpanStatus; errorMessage?: string; source?: { file: string; line: number }; attributes: Record<string, string | number | boolean> }`
  - `IngestBatchSchema` = `{ key: string; spans: Span[] /*1..500*/ }`
  - `newTraceId(): string`, `newSpanId(): string` (via `crypto.getRandomValues`, works in browser and Node)
  - `formatTraceparent(traceId, spanId): string`, `parseTraceparent(header: string | null): { traceId: string; parentSpanId: string } | null`
  - `sanitizeSpan(span: Span): Span`

- [ ] **Step 1: Scaffold workspace**

Root `package.json` scripts: `test` → `pnpm -r test`, `typecheck` → `pnpm -r typecheck`, `lint` → `pnpm -r lint`. `docker-compose.yml`: `postgres:16` on 5432; `docker/init.sql` creates databases `devlens`, `devlens_test`, `demo`. `.env.example` lists every env var used in later tasks.

- [ ] **Step 2: Write failing tests**

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
test("truncates long strings to 500 chars", () => {
  expect(sanitizeSpan({ ...validSpan, errorMessage: "x".repeat(2000) }).errorMessage!.length).toBe(500);
});
```

- [ ] **Step 3: Run** `pnpm --filter @devlens/shared test` — Expected: FAIL (modules missing).

- [ ] **Step 4: Implement** `span.ts`, `traceparent.ts`, `sanitize.ts`. Sensitive-key regex: `/pass|secret|token|auth|cookie|session|email|card/i`. Sanitizer applies to `name`, `errorMessage`, string attribute values.

- [ ] **Step 5: Run** `pnpm --filter @devlens/shared test` — Expected: PASS.

- [ ] **Step 6: Commit** `feat(shared): monorepo scaffold and trace contract`

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
                    publicKey String @unique; secretKeyHash String @unique; allowedOrigins String[]; createdAt DateTime @default(now()); spans Span[] }
    model Span    { projectId String; id String; traceId String; parentSpanId String?; name String; kind String; startTime DateTime; durationMs Int
                    status String; errorMessage String?; sourceFile String?; sourceLine Int?; attributes Json @default("{}")
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

- [ ] **Step 3: Implement** schema + `prisma migrate dev --name init`, `auth.ts` (Credentials provider, bcryptjs cost 12), `signUp`, login/signup pages, `middleware.ts` protecting `/projects/:path*`. Seed creates `demo@devlens.test` with password from `SEED_PASSWORD`.

- [ ] **Step 4: Run** `pnpm --filter dashboard test` — Expected: PASS.

- [ ] **Step 5: Commit** `feat(dashboard): schema and credential auth`

---

### Task 3: Projects and API keys

**Files:**
- Create: `apps/dashboard/lib/projects.ts`, `apps/dashboard/app/projects/page.tsx`, `apps/dashboard/app/projects/actions.ts`, `apps/dashboard/app/projects/[projectId]/settings/page.tsx`
- Test: `apps/dashboard/test/projects.test.ts`

**Interfaces:**
- Consumes: `prisma`, `requireUserId()` (Task 2).
- Produces:
  - `createProject(ownerId: string, name: string, allowedOrigins: string[]): Promise<{ project: Project; secretKey: string }>` — `publicKey = "pk_" + 24 random hex`, `secretKey = "sk_" + 32 random hex`, store `sha256(secretKey)` hex.
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
```

- [ ] **Step 2: Run** — Expected: FAIL. **Step 3: Implement**; the create form shows the secret key once with a copy button. Origins normalized with `new URL(o).origin`. **Step 4: Run** — Expected: PASS.

- [ ] **Step 5: Commit** `feat(dashboard): projects and API keys`

---

### Task 4: Ingest endpoint

**Files:**
- Create: `apps/dashboard/app/api/ingest/route.ts`, `apps/dashboard/lib/ingest.ts`, `apps/dashboard/lib/rate-limit.ts`
- Test: `apps/dashboard/test/ingest.test.ts`

**Interfaces:**
- Consumes: `IngestBatchSchema`, `sanitizeSpan` (Task 1); `prisma`, `hashKey` (Tasks 2–3).
- Produces: `POST /api/ingest`, body `IngestBatch` as JSON sent with `Content-Type: text/plain` (a CORS "simple request" — no preflight). Responses:
  - `202 { accepted: number }`; duplicate `(projectId, id)` silently skipped (`createMany({ skipDuplicates: true })`)
  - `400` invalid JSON/schema · `401` unknown key · `403` public key with disallowed `Origin` or a non-`browser` span · `413` body > 1 MB (check `content-length` and actual byte length) · `429` over 600 spans/min per project
  - When the request had an allowed `Origin`, response carries `Access-Control-Allow-Origin: <origin>`.
- `handleIngest(req: Request): Promise<Response>` in `lib/ingest.ts` (route just re-exports it, so tests call it directly).

- [ ] **Step 1: Write failing tests** (real `devlens_test` DB)

```ts
test("secret key stores sanitized spans", async () => {
  const res = await handleIngest(post({ key: sk, spans: [{ ...span, errorMessage: "Unique constraint failed on (email) for a@b.co" }] }));
  expect(res.status).toBe(202);
  expect((await prisma.span.findFirstOrThrow()).errorMessage).toBe("Unique constraint failed on (email) for [email]");
});
test("public key: allowed origin + browser kind only", async () => {
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
test("re-sent batch is idempotent", async () => {
  await handleIngest(post({ key: sk, spans: [span] })); await handleIngest(post({ key: sk, spans: [span] }));
  expect(await prisma.span.count()).toBe(1);
});
```

- [ ] **Step 2: Run** — Expected: FAIL.

- [ ] **Step 3: Implement.** Order: size → JSON → schema → key lookup (`pk_` by `publicKey`, `sk_` by `secretKeyHash`) → origin/kind → rate limit → sanitize → insert. `rate-limit.ts`: fixed 60 s window `Map<projectId, {windowStart, count}>`, marked `// ponytail: in-memory, single instance only; move to Postgres/Redis if horizontally scaled`.

- [ ] **Step 4: Run** — Expected: PASS. **Step 5: Commit** `feat(dashboard): span ingest endpoint`

---

### Task 5: Node SDK

**Files:**
- Create: `packages/sdk-node/src/index.ts`, `context.ts`, `exporter.ts`, `handler.ts`, `prisma.ts`, `stack.ts`
- Test: `packages/sdk-node/src/*.test.ts`

**Interfaces:**
- Consumes: `Span`, `newSpanId`, `newTraceId`, `parseTraceparent` (Task 1); ingest contract (Task 4).
- Produces (from `@devlens/sdk-node`):
  - `configure(opts: { endpoint: string; secretKey: string; fetch?: typeof fetch }): void`
  - `withDevLens<C>(name: string, handler: (req: Request, ctx: C) => Promise<Response>): (req: Request, ctx: C) => Promise<Response>` — `kind: "http"` span; continues `traceparent` if valid, else new trace; `status = "error"` when handler throws or response status ≥ 400; attributes `{ method, path, httpStatus }`; on throw sets `errorMessage` and `source = sourceFromStack(err.stack)`, then rethrows; flushes after the response.
  - `span<T>(name: string, fn: () => Promise<T>): Promise<T>` — `kind: "function"` child of current span; captures call-site `source`.
  - `instrumentPrisma<T extends PrismaClient>(client: T): T` — `$extends` query hook; span name `"${model}.${operation}"`, `kind: "database"`, attributes `{ model, operation }` only; error message from the Prisma error.
  - `sourceFromStack(stack: string | undefined): { file: string; line: number } | undefined` — first frame not under `node_modules`, `node:`, or `sdk-node`; paths made relative to `process.cwd()`.
  - `createExporter(opts): { push(span: Span): void; flush(): Promise<void> }` — sends in chunks of ≤ 500; never rejects.
- Context: `AsyncLocalStorage<{ traceId: string; spanId: string }>`.

- [ ] **Step 1: Write failing tests** (fake `fetch` capturing bodies)

```ts
test("continues the incoming trace and nests spans", async () => {
  const h = withDevLens("POST /api/register", async () => { await span("svc", async () => {}); return new Response(null, { status: 201 }); });
  await h(req({ traceparent: formatTraceparent(T, P) }), {}); await flushed();
  const [svc, http] = sent();
  expect(http).toMatchObject({ traceId: T, parentSpanId: P, kind: "http", status: "ok" });
  expect(svc).toMatchObject({ traceId: T, parentSpanId: http.id, kind: "function" });
});
test("4xx and thrown errors mark error; thrown errors still propagate", async () => {
  await withDevLens("x", async () => new Response(null, { status: 409 }))(req(), {});
  await expect(withDevLens("y", async () => { throw new TypeError("boom"); })(req(), {})).rejects.toThrow("boom");
  await flushed();
  expect(sent().map((s) => s.status)).toEqual(["error", "error"]);
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
```

- [ ] **Step 2: Run** `pnpm --filter @devlens/sdk-node test` — Expected: FAIL. **Step 3: Implement.** **Step 4: Run** — Expected: PASS.

- [ ] **Step 5: Commit** `feat(sdk-node): request, function and prisma spans`

---

### Task 6: Browser SDK

**Files:**
- Create: `packages/sdk-browser/src/index.ts`, `packages/sdk-browser/src/exporter.ts`
- Test: `packages/sdk-browser/src/index.test.ts` (Vitest `environment: "jsdom"`)

**Interfaces:**
- Consumes: `Span`, `newTraceId`, `newSpanId`, `formatTraceparent` (Task 1); ingest contract (Task 4).
- Produces (from `@devlens/sdk-browser`):
  - `init(opts: { endpoint: string; publicKey: string }): void` — also registers `window` `error` and `unhandledrejection` listeners, each recorded as a standalone root span `name: "uncaught error"`, `status: "error"`.
  - `track<T>(name: string, fn: (fetch: typeof window.fetch) => Promise<T>): Promise<T>` — root `kind: "browser"` span; the `fetch` passed in creates a child span `"fetch <METHOD> <path>"`, sets `traceparent` to that child's id, records `httpStatus`, marks error on network failure or `!res.ok`. Root span is error if `fn` throws or any child failed.
  - Exporter batches spans, flushes every 2 s and on `pagehide` via `navigator.sendBeacon` (falls back to `fetch(..., { keepalive: true })`), `Content-Type: text/plain`. Never throws.
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
test("409 marks fetch and root as error", async () => {
  mockFetchStatus(409); await track("a", (f) => f("/x"));
  expect(flushedSpans().map((s) => s.status)).toEqual(["error", "error"]);
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

- [ ] **Step 5: Commit** `feat(sdk-browser): tracked actions and error capture`

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
- Env: `NEXT_PUBLIC_DEVLENS_ENDPOINT`, `NEXT_PUBLIC_DEVLENS_KEY` (pk), `DEVLENS_SECRET_KEY` (sk), `DATABASE_URL` (→ `demo` db). `next.config.ts`: `transpilePackages: ["@devlens/sdk-browser", "@devlens/sdk-node", "@devlens/shared"]`, `experimental.serverSourceMaps: true`; start with `NODE_OPTIONS=--enable-source-maps` so `source` points at `.ts` files.

- [ ] **Step 1: Build it.** Dashboard seed (Task 2) gains a project for the demo user with origin `http://localhost:3001` and prints its keys.
- [ ] **Step 2: Verify manually:** `docker compose up -d`, run both apps, register the same email twice, then `psql devlens -c "select kind,name,status,\"sourceFile\" from \"Span\" order by \"startTime\""` — Expected: one trace containing `browser` → `browser` (fetch) → `http` → `function` → `database` (`DemoUser.create`, `error`) and `sourceFile` ending in `services/registration.ts`.
- [ ] **Step 3: Commit** `feat(demo-app): instrumented sample app with failure scenarios`

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
  - `getTraceSpans(projectId: string, traceId: string): Promise<Span[]>` — maps DB rows back to the shared `Span` shape (`sourceFile/sourceLine` → `source`).
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

- [ ] **Step 2: Run** — FAIL. **Step 3: Implement** (one `$queryRaw` grouped query is fine; parameterize everything). **Step 4: Run** — PASS. **Step 5: Commit** `feat(dashboard): trace list`

---

### Task 9: Trace graph transforms and AI context builder

**Files:**
- Create: `apps/dashboard/lib/trace-graph.ts`
- Test: `apps/dashboard/test/trace-graph.test.ts`

**Interfaces:**
- Consumes: `Span` (Task 1).
- Produces:
  - `failurePath(spans: Span[]): Span[]` — root-first path to the deepest error span (ties → earliest `startTime`); `[]` if no error.
  - `defaultCollapsed(spans: Span[]): Set<string>` — empty when `spans.length ≤ 50`; otherwise ids of every span that has children and no error in its subtree.
  - `toFlow(spans: Span[], opts: { collapsed: Set<string>; focusFailure: boolean }): { nodes: Node<SpanNodeData>[]; edges: Edge[] }` — dagre layout top→bottom, node 240×64; `SpanNodeData = { span: Span; orphan: boolean; onFailurePath: boolean; hiddenChildren: number }`; a span whose `parentSpanId` is missing from the set is a root with `orphan: true`; collapsed spans hide their descendants; `focusFailure` keeps only failure-path spans.
  - `type InvestigationContext = { traceId: string; failure: { spanId: string; operation: string; kind: SpanKind; error?: string; source?: string } | null; executionPath: string[]; spans: { name: string; kind: SpanKind; status: SpanStatus; durationMs: number; source?: string; httpStatus?: number }[]; evidence: { totalDurationMs: number; spanCount: number } }`
  - `buildContext(spans: Span[], selectedIds?: string[]): InvestigationContext` — `spans` = selected spans, else the failure path, else all; `source` formatted `"file:line"` only when present.

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
  expect(c.failure).toMatchObject({ operation: "DemoUser.create", kind: "database", source: "services/registration.ts:14" });
  expect(c.executionPath).toHaveLength(5);
  expect(buildContext(networkFailTrace).failure!.source).toBeUndefined();
  expect(buildContext(okTrace).failure).toBeNull();
});
```

- [ ] **Step 2: Run** — FAIL. **Step 3: Implement.** **Step 4: Run** — PASS. **Step 5: Commit** `feat(dashboard): trace graph transforms and context export`

---

### Task 10: Trace explorer UI and context endpoint

**Files:**
- Create: `apps/dashboard/app/projects/[projectId]/traces/[traceId]/page.tsx`, `apps/dashboard/components/trace-explorer.tsx`, `apps/dashboard/components/span-node.tsx`, `apps/dashboard/components/span-inspector.tsx`, `apps/dashboard/app/api/projects/[projectId]/traces/[traceId]/context/route.ts`
- Test: `apps/dashboard/test/context-route.test.ts`

**Interfaces:**
- Consumes: `getTraceSpans`, `getOwnedProject`, `requireUserId` (Tasks 2–3, 8); `toFlow`, `failurePath`, `defaultCollapsed`, `buildContext` (Task 9).
- Produces:
  - `GET /api/projects/:projectId/traces/:traceId/context?spans=id1,id2` → `200 InvestigationContext`; `401` signed out; `404` not owned or no spans. (Future MCP server reuses this.)
  - `<TraceExplorer spans={Span[]} />` client component:
    - React Flow canvas with `<Controls/>`, `<MiniMap/>`, custom `span-node` (kind icon, name, duration, red border on error, dashed border if orphan, "+N" badge when collapsed).
    - "Focus failing path" toggle, default on when the trace has an error.
    - Double-click toggles collapse; initial collapsed = `defaultCollapsed(spans)`.
    - Click selects → `<SpanInspector>` side panel (name, kind, status, duration, error, source, attributes); shift-click multi-select.
    - "Copy context for AI" (clipboard) and "Download JSON" use `buildContext(spans, selectedIds)`.
    - Inspector stacks below the canvas under `md`; all controls keyboard-reachable with labels.

- [ ] **Step 1: Write failing test**

```ts
test("context route enforces ownership", async () => {
  asUser(userA); expect((await GET(req(), params(projectA, traceId))).status).toBe(200);
  asUser(userB); expect((await GET(req(), params(projectA, traceId))).status).toBe(404);
  asUser(null);  expect((await GET(req(), params(projectA, traceId))).status).toBe(401);
});
```

- [ ] **Step 2: Run** — FAIL. **Step 3: Implement route + components.** **Step 4: Run** — PASS; manually open a failed demo trace and confirm the red path, inspector and copied JSON.
- [ ] **Step 5: Commit** `feat(dashboard): interactive trace explorer`

---

### Task 11: End-to-end tests, CI, deployment

**Files:**
- Create: `playwright.config.ts`, `e2e/debug-flow.spec.ts`, `.github/workflows/ci.yml`, `README.md`

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

- [ ] **Step 2: Run** `pnpm exec playwright test` — Expected: PASS (fix any integration gaps in the owning task's code).
- [ ] **Step 3: CI** — `ci.yml` on push/PR: Postgres 16 service, `pnpm install --frozen-lockfile`, `prisma migrate deploy` (both apps), `pnpm typecheck`, `pnpm lint`, `pnpm test`, `pnpm exec playwright test`. Expected: green run on GitHub.
- [ ] **Step 4: Deploy** — dashboard and demo as two Node services (`next build && next start`, `NODE_OPTIONS=--enable-source-maps`) on a Node host (e.g. Render/Railway) with managed Postgres; set env from `.env.example`; demo project's allowed origin = deployed demo URL. README covers: architecture diagram, local setup, SDK usage snippet, security model (keys, sanitization), how to run tests, the usability study protocol (2–3 students diagnose the seeded bug with logs vs DevLens; record time and correctness).
- [ ] **Step 5: Commit** `chore: e2e tests, CI and deployment docs`

---

## Follow-up plans (not in this plan)

- **MCP server (read-only):** `list_failed_traces`, `get_trace_context` wrapping Task 10's context endpoint with a per-project read token.
- **Graphify enrichment:** import graph output for the demo repo; link `source.file` to graph nodes.
