import { expect, test } from "vitest";
import { formatTraceparent, newSpanId, newTraceId, parseTraceparent } from "./traceparent";

test("round-trips", () => {
  const t = newTraceId(), s = newSpanId();
  expect(t).toMatch(/^[0-9a-f]{32}$/); expect(s).toMatch(/^[0-9a-f]{16}$/);
  expect(parseTraceparent(formatTraceparent(t, s))).toEqual({ traceId: t, parentSpanId: s });
});

test.each([
  null,
  "",
  "garbage",
  "00-" + "0".repeat(32) + "-" + "a".repeat(16) + "-01", // all-zero traceId is invalid per W3C
  "00-" + "a".repeat(32) + "-" + "0".repeat(16) + "-01", // all-zero parent id is invalid too
  "00-" + "A".repeat(32) + "-" + "a".repeat(16) + "-01", // W3C requires lowercase hex
  "01-zz-zz-01",
])("rejects %s", (h) => expect(parseTraceparent(h)).toBeNull());

test("ids are random", () => {
  expect(newTraceId()).not.toBe(newTraceId());
});
