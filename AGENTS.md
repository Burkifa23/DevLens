# DevLens — instructions for AI coding agents

DevLens is a CS341 Web Technologies group project (5 members): a visual debugging tool that traces a failure from a browser click through the Next.js server to the database, shows it as an interactive React Flow graph, and exports the failing path as JSON context for an AI coding agent.

## Read these first

1. `docs/superpowers/plans/2026-11-20-devlens-mvp.md` — **the implementation plan. It is the source of truth** for file paths, function names, signatures, tests and task order. Do not rename or reshape an interface it defines; if you think it is wrong, stop and tell the human.
2. `docs/architecture.md` — how the system fits together (the viva study guide).
3. `chat.md` — the original product discussion (the spec). Where it changed its mind, its latest message wins.

## Working rules

- Work on one plan task at a time. Before starting, check which tasks are done (`git log`, checked boxes in the plan) and that the task's dependencies are merged.
- TDD: write the task's tests first, watch them fail, then implement.
- Follow the plan's **Global Constraints** — especially: Node runtime only, never store secrets/PII/query arguments, never fabricate source locations, telemetry must never break the instrumented app.
- **Documentation is part of done.** Every exported function/type/component gets a TSDoc comment (what + why). Update the README named in the plan's Documentation map with *How it works*, *Key files* and *Viva questions*. Update `docs/architecture.md` if you change the flow, data model or security model. Every member is examined on this code, so explain it for a student reader.
- Tick the task's checkboxes in the plan when its steps are done.
- Do not commit or push unless the human asks; when done, list the files changed and a suggested commit message.
- Keep it simple: no new dependencies or abstractions the plan does not call for.

## Layout (target)

```
apps/dashboard      Next.js dashboard: auth, projects, ingest API, trace list, explorer
apps/demo-app       Instrumented sample app with intentional failures
packages/shared     Span schema, traceparent helpers, sanitizer
packages/sdk-node   Server SDK (request/function/Prisma spans)
packages/sdk-browser Browser SDK (tracked actions, error capture)
docs/               Plan and architecture guide
```
