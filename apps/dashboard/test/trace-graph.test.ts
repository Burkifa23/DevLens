import { describe, expect, test } from "vitest";
import { defaultCollapsed, failurePath, toFlow, toWaterfall } from "../lib/trace-graph";
import { cyclicTrace, networkFailTrace, okTrace, registrationTrace, serverOnlyTrace, syntheticTrace } from "./fixtures/traces";

// The plan's Task 9 tests, unchanged.
describe("trace graph (plan tests)", () => {
  test("failure path for duplicate registration", () => {
    expect(failurePath(registrationTrace).map((s) => s.name)).toEqual(
      ["Submit registration", "fetch POST /api/register", "POST /api/register", "RegistrationService.registerUser", "DemoUser.create"]);
  });

  test("network failure: path ends at the browser fetch span", () => {
    expect(failurePath(networkFailTrace).at(-1)!.name).toBe("fetch POST /api/register");
  });

  test("missing parent becomes an orphan root", () => {
    const { nodes } = toFlow(serverOnlyTrace, { collapsed: new Set(), focusFailure: false });
    expect(nodes.find((n) => n.data.span.kind === "http")!.data.orphan).toBe(true);
  });

  test("large traces collapse successful subtrees", () => {
    const big = syntheticTrace(500, { failingLeaf: true });
    const { nodes } = toFlow(big, { collapsed: defaultCollapsed(big), focusFailure: false });
    expect(nodes.length).toBeLessThan(60);
    expect(nodes.some((n) => n.data.span.status === "error")).toBe(true);
  });

  test("waterfall rows are ordered, offset and never zero-width", () => {
    const rows = toWaterfall(registrationTrace);
    expect(rows.map((r) => r.depth)).toEqual([0, 1, 2, 3, 4]);
    expect(rows[0].offsetPct).toBe(0);
    expect(rows.every((r) => r.widthPct >= 0.5 && r.offsetPct + r.widthPct <= 100.5)).toBe(true);
    expect(toWaterfall(serverOnlyTrace)[0].depth).toBe(0);
  });
});

// Extra edge cases from the plan's contract text and Review Focus.
describe("trace graph (edge cases)", () => {
  test("no error means an empty failure path", () => {
    expect(failurePath(okTrace)).toEqual([]);
    expect(failurePath([])).toEqual([]);
  });

  test("ties between equally deep errors go to the earliest start", () => {
    const [root] = okTrace;
    const late = { ...root, id: "00000000000000a1", parentSpanId: root.id, name: "late", status: "error" as const, startTime: "2026-11-23T10:00:00.050Z" };
    const early = { ...late, id: "00000000000000a2", name: "early", startTime: "2026-11-23T10:00:00.010Z" };
    expect(failurePath([root, late, early]).at(-1)!.name).toBe("early");
  });

  test("cyclic parent claims terminate and every span is drawn once", () => {
    expect(failurePath(cyclicTrace).length).toBeGreaterThan(0);
    const { nodes, edges } = toFlow(cyclicTrace, { collapsed: new Set(), focusFailure: false });
    expect(nodes.map((n) => n.id).sort()).toEqual(cyclicTrace.map((s) => s.id).sort());
    expect(edges.length).toBeLessThan(nodes.length); // a forest has fewer edges than nodes
    expect(toWaterfall(cyclicTrace)).toHaveLength(cyclicTrace.length);
    expect(defaultCollapsed(cyclicTrace).size).toBe(0);
  });

  test("small traces start fully expanded", () => {
    expect(defaultCollapsed(registrationTrace).size).toBe(0);
    expect(defaultCollapsed(syntheticTrace(50, { failingLeaf: false })).size).toBe(0);
  });

  test("large traces keep the failing branch expanded", () => {
    const big = syntheticTrace(500, { failingLeaf: true });
    const collapsed = defaultCollapsed(big);
    for (const span of failurePath(big)) expect(collapsed.has(span.id)).toBe(false);
  });

  test("a collapsed span hides its descendants and counts them", () => {
    const { nodes, edges } = toFlow(registrationTrace, { collapsed: new Set([registrationTrace[2].id]), focusFailure: false });
    expect(nodes.map((n) => n.data.span.name)).toEqual(["Submit registration", "fetch POST /api/register", "POST /api/register"]);
    expect(nodes[2].data.hiddenChildren).toBe(2);
    expect(edges).toHaveLength(2);
  });

  test("focusFailure keeps only the failing path and marks it", () => {
    const big = syntheticTrace(100, { failingLeaf: true });
    const { nodes } = toFlow(big, { collapsed: new Set(), focusFailure: true });
    expect(nodes.map((n) => n.id)).toEqual(failurePath(big).map((s) => s.id));
    expect(nodes.every((n) => n.data.onFailurePath)).toBe(true);
  });

  test("focusFailure on a trace with no error shows everything", () => {
    expect(toFlow(okTrace, { collapsed: new Set(), focusFailure: true }).nodes).toHaveLength(okTrace.length);
  });

  test("nodes are laid out top to bottom at 240x64", () => {
    const { nodes, edges } = toFlow(registrationTrace, { collapsed: new Set(), focusFailure: false });
    expect(edges.map((e) => [e.source, e.target])).toEqual(
      registrationTrace.slice(1).map((s) => [s.parentSpanId, s.id]));
    for (let i = 1; i < nodes.length; i++) expect(nodes[i].position.y).toBeGreaterThan(nodes[i - 1].position.y);
    expect(nodes.every((n) => n.type === "span" && n.width === 240 && n.height === 64)).toBe(true);
  });

  test("a zero-length trace still gives visible bars", () => {
    const flat = registrationTrace.map((s) => ({ ...s, startTime: registrationTrace[0].startTime, durationMs: 0 }));
    expect(toWaterfall(flat).every((r) => r.offsetPct === 0 && r.widthPct === 0.5)).toBe(true);
  });
});
