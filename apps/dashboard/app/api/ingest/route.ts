// POST /api/ingest — span ingestion for both SDKs. All logic (and its tests) live in lib/ingest.ts.
// Not covered by proxy.ts: SDKs authenticate with project keys, not a login session.
import { handleIngest } from "@/lib/ingest";

export const runtime = "nodejs";

export function POST(req: Request): Promise<Response> {
  return handleIngest(req);
}
