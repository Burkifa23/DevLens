# DevLens Architecture (study guide)

> Approved design decisions; implementation is not yet present. Authority: `AGENTS.md` → this guide → the implementation plan; `chat.md` is historical only. Contracts and planned tests live in `docs/superpowers/plans/2026-11-20-devlens-mvp.md`. Each task updates this file if it changes the flow, data model or security model. Every member should be able to explain every section here in the viva.

## 1. What DevLens does

A developer's app fails. Instead of reading scattered browser and server logs, the developer opens DevLens and sees **one connected graph**: the button click, the HTTP request, the server function, the database query, and which one failed. They can then export the failing path as a small JSON file and give it to an AI coding agent, so the agent starts from evidence instead of guessing.

### Coverage and responsibilities

The graph shows captured runtime operations only: explicit `track` actions and their supplied fetch, wrapped request handlers, explicit `span` functions, instrumented Prisma operations, and standalone browser uncaught-error listeners. It does not discover every click, function, branch, query client or dependency; there is no static codebase graph. Missing instrumentation, dropped delivery, source maps and browser/server clock skew limit completeness and timing precision. A connected path is diagnostic evidence, not proof of root cause. Graphify, MCP and autonomous fixes remain out of scope.

Each app owner must initialize the SDKs, choose safe static labels, wrap the relevant routes/functions/Prisma client, configure propagation origins and source maps, and verify coverage with the SDK and graph owners. Every member verifies their subsystem with its consumers before completion; Member 5 coordinates integration, CI and deployment. Members 1 and 4 jointly own span fixtures and how the graph interprets them.

## 2. The parts

```
┌──────────────── demo-app (port 3001) ────────────────┐
│ Browser: @devlens/sdk-browser  ── fetch + traceparent ─┼─► Next.js API: @devlens/sdk-node
└───────────┬──────────────────────────────────────────┘           │ (http, function, database spans)
            │ spans (public key)                                    │ spans (secret key)
            ▼                                                       ▼
┌──────────────────────── dashboard (port 3000) ───────────────────────────┐
│ POST /api/ingest → validate → check key/origin → rate limit → sanitize → │
│ PostgreSQL (Span table) → trace list → React Flow explorer → JSON export │
└──────────────────────────────────────────────────────────────────────────┘
```

| Part | Role |
|---|---|
| `packages/shared` | The contract everyone agrees on: the `Span` shape, `traceparent` helpers, the sanitizer |
| `packages/sdk-browser` | Records user actions and their `fetch` calls in the browser; captures uncaught errors |
| `packages/sdk-node` | Records server requests, service functions and Prisma queries; sends them with the secret key |
| `apps/dashboard` | Stores spans, logs users in, lists traces, draws the explorer, exports AI context |
| `apps/demo-app` | A small registration app with intentional bugs, used to demonstrate and test DevLens |

## 3. Key concepts

- **Span** — one timed operation (a click, a fetch, a request, a function, a query). It has an `id`, a `traceId`, an optional `parentSpanId`, a `kind`, a duration and a status.
- **Trace** — all spans sharing one `traceId`. It is not stored separately; the dashboard groups spans by `traceId`.
- **Parent/child** — `parentSpanId` turns a flat list of spans into a tree. The tree is what the explorer draws.
- **W3C `traceparent` header** — `00-<traceId>-<parentSpanId>-01`. The browser SDK adds it to its supplied fetch only for same-origin or explicitly approved API origins; the server SDK reads it, so the server's spans join the browser's trace. This is the standard used by OpenTelemetry, which is why we chose it over a custom header.
- **AsyncLocalStorage (server)** — remembers "the current span" across `await`s inside one request, so concurrent requests never mix up their spans.
- **Explicit context (browser)** — the browser has no AsyncLocalStorage, so `track(name, fetch => …)` hands each action its own `fetch`. Two simultaneous actions therefore cannot be confused.

## 4. One request, step by step (duplicate registration)

