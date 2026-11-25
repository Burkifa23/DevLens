/**
 * Trace graph transforms (plan Task 9): turn a flat list of stored spans into the shapes the
 * explorer draws, namely the failing path, a React Flow graph and a waterfall timeline.
 *
 * Everything here is a pure function of `StoredSpan[]`: no database, no React, no fetch. That
 * keeps it easy to unit-test, and lets the client explorer (Task 10) import it safely.
 *
 * Parent links (`parentSpanId`) are claims sent by SDKs, and a browser key can send anything.
 * So every traversal here guards against a missing parent (the span becomes a root, flagged
 * as an orphan) and against cycles (the loop is cut, so nothing can hang the page).
 */
import dagre from "@dagrejs/dagre";
import type { Edge, Node } from "@xyflow/react";
import type { StoredSpan } from "@devlens/shared";

/** Width and height of one span node in the graph, in pixels; dagre lays nodes out at this size. */
export const NODE_WIDTH = 240;
export const NODE_HEIGHT = 64;

/** Traces with more spans than this start with their successful subtrees collapsed. */
const COLLAPSE_THRESHOLD = 50;
/** The narrowest waterfall bar, as a percentage, so 0 ms spans stay visible and clickable. */
const MIN_BAR_PCT = 0.5;

/**
 * Data carried by each React Flow node; `span-node.tsx` (Task 10) renders it.
 * - `orphan`: the span names a parent that can't be used (missing from this trace, for example
 *   because the browser batch was lost, or part of a parent cycle), so it is drawn as a root
 *   with a dashed border instead of being dropped.
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

/** Start time in epoch milliseconds. */
const startOf = (span: StoredSpan) => Date.parse(span.startTime);
const byStart = (a: StoredSpan, b: StoredSpan) => startOf(a) - startOf(b);

/**
 * How deep each span sits in the trace tree: 0 for a root, 1 for its children, and so on.
 *
 * A span is a root when it has no parent, when its parent is missing from `spans`, or when
 * following its parents runs into a loop (the loop is cut at the last span reached).
 * Every other span is exactly one deeper than its parent, so the depths always describe a
 * proper tree. Iterative with memoization: each span is walked once, so even long or
 * malformed chains cost O(n) and can't overflow the stack.
 *
 * Exported because `buildContext` (lib/context.ts) ranks errors and orders export paths by it.
 */
export function spanDepths(spans: StoredSpan[]): Map<string, number> {
  const byId = new Map(spans.map((s) => [s.id, s]));
  const depths = new Map<string, number>();

  for (const start of spans) {
    if (depths.has(start.id)) continue;
    // Walk up until we reach a span whose depth is known, a missing parent, or a loop.
    const chain: StoredSpan[] = [];
    const onChain = new Set<string>();
    let current: StoredSpan | undefined = start;
    let base = -1; // depth of the span above the top of the chain (-1: the top is a root)
    while (current && !depths.has(current.id) && !onChain.has(current.id)) {
      chain.push(current);
      onChain.add(current.id);
      current = current.parentSpanId === undefined ? undefined : byId.get(current.parentSpanId);
    }
    if (current && depths.has(current.id)) base = depths.get(current.id)!;
    // Otherwise the walk hit a root or a loop: the last span on the chain becomes the root.
    for (let i = chain.length - 1; i >= 0; i--) depths.set(chain[i].id, base + (chain.length - i));
  }
  return depths;
}

/** The tree that the graph and the waterfall both walk, derived once from `spanDepths`. */
type TraceTree = {
  depths: Map<string, number>;
  roots: StoredSpan[];
  children: Map<string, StoredSpan[]>;
};

function buildTree(spans: StoredSpan[]): TraceTree {
  const depths = spanDepths(spans);
  const roots: StoredSpan[] = [];
  const children = new Map<string, StoredSpan[]>();
  for (const span of spans) {
    // Depth 0 means "draw as a root", even if parentSpanId points somewhere unusable.
    if (depths.get(span.id) === 0 || span.parentSpanId === undefined) roots.push(span);
    else children.set(span.parentSpanId, [...(children.get(span.parentSpanId) ?? []), span]);
  }
  roots.sort(byStart);
  for (const list of children.values()) list.sort(byStart);
  return { depths, roots, children };
}

