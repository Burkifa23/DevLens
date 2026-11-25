import { describe, expect, test } from "vitest";
import { buildContext, sourceUrl } from "../lib/context";
import { cyclicTrace, networkFailTrace, okTrace, registrationTrace } from "./fixtures/traces";

const repo = "https://github.com/team/DevLens";
const sha = "a".repeat(40);

// Ready now: sourceUrl needs no span contract, only strings and { file, line }.
describe("sourceUrl", () => {
  test("builds a link to the exact line at the exact commit", () => {
    expect(sourceUrl(repo, sha, { file: "apps/demo-app/services/registration.ts", line: 14 }))
      .toBe(`${repo}/blob/${sha}/apps/demo-app/services/registration.ts#L14`);
  });

  test("encodes each path segment but keeps the slashes", () => {
    expect(sourceUrl(repo, sha, { file: "src/my file#1.ts", line: 3 }))
      .toBe(`${repo}/blob/${sha}/src/my%20file%231.ts#L3`);
  });

  test("returns undefined when any piece of evidence is missing", () => {
    const source = { file: "a.ts", line: 1 };
    expect(sourceUrl(null, sha, source)).toBeUndefined();
    expect(sourceUrl(undefined, sha, source)).toBeUndefined();
    expect(sourceUrl(repo, undefined, source)).toBeUndefined();
    expect(sourceUrl(repo, sha, undefined)).toBeUndefined();
  });

  // Same assertions as the sourceUrl half of the plan's "unsafe or browser-public" test.
  test("rejects unsafe paths, short SHAs and non-GitHub repos", () => {
    for (const file of ["../secret.ts", "/tmp/secret.ts", "https://evil.test/x", "a/../../x"])
      expect(sourceUrl(repo, sha, { file, line: 1 })).toBeUndefined();
    expect(sourceUrl(repo, "abc123", { file: "a.ts", line: 1 })).toBeUndefined();
    expect(sourceUrl("javascript:alert(1)", sha, { file: "a.ts", line: 1 })).toBeUndefined();
  });

  test("rejects other path tricks", () => {
    for (const file of ["", "C:\\x.ts", "C:/x.ts", "a\\b.ts", "./a.ts", "a//b.ts", "a/", "a\u0000.ts", "a\n.ts", "x".repeat(501)])
      expect(sourceUrl(repo, sha, { file, line: 1 })).toBeUndefined();
  });

  test("rejects lines that are not positive integers", () => {
    for (const line of [0, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY])
      expect(sourceUrl(repo, sha, { file: "a.ts", line })).toBeUndefined();
  });

  test("rejects repo URLs that are not exactly https://github.com/owner/repo", () => {
    for (const bad of [
      "http://github.com/team/DevLens",
      "https://github.com/team",
      "https://github.com/team/DevLens/",
      "https://github.com/team/DevLens/tree/main",
      "https://github.com.evil.test/team/DevLens",
      "https://github.com/../DevLens",
      "https://github.com/team/..",
    ])
      expect(sourceUrl(bad, sha, { file: "a.ts", line: 1 })).toBeUndefined();
  });

  test("rejects a SHA with non-hex characters", () => {
    expect(sourceUrl(repo, "g".repeat(40), { file: "a.ts", line: 1 })).toBeUndefined();
  });
});

