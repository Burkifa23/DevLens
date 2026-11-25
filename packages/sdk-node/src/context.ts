import { AsyncLocalStorage } from "node:async_hooks";
import { newSpanId, newTraceId, type Span, type SpanKind } from "@devlens/shared";
import { createExporter, type Exporter } from "./exporter";
import { setRepoRoot, sourceFromStack } from "./stack";

/** The current span, as seen by code running inside it. */
export type SpanContext = { traceId: string; spanId: string };

/**
 * Remembers the current span across `await`s. Each `run()` gets its own
 * store, so two requests handled at the same time never see each other's
 * span — even though they share one Node thread.
 */
export const spanContext = new AsyncLocalStorage<SpanContext>();

/** Options for {@link configure}. */
export interface DevLensConfig {
  /** Full URL of the dashboard's `POST /api/ingest`. */
  endpoint: string;
  /** The project's secret `sk_` key. Server-side only — never ship it to the browser. */
  secretKey: string;
  /** Folder that source paths are made relative to. Defaults to `process.cwd()`. */
  repoRoot?: string;
  /** Deployed commit; added to every span so the dashboard can link to the exact source on GitHub. */
  commitSha?: string;
  /** Injected for tests; defaults to the global `fetch`. */
  fetch?: typeof fetch;
}

let exporter: Exporter | undefined;
let commitSha: string | undefined;

/**
 * Sets up the Node SDK. Call once at server start-up (e.g. in `lib/devlens.ts`).
 * Until it is called, wrappers still run the app's code but record nothing.
 */
export function configure(opts: DevLensConfig): void {
  exporter = createExporter({ endpoint: opts.endpoint, key: opts.secretKey, fetch: opts.fetch });
  commitSha = opts.commitSha;
  setRepoRoot(opts.repoRoot ?? process.cwd());
}

/** Internal: a span that has started but not ended yet. */
export interface ActiveSpan {
  traceId: string;
  id: string;
  parentSpanId?: string;
  name: string;
  kind: SpanKind;
  startTime: string;
  started: number;
}

/** Internal: starts a span under `parent`, or as the root of a new trace when there is none. */
export function startSpan(name: string, kind: SpanKind, parent: SpanContext | undefined): ActiveSpan {
  return {
    traceId: parent?.traceId ?? newTraceId(),
    id: newSpanId(),
    ...(parent && { parentSpanId: parent.spanId }),
    name,
    kind,
    startTime: new Date().toISOString(),
    started: performance.now(),
  };
}

/** Internal: the context that children of `span` should run in. */
export const contextOf = (span: ActiveSpan): SpanContext => ({ traceId: span.traceId, spanId: span.id });

/** Internal: how a span ended. Only safe, allowlisted facts go in here. */
export interface SpanOutcome {
  status: Span["status"];
  errorMessage?: string;
  source?: Span["source"];
  attributes?: Span["attributes"];
}

/** Internal: finishes a span and queues it. Does nothing before `configure()`. */
export function endSpan(active: ActiveSpan, outcome: SpanOutcome): void {
  if (!exporter) return;
  const { started, ...ids } = active;
  exporter.push({
    ...ids,
    durationMs: Math.max(0, Math.round(performance.now() - started)),
    status: outcome.status,
    ...(outcome.errorMessage !== undefined && { errorMessage: outcome.errorMessage }),
    ...(outcome.source && { source: outcome.source }),
    attributes: { ...outcome.attributes, ...(commitSha && { commitSha }) },
  });
}

/** Internal: starts delivery in the background. Callers never await it. */
export function scheduleFlush(): void {
  void exporter?.flush();
}

/** Internal (tests): sends the current batch. */
export async function flush(): Promise<void> {
  await exporter?.flush();
}

/**
 * Internal: the message to record for a thrown value. Prisma errors
 * (`PrismaClient*`) are trimmed with {@link prismaMessage} wherever they are
 * caught (database, function or http span); other values keep their message.
 */
export function messageOf(err: unknown): string {
  if (err instanceof Error && err.name.startsWith("PrismaClient")) return prismaMessage(err);
  return err instanceof Error ? err.message : String(err);
}

/**
 * Internal: keeps only the Prisma error code and the final reason line.
 * Prisma messages can print the failing call with its arguments (user data),
 * a code excerpt and the absolute file path above the reason, e.g.
 * "Invalid `prisma.user.create()` invocation in /srv/app/…/registration.ts:12:36 …
 * Unique constraint failed on the constraint: `User_email_key`".
 */
export function prismaMessage(err: unknown): string {
  const message = err instanceof Error ? err.message : String(err);
  const reason = message.split("\n").map((line) => line.trim()).filter(Boolean).at(-1) ?? "";
  const code = (err as { code?: unknown } | null)?.code;
  return typeof code === "string" ? `${code}: ${reason}` : reason;
}

/**
 * Internal: runs telemetry code and swallows its failures. Capture bugs must
 * never change what the application returns or throws.
 */
export function safely(fn: () => void): void {
  try {
    fn();
  } catch {
    // Deliberately ignored: see above.
  }
}

/**
 * Records `fn` as a `function` span, a child of the current span (or a new
 * trace when called outside a request). The span's `source` is the line that
 * called `span()`, taken from a real stack trace — never inferred.
 *
 * Returns exactly what `fn` returns and rethrows exactly what it throws; a
 * throw marks the span `error` even if the caller later handles it (e.g. as a 409).
 *
 * @example await span("RegistrationService.registerUser", () => registerUser(input))
 */
export async function span<T>(name: string, fn: () => Promise<T>): Promise<T> {
  let active: ActiveSpan | undefined;
  let source: Span["source"];
  try {
    active = startSpan(name, "function", spanContext.getStore());
    source = sourceFromStack(new Error().stack);
  } catch {
    active = undefined;
  }
  if (!active) return fn();
  const running = active;

  let value: T;
  try {
    value = await spanContext.run(contextOf(running), fn);
  } catch (err) {
    safely(() => endSpan(running, { status: "error", errorMessage: messageOf(err), source }));
    throw err;
  }
  safely(() => endSpan(running, { status: "ok", source }));
  return value;
}