1. User submits the form. `track("Submit registration", …)` creates a root **browser** span.
2. The tracked `fetch` creates a child **browser** span and sends `traceparent` with that span's id.
3. `withDevLens` on `POST /api/register` reads `traceparent` and creates an **http** span whose parent is the fetch span.
4. `span("RegistrationService.registerUser")` creates a **function** span (with its source file/line from the stack).
5. The instrumented Prisma client creates a **database** span `DemoUser.create`. Postgres rejects the duplicate email → span status `error`.
6. The API handles the conflict and returns `409`: the server http span stays `ok` with `httpStatus: 409`; the database/function throw remains captured as `error`. The browser fetch/root are flagged `error` for an unsuccessful request, without inventing an exception. Returned 5xx and thrown handler exceptions flag server HTTP error; thrown application exceptions still propagate unchanged. These display flags use a simplified DevLens policy, not the full OpenTelemetry status model.
7. Both SDKs send their spans to `POST /api/ingest`. Order does not matter — spans are joined later by id.
8. The dashboard lists the trace as failed. The explorer highlights the path root → … → `DemoUser.create`. The Timeline tab shows the same spans as a waterfall, so you can see where the time went.
9. Clicking the failed span shows its source. If the project has a `repoUrl` and a server-key span supplies a full 40-hex `commitSha` and a safe captured repo-relative path/line, the source can link to that commit on GitHub. DevLens validates the URL structure but cannot verify the claimed source or code execution.
10. "Copy context for AI" and "Download JSON" request the same authenticated server context endpoint. It checks ownership and selected IDs within the requested trace, sanitizes again, and uses the project repository URL and common source-link helper. It returns only the selected evidence (or the default failure path), including provenance; responses are private/no-store. No independent client builder exists.

### Cross-origin tracing

`traceparent` is not a CORS-safelisted header and can trigger OPTIONS preflight on application requests. `init({ endpoint, publicKey, traceOrigins })` propagates to same-origin by default and only listed cross-origin APIs. Their owners must allow the caller origin, method and `traceparent` plus existing headers; credentialed apps must configure credentials explicitly. No propagation for no-cors requests or unapproved destinations. Unsupported cross-origin redirects can break reliable propagation. A blocked preflight records a browser network failure; never retry a business request automatically without the header.

