/**
 * AI investigation context (plan Task 9): the JSON a developer copies or downloads and gives
 * to an AI coding agent, plus the helper that turns captured source locations into GitHub links.
 *
 * SERVER-ONLY: only the authenticated context route (Task 10) and the trace page's server code
 * may import this file. The browser must never build its own export or source links: one
 * server builder means one place to enforce sanitizing, authorization and provenance rules.
 *
 * (`server-only` isn't a dependency of this app, so this rule is enforced by review: Task 10's
 * client components import `lib/trace-graph`, never this file.)
 */
import { sanitizeSpan, type SpanKind, type SpanStatus, type StoredSpan } from "@devlens/shared";
import { failurePath, spanDepths } from "./trace-graph";

/**
 * The exported investigation context: only diagnostic evidence, never raw request data.
 * Every field here is on an allowlist; arbitrary span attributes are never copied in.
 * The strings are telemetry: an AI agent must treat them as data, not as instructions.
 */
export type InvestigationContext = {
  traceId: string;
  failure: {
    spanId: string;
    operation: string;
    kind: SpanKind;
    error?: string;
    source?: string;
    sourceUrl?: string;
  } | null;
  executionPath: string[];
  spans: {
    spanId: string;
    ingestSource: StoredSpan["ingestSource"];
    name: string;
    kind: SpanKind;
    status: SpanStatus;
    durationMs: number;
    source?: string;
    sourceUrl?: string;
    httpStatus?: number;
  }[];
  evidence: { totalDurationMs: number; spanCount: number };
};

/**
 * Builds the AI context for one already-authorized trace (the caller has checked ownership).
 *
 * Which spans are used: the `selectedIds` if non-empty, else the failure path, else all spans.
 * The failure, executionPath (root-first names) and evidence are all computed from that chosen
 * subset only, so unselected siblings never leak into the export.
 *
 * - Sanitizes again, as defence in depth, in case the stored data predates a sanitizer fix.
 * - Formats `source` as "file:line", and only when it was captured.
 * - Adds `sourceUrl` only for `server-secret` spans, and only when `sourceUrl()` validates
 *   the repo, the commit and the path.
 * - Copies fields one by one (an allowlist) and never spreads a span, so a new span field or
 *   an arbitrary attribute can't slip into the export.
 *
 * An explicit empty selection is rejected by the route (400); here it is treated as "use the
 * default", defensively. Depth is measured in the whole trace, so "deepest error" and
 * "root-first" mean the same thing for a selection as they do for the full graph.
 */
export function buildContext(
  spans: StoredSpan[],
  selectedIds?: string[],
  repoUrl?: string | null,
): InvestigationContext {
  const clean = spans.map(sanitizeSpan);
  const depths = spanDepths(clean);
  const start = (s: StoredSpan) => Date.parse(s.startTime);

  let chosen: StoredSpan[];
  if (selectedIds && selectedIds.length > 0) {
    const wanted = new Set(selectedIds);
    chosen = clean.filter((s) => wanted.has(s.id));
  } else {
    const path = failurePath(clean);
    chosen = path.length > 0 ? path : clean;
  }
  // Root-first: shallower spans first; among equals, the one that started first.
  chosen = [...chosen].sort((a, b) => depths.get(a.id)! - depths.get(b.id)! || start(a) - start(b));

  // The deepest error in the chosen spans (ties → earliest start), or null if none failed.
  let failed: StoredSpan | undefined;
  for (const span of chosen) {
    if (span.status !== "error") continue;
    if (!failed || depths.get(span.id)! > depths.get(failed.id)! ||
        (depths.get(span.id) === depths.get(failed.id) && start(span) < start(failed))) failed = span;
  }

  const location = (s: StoredSpan) => (s.source ? `${s.source.file}:${s.source.line}` : undefined);
  // Only server-key spans may produce links; browser-public source claims are shown as text only.
  const link = (s: StoredSpan) => {
    if (s.ingestSource !== "server-secret") return undefined;
    const sha = s.attributes.commitSha;
    return sourceUrl(repoUrl, typeof sha === "string" ? sha : undefined, s.source);
  };
  // Leave out keys whose value is undefined, so the JSON has no "source": undefined noise.
  const defined = <T extends object>(o: T): T =>
    Object.fromEntries(Object.entries(o).filter(([, v]) => v !== undefined)) as T;

  const ends = chosen.map((s) => start(s) + s.durationMs);
  const starts = chosen.map(start);

  return {
    traceId: clean[0]?.traceId ?? "",
    failure: failed
      ? defined({
          spanId: failed.id,
          operation: failed.name,
          kind: failed.kind,
          error: failed.errorMessage,
          source: location(failed),
          sourceUrl: link(failed),
        })
      : null,
    executionPath: chosen.map((s) => s.name),
    spans: chosen.map((s) =>
      defined({
        spanId: s.id,
        ingestSource: s.ingestSource,
        name: s.name,
        kind: s.kind,
        status: s.status,
        durationMs: s.durationMs,
        source: location(s),
        sourceUrl: link(s),
        httpStatus: typeof s.attributes.httpStatus === "number" ? s.attributes.httpStatus : undefined,
      }),
    ),
    evidence: {
      totalDurationMs: chosen.length > 0 ? Math.max(...ends) - Math.min(...starts) : 0,
      spanCount: chosen.length,
    },
  };
}

