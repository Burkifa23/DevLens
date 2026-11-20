# DevLens Architecture (study guide)

> Written before implementation from the plan in `docs/superpowers/plans/2026-11-20-devlens-mvp.md`. Each task updates this file if it changes the flow, data model or security model. Every member should be able to explain every section here in the viva.

## 1. What DevLens does

A developer's app fails. Instead of reading scattered browser and server logs, the developer opens DevLens and sees **one connected graph**: the button click, the HTTP request, the server function, the database query, and which one failed. They can then export the failing path as a small JSON file and give it to an AI coding agent, so the agent starts from evidence instead of guessing.

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
- **W3C `traceparent` header** — `00-<traceId>-<parentSpanId>-01`. The browser SDK adds it to each `fetch`; the server SDK reads it, so the server's spans join the browser's trace. This is the standard used by OpenTelemetry, which is why we chose it over a custom header.
- **AsyncLocalStorage (server)** — remembers "the current span" across `await`s inside one request, so concurrent requests never mix up their spans.
- **Explicit context (browser)** — the browser has no AsyncLocalStorage, so `track(name, fetch => …)` hands each action its own `fetch`. Two simultaneous actions therefore cannot be confused.

## 4. One request, step by step (duplicate registration)

1. User submits the form. `track("Submit registration", …)` creates a root **browser** span.
2. The tracked `fetch` creates a child **browser** span and sends `traceparent` with that span's id.
3. `withDevLens` on `POST /api/register` reads `traceparent` and creates an **http** span whose parent is the fetch span.
4. `span("RegistrationService.registerUser")` creates a **function** span (with its source file/line from the stack).
5. The instrumented Prisma client creates a **database** span `DemoUser.create`. Postgres rejects the duplicate email → span status `error`.
6. The API returns `409`; the http, fetch and root spans are marked `error` too.
7. Both SDKs send their spans to `POST /api/ingest`. Order does not matter — spans are joined later by id.
8. The dashboard lists the trace as failed. The explorer highlights the path root → … → `DemoUser.create`. The Timeline tab shows the same spans as a waterfall, so you can see where the time went.
9. Clicking the failed span shows its source. If the project has a `repoUrl` and the server sent a `commitSha`, the source is a link to the exact line on GitHub at the commit that ran.
10. "Copy context for AI" produces the `InvestigationContext` JSON for that path, including those links.

## 5. Data model

| Model | Purpose |
|---|---|
| `User` | Dashboard user; password stored only as a bcrypt hash |
| `Project` | One monitored app; owns a public key, a hashed secret key, allowed origins and an optional GitHub `repoUrl` |
| `Span` | One recorded operation; primary key `(projectId, id)` so re-sent batches are ignored |

## 6. Security model

- **Two keys per project.** The public key (`pk_…`) lives in browser code, so anyone can read it — that is why it may only submit `browser` spans and only from the project's allowed origins. The secret key (`sk_…`) stays on the server, is shown once, and is stored as a SHA-256 hash.
- **Sanitization at the trust boundary.** The ingest endpoint drops attributes like `password`, `token`, `cookie`, `authorization`, redacts emails and bearer tokens in messages, and truncates long strings. It runs on the server, so a modified SDK cannot skip it.
- **No query arguments.** Database spans store model, operation and duration only.
- **Limits.** 1 MB per request, 500 spans per batch, 600 spans per minute per project.
- **Ownership.** Every dashboard read goes through `getOwnedProject(userId, projectId)`; another user's trace returns 404.
- **Telemetry never breaks the app.** SDK send failures are swallowed.
- **Safe links.** `repoUrl` must be an `https://github.com/owner/repo` URL, because it becomes a clickable link — this blocks `javascript:` links.
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
