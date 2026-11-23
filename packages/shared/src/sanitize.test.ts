import { expect, test } from "vitest";
import { sanitizeSpan } from "./sanitize";
import type { StoredSpan } from "./span";
import { validSpan } from "./test-fixtures";

test("drops sensitive attribute keys", () => {
  const s = sanitizeSpan({ ...validSpan, attributes: { authorization: "Bearer x", password: "p", cookie: "c", httpStatus: 409 } });
  expect(s.attributes).toEqual({ httpStatus: 409 });
});

test("redacts emails and bearer tokens in messages", () => {
  const s = sanitizeSpan({ ...validSpan, errorMessage: "dup a.b@x.com token Bearer abc.def" });
  expect(s.errorMessage).toBe("dup [email] token Bearer [redacted]");
});

test("redacts sensitive key=value pairs in free text", () => {
  const s = sanitizeSpan({ ...validSpan, errorMessage: "login failed password=hunter2 session: abc123" });
  expect(s.errorMessage).toBe("login failed password=[redacted] session: [redacted]");
});

test("unknown attributes and unsafe source are removed", () => {
  const clean = sanitizeSpan({ ...validSpan, source: { file: "../private.ts", line: 1 },
    attributes: { customPayload: "private data", httpStatus: 409 } });
  expect(clean.attributes).toEqual({ httpStatus: 409 });
  expect(clean.source).toBeUndefined();
});

test.each([
  "/home/app/src/x.ts",
  "C:/Users/me/x.ts",
  "C:\\Users\\me\\x.ts",
  "src/../../etc/passwd",
  "file:///src/x.ts",
  "src/x\u0000.ts",
])("rejects unsafe source path %s", (file) => {
  expect(sanitizeSpan({ ...validSpan, source: { file, line: 3 } }).source).toBeUndefined();
});

test("keeps safe repo-relative source with a positive line", () => {
  const source = { file: "apps/demo-app/services/registration.ts", line: 14 };
  expect(sanitizeSpan({ ...validSpan, source }).source).toEqual(source);
  expect(sanitizeSpan({ ...validSpan, source: { ...source, line: 0 } }).source).toBeUndefined();
});

test("strips query, fragment and origin from the path attribute", () => {
  expect(sanitizeSpan({ ...validSpan, attributes: { path: "/api/reset?token=abc#x" } }).attributes.path).toBe("/api/reset");
  expect(sanitizeSpan({ ...validSpan, attributes: { path: "https://user:pw@host/api/x?q=1" } }).attributes.path).toBe("/api/x");
});

test("truncates long strings to 500 chars", () => {
  expect(sanitizeSpan({ ...validSpan, errorMessage: "x".repeat(2000) }).errorMessage!.length).toBe(500);
});

test("preserves server-derived provenance and does not mutate input", () => {
  const stored: StoredSpan = { ...validSpan, errorMessage: "a@b.co", ingestSource: "server-secret" };
  const clean = sanitizeSpan(stored);
  expect(clean.ingestSource).toBe("server-secret");
  expect(stored.errorMessage).toBe("a@b.co");
});
