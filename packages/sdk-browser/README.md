# @devlens/sdk-browser

The browser half of DevLens instrumentation. It records each user action you wrap with `track` and each `fetch` that action makes, as `browser` spans. It adds the W3C `traceparent` header so the server's spans join the same trace, records uncaught errors, and sends everything to the dashboard with the project's **public** key.

## Usage

```tsx
// app/devlens-init.tsx
"use client";
import { useEffect } from "react";
import { init } from "@devlens/sdk-browser";

export function DevLensInit() {
  useEffect(() => {
    init({
      endpoint: process.env.NEXT_PUBLIC_DEVLENS_ENDPOINT!, // dashboard /api/ingest
      publicKey: process.env.NEXT_PUBLIC_DEVLENS_KEY!,    // pk_… (safe to ship)
      traceOrigins: [],                                   // extra API origins that may get traceparent
    });
  }, []);
  return null;
}
```

```ts
import { track } from "@devlens/sdk-browser";

const res = await track("Submit registration", (fetch) =>
  fetch("/api/register", { method: "POST", headers: { "content-type": "application/json" }, body }),
);
if (res.status === 409) showError("Email already registered"); // fetch still resolves on 4xx/5xx
```

Use the `fetch` that `track` passes in. The global `fetch` is not traced. Use static action names: names are stored, and redaction is only best effort.

## How it works

1. **`init`** creates the exporter, normalizes `traceOrigins` to exact origins, and registers one listener for each of `error`, `unhandledrejection` and `pagehide`. Calling `init` again (React strict mode, hot reload) swaps the exporter but never adds listeners twice.
2. **`track(name, fn)`** starts a root `browser` span and calls `fn` with a *traced fetch*. That function closes over the root span. The context travels with the function, not in a global "current span", so two overlapping actions can never cross-link. The browser has no AsyncLocalStorage.
3. Each **traced fetch** starts a child span `fetch <METHOD> <path>` (the path has no query string or fragment). It then decides whether to add `traceparent = 00-<traceId>-<child span id>-01`:
   - **Yes** for same-origin URLs and origins listed in `traceOrigins`.
   - **No** for `mode: "no-cors"` and for every other origin.

   It starts from the headers fetch would have used (`init.headers`, else the `Request`'s own) and adds ours. Method, body and the original `Request` object pass through unchanged.
4. **Status** follows the plan's HTTP status policy:
   - A 4xx/5xx response flags the fetch span `error` with `httpStatus`, without inventing an exception, and `fetch` still resolves.
   - A network failure (offline, DNS, blocked preflight) records the real error message and rejects with the original error. It is never retried, because retrying a business request could duplicate side effects.
   - The root span is `error` if `fn` throws (with the real message) or any child failed (no message).
5. **Uncaught errors and unhandled rejections** become standalone root spans named `uncaught error`. The browser cannot know which action caused them, so they are not linked to one.
6. **Delivery** uses the same bounded exporter contract as the Node SDK:
   - Spans are sanitized on enqueue.
   - At most 500 spans / 1 MiB are held, and spans over 16 KiB are dropped.
   - Each request carries at most 100 spans / 48 KiB, one request is in flight at a time, and a 2 s timer triggers sends.
   - Requests time out after 2 s, with one retry for network errors and 5xx. A 429 pauses sending for 60 s.
   - Bodies are JSON sent as `text/plain`, a CORS "simple request" with no preflight.
   - On `pagehide` it sends **one** batch with `navigator.sendBeacon`. If the beacon is refused, it makes one `keepalive` fetch instead, with no retries. A beacon being accepted does not prove delivery, so closing a tab can lose spans.

### Cross-origin APIs (preflight)

`traceparent` is **not** a CORS-safelisted header. Adding it to a request for another origin makes the browser send an `OPTIONS` preflight first. To trace an API on another origin:

- List its exact origin in `traceOrigins`.
- Have the API answer the preflight with your page's origin in `Access-Control-Allow-Origin`, the method in `Access-Control-Allow-Methods`, and `traceparent` (plus headers you already send, such as `content-type`) in `Access-Control-Allow-Headers`. Configure credentials only if the app already needs them.

If the API omits `traceparent`, the browser blocks the request. The fetch span records a network failure, and the SDK does **not** retry without the header. Unlisted origins still get a local fetch span, but no header and therefore no server link. Redirects to another origin are unsupported for reliable propagation, so don't trace redirecting third-party endpoints. jsdom tests can't prove CORS behaviour; real-browser preflight checks belong to Task 11.

## Key files

| Path | Role |
|---|---|
| `src/index.ts` | `init`, `track`, the traced fetch, propagation rules, uncaught-error listeners |
| `src/exporter.ts` | `createExporter`: bounded queue, batching, timeout, retry, 429 pause, `sendOnPageHide` |
| `src/index.test.ts` | `track`/fetch/propagation/error tests (jsdom, fake `fetch`, a fake CORS API) |
| `src/exporter.test.ts` | Delivery-policy tests, including beacon and keepalive behaviour |
| `vitest.config.ts` | Runs the tests in jsdom |

Run `pnpm --filter @devlens/sdk-browser test`.

## Viva questions

- **Two registrations are submitted at the same time. Why don't their spans mix?** Each `track` call creates its own root span and its own traced `fetch` that closes over it. There is no shared "current span" variable that a second action could overwrite. The test fires two overlapping actions and expects two trace ids.
- **Why not add `traceparent` to every request?** It isn't CORS-safelisted, so cross-origin requests would need a preflight that most third-party APIs reject, which would break the app. It would also leak trace ids to third parties. So the header goes only to same-origin requests and explicitly approved `traceOrigins`, and never with `no-cors`.
- **The server returns 409. What does the browser record?** The fetch span and the root are flagged `error` with `httpStatus: 409`, but with no `errorMessage`, because no exception happened. `fetch` resolves normally so the app can show its message.
- **Why is the exporter's body `text/plain` when it is JSON?** `text/plain` POSTs are CORS "simple requests", so sending spans to the dashboard needs no preflight. The ingest endpoint parses the text as JSON.
- **Can a closed tab lose spans?** Yes. On `pagehide` the SDK sends one batch of up to 48 KiB by beacon (or keepalive fetch) with no retries. Anything beyond that, or anything the browser drops, is lost. The dashboard copes with incomplete traces: a server span whose parent never arrived is shown as an orphan root.
