import { CircleCheck, CircleX } from "lucide-react";
import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { buttonVariants } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { getOwnedProject } from "@/lib/projects";
import { requireUserId } from "@/lib/session";
import { listTraces, type TraceSummary } from "@/lib/traces";

export const metadata: Metadata = { title: "Traces" };

const PAGE_SIZE = 50;

/** The list's filters, read from the URL so a filtered view can be bookmarked or shared. */
type Filters = { onlyErrors: boolean; q: string; before?: Date };

/** Reads the search params, ignoring anything malformed rather than erroring. */
function readFilters(sp: Record<string, string | string[] | undefined>): Filters {
  const one = (v: string | string[] | undefined) => (Array.isArray(v) ? v[0] : v) ?? "";
  const before = new Date(one(sp.before));
  return {
    onlyErrors: one(sp.errors) === "1",
    q: one(sp.q).slice(0, 200),
    before: Number.isNaN(before.getTime()) ? undefined : before,
  };
}

/** Builds this page's URL for a set of filters (empty values are left out). */
function listHref(projectId: string, f: Filters): string {
  const params = new URLSearchParams();
  if (f.onlyErrors) params.set("errors", "1");
  if (f.q) params.set("q", f.q);
  if (f.before) params.set("before", f.before.toISOString());
  const query = params.toString();
  return `/projects/${projectId}${query ? `?${query}` : ""}`;
}

/** "142 ms" under a second, "1.25 s" above. */
function formatDuration(ms: number): string {
  return ms < 1000 ? `${ms} ms` : `${(ms / 1000).toFixed(2)} s`;
}

/** Server-rendered time in UTC, so it reads the same wherever the dashboard runs. */
function formatTime(d: Date): string {
  return `${d.toLocaleString("en-GB", { timeZone: "UTC", dateStyle: "medium", timeStyle: "medium" })} UTC`;
}

/**
 * Failed / OK badge. Shown with an icon and a word, never colour alone
 * (see "Design tokens" in the README); red is reserved for errors.
 */
function StatusBadge({ hasError }: { hasError: boolean }) {
  return hasError ? (
    <span className="inline-flex items-center gap-1 text-sm font-medium text-status-error">
      <CircleX className="size-4" aria-hidden />
      Failed
    </span>
  ) : (
    <span className="inline-flex items-center gap-1 text-sm text-muted-foreground">
      <CircleCheck className="size-4" aria-hidden />
      OK
    </span>
  );
}

/**
 * /projects/[projectId] — the project's traces, newest first (Task 8).
 *
 * Filters ("Errors only", search) and paging ("Older") are URL search params
 * handled by a plain GET form and links, so the page works without client
 * JavaScript. Another user's project gives the same 404 as a missing one.
 */
