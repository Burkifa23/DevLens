/**
 * Per-project ingest rate limit: at most {@link SPANS_PER_MINUTE} spans per
 * project in each fixed 60-second window.
 *
 * 600/minute is a conservative demo default, not a measured production capacity.
 *
 * ponytail: in-memory, single instance only; move to Postgres/Redis if horizontally scaled.
 * (Two server instances would each allow 600, and a restart resets the counts.)
 */
export const SPANS_PER_MINUTE = 600;
const WINDOW_MS = 60_000;

const windows = new Map<string, { windowStart: number; count: number }>();
let lastSweep = 0;

/**
 * Records an attempt to ingest `count` spans for `projectId` and says whether
 * it fits in the current window. Duplicates count too: the limit is on work
 * the server is asked to do, not on rows that end up stored.
 *
 * A rejected batch is not added to the count, so a client that backs off
 * (the SDKs pause 60 s after a 429) can resume in the same window.
 *
 * `now` is a parameter so tests can move the clock.
 */
export function allowSpans(projectId: string, count: number, now: number = Date.now()): boolean {
  sweepIdle(now);
  let entry = windows.get(projectId);
  if (!entry || now - entry.windowStart >= WINDOW_MS) {
    entry = { windowStart: now, count: 0 };
    windows.set(projectId, entry);
  }
  if (entry.count + count > SPANS_PER_MINUTE) return false;
  entry.count += count;
  return true;
}

/** At most once per window, forgets projects whose window has ended, so the map can't grow without bound. */
function sweepIdle(now: number): void {
  if (now - lastSweep < WINDOW_MS) return;
  lastSweep = now;
  for (const [projectId, entry] of windows) {
    if (now - entry.windowStart >= WINDOW_MS) windows.delete(projectId);
  }
}

/** How many projects the limiter is currently tracking (for tests). */
export function trackedProjects(): number {
  return windows.size;
}
