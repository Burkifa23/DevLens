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

## Design tokens

Defined in `app/globals.css` and used as Tailwind classes, e.g. `text-status-error`, `bg-kind-database/10`.

| Token | Meaning |
|---|---|
| `primary` (indigo) | Actions, links, focus rings, selected nodes |
| `status-error` (= `destructive`, red) | A failed span. Red is used for nothing else. |
| `status-ok` (green) | A successful span, used sparingly; most OK spans stay neutral |
| `kind-browser` / `kind-http` / `kind-function` / `kind-database` | Span kind accents (blue, violet, teal, amber) |

Rules: status and kind are never shown by color alone; pair them with an icon or text, since about 1 in 12 men has red–green color blindness. Dark mode follows the operating system setting.
