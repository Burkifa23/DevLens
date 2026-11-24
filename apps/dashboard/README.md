# DevLens dashboard

The Next.js app where developers sign in, create projects, receive spans from the SDKs, and explore traces. Each plan task adds its own section below.

## Running it locally

1. Start Postgres with `docker compose up -d` from the repo root, or use a local Postgres with databases `devlens`, `devlens_test` and `demo`.
2. Copy the dashboard block of `/.env.example` to `apps/dashboard/.env` and fill it in. Also set `TEST_DATABASE_URL` to the `devlens_test` database.
3. `pnpm --filter dashboard db:migrate`, then optionally `pnpm --filter dashboard db:seed` (creates `demo@devlens.test` with `SEED_PASSWORD`).
4. `pnpm --filter dashboard dev` and open http://localhost:3000.

Tests: `pnpm --filter dashboard test`. They migrate and wipe the `*_test` database and refuse to run against any other.

## Auth (Task 2)

### How it works

1. **Sign up** (`/signup`): `signUp` validates the form with zod (valid email; password 10–72 bytes, because bcrypt ignores anything past 72 bytes), lowercases the email, and stores a bcrypt hash at cost 12. A duplicate email is caught from the database's unique constraint (Prisma error `P2002`), so two simultaneous sign-ups can't both succeed. The signup form then logs the new user straight in.
2. **Log in** (`/login`): Auth.js's Credentials provider looks up the user and compares the password with bcrypt. Wrong email and wrong password give the same message and take the same time (unknown emails are compared against a dummy hash), so the form can't be used to discover who has an account.
3. **Session**: Auth.js stores the session in a signed, http-only JWT cookie. No session table is needed. The user id is the JWT `sub` and is exposed as `session.user.id`.
4. **Protecting pages**: `proxy.ts` (Next.js 16's new name for `middleware.ts`) redirects signed-out visitors of `/projects/*` to `/login`. That's only a quick first check. The real check is `requireUserId()`, which every protected page, server action and route handler must call itself.

### Key files

| Path | Role |
|---|---|
| `prisma/schema.prisma` | `User`, `Project`, `Span` models |
| `prisma.config.ts` | Prisma CLI config; migrations use `DIRECT_URL` |
| `prisma/migrations/` | SQL migrations, applied with `prisma migrate deploy` |
| `prisma/seed.ts` | Creates `demo@devlens.test` |
| `lib/db.ts` | The shared Prisma client (Prisma 7 `pg` adapter, `DATABASE_URL`) |
| `auth.ts` | Auth.js config: Credentials provider, JWT sessions, callbacks |
| `lib/session.ts` | `requireUserId()`: the real auth check |
| `proxy.ts` | Early redirect to `/login` for `/projects/*` |
| `app/(auth)/actions.ts` | `signUp`, `logIn`, `signUpAndLogIn` server actions |
| `app/(auth)/auth-form.tsx` | The shared email + password form |
| `app/api/auth/[...nextauth]/route.ts` | Auth.js HTTP endpoints |
| `test/setup.ts`, `test/global-setup.ts`, `test/test-db-url.ts` | Test database safety check, migrations, `resetDb()` |

### Viva questions

- **Why bcrypt and not SHA-256 for passwords?** bcrypt is deliberately slow (cost 12 is about 4,000 rounds of its key setup) and salted, so leaked hashes are expensive to brute-force. SHA-256 is fast, which helps attackers. (Project *secret keys* use SHA-256 in Task 3, because they are long random strings, not human-chosen passwords.)
- **Why is there a 72-character limit?** bcrypt only uses the first 72 bytes. Without the limit, two different long passwords sharing the first 72 bytes would both work.
- **Why catch P2002 instead of checking "does this email exist?" first?** Check-then-insert has a race: two requests can both see "no user" and both insert. The database's unique index is the only reliable check.
- **Why is `proxy.ts` not enough to protect pages?** It is an optimistic redirect that only runs for matched paths. A missed path or matcher typo would expose data, so each page and action re-checks with `requireUserId()`.
- **Where is the session stored?** In a signed JWT cookie (`AUTH_SECRET` signs it). The server can verify it without a database lookup; the trade-off is that a session can't be revoked before it expires.

## Projects & keys (Task 3)

### How it works

1. **Creating a project** (`/projects`): the form sends a name, allowed origins (one per line) and an optional GitHub repo URL to `createProjectAction`. The action re-checks the session with `requireUserId()` and calls `createProject`.
2. **Validation in `createProject`**: the name is trimmed (1–100 characters). Each origin goes through `new URL(o).origin`, so `http://localhost:3001/app?x=1` becomes `http://localhost:3001`. Only `http:` and `https:` are allowed, duplicates are removed, and there are at most 20. The repo URL must be exactly `https://github.com/owner/repo`. Any problem throws `ProjectInputError`, which the action turns into a form error. Any other error is a real bug and is rethrown.
3. **Two keys**: `pk_` + 24 random hex characters is the **public key**. It's stored as-is, because it goes into browser code. `sk_` + 32 random hex characters is the **secret key**. Only its SHA-256 hash is stored, and the key itself is returned exactly once, in the action's response, so the form can show it with a "copy it now" warning.
4. **Ownership**: `getOwnedProject(userId, projectId)` looks a project up by id *and* owner. Every page, action and route that takes a project id must use it. Someone else's project gives the same 404 as a project that doesn't exist.
5. **Settings** (`/projects/[projectId]/settings`): shows the public key with a copy button, the allowed origins, the repo link, and the environment variables to paste into the instrumented app. It never shows the secret key or its hash.

### Key files

| Path | Role |
|---|---|
| `lib/projects.ts` | `createProject`, `getOwnedProject`, `listProjects`, `hashKey`, `ProjectInputError` |
| `app/projects/actions.ts` | `createProjectAction`: session check, input to `createProject`, errors to form state |
| `app/projects/page.tsx` | Project list and the create form |
| `app/projects/create-project-form.tsx` | Client form; shows the new keys once |
| `app/projects/[projectId]/settings/page.tsx` | Keys, origins, repo link, setup snippet |
| `components/copy-button.tsx` | `CopyButton` and `KeyField` (monospace value + copy) |
| `test/projects.test.ts` | Key format and hashing, ownership, origin and repo validation |

### Viva questions

- **Why SHA-256 for the secret key when passwords use bcrypt?** The key is 128 random bits, so there is nothing to guess and a slow hash adds no protection; SHA-256 lets ingest find the project with one indexed lookup (`secretKeyHash`). Passwords are short and human-chosen, so they need bcrypt's deliberate slowness.
- **Why can't the dashboard show the secret key again?** Only the hash is stored, and a hash can't be reversed. If the database leaks, the attacker gets hashes, not working keys.
- **Why is the public key safe in browser code?** It can only submit `browser` spans, and only from the project's allowed origins (enforced in ingest, Task 4). It can't read anything. A non-browser client can fake the `Origin` header, so this limits honest browsers; it isn't authentication.
- **Why must the repo URL match `https://github.com/owner/repo` exactly?** It is rendered as a link. A looser check could store `javascript:alert(1)`, which would run code when clicked (stored XSS).
- **Why does someone else's project return 404 instead of 403?** A 403 would confirm that the id exists. A 404 reveals nothing.
- **Why normalize origins with `new URL(o).origin`?** Browsers send the `Origin` header as scheme + host + port only, lowercase, with no path or trailing slash. Storing the same form makes ingest's check an exact string match.

## Ingest (Task 4)

### How it works

`POST /api/ingest` is the only way spans get into DevLens. Both SDKs send `{ "key": "...", "spans": [...] }` as JSON with `Content-Type: text/plain`. That content type keeps the browser request a CORS "simple request", so there is no preflight `OPTIONS` round trip. `handleIngest` runs the checks cheapest first, so bad requests are rejected before they cost a database query:

1. **Size**: the body is read in chunks and abandoned as soon as it passes 1 MiB → `413`. It does not trust `Content-Length`, which a client can omit or fake.
2. **JSON + schema**: `IngestBatchSchema` from `@devlens/shared` is strict: 1–500 spans, size limits, and no unknown fields. A forged `ingestSource` field is rejected → `400`.
3. **Key**: `pk_…` is looked up as-is, `sk_…` by its SHA-256 hash → `401` if neither matches.
4. **Public key rules**: the `Origin` header must be one of the project's allowed origins (a missing or `"null"` Origin never matches), and every span must be `kind: "browser"` → `403`.
5. **Rate limit**: at most 600 spans per project per minute. Duplicates count, and a rejected batch doesn't → `429`.
6. **Store**: each span is sanitized, labelled with `ingestSource` (`browser-public` or `server-secret`, decided by which key was verified), and inserted with `createMany({ skipDuplicates: true })`. A span id already stored for the project is skipped, so the first copy wins and can't be overwritten. Re-sent batches are harmless. → `202 { accepted }`, the number of newly stored spans.

When the Origin was accepted, every response from step 4 on carries `Access-Control-Allow-Origin: <that origin>` and `Vary: Origin`, never `*`, so the browser SDK can read the status. Other origins get no CORS header, so the browser blocks the page from reading the response.

### Key files

| Path | Role |
|---|---|
| `lib/ingest.ts` | `handleIngest`: the checks above, CORS, row mapping |
| `lib/rate-limit.ts` | `allowSpans`: per-project fixed 60 s window, in memory |
| `app/api/ingest/route.ts` | The route; just calls `handleIngest` (Node runtime) |
| `test/ingest.test.ts` | Keys, origins, kinds, size, schema, flood, idempotency, CORS |
| `test/rate-limit.test.ts` | Window reset, rejected batches, idle cleanup (fake clock) |

### Viva questions

- **Why `text/plain` instead of `application/json`?** A cross-origin `application/json` POST triggers a CORS preflight (`OPTIONS`) first: two round trips per batch, and `sendBeacon` can't do it at all. `text/plain` is a "simple request" with no preflight; the server parses the body as JSON anyway.
- **Does the Origin check stop attackers?** No. Any non-browser client (curl, a script) can send any `Origin` header. It stops *other websites' pages* from using your public key through visitors' browsers. That's why the public key can only add browser spans, and why stored spans say `browser-public`: treat them as claims, not proof.
- **Why is `ingestSource` set by the server, and why reject it in the body?** If clients could label their own spans, a browser could pass its spans off as `server-secret` (trusted server evidence). Only the key the server verified decides the label.
- **Why read the body in chunks instead of checking `Content-Length`?** The header is optional and can lie. Reading everything first would let one request use unlimited memory; stopping at 1 MiB bounds it.
- **What happens if the same batch is sent twice?** The SDKs retry once on network errors, so it does happen. The primary key `(projectId, id)` plus `skipDuplicates` stores each span once, and the first copy wins.
- **What are the rate limiter's limits?** It's in memory, so it only works with one server instance and resets on restart. 600/minute is a demo default, not a measured capacity. The upgrade path is a shared counter in Postgres or Redis.

## Design tokens

Defined in `app/globals.css` and used as Tailwind classes, e.g. `text-status-error`, `bg-kind-database/10`.

| Token | Meaning |
|---|---|
| `primary` (indigo) | Actions, links, focus rings, selected nodes |
| `status-error` (= `destructive`, red) | A failed span. Red is used for nothing else. |
| `status-ok` (green) | A successful span, used sparingly; most OK spans stay neutral |
| `kind-browser` / `kind-http` / `kind-function` / `kind-database` | Span kind accents (blue, violet, teal, amber) |

Rules: status and kind are never shown by color alone; pair them with an icon or text, since about 1 in 12 men has red–green color blindness. Dark mode follows the operating system setting.