/** Same rule as Task 3's createProject: exactly https://github.com/<owner>/<repo>. */
const GITHUB_REPO = /^https:\/\/github\.com\/([\w.-]+)\/([\w.-]+)$/;
/** A full commit SHA. A short SHA could be ambiguous, so it is refused. */
const FULL_SHA = /^[0-9a-f]{40}$/i;
/** ASCII control characters (including newline and NUL) never belong in a path. */
const CONTROL_CHARS = /[\u0000-\u001f\u007f]/;
/** Same cap as the span schema's source.file limit. */
const MAX_FILE_LENGTH = 500;

/**
 * Builds a GitHub link to the exact line of a captured source location:
 * `${repoUrl}/blob/${commitSha}/${file}#L${line}`.
 *
 * Returns `undefined` unless every piece of evidence is present and safe, because this string
 * is rendered as a clickable link and exported to an AI agent:
 * - `repoUrl` must be exactly `https://github.com/owner/repo`. This blocks `javascript:`
 *   URLs and other hosts. Dot-only owner or repo names are also rejected.
 * - `commitSha` must be a full 40-character hex SHA, so the link points at the code that ran,
 *   not whatever is on `main` today.
 * - `file` must be a clean repo-relative path. That means no leading slash, no drive letter
 *   or URL scheme (no `:`), no backslashes, no empty, `.` or `..` segments, and no control
 *   characters. Each segment is URL-encoded.
 * - `line` must be a positive integer.
 *
 * Only call this for `server-secret` spans (the callers enforce that). Even then, the link is
 * a telemetry claim: DevLens checks that the URL is well-formed, not that the repository
 * really contains that code or that it ran.
 */
export function sourceUrl(
  repoUrl: string | null | undefined,
  commitSha: string | undefined,
  source: { file: string; line: number } | undefined,
): string | undefined {
  if (typeof repoUrl !== "string" || typeof commitSha !== "string" || !source) return undefined;

  const repo = GITHUB_REPO.exec(repoUrl);
  // "." and ".." match [\w.-]+ but would turn the link into a different GitHub path.
  if (!repo || repo.slice(1).some((part) => /^\.+$/.test(part))) return undefined;

  if (!FULL_SHA.test(commitSha)) return undefined;

  const { file, line } = source;
  if (!Number.isSafeInteger(line) || line < 1) return undefined;
  if (typeof file !== "string" || file.length === 0 || file.length > MAX_FILE_LENGTH) return undefined;
  // ":" covers both URL schemes (https:) and Windows drive letters (C:).
  if (CONTROL_CHARS.test(file) || file.includes("\\") || file.includes(":")) return undefined;

  const segments = file.split("/");
  // A leading "/" (absolute), "//", a trailing "/", "." and ".." (traversal) all produce a bad segment.
  if (segments.some((s) => s === "" || s === "." || s === "..")) return undefined;

  const path = segments.map(encodeURIComponent).join("/");
  return `${repoUrl}/blob/${commitSha}/${path}#L${line}`;
}