// The plan's buildContext tests, unchanged.
describe("buildContext (plan tests)", () => {
  test("context export matches the agreed shape and never invents source", () => {
    const c = buildContext(registrationTrace);
    expect(c.failure).toMatchObject({ operation: "DemoUser.create", kind: "database", source: "apps/demo-app/services/registration.ts:14" });
    expect(c.executionPath).toHaveLength(5);
    expect(buildContext(networkFailTrace).failure!.source).toBeUndefined();
    expect(buildContext(okTrace).failure).toBeNull();
  });

  test("source links only when repo, commit and source are all known", () => {
    const withSha = registrationTrace.map((s) => ({ ...s, attributes: { ...s.attributes, commitSha: "a".repeat(40) } }));
    expect(buildContext(withSha, undefined, "https://github.com/team/DevLens").failure!.sourceUrl)
      .toBe(`https://github.com/team/DevLens/blob/${"a".repeat(40)}/apps/demo-app/services/registration.ts#L14`);
    expect(buildContext(registrationTrace, undefined, "https://github.com/team/DevLens").failure!.sourceUrl).toBeUndefined();
    expect(buildContext(withSha, undefined, null).failure!.sourceUrl).toBeUndefined();
  });

  test("selection exports only selected sanitized evidence and provenance", () => {
    const selected = registrationTrace.at(-1)!;
    const c = buildContext(registrationTrace, [selected.id]);
    expect(c.spans.map((s) => s.spanId)).toEqual([selected.id]);
    expect(c.spans[0].ingestSource).toBe("server-secret");
    expect(c.evidence.spanCount).toBe(1);
    expect(c.executionPath).toEqual([selected.name]);
    const dirty = { ...selected, errorMessage: "dup a@b.co", attributes: { authorization: "Bearer secret" } };
    expect(JSON.stringify(buildContext([dirty]))).not.toMatch(/a@b\.co|Bearer secret|authorization/);
  });

  test("unsafe or browser-public source claims do not create links", () => {
    for (const file of ["../secret.ts", "/tmp/secret.ts", "https://evil.test/x", "a/../../x"])
      expect(sourceUrl(repo, sha, { file, line: 1 })).toBeUndefined();
    expect(sourceUrl(repo, "abc123", { file: "a.ts", line: 1 })).toBeUndefined();
    expect(sourceUrl("javascript:alert(1)", sha, { file: "a.ts", line: 1 })).toBeUndefined();
    const browser = { ...registrationTrace.at(-1)!, ingestSource: "browser-public" as const, attributes: { commitSha: sha } };
    expect(buildContext([browser], undefined, repo).spans[0].sourceUrl).toBeUndefined();
  });
});

// Extra cases from the buildContext contract text.
describe("buildContext (edge cases)", () => {
  test("default export is the failure path with its evidence", () => {
    const c = buildContext(registrationTrace);
    expect(c.traceId).toBe(registrationTrace[0].traceId);
    expect(c.spans.map((s) => s.spanId)).toEqual(registrationTrace.map((s) => s.id));
    expect(c.evidence).toEqual({ spanCount: 5, totalDurationMs: 120 });
    expect(c.failure!.error).toContain("P2002");
  });

  test("a trace with no error exports every span and no failure", () => {
    const c = buildContext(okTrace);
    expect(c.failure).toBeNull();
    expect(c.spans).toHaveLength(okTrace.length);
  });

  test("an empty selection is treated as the default", () => {
    expect(buildContext(registrationTrace, [])).toEqual(buildContext(registrationTrace));
  });

  test("selected spans come out root-first, and failure is computed from the selection only", () => {
    const [root, fetchSpan, http] = registrationTrace;
    const c = buildContext(registrationTrace, [http.id, root.id]);
    expect(c.executionPath).toEqual([root.name, http.name]);
    expect(c.failure!.spanId).toBe(root.id); // http is ok; the deeper database error was not selected
    expect(c.evidence.totalDurationMs).toBe(120);
    expect(JSON.stringify(c)).not.toContain(fetchSpan.id);
    expect(buildContext(registrationTrace, [http.id]).failure).toBeNull();
  });

  test("a response status is evidence, not an invented exception", () => {
    const fetchSpan = buildContext(registrationTrace, [registrationTrace[1].id]);
    expect(fetchSpan.spans[0].httpStatus).toBe(409);
    expect(fetchSpan.failure!.error).toBeUndefined();
    expect(fetchSpan.failure!.source).toBeUndefined();
  });

  test("only allowlisted fields are exported", () => {
    const c = buildContext(registrationTrace);
    expect(Object.keys(c.spans[4]).sort()).toEqual(["durationMs", "ingestSource", "kind", "name", "source", "spanId", "status"]);
    expect(JSON.stringify(c)).not.toMatch(/"attributes"|"parentSpanId"|"startTime"/);
  });

  test("cyclic parent claims terminate", () => {
    expect(buildContext(cyclicTrace).spans.length).toBeGreaterThan(0);
  });
});