/** Pre-order (parent before children, children by start time) walk; stops descending at `stopAt`. */
function walk(tree: TraceTree, visit: (span: StoredSpan) => void, stopAt?: Set<string>): void {
  const stack = [...tree.roots].reverse();
  const seen = new Set<string>(); // defensive: duplicate ids must not be visited twice
  while (stack.length > 0) {
    const span = stack.pop()!;
    if (seen.has(span.id)) continue;
    seen.add(span.id);
    visit(span);
    if (stopAt?.has(span.id)) continue;
    const kids = tree.children.get(span.id) ?? [];
    for (let i = kids.length - 1; i >= 0; i--) stack.push(kids[i]);
  }
}

/** Spans sorted deepest first, so a single pass can fold child results into parents. */
function deepestFirst(spans: StoredSpan[], depths: Map<string, number>): StoredSpan[] {
  return [...spans].sort((a, b) => depths.get(b.id)! - depths.get(a.id)!);
}

/**
 * Returns the chain from the root down to the failure: root first, ending at the deepest span
 * with `status: "error"` (ties go to the earliest `startTime`). Returns `[]` when nothing failed.
 *
 * Why the deepest error: an error usually bubbles up (database → function → fetch → click),
 * and the deepest one is closest to where it started. It is a place to start looking, not
 * proof of the root cause.
 *
 * Parent links come from untrusted clients and could form a cycle, so the walk up the tree
 * tracks visited ids and stops on a repeat.
 */
export function failurePath(spans: StoredSpan[]): StoredSpan[] {
  const depths = spanDepths(spans);
  let target: StoredSpan | undefined;
  for (const span of spans) {
    if (span.status !== "error") continue;
    const deeper = target === undefined || depths.get(span.id)! > depths.get(target.id)!;
    const tieButEarlier = target !== undefined && depths.get(span.id) === depths.get(target.id) && startOf(span) < startOf(target);
    if (deeper || tieButEarlier) target = span;
  }
  if (!target) return [];

  const byId = new Map(spans.map((s) => [s.id, s]));
  const path: StoredSpan[] = [];
  const visited = new Set<string>();
  let current: StoredSpan | undefined = target;
  while (current && !visited.has(current.id)) {
    path.push(current);
    visited.add(current.id);
    // Stop at a root (depth 0): its parentSpanId, if any, is missing or part of a cut loop.
    if (depths.get(current.id) === 0 || current.parentSpanId === undefined) break;
    current = byId.get(current.parentSpanId);
  }
  return path.reverse();
}

/**
 * Which spans start collapsed, so big traces stay readable and fast to render.
 * Empty when `spans.length <= 50`. Otherwise it holds the id of every span that has children
 * and has no error anywhere in its subtree, so the failing branch always stays visible.
 */
export function defaultCollapsed(spans: StoredSpan[]): Set<string> {
  const collapsed = new Set<string>();
  if (spans.length <= COLLAPSE_THRESHOLD) return collapsed;

  const tree = buildTree(spans);
  const errorInSubtree = new Set<string>();
  // Deepest first: by the time we reach a span, all of its children have reported in.
  for (const span of deepestFirst(spans, tree.depths)) {
    if (span.status === "error") errorInSubtree.add(span.id);
    if (errorInSubtree.has(span.id) && tree.depths.get(span.id)! > 0) errorInSubtree.add(span.parentSpanId!);
  }
  for (const span of spans) {
    if (tree.children.has(span.id) && !errorInSubtree.has(span.id)) collapsed.add(span.id);
  }
  return collapsed;
}

