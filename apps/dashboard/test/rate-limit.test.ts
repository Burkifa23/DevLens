import { expect, test } from "vitest";
import { allowSpans, SPANS_PER_MINUTE, trackedProjects } from "@/lib/rate-limit";

const T0 = 1_000_000;

test("allows up to the limit per project per minute, then blocks", () => {
  expect(allowSpans("p1", SPANS_PER_MINUTE, T0)).toBe(true);
  expect(allowSpans("p1", 1, T0 + 1000)).toBe(false);
  expect(allowSpans("p2", 1, T0 + 1000)).toBe(true); // other projects are unaffected
});

test("a rejected batch is not counted", () => {
  expect(allowSpans("p3", 500, T0)).toBe(true);
  expect(allowSpans("p3", 200, T0)).toBe(false);
  expect(allowSpans("p3", 100, T0)).toBe(true);
});

test("the window resets after 60 seconds", () => {
  expect(allowSpans("p4", SPANS_PER_MINUTE, T0)).toBe(true);
  expect(allowSpans("p4", 1, T0 + 59_999)).toBe(false);
  expect(allowSpans("p4", 1, T0 + 60_000)).toBe(true);
});

test("idle projects are forgotten, so the map cannot grow forever", () => {
  allowSpans("idle-a", 1, T0);
  allowSpans("idle-b", 1, T0);
  const before = trackedProjects();
  allowSpans("busy", 1, T0 + 5 * 60_000); // a later call sweeps expired windows
  expect(trackedProjects()).toBeLessThan(before);
  expect(trackedProjects()).toBe(1);
});
