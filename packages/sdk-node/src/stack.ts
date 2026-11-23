import path from "node:path";
import { fileURLToPath } from "node:url";

let repoRoot = process.cwd();

/** Internal: set by `configure({ repoRoot })`. Source paths are made relative to this folder. */
export function setRepoRoot(root: string): void {
  repoRoot = pathLib(root).resolve(root);
}

/** Windows roots (`C:\…`) need win32 path rules even when tests run on macOS/Linux. */
const pathLib = (p: string) => (/^[A-Za-z]:[\\/]/.test(p) ? path.win32 : path.posix);

// "at fn (/abs/file.ts:12:5)" or "at /abs/file.ts:12:5" -> file, line.
const FRAME = /^at (?:.*? \()?(.+?):(\d+):\d+\)?$/;
const NODE_MODULES = /[\\/]node_modules[\\/]/;
// The SDK's own frames (span(), the wrapper, the Prisma hook) are never the app's code.
// Its *.test.ts files are, from the SDK's point of view, application code.
const SDK_SOURCE = /[\\/]sdk-node[\\/](?:src|dist)[\\/](?![^\\/]*\.test\.[cm]?[jt]sx?$)/;

/**
 * Finds the application source location in a V8 stack trace.
 *
 * Returns the first frame that is inside `repoRoot` and is not Node internals
 * (`node:`), a dependency (`node_modules`) or the SDK itself, as a path
 * relative to `repoRoot` with `/` separators (on Windows too). Returns
 * `undefined` when no such frame exists: DevLens never guesses a location,
 * and absolute paths would reveal the server's folder layout.
 *
 * With source maps enabled (`NODE_OPTIONS=--enable-source-maps`), frames
 * point at the original `.ts` files instead of compiled output.
 */
export function sourceFromStack(stack: string | undefined): { file: string; line: number } | undefined {
  if (!stack) return undefined;
  const lib = pathLib(repoRoot);
  for (const raw of stack.split("\n")) {
    const match = FRAME.exec(raw.trim());
    if (!match) continue;
    let file = match[1]!;
    const line = Number(match[2]);
    if (file.startsWith("node:") || NODE_MODULES.test(file) || SDK_SOURCE.test(file)) continue;
    if (file.startsWith("file://")) {
      try {
        file = fileURLToPath(file, { windows: lib === path.win32 });
      } catch {
        continue;
      }
    }
    if (!lib.isAbsolute(file) || !(line > 0)) continue;
    const relative = lib.relative(repoRoot, file);
    // Outside the repo: "../x" or, on Windows, another drive (still absolute).
    if (!relative || relative === ".." || relative.startsWith(`..${lib.sep}`) || lib.isAbsolute(relative)) continue;
    return { file: relative.split(lib.sep).join("/"), line };
  }
  return undefined;
}