This differs from SDK delivery to `/api/ingest`, which uses JSON in `text/plain` without trace headers to avoid a preflight. Test both same-origin and cross-origin application APIs in a real browser, including denied preflight and an unapproved destination receiving no added header. See [W3C security/cross-origin risks](https://www.w3.org/TR/trace-context/#security-considerations) and [HTTP status conventions](https://opentelemetry.io/docs/specs/semconv/http/http-spans/#status).

## 5. Data model

| Model | Purpose |
|---|---|
| `User` | Dashboard user; password stored only as a bcrypt hash |
| `Project` | One monitored app; owns a public key, a hashed secret key, allowed origins and an optional GitHub `repoUrl` |
| `Span` | One recorded operation; primary key `(projectId, id)` so re-sent batches are ignored; stores server-derived `ingestSource` (`browser-public` or `server-secret`) |

## 6. Security model

- **Two keys per project.** The public key (`pk_…`) is visible and permits browser spans only, with an exact allowed Origin header (missing/`null` rejected). CORS/Origin constrain browsers, not attacker authentication: a non-browser caller can forge Origin and trace IDs. Browser spans are untrusted claims. The secret key (`sk_…`) stays server-side, is shown once and stored as SHA-256. Server provenance means key possession, not verified truth.
- **Provenance and correlation.** Ingest derives `ingestSource` from the verified key and rejects client-supplied provenance. The inspector and exports retain it. Correlation IDs/parent links never authorize reads or prove causality. First stored span ID wins; collisions cannot overwrite records but public telemetry can still pollute/collide with traces. This is an explicit MVP limitation.
- **Sanitization at the trust boundary.** Strict input schema, allowlisted diagnostic attributes, no raw bodies/query arguments or URL query strings; redact emails/bearer tokens, drop sensitive keys, truncate free text and reject unsafe source paths. Sanitize again on export. Redaction cannot guarantee removal of all PII: app owners must supply safe static names and messages, inspect representative exports and never submit secrets.
- **Limits and caveats.** 1 MiB per ingest request, 500 spans per batch, 600 attempted spans/minute/project including duplicates. Exact allowed-origin responses include `Vary: Origin`; no wildcard or credentialed ingest. The rate limit is a conservative demo default to validate with normal/concurrent workloads, not proven production capacity. Single-instance in-memory limits reset on restart and need expired-entry cleanup. Public-key spoofing, quota exhaustion and cumulative storage growth remain possible; wider deployment requires abuse controls, retention and key rotation beyond this MVP.
- **Ownership and AI context.** Every read checks `getOwnedProject`; export then loads exactly that project's trace and validates all selected IDs against it. Signed-out API requests get 401 JSON, another owner's/missing trace gets 404, invalid selections get 400. Only the server calls `buildContext(authorizedSpans, selectedIds, project.repoUrl)`; copy/download share this endpoint. Allowlist output fields and treat telemetry strings as data, never instructions for the receiving AI agent.
- **Bounded SDK overhead.** Errors in capture/export must not change application results; capture/delivery still consume CPU, memory and network. Both exporters cap retained spans (including in flight) at 500/1 MiB, discard newest overflow and oversized spans, send ≤100 spans/48 KiB at once, allow one in-flight request, abort at 2 s and retry at most once after 1 s for transient failure. Other 4xx discard; 429 also pauses delivery 60 s. Node wrappers never await export; pagehide sends one best-effort bounded batch. The plan's SDK delivery policy defines counters, timing and loss tests. Loss on exit/outage is expected; measure on/off demo overhead rather than claim zero overhead.
- **Safe links.** Only a validated `https://github.com/owner/repo`, full commit SHA and captured safe relative path/positive line form a link; omit invalid/missing evidence. Inspector and context use the same server helper. Browser-public source claims do not generate links. Links remain telemetry claims, not repository verification.
- **Health checks reveal nothing.** `/api/health` returns only `{ ok, db }`, never error text or settings.

## 6b. Deployment

| Piece | Where | Note |
|---|---|---|
| Dashboard, demo app | Two Render web services (long-running Node) | Not serverless: spans are sent after the response, and a frozen function would drop them |
| PostgreSQL | Neon (databases `devlens` and `demo`) | Pooled URL for the app, direct URL for migrations |
| Uptime | Monitor on both `/api/health` + public status page | Evidence of production quality; free Render services sleep when idle |
| CI | GitHub Actions | Typecheck, lint, unit and e2e tests on every push |

## 7. Why these choices (likely viva questions)

| Question | Short answer |
|---|---|
| Why Next.js + TypeScript and not Laravel? | The whole team knows JS; one language for SDKs, API and UI; shared types between them. The rubric does not require PHP. |
| Why React Flow and not Mermaid? | Mermaid draws static diagrams. We need click-to-inspect, collapse/expand and multi-select to narrow a bug down — that is interactive UI. |
| Why not store traces as a table? | A trace is just spans with the same `traceId`; storing it twice risks inconsistency. |
| What if the browser's spans never arrive? | The server spans' parent is missing; the explorer shows them as an "orphan" root instead of failing. |
| Why not full OpenTelemetry? | Its SDK is large; we only need the `traceparent` standard and a few span types. Upgrading later is possible because our format follows the same standard. |
| How do you prove usefulness? | Usability test: students diagnose the seeded bug with logs vs DevLens; we record time and correctness. |
| Why a graph *and* a timeline? | The graph shows *how* execution reached the failure; the timeline (waterfall, as in Grafana/Jaeger) shows *where the time went*. Both come from the same spans. |

## 8. How DevLens compares to existing tools

| Tool | What it does | What we took from it | Why DevLens is still different |
|---|---|---|---|
| Google Code Wiki | AI-written wiki, diagrams and chat for a repo, updated on every merge | Every visual links back to the exact code; give AI curated context, not raw files | It explains what code *exists*; DevLens shows what *actually ran* and where it failed — measured, not generated |
| Uptime monitors (UptimeRobot, Uptime Kuma) | Ping a URL, alert when it is down, public status page | `/api/health` endpoints and a status page for our own deployment | They only say "up or down", never *why* a request failed |
| PostHog | Product analytics, session replay, error tracking for the frontend | Browser-safe public key pattern (same idea as our `pk_`); error grouping as a future feature | Its focus is user behaviour in the browser; it does not follow a click through the server to the database query |
| Grafana (+ Tempo, Faro) | Dashboards; Tempo stores traces; Faro is a browser SDK that can link frontend to backend traces | The waterfall timeline view; using the W3C/OpenTelemetry trace standard | Closest competitor, but needs an observability stack to run and is built for ops teams. DevLens is one app, focused on the single failing path, and exports it for an AI agent |
