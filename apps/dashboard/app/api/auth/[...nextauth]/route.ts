// Auth.js endpoints (/api/auth/session, /api/auth/callback/credentials, ...).
import { handlers } from "@/auth";

export const runtime = "nodejs";
export const { GET, POST } = handlers;