export default async function TraceListPage({
  params,
  searchParams,
}: {
  params: Promise<{ projectId: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const userId = await requireUserId();
  const { projectId } = await params;
  const project = await getOwnedProject(userId, projectId);
  if (!project) notFound();

  const filters = readFilters(await searchParams);
  const traces = await listTraces(project.id, { ...filters, limit: PAGE_SIZE });
  const filtered = filters.onlyErrors || filters.q !== "" || filters.before !== undefined;
  // A full page means there may be older traces; an empty "Older" page then just shows the empty state.
  const last = traces.at(-1);
  const olderHref = traces.length === PAGE_SIZE && last ? listHref(project.id, { ...filters, before: last.startTime }) : null;

  return (
    <main className="mx-auto grid w-full max-w-5xl gap-6 px-4 py-10">
      <nav aria-label="Breadcrumb" className="text-sm text-muted-foreground">
        <Link href="/projects" className="underline underline-offset-4 hover:text-foreground">
          Projects
        </Link>{" "}
        / <span className="text-foreground">{project.name}</span>
      </nav>

      <header className="flex flex-wrap items-center justify-between gap-4">
        <h1 className="text-2xl font-semibold tracking-tight">Traces</h1>
        <Link href={`/projects/${project.id}/settings`} className={buttonVariants({ variant: "outline" })}>
          Keys &amp; settings
        </Link>
      </header>

      <form method="get" action={`/projects/${project.id}`} className="flex flex-wrap items-center gap-3" role="search">
        <label className="flex items-center gap-2 text-sm">
          <input type="checkbox" name="errors" value="1" defaultChecked={filters.onlyErrors} className="size-4 accent-primary" />
          Errors only
        </label>
        <label htmlFor="trace-search" className="sr-only">
          Search span names
        </label>
        <Input
          id="trace-search"
          type="search"
          name="q"
          defaultValue={filters.q}
          placeholder="Search span names, e.g. DemoUser.create"
          maxLength={200}
          className="w-full sm:w-72"
        />
        <button type="submit" className={buttonVariants()}>
          Apply
        </button>
        {filtered && (
          <Link href={`/projects/${project.id}`} className="text-sm underline underline-offset-4">
            Clear
          </Link>
        )}
      </form>

      {traces.length === 0 ? (
        <EmptyState projectId={project.id} filtered={filtered} />
      ) : (
        <TraceTable projectId={project.id} traces={traces} />
      )}

      {(olderHref || filters.before) && (
        <nav aria-label="Pagination" className="flex gap-4 text-sm">
          {filters.before && (
            <Link href={listHref(project.id, { ...filters, before: undefined })} className="underline underline-offset-4">
              Newest
            </Link>
          )}
          {olderHref && (
            <Link href={olderHref} className="underline underline-offset-4">
              Older
            </Link>
          )}
        </nav>
      )}
    </main>
  );
}

/** Shown when there are no rows: either nothing has been recorded yet, or nothing matches the filters. */
function EmptyState({ projectId, filtered }: { projectId: string; filtered: boolean }) {
  return (
    <div className="rounded-lg border border-dashed p-8 text-center text-sm text-muted-foreground">
      {filtered ? (
        <p>No traces match these filters.</p>
      ) : (
        <p>
          No traces yet. Add the SDK keys from{" "}
          <Link href={`/projects/${projectId}/settings`} className="underline underline-offset-4">
            Keys &amp; settings
          </Link>{" "}
          to your app, then use it to record one.
        </p>
      )}
    </div>
  );
}

/** The trace rows: a table from the `md` breakpoint up, stacked cards below it. */
function TraceTable({ projectId, traces }: { projectId: string; traces: TraceSummary[] }) {
  const href = (t: TraceSummary) => `/projects/${projectId}/traces/${t.traceId}`;
  return (
    <>
      <table className="hidden w-full text-left text-sm md:table">
        <thead className="border-b text-muted-foreground">
          <tr>
            <th scope="col" className="py-2 pr-4 font-medium">Status</th>
            <th scope="col" className="py-2 pr-4 font-medium">Trace</th>
            <th scope="col" className="py-2 pr-4 font-medium">Started</th>
            <th scope="col" className="py-2 pr-4 text-right font-medium">Duration</th>
            <th scope="col" className="py-2 text-right font-medium">Spans</th>
          </tr>
        </thead>
        <tbody>
          {traces.map((t) => (
            <tr key={t.traceId} className="border-b last:border-0 hover:bg-muted/50">
              <td className="py-3 pr-4">
                <StatusBadge hasError={t.hasError} />
              </td>
              <td className="py-3 pr-4">
                <Link href={href(t)} className="font-medium underline underline-offset-4">
                  {t.rootName}
                </Link>
              </td>
              <td className="py-3 pr-4 text-muted-foreground">
                <time dateTime={t.startTime.toISOString()}>{formatTime(t.startTime)}</time>
              </td>
              <td className="py-3 pr-4 text-right tabular-nums">{formatDuration(t.durationMs)}</td>
              <td className="py-3 text-right tabular-nums">{t.spanCount}</td>
            </tr>
          ))}
        </tbody>
      </table>

      <ul className="grid gap-3 md:hidden">
        {traces.map((t) => (
          <li key={t.traceId} className="grid gap-1 rounded-lg border p-4">
            <div className="flex items-center justify-between gap-2">
              <StatusBadge hasError={t.hasError} />
              <span className="text-sm tabular-nums text-muted-foreground">
                {formatDuration(t.durationMs)} · {t.spanCount} span{t.spanCount === 1 ? "" : "s"}
              </span>
            </div>
            <Link href={href(t)} className="font-medium underline underline-offset-4">
              {t.rootName}
            </Link>
            <time dateTime={t.startTime.toISOString()} className="text-sm text-muted-foreground">
              {formatTime(t.startTime)}
            </time>
          </li>
        ))}
      </ul>
    </>
  );
}
