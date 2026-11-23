import { describe, expect, test } from "vitest";
import { defaultCollapsed, failurePath, toFlow, toWaterfall } from "../lib/trace-graph";
import { networkFailTrace, registrationTrace, serverOnlyTrace, syntheticTrace } from "./fixtures/traces";

// WAITING ON TASKS 1–2: these are the plan's tests, unchanged. Every function here takes
// `StoredSpan[]`, so nothing can run until @devlens/shared exports it and the fixtures
// in ./fixtures/traces are filled in (jointly with Member 1). Then remove `.skip`.
describe.skip("trace graph (waiting on Task 1 StoredSpan contract)", () => {
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
