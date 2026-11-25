import type { IngestSource, SpanKind, SpanStatus, StoredSpan } from "@devlens/shared";
import { prisma } from "@/lib/db";

/**
 * One row of the trace list. Computed from the trace's spans on every read:
 * there is no Trace table, a trace is just the spans sharing a `traceId`.
 */
export type TraceSummary = {
  traceId: string;
  /** Name of the earliest span, usually the user action that started the trace. */
  rootName: string;
  /** When the earliest span started. */
  startTime: Date;
  /** From the first span's start to the last span's end, in milliseconds. */
  durationMs: number;
  spanCount: number;
  /** True when any span in the trace has status "error". */
  hasError: boolean;
};

/** Options for {@link listTraces}. All come from the page's URL search params. */
export type ListTracesOptions = {
  /** Only traces with at least one failed span. */
  onlyErrors?: boolean;
  /** Case-insensitive text that must appear in at least one span name. */
  q?: string;
  /** Only traces that started before this time: the "Older" page. */
  before?: Date;
  /** Rows per page: default 50, at most 100. */
  limit?: number;
};

const DEFAULT_LIMIT = 50;
const MAX_LIMIT = 100;

/**
 * Lists a project's traces, newest first, as one grouped SQL query.
 *
 * Callers must check ownership first (`getOwnedProject`): this trusts `projectId`.
 *
 * Safe from SQL injection: Prisma's `$queryRaw` tagged template sends every
 * `${value}` as a bound parameter, never as SQL text. The search text's `%`, `_`
 * and `\` are escaped too, so they match literally instead of acting as LIKE wildcards.
 *
 * Paging is by start time ("Older" passes the last row's `startTime` as `before`).
 * Known limit: two traces starting in the same millisecond on a page boundary
 * could be skipped. Rare enough for this MVP.
 */
export async function listTraces(projectId: string, opts: ListTracesOptions): Promise<TraceSummary[]> {
  const limit = Math.min(Math.max(Math.trunc(opts.limit ?? DEFAULT_LIMIT), 1), MAX_LIMIT);
  const text = opts.q?.trim();
  const pattern = text ? `%${text.replace(/[\\%_]/g, (c) => `\\${c}`)}%` : null;
  const before = opts.before ?? null;

  return prisma.$queryRaw<TraceSummary[]>`
    SELECT "traceId",
           (array_agg("name" ORDER BY "startTime", "id"))[1] AS "rootName",
           min("startTime") AS "startTime",
           round(extract(epoch FROM max("startTime" + "durationMs" * interval '1 millisecond')
                                  - min("startTime")) * 1000)::int AS "durationMs",
           count(*)::int AS "spanCount",
           bool_or("status" = 'error') AS "hasError"
    FROM "Span"
    WHERE "projectId" = ${projectId}
    GROUP BY "traceId"
    HAVING (${opts.onlyErrors ?? false}::boolean = false OR bool_or("status" = 'error'))
       AND (${pattern}::text IS NULL OR bool_or("name" ILIKE ${pattern}::text))
       AND (${before}::timestamp IS NULL OR min("startTime") < ${before}::timestamp)
    ORDER BY min("startTime") DESC, "traceId" DESC
    LIMIT ${limit}`;
}

/**
 * Loads one trace's spans, oldest first, as the shared `StoredSpan` shape used by
 * the graph, timeline and AI export (Tasks 9–10).
 *
 * Filtering by `projectId` as well as `traceId` is what stops one project from
 * reading another project's spans, even if both used the same trace id.
 * The `as` casts are safe because ingest validated `kind`, `status` and
 * `ingestSource` before storing them. Optional fields that are NULL in the
 * database are left out rather than set to undefined.
 */
export async function getTraceSpans(projectId: string, traceId: string): Promise<StoredSpan[]> {
  const rows = await prisma.span.findMany({
    where: { projectId, traceId },
    orderBy: [{ startTime: "asc" }, { id: "asc" }],
  });

  return rows.map((r) => ({
    id: r.id,
    traceId: r.traceId,
    ...(r.parentSpanId !== null && { parentSpanId: r.parentSpanId }),
    name: r.name,
    kind: r.kind as SpanKind,
    startTime: r.startTime.toISOString(),
    durationMs: r.durationMs,
    status: r.status as SpanStatus,
    ...(r.errorMessage !== null && { errorMessage: r.errorMessage }),
    ...(r.sourceFile !== null && r.sourceLine !== null && { source: { file: r.sourceFile, line: r.sourceLine } }),
    attributes: r.attributes as StoredSpan["attributes"],
    ingestSource: r.ingestSource as IngestSource,
  }));
}
