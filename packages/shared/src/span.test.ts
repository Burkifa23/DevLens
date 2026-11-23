import { expect, test } from "vitest";
import { IngestBatchSchema, SpanSchema } from "./span";
import { validSpan } from "./test-fixtures";

test("accepts a valid span", () => {
  expect(SpanSchema.safeParse(validSpan).success).toBe(true);
});

test("rejects bad ids, unknown kind, >500 spans", () => {
  expect(SpanSchema.safeParse({ ...validSpan, id: "xyz" }).success).toBe(false);
  expect(SpanSchema.safeParse({ ...validSpan, kind: "shell" }).success).toBe(false);
  expect(IngestBatchSchema.safeParse({ key: "pk_x", spans: Array(501).fill(validSpan) }).success).toBe(false);
});

test("rejects client-supplied provenance and other unknown fields", () => {
  expect(SpanSchema.safeParse({ ...validSpan, ingestSource: "server-secret" }).success).toBe(false);
  expect(IngestBatchSchema.safeParse({ key: "pk_x", spans: [validSpan], extra: 1 }).success).toBe(false);
});

test("rejects nonfinite or fractional durations", () => {
  for (const durationMs of [Infinity, NaN, -1, 1.5])
    expect(SpanSchema.safeParse({ ...validSpan, durationMs }).success).toBe(false);
  expect(SpanSchema.safeParse({ ...validSpan, attributes: { httpStatus: Infinity } }).success).toBe(false);
});

test("enforces size limits", () => {
  const tooMany = Object.fromEntries(Array.from({ length: 21 }, (_, i) => [`k${i}`, 1]));
  expect(SpanSchema.safeParse({ ...validSpan, attributes: tooMany }).success).toBe(false);
  expect(SpanSchema.safeParse({ ...validSpan, attributes: { ["k".repeat(65)]: 1 } }).success).toBe(false);
  expect(SpanSchema.safeParse({ ...validSpan, attributes: { path: "x".repeat(2001) } }).success).toBe(false);
  expect(SpanSchema.safeParse({ ...validSpan, name: "x".repeat(201) }).success).toBe(false);
  expect(SpanSchema.safeParse({ ...validSpan, errorMessage: "x".repeat(8001) }).success).toBe(false);
  expect(SpanSchema.safeParse({ ...validSpan, source: { file: "x".repeat(501), line: 1 } }).success).toBe(false);
  expect(IngestBatchSchema.safeParse({ key: "pk_x", spans: [] }).success).toBe(false);
});

test("rejects a non-ISO start time", () => {
  expect(SpanSchema.safeParse({ ...validSpan, startTime: "yesterday" }).success).toBe(false);
});
