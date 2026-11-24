import { IngestBatchSchema, sanitizeSpan, type IngestSource, type Span } from "@devlens/shared";
import { prisma } from "@/lib/db";
import { hashKey } from "@/lib/projects";
import { allowSpans } from "@/lib/rate-limit";

const MAX_BODY_BYTES = 1024 * 1024; // 1 MiB

/** JSON response; `corsOrigin` is echoed back only once the request's Origin has been verified for this project. */
function reply(status: number, body: unknown, corsOrigin?: string): Response {
  const headers = new Headers({ "content-type": "application/json" });
  if (corsOrigin) {
    // Exact origin, never "*", and no credentials: only that site's pages may read the response.
    headers.set("access-control-allow-origin", corsOrigin);
    headers.set("vary", "Origin");
  }
  return new Response(JSON.stringify(body), { status, headers });
}

/**
 * Reads the request body but gives up as soon as it passes `max` bytes.
 * Checking Content-Length alone isn't enough: a client can omit it or lie, and
 * buffering the whole body first would let one request use unbounded memory.
 * Returns null when the body is too large.
 */
async function readBodyWithLimit(req: Request, max: number): Promise<string | null> {
  const declared = Number(req.headers.get("content-length"));
  if (declared > max) return null;
  if (!req.body) return "";

  const reader = req.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > max) {
      await reader.cancel(); // stop the upload instead of reading the rest
      return null;
    }
    chunks.push(value);
  }
  return new TextDecoder().decode(Buffer.concat(chunks));
}

/** Finds the project a key belongs to: public keys are stored as-is, secret keys only as their SHA-256 hash. */
async function findProjectByKey(key: string): Promise<{ projectId: string; source: IngestSource; allowedOrigins: string[] } | null> {
  if (key.startsWith("pk_")) {
    const p = await prisma.project.findUnique({ where: { publicKey: key }, select: { id: true, allowedOrigins: true } });
    return p && { projectId: p.id, source: "browser-public", allowedOrigins: p.allowedOrigins };
  }
  if (key.startsWith("sk_")) {
    const p = await prisma.project.findUnique({ where: { secretKeyHash: hashKey(key) }, select: { id: true, allowedOrigins: true } });
    return p && { projectId: p.id, source: "server-secret", allowedOrigins: p.allowedOrigins };
  }
  return null;
}

/** Maps a sanitized wire span to a database row, adding the server-derived provenance. */
function toRow(span: Span, projectId: string, ingestSource: IngestSource) {
  return {
    projectId,
    id: span.id,
    traceId: span.traceId,
    parentSpanId: span.parentSpanId ?? null,
    name: span.name,
    kind: span.kind,
    startTime: new Date(span.startTime),
    durationMs: span.durationMs,
    status: span.status,
    ingestSource,
    errorMessage: span.errorMessage ?? null,
    sourceFile: span.source?.file ?? null,
    sourceLine: span.source?.line ?? null,
    attributes: span.attributes,
  };
}

/**
 * `POST /api/ingest`: where both SDKs send their spans.
 *
 * The body is `{ key, spans }` as JSON, sent as `text/plain` so browsers treat
 * it as a CORS "simple request" (no preflight). Checks run cheapest first, so
 * bad requests are rejected before they cost a database query:
 *
 * 1. size: over 1 MiB, 413
 * 2. JSON + strict schema: 400 (unknown fields such as a forged `ingestSource` included)
 * 3. key lookup: 401 for an unknown key
 * 4. public key only: the Origin must be one of the project's allowed origins and
 *    every span must be `kind: "browser"`, otherwise 403. The Origin header can be
 *    forged outside a browser, so this limits honest browsers; it isn't authentication.
 * 5. rate limit: 429 over 600 spans/minute per project
 * 6. sanitize each span, label it with where it came from (decided by the key, never
 *    by the client), and insert. Duplicate (projectId, id) pairs are skipped: the first
 *    stored span wins and can't be overwritten.
 *
 * Returns `202 { accepted }`, where accepted counts newly stored spans.
 */
export async function handleIngest(req: Request): Promise<Response> {
  const text = await readBodyWithLimit(req, MAX_BODY_BYTES);
  if (text === null) return reply(413, { error: "Body too large (max 1 MiB)" });

  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch {
    return reply(400, { error: "Body is not valid JSON" });
  }
  const parsed = IngestBatchSchema.safeParse(json);
  if (!parsed.success) return reply(400, { error: "Body does not match the span schema" });
  const { key, spans } = parsed.data;

  const project = await findProjectByKey(key);
  if (!project) return reply(401, { error: "Unknown key" });

  let corsOrigin: string | undefined;
  if (project.source === "browser-public") {
    const origin = req.headers.get("origin");
    // A missing Origin, or the literal "null" (sandboxed iframes, file:// pages), never matches.
    if (!origin || origin === "null" || !project.allowedOrigins.includes(origin)) {
      return reply(403, { error: "Origin not allowed for this key" });
    }
    corsOrigin = origin;
    if (spans.some((s) => s.kind !== "browser")) {
      return reply(403, { error: "The public key may only send browser spans" }, corsOrigin);
    }
  }

  if (!allowSpans(project.projectId, spans.length)) {
    return reply(429, { error: "Rate limit exceeded (600 spans per minute)" }, corsOrigin);
  }

  const rows = spans.map((s) => toRow(sanitizeSpan(s), project.projectId, project.source));
  const { count } = await prisma.span.createMany({ data: rows, skipDuplicates: true });
  return reply(202, { accepted: count }, corsOrigin);
}
