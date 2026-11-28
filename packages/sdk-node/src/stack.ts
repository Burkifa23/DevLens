import { findSourceMap, type SourceMap } from "node:module";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

let repoRoot = process.cwd();

/** Internal: set by `configure({ repoRoot })`. Source paths are made relative to this folder. */
export function setRepoRoot(root: string): void {
  repoRoot = pathLib(root).resolve(root);
}

/** Windows roots (`C:\…`) need win32 path rules even when tests run on macOS/Linux. */
const pathLib = (p: string) => (/^[A-Za-z]:[\\/]/.test(p) ? path.win32 : path.posix);

// "at fn (/abs/file.ts:12:5)" or "at /abs/file.ts:12:5" -> file, line, column.
const FRAME = /^at (?:.*? \()?(.+?):(\d+):(\d+)\)?$/;
const NODE_MODULES = /[\\/]node_modules[\\/]/;
// The SDK's own frames (span(), the wrapper, the Prisma hook) are never the app's code.
// Its *.test.ts files are, from the SDK's point of view, application code.
const SDK_SOURCE = /[\\/]sdk-node[\\/](?:src|dist)[\\/](?![^\\/]*\.test\.[cm]?[jt]sx?$)/;

/**
 * Finds the source map Node registered for a stack frame's file, trying each
 * spelling Node may have used as the cache key (the path or its `file://` URL,
 * with brackets percent-encoded). This is the same lookup Next.js does in
 * `patch-error-inspect.js`.
 *
 * A `?query` (Turbopack's hot-reloaded modules use `<chunk URL>?<module id>`)
 * is kept: such a module was eval'd with its *own* inline map, and the chunk
 * file's map would give the wrong line.
 */
function sourceMapOf(file: string): SourceMap | undefined {
  const query = file.indexOf("?");
  const candidates = file.startsWith("file://")
    ? query < 0 ? [file, fileURLToPath(file)] : [file]
    : query < 0 ? [file, pathToFileURL(file).href] : [pathToFileURL(file.slice(0, query)).href + file.slice(query)];
  for (const candidate of candidates) {
    const map = findSourceMap(candidate);
    if (map) return map;
  }
  return undefined;
}

/**
 * Translates a compiled position to its original file and line through the
 * source map Node holds for that file. Node only keeps maps when source maps
 * are enabled (`NODE_OPTIONS=--enable-source-maps`).
 *
 * Returns `undefined` when there is no map (plain Node already printed the
 * original `.ts` frame, or maps are off) and `null` when the file has a map
 * but this position has no original source (bundler glue): such a frame is
 * skipped rather than reported as compiled output.
 */
function originalPosition(file: string, line: number, column: number): { file: string; line: number } | null | undefined {
  let map: SourceMap | undefined;
  try {
    map = sourceMapOf(file);
  } catch {
    return undefined; // an unreadable map is the same as no map
  }
  if (!map) return undefined;
  const origin = map.findOrigin(line, column); // 1-based in, 1-based out; {} when unmapped
  return "fileName" in origin ? { file: origin.fileName, line: origin.lineNumber } : null;
}

/**
 * Finds the application source location in a V8 stack trace.
 *
 * Each frame is first translated through its source map, if Node has one for
 * that file. Inside Next.js this is required: Next 16 replaces
 * `Error.prepareStackTrace`, so `err.stack` names compiled `.next/` chunks even
 * with `--enable-source-maps`. In plain Node the frames are already original
 * `.ts` paths and have no map of their own, so they are used as they are.
 *
 * Returns the first frame that is inside `repoRoot` and is not Node internals
 * (`node:`), a dependency (`node_modules`) or the SDK itself, as a path
 * relative to `repoRoot` with `/` separators (on Windows too). Returns
 * `undefined` when no such frame exists: DevLens never guesses a location,
 * and absolute paths would reveal the server's folder layout.
 */
export function sourceFromStack(stack: string | undefined): { file: string; line: number } | undefined {
  if (!stack) return undefined;
  const lib = pathLib(repoRoot);
  for (const raw of stack.split("\n")) {
    const match = FRAME.exec(raw.trim());
    if (!match) continue;
    let file = match[1]!;
    let line = Number(match[2]);
    if (file.startsWith("node:")) continue;
    const original = originalPosition(file, line, Number(match[3]));
    if (original === null) continue;
    if (original) ({ file, line } = original);
    if (NODE_MODULES.test(file) || SDK_SOURCE.test(file)) continue;
    if (file.startsWith("file://")) {
      try {
        file = fileURLToPath(file, { windows: lib === path.win32 }); // also drops any ?query
      } catch {
        continue;
      }
    } else if (file.includes("?")) {
      file = file.slice(0, file.indexOf("?"));
    }
    if (!lib.isAbsolute(file) || !(line > 0)) continue;
    const relative = lib.relative(repoRoot, file);
    // Outside the repo: "../x" or, on Windows, another drive (still absolute).
    if (!relative || relative === ".." || relative.startsWith(`..${lib.sep}`) || lib.isAbsolute(relative)) continue;
    return { file: relative.split(lib.sep).join("/"), line };
  }
  return undefined;
}
