/**
 * AI investigation context (plan Task 9): the JSON a developer copies or downloads and gives
 * to an AI coding agent, plus the helper that turns captured source locations into GitHub links.
 *
 * SERVER-ONLY: only the authenticated context route (Task 10) and the trace page's server code
 * may import this file. The browser must never build its own export or source links: one
 * server builder means one place to enforce sanitizing, authorization and provenance rules.
 *
 * STATUS: `sourceUrl` is implemented and tested (it needs no span contract). `buildContext`
 * is WAITING ON TASK 1 (the `StoredSpan` type and `sanitizeSpan` from @devlens/shared).
 */
import type { SpanKind, SpanStatus, StoredSpan } from "@devlens/shared";
// TODO(Task 1): enable once @devlens/shared exists. Used by buildContext.
// import { sanitizeSpan } from "@devlens/shared";
// import { failurePath } from "./trace-graph";

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
 *
 * TODO(Task 1) algorithm:
 *  1. chosen = selectedIds?.length ? spans filtered to those ids
 *             : failurePath(spans).length ? failurePath(spans) : spans.
 *     (An empty selection is rejected by the route; here it is treated as "use the default".)
 *  2. Sanitize each chosen span with sanitizeSpan.
 *  3. Order the chosen spans root-first (by depth, then startTime) to get executionPath.
 *  4. failure = the deepest error within chosen (ties → earliest startTime), or null.
 *  5. For each span: link = ingestSource === "server-secret"
 *       ? sourceUrl(repoUrl, attributes.commitSha as string, source) : undefined.
 *  6. evidence: spanCount = chosen.length; totalDurationMs = max(end) - min(start) over chosen.
 *  7. Build the result field by field (an allowlist; never spread a span object).
 */
export function buildContext(
  spans: StoredSpan[],
  selectedIds?: string[],
  repoUrl?: string | null,
): InvestigationContext {
  void spans;
  void selectedIds;
  void repoUrl;
  throw new Error("buildContext: waiting on the Task 1 StoredSpan contract");
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
