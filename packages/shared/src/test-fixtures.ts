import type { Span } from "./span";

/** A minimal valid span for tests. Not exported from the package. */
export const validSpan: Span = {
  id: "a1b2c3d4e5f60718",
  traceId: "0af7651916cd43dd8448eb211c80319c",
  name: "POST /api/register",
  kind: "http",
  startTime: "2026-11-23T10:00:00.000Z",
  durationMs: 142,
  status: "ok",
  attributes: {},
};
