/**
 * Trace graph transforms (plan Task 9): turn a flat list of stored spans into the shapes the
 * explorer draws, namely the failing path, a React Flow graph and a waterfall timeline.
 *
 * Everything here is a pure function of `StoredSpan[]`: no database, no React, no fetch. That
 * keeps it easy to unit-test, and lets the client explorer (Task 10) import it safely.
 *
 * STATUS: signatures and types are final (they copy the plan). The bodies are WAITING ON
 * TASK 1, because they depend on the `StoredSpan` contract from @devlens/shared. Each stub
 * lists the algorithm to implement once that contract lands.
 */
import type { Edge, Node } from "@xyflow/react";
import type { StoredSpan } from "@devlens/shared";
// TODO(Task 1): enable once dependencies exist. Used by toFlow for the top→bottom layout.
// import dagre from "@dagrejs/dagre";

/** Width and height of one span node in the graph, in pixels; dagre lays nodes out at this size. */
export const NODE_WIDTH = 240;
export const NODE_HEIGHT = 64;

/**
 * Data carried by each React Flow node; `span-node.tsx` (Task 10) renders it.
 * - `orphan`: the span's parent is not in this trace (for example, the browser batch was
 *   lost), so it is drawn as a root with a dashed border instead of being dropped.
 * - `onFailurePath`: the span is on the root→error chain, so it is highlighted red.
 * - `hiddenChildren`: number of descendants hidden by collapsing, shown as a "+N" badge.
 */
export type SpanNodeData = {
  span: StoredSpan;
  orphan: boolean;
  onFailurePath: boolean;
  hiddenChildren: number;
};

/**
 * One row of the Timeline (waterfall) tab. `offsetPct` and `widthPct` position the bar as a
 * percentage of the whole trace duration, so the view needs no pixel maths.
 */
export type WaterfallRow = {
  span: StoredSpan;
  depth: number;
  offsetPct: number;
  widthPct: number;
};

const WAITING = "waiting on the Task 1 StoredSpan contract";

/**
 * Returns the chain from the root down to the failure: root first, ending at the deepest span
 * with `status: "error"` (ties go to the earliest `startTime`). Returns `[]` when nothing failed.
 *
 * Why the deepest error: an error usually bubbles up (database → function → fetch → click),
 * and the deepest one is closest to where it started.
 *
 * Guards against malformed data: parent links come from untrusted clients and could form a
 * cycle, so the walk up the tree tracks visited ids and stops on a repeat.
 *
 * TODO(Task 1) algorithm:
 *  1. Index spans by id.
 *  2. For each error span, compute its depth by walking parentSpanId links, keeping a visited
 *     set and stopping at a missing parent or a repeated id.
 *  3. Pick the error span with the greatest depth; on a tie, pick the earliest startTime.
 *  4. Walk from that span up to its root (same visited guard), then reverse the list.
 */
export function failurePath(spans: StoredSpan[]): StoredSpan[] {
  void spans;
  throw new Error(`failurePath: ${WAITING}`);
}

/**
 * Which spans start collapsed, so big traces stay readable and fast to render.
 * Empty when `spans.length <= 50`. Otherwise it holds the id of every span that has children
 * and has no error anywhere in its subtree, so the failing branch always stays visible.
 *
 * TODO(Task 1) algorithm:
 *  1. If spans.length <= 50, return an empty Set.
 *  2. Build a children map (parentSpanId → child ids) using only parents present in the set.
 *  3. Do one post-order pass per root, with a visited guard, recording whether each
 *     subtree contains an error.
 *  4. Return the ids of every span that has at least one child and no error in its subtree.
 */
export function defaultCollapsed(spans: StoredSpan[]): Set<string> {
  void spans;
  throw new Error(`defaultCollapsed: ${WAITING}`);
}

/**
 * Converts spans into React Flow nodes and edges, laid out top to bottom with dagre
 * (each node is 240×64).
 *
 * - A span whose `parentSpanId` is missing from the set becomes a root with `orphan: true`.
 * - Descendants of a collapsed span are hidden; the collapsed node gets `hiddenChildren`.
 * - `focusFailure` keeps only the spans on `failurePath(spans)`.
 *
 * TODO(Task 1) algorithm:
 *  1. Index spans; mark orphans (a parentSpanId that is set but not in the index).
 *  2. Compute the failure path ids, so nodes can be marked with onFailurePath.
 *  3. Choose the visible spans: walk from the roots, skipping descendants of `collapsed` ids
 *     (count them into hiddenChildren). If focusFailure is set, intersect with the failure path.
 *  4. Add the visible nodes and their parent→child edges to a dagre graph
 *     (rankdir "TB", NODE_WIDTH × NODE_HEIGHT), then run the layout.
 *  5. Map the results to Node<SpanNodeData> (type "span"; dagre gives centre points, so
 *     subtract half the width and height) and to Edge (id `${parent}-${child}`).
 */
export function toFlow(
  spans: StoredSpan[],
  opts: { collapsed: Set<string>; focusFailure: boolean },
): { nodes: Node<SpanNodeData>[]; edges: Edge[] } {
  void spans;
  void opts;
  throw new Error(`toFlow: ${WAITING}`);
}

/**
 * Builds the waterfall rows for the Timeline tab: depth-first order (children sorted by
 * `startTime`), with each bar's offset measured from the earliest span across the whole trace
 * duration.
 *
 * - `widthPct` is at least 0.5, so 0 ms spans stay visible.
 * - Orphans have depth 0, like roots.
 *
 * TODO(Task 1) algorithm:
 *  1. Find traceStart = min(startTime) and traceEnd = max(startTime + durationMs), and
 *     total = traceEnd - traceStart (use 1 if total is 0, to avoid dividing by zero).
 *  2. Treat spans whose parent is missing as roots. Sort roots and children by startTime.
 *  3. Walk depth-first with a visited guard, emitting rows with
 *     offsetPct = (start - traceStart) / total * 100 and
 *     widthPct = max(0.5, durationMs / total * 100).
 */
export function toWaterfall(spans: StoredSpan[]): WaterfallRow[] {
  void spans;
  throw new Error(`toWaterfall: ${WAITING}`);
}
