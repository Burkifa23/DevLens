import { z } from "zod";

/**
 * Which layer recorded a span. `browser` spans come from the browser SDK; the
 * other three come from the Node SDK. The ingest endpoint only accepts
 * `browser` spans from a public key (see Security model in docs/architecture.md).
 */
export const SpanKindSchema = z.enum(["browser", "http", "function", "database"]);
export type SpanKind = z.infer<typeof SpanKindSchema>;

/**
 * DevLens display flag, not the full OpenTelemetry status. See the plan's
 * "HTTP status policy": e.g. a server span that returns 409 stays `ok`.
 */
export const SpanStatusSchema = z.enum(["ok", "error"]);
export type SpanStatus = z.infer<typeof SpanStatusSchema>;

// W3C Trace Context forbids all-zero ids, so we reject them here too.
const hexId = (length: number) =>
  z.string().regex(new RegExp(`^[0-9a-f]{${length}}$`)).refine((v) => /[1-9a-f]/.test(v), "all-zero id");

/** 16 lowercase hex chars (8 random bytes), as in a `traceparent` parent-id. */
export const SpanIdSchema = hexId(16);
/** 32 lowercase hex chars (16 random bytes), as in a `traceparent` trace-id. */
export const TraceIdSchema = hexId(32);

// z.number() rejects Infinity and NaN in zod 4, so no extra finite() check is needed.
const AttributeValueSchema = z.union([z.string().max(2000), z.number(), z.boolean()]);

/**
 * One timed operation as it arrives over the wire from an SDK.
 *
 * Strict: unknown fields are rejected, so a client cannot smuggle in
 * `ingestSource` (provenance is decided by the server from the verified key).
 * The size limits keep one span small; the ingest endpoint's byte limit is
 * still the real cap on a request.
 */
export const SpanSchema = z.strictObject({
  id: SpanIdSchema,
  traceId: TraceIdSchema,
  parentSpanId: SpanIdSchema.optional(),
  name: z.string().min(1).max(200),
  kind: SpanKindSchema,
  startTime: z.iso.datetime({ offset: true }),
  durationMs: z.number().int().nonnegative(),
  status: SpanStatusSchema,
  errorMessage: z.string().max(8000).optional(),
  source: z
    .strictObject({ file: z.string().min(1).max(500), line: z.number().int().positive() })
    .optional(),
  attributes: z
    .record(z.string().min(1).max(64), AttributeValueSchema)
    .refine((a) => Object.keys(a).length <= 20, "at most 20 attributes"),
});
export type Span = z.infer<typeof SpanSchema>;

/**
 * Where a stored span came from, derived by the ingest server from the key
 * that was verified — never read from the request body.
 */
export type IngestSource = "browser-public" | "server-secret";

/** A span as read back from the database for the dashboard, graphs and exports. */
export type StoredSpan = Span & { ingestSource: IngestSource };

/**
 * The body of `POST /api/ingest`: the project key plus 1–500 spans.
 * Strict for the same reason as {@link SpanSchema}.
 */
export const IngestBatchSchema = z.strictObject({
  key: z.string().min(1).max(100),
  spans: z.array(SpanSchema).min(1).max(500),
});
export type IngestBatch = z.infer<typeof IngestBatchSchema>;