/**
 * Converts spans into React Flow nodes and edges, laid out top to bottom with dagre
 * (each node is 240×64).
 *
 * - A span whose parent can't be used (missing from the set, or part of a parent loop)
 *   becomes a root with `orphan: true`.
 * - Descendants of a collapsed span are hidden; the collapsed node reports how many in
 *   `hiddenChildren`.
 * - `focusFailure` keeps only the spans on `failurePath(spans)`. A trace with no error has
 *   nothing to focus on, so it is shown in full instead of as an empty canvas.
 */
export function toFlow(
  spans: StoredSpan[],
  opts: { collapsed: Set<string>; focusFailure: boolean },
): { nodes: Node<SpanNodeData>[]; edges: Edge[] } {
  const tree = buildTree(spans);
  const onPath = new Set(failurePath(spans).map((s) => s.id));

  // Count every span's descendants (deepest first, folding each subtree size into its parent).
  const subtreeSize = new Map<string, number>();
  for (const span of deepestFirst(spans, tree.depths)) {
    const size = (subtreeSize.get(span.id) ?? 0) + 1;
    subtreeSize.set(span.id, size);
    if (tree.depths.get(span.id)! > 0) subtreeSize.set(span.parentSpanId!, (subtreeSize.get(span.parentSpanId!) ?? 0) + size);
  }

  let visible: StoredSpan[] = [];
  walk(tree, (span) => visible.push(span), opts.collapsed);
  if (opts.focusFailure && onPath.size > 0) visible = visible.filter((s) => onPath.has(s.id));
  const visibleIds = new Set(visible.map((s) => s.id));

  const edges: Edge[] = [];
  for (const span of visible) {
    if (tree.depths.get(span.id)! > 0 && visibleIds.has(span.parentSpanId!)) {
      edges.push({ id: `${span.parentSpanId}-${span.id}`, source: span.parentSpanId!, target: span.id });
    }
  }

  const graph = new dagre.graphlib.Graph();
  graph.setGraph({ rankdir: "TB", nodesep: 24, ranksep: 48 });
  graph.setDefaultEdgeLabel(() => ({}));
  for (const span of visible) graph.setNode(span.id, { width: NODE_WIDTH, height: NODE_HEIGHT });
  for (const edge of edges) graph.setEdge(edge.source, edge.target);
  dagre.layout(graph);

  const nodes = visible.map((span): Node<SpanNodeData> => {
    const { x, y } = graph.node(span.id); // dagre gives the centre; React Flow wants the top-left
    const collapsed = opts.collapsed.has(span.id);
    return {
      id: span.id,
      type: "span",
      position: { x: x - NODE_WIDTH / 2, y: y - NODE_HEIGHT / 2 },
      width: NODE_WIDTH,
      height: NODE_HEIGHT,
      data: {
        span,
        orphan: span.parentSpanId !== undefined && tree.depths.get(span.id) === 0,
        onFailurePath: onPath.has(span.id),
        hiddenChildren: collapsed ? subtreeSize.get(span.id)! - 1 : 0,
      },
    };
  });
  return { nodes, edges };
}

/**
 * Builds the waterfall rows for the Timeline tab: depth-first order (children sorted by
 * `startTime`), with each bar's offset measured from the earliest span across the whole trace
 * duration.
 *
 * - `widthPct` is at least 0.5, so 0 ms spans stay visible.
 * - Orphans have depth 0, like roots.
 * - Browser and server clocks can disagree, so bars show recorded times, not a guaranteed order.
 */
export function toWaterfall(spans: StoredSpan[]): WaterfallRow[] {
  if (spans.length === 0) return [];
  const tree = buildTree(spans);
  const traceStart = Math.min(...spans.map(startOf));
  const traceEnd = Math.max(...spans.map((s) => startOf(s) + s.durationMs));
  const total = traceEnd - traceStart || 1; // a 0 ms trace would otherwise divide by zero

  const rows: WaterfallRow[] = [];
  walk(tree, (span) =>
    rows.push({
      span,
      depth: tree.depths.get(span.id)!,
      offsetPct: ((startOf(span) - traceStart) / total) * 100,
      widthPct: Math.max(MIN_BAR_PCT, (span.durationMs / total) * 100),
    }),
  );
  return rows;
}
