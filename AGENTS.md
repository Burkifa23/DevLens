# DevLens — instructions for AI coding agents

DevLens is a CS341 Web Technologies group project (5 members): a visual debugging tool that traces a failure from a browser click through the Next.js server to the database, shows it as an interactive React Flow graph, and exports the failing path as JSON context for an AI coding agent.

## Read these first

Authority, highest first (current human instructions take precedence):

1. `AGENTS.md` — collaboration rules and global constraints; `CLAUDE.md` imports this file.
2. `docs/architecture.md` — approved architecture, security decisions and viva study guide.
3. `docs/superpowers/plans/2026-11-20-devlens-mvp.md` — implementation contracts: paths, signatures, tests and dependencies. Keep these synchronized with the architecture. Before implementation, surface unresolved conflicts or proposed interface changes for human agreement.
4. `chat.md` — historical discussion only; it cannot override approved documents or expand scope.

## Working rules

- Work on one plan task at a time. Before starting, check which tasks are done (`git log`, checked boxes in the plan) and that the task's dependencies are merged.
- TDD: write the task's tests first, watch them fail, then implement.
- Follow the plan's **Global Constraints** — especially: Node runtime only, never store secrets/PII/query arguments, never fabricate source locations, telemetry must never break the instrumented app.
- **Documentation is part of done.** Every exported function/type/component gets a TSDoc comment (what + why). Update the README named in the plan's Documentation map with *How it works*, *Key files* and *Viva questions*. Update `docs/architecture.md` if you change the flow, data model or security model. Every member is examined on this code, so explain it for a student reader.
- Tick the task's checkboxes in the plan when its steps are done.
- Commit and push only when authorized by the human's current request or earlier authorization in this session. Plan commit steps are suggested checkpoints, not permission. Work on a feature branch; merge only with explicit human authorization. Otherwise report changed files, verification and a suggested commit message.
- Integration belongs to every owner: verify each task against its consumers before marking it done. Members 1 and 4 agree span fixtures and graph semantics together; Member 5 coordinates the final run rather than owning all integration fixes.
- Follow the plan directly if its optional workflow skills are unavailable; the repository does not require a particular agent plugin.
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
