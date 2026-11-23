import { afterEach, expect, test } from "vitest";
import { setRepoRoot, sourceFromStack } from "./stack";

afterEach(() => setRepoRoot(process.cwd()));

const stack = (...frames: string[]) => ["Error: boom", ...frames.map((f) => `    at ${f}`)].join("\n");

test("returns the first frame inside the repo, relative with / separators", () => {
  setRepoRoot("/srv/app");
  expect(sourceFromStack(stack("registerUser (/srv/app/apps/demo/services/registration.ts:14:11)"))).toEqual({
    file: "apps/demo/services/registration.ts",
    line: 14,
  });
});

test("accepts frames without a function name and file:// URLs (ESM)", () => {
  setRepoRoot("/srv/app");
  expect(sourceFromStack(stack("/srv/app/a.ts:3:1"))).toEqual({ file: "a.ts", line: 3 });
  expect(sourceFromStack(stack("async run (file:///srv/app/b.ts:7:2)"))).toEqual({ file: "b.ts", line: 7 });
});

test("skips node internals, node_modules and the SDK's own source", () => {
  setRepoRoot("/srv/app");
  const s = stack(
    "processTicksAndRejections (node:internal/process/task_queues:95:5)",
    "span (/srv/app/packages/sdk-node/src/context.ts:80:20)",
    "Object.create (/srv/app/node_modules/.pnpm/@prisma+client/runtime.js:1:1)",
    "handler (/srv/app/apps/demo/app/api/register/route.ts:9:3)",
  );
  expect(sourceFromStack(s)).toEqual({ file: "apps/demo/app/api/register/route.ts", line: 9 });
});

test("keeps the SDK's own test files (they are application code from the SDK's point of view)", () => {
  setRepoRoot("/srv/app");
  expect(sourceFromStack(stack("t (/srv/app/packages/sdk-node/src/handler.test.ts:5:1)"))?.file).toBe(
    "packages/sdk-node/src/handler.test.ts",
  );
});

test("omits the source when no frame is inside the repo", () => {
  setRepoRoot("/srv/app");
  expect(sourceFromStack(stack("x (/srv/other/x.ts:1:1)", "y (/srv/app-evil/y.ts:2:2)"))).toBeUndefined();
  expect(sourceFromStack(stack("<anonymous>", "eval (eval at f (/srv/app/a.ts:1:1), <anonymous>:1:1)"))).toBeUndefined();
  expect(sourceFromStack(undefined)).toBeUndefined();
  expect(sourceFromStack("")).toBeUndefined();
});

test("Windows paths become repo-relative with / separators", () => {
  setRepoRoot("C:\\work\\devlens");
  expect(sourceFromStack(stack("f (C:\\work\\devlens\\apps\\demo\\services\\report.ts:12:7)"))).toEqual({
    file: "apps/demo/services/report.ts",
    line: 12,
  });
  expect(sourceFromStack(stack("f (C:\\work\\devlens\\node_modules\\x\\index.js:1:1)"))).toBeUndefined();
});
