import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { afterAll, afterEach, beforeAll, describe, expect, test } from "vitest";
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

// --- Bundled code (Next.js / Turbopack) --------------------------------------
// Next 16 replaces Error.prepareStackTrace, so inside Next err.stack names the
// compiled chunk even with --enable-source-maps. These fixtures are real files
// with inline source maps, laid out like Turbopack's output.
describe("frames in bundled code are mapped back through their source maps", () => {
  const inlineMap = (map: object) =>
    `//# sourceMappingURL=data:application/json;base64,${Buffer.from(JSON.stringify(map)).toString("base64")}`;
  let root: string;
  let chunk: string;
  let vendor: string;

  beforeAll(() => {
    process.setSourceMapsEnabled(true); // what NODE_OPTIONS=--enable-source-maps does
    root = realpathSync(mkdtempSync(path.join(tmpdir(), "devlens-stack-")));
    const chunks = path.join(root, "apps/demo/.next/server/chunks");
    mkdirSync(chunks, { recursive: true });
    const load = createRequire(import.meta.url);

    // Generated line 3 -> services/registration.ts line 14 (VLQ "AAaA": line +13). Lines 1-2 are unmapped glue.
    chunk = path.join(chunks, "[root-of-the-server]__abc._.js");
    writeFileSync(
      chunk,
      `"use strict";\nexports.a = 1;\nexports.b = 2;\n` +
        inlineMap({ version: 3, sources: ["../../../services/registration.ts"], names: [], mappings: ";;AAaA" }),
    );
    load(chunk);

    // A dependency bundled into the app's chunks: line 1 -> node_modules/pkg/index.js line 1.
    vendor = path.join(chunks, "vendor._.js");
    writeFileSync(
      vendor,
      `module.exports = 1;\n` +
        inlineMap({ version: 3, sources: ["../../../../../node_modules/pkg/index.js"], names: [], mappings: "AAAA" }),
    );
    load(vendor);
  });

  afterAll(() => rmSync(root, { recursive: true, force: true }));

  test("a frame in a compiled chunk maps to the original .ts file and line", () => {
    setRepoRoot(root);
    expect(sourceFromStack(stack(`registerUser (${chunk}:3:5)`))).toEqual({
      file: "apps/demo/services/registration.ts",
      line: 14,
    });
  });

  test("file:// frames map too (Node keys its map cache by percent-encoded URL)", () => {
    setRepoRoot(root);
    expect(sourceFromStack(stack(`registerUser (${pathToFileURL(chunk).href}:3:5)`))).toEqual({
      file: "apps/demo/services/registration.ts",
      line: 14,
    });
  });

  test("hot-reloaded modules (sourceURL ending in ?id=) use their own map, not the chunk file's", () => {
    setRepoRoot(root);
    // Turbopack's dev runtime evals each updated module with `//# sourceURL=<chunk URL>?<module id>`
    // and that module's own inline map. Generated line 1 -> line 20 (VLQ "AAmBA": line +19).
    const sourceURL = `${pathToFileURL(chunk).href}?id=7`;
    const original = pathToFileURL(path.join(root, "apps/demo/services/registration.ts")).href;
    (0, eval)(
      `(() => 1)\n//# sourceURL=${sourceURL}\n` +
        inlineMap({ version: 3, sources: [original], names: [], mappings: "AAmBA" }),
    );
    expect(sourceFromStack(stack(`registerUser (${sourceURL}:1:1)`))).toEqual({
      file: "apps/demo/services/registration.ts",
      line: 20,
    });
  });

  test("never falls back to the compiled path: a mapped file with no entry at that position is skipped", () => {
    setRepoRoot(root);
    expect(sourceFromStack(stack(`glue (${chunk}:1:1)`))).toBeUndefined();
  });

  test("mapped frames inside node_modules are skipped like unmapped ones", () => {
    setRepoRoot(root);
    expect(sourceFromStack(stack(`dep (${vendor}:1:1)`, `registerUser (${chunk}:3:5)`))).toEqual({
      file: "apps/demo/services/registration.ts",
      line: 14,
    });
  });
});
