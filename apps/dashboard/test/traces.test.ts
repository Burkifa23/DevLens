import type { StoredSpan } from "@devlens/shared";
import { beforeEach, expect, test } from "vitest";
import { prisma } from "@/lib/db";
import { createProject } from "@/lib/projects";
import { getTraceSpans, listTraces } from "@/lib/traces";

// Task 8 needs several separate traces (different trace ids, different times), so its
// sample traces live here rather than in fixtures/traces.ts, whose traces share one id.

/** A sample trace: its id plus its spans. */
type Fixture = { id: string; spans: StoredSpan[] };

const T0 = Date.parse("2026-11-23T10:00:00.000Z");
const at = (ms: number) => new Date(T0 + ms).toISOString();
/** Span id `n` as 16 hex characters (never all zero). */
const sid = (prefix: string, n: number) => `${prefix}${n.toString(16).padStart(15, "0")}`;

/** Builds a fixture whose spans form one parent → child chain, starting `offsetMs` after T0. */
function chain(
  traceId: string,
  offsetMs: number,
  spans: Array<Partial<StoredSpan> & Pick<StoredSpan, "name" | "kind" | "status" | "durationMs">>,
): Fixture {
  const p = traceId[0]!; // keeps span ids unique across fixtures
  return {
    id: traceId,
    spans: spans.map((s, i) => ({
      id: sid(p, i + 1),
      traceId,
      parentSpanId: i === 0 ? undefined : sid(p, i),
      startTime: at(offsetMs + i * 10),
      attributes: {},
      ingestSource: s.kind === "browser" ? "browser-public" : "server-secret",
      ...s,
    })),
  };
}

/** Duplicate-email registration (newer): the database insert fails. */
const failedRegistrationTrace = chain("a".repeat(32), 60_000, [
  { name: "Submit registration", kind: "browser", status: "error", durationMs: 120 },
  { name: "fetch POST /api/register", kind: "browser", status: "error", durationMs: 110, attributes: { httpStatus: 409 } },
  { name: "POST /api/register", kind: "http", status: "ok", durationMs: 90, attributes: { httpStatus: 409 } },
  { name: "RegistrationService.registerUser", kind: "function", status: "error", durationMs: 70 },
  {
    name: "DemoUser.create", kind: "database", status: "error", durationMs: 40,
    errorMessage: "Unique constraint failed on the fields: (`email`)",
    source: { file: "apps/demo-app/services/registration.ts", line: 14 },
    attributes: { model: "DemoUser", operation: "create" },
  },
]);

/** A successful page load (older): no errors anywhere. */
const okTrace = chain("b".repeat(32), 0, [
  { name: "Load stats", kind: "browser", status: "ok", durationMs: 80 },
  { name: "fetch GET /api/stats", kind: "browser", status: "ok", durationMs: 70 },
  { name: "GET /api/stats", kind: "http", status: "ok", durationMs: 50 },
]);

/** Inserts fixture spans for a project, converting StoredSpan fields to database columns. */
async function seedSpans(projectId: string, traces: Fixture[]): Promise<void> {
  await prisma.span.createMany({
    data: traces.flatMap((t) =>
      t.spans.map((s) => ({
        projectId,
        id: s.id,
        traceId: s.traceId,
        parentSpanId: s.parentSpanId ?? null,
        name: s.name,
        kind: s.kind,
        startTime: new Date(s.startTime),
        durationMs: s.durationMs,
        status: s.status,
        ingestSource: s.ingestSource,
        errorMessage: s.errorMessage ?? null,
        sourceFile: s.source?.file ?? null,
        sourceLine: s.source?.line ?? null,
        attributes: s.attributes,
      })),
    ),
  });
}

let projectId: string;
let otherProjectId: string;

beforeEach(async () => {
  const owner = await prisma.user.create({ data: { email: "owner@devlens.test", passwordHash: "x" } });
  projectId = (await createProject(owner.id, "Demo", [])).project.id;
  otherProjectId = (await createProject(owner.id, "Other", [])).project.id;
});

test("summarizes and filters traces", async () => {
  await seedSpans(projectId, [okTrace, failedRegistrationTrace]);
  const all = await listTraces(projectId, {});
  expect(all.map((t) => t.traceId)).toEqual([failedRegistrationTrace.id, okTrace.id]);
  expect(all[0]).toMatchObject({ rootName: "Submit registration", spanCount: 5, hasError: true });
  expect(await listTraces(projectId, { onlyErrors: true })).toHaveLength(1);
  expect(await listTraces(projectId, { q: "demouser.create" })).toHaveLength(1);
});

test("never leaks another project's spans", async () => {
  await seedSpans(otherProjectId, [okTrace]);
  expect(await getTraceSpans(projectId, okTrace.id)).toEqual([]);
  expect(await listTraces(projectId, {})).toEqual([]);
});

// Beyond the plan's two tests: the summary maths, paging and search edge cases.

test("start time and duration cover the whole trace", async () => {
  await seedSpans(projectId, [failedRegistrationTrace]);
  const [t] = await listTraces(projectId, {});
  expect(t!.startTime).toEqual(new Date(T0 + 60_000));
  // Root starts at 0 ms and lasts 120 ms; the last span ends at 40 + 40 = 80 ms, so 120 wins.
  expect(t!.durationMs).toBe(120);
  expect((await listTraces(projectId, { q: "nothing matches" }))).toEqual([]);
});

test("'Older' paging uses before, and limit is capped at 100", async () => {
  await seedSpans(projectId, [okTrace, failedRegistrationTrace]);
  const page1 = await listTraces(projectId, { limit: 1 });
  expect(page1.map((t) => t.traceId)).toEqual([failedRegistrationTrace.id]);
  const page2 = await listTraces(projectId, { limit: 1, before: page1[0]!.startTime });
  expect(page2.map((t) => t.traceId)).toEqual([okTrace.id]);
  expect(await listTraces(projectId, { limit: 1_000 })).toHaveLength(2); // capped, not rejected
});

test("search treats % and _ literally", async () => {
  await seedSpans(projectId, [okTrace, failedRegistrationTrace]);
  expect(await listTraces(projectId, { q: "%" })).toEqual([]);
  expect(await listTraces(projectId, { q: "_" })).toEqual([]);
});

test("getTraceSpans returns StoredSpans in start order, with provenance and source", async () => {
  await seedSpans(projectId, [failedRegistrationTrace, okTrace]);
  const spans = await getTraceSpans(projectId, failedRegistrationTrace.id);
  expect(spans).toEqual(failedRegistrationTrace.spans);
  expect(spans.at(-1)).toMatchObject({
    ingestSource: "server-secret",
    source: { file: "apps/demo-app/services/registration.ts", line: 14 },
  });
  expect(spans[0]).not.toHaveProperty("source");
});
