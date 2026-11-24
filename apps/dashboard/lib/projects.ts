import { createHash, randomBytes } from "node:crypto";
import type { Project } from "@/generated/prisma/client";
import { prisma } from "@/lib/db";

/**
 * A problem with what the user typed (bad origin, bad repo URL, empty name).
 * Server actions show its message in the form; any other error is a real bug
 * and is rethrown.
 */
export class ProjectInputError extends Error {}

const MAX_ORIGINS = 20;
// Exactly https://github.com/<owner>/<repo>. The URL is later rendered as a link
// in the explorer, so anything looser could let a `javascript:` URL through.
const GITHUB_REPO = /^https:\/\/github\.com\/[\w.-]+\/[\w.-]+$/;

/**
 * SHA-256 hex digest of an API key.
 *
 * Secret keys are stored only as this hash, so a database leak does not leak
 * usable keys. A fast hash is fine here (unlike passwords, which use bcrypt)
 * because the key is 128 random bits: there is nothing to guess.
 */
export function hashKey(key: string): string {
  return createHash("sha256").update(key).digest("hex");
}

/** Turns typed origins into a clean list: `new URL(o).origin` each, blanks skipped, duplicates removed. */
function normalizeOrigins(origins: string[]): string[] {
  const result = new Set<string>();
  for (const raw of origins) {
    const text = raw.trim();
    if (!text) continue;
    let url: URL;
    try {
      url = new URL(text);
    } catch {
      throw new ProjectInputError(`Invalid origin: ${text}`);
    }
    // Browsers only send Origin for http(s) pages; `javascript:` etc. have origin "null".
    if (url.protocol !== "http:" && url.protocol !== "https:") throw new ProjectInputError(`Invalid origin: ${text}`);
    result.add(url.origin); // drops path, query and trailing slash; lowercases the host
  }
  if (result.size > MAX_ORIGINS) throw new ProjectInputError(`At most ${MAX_ORIGINS} origins`);
  return [...result];
}

/**
 * Creates a project for `ownerId` with a fresh key pair.
 *
 * - `publicKey` (`pk_` + 24 hex) is stored as-is: it goes in browser code and
 *   only lets browsers on `allowedOrigins` send browser spans.
 * - `secretKey` (`sk_` + 32 hex) is returned to the caller exactly once and only
 *   its SHA-256 hash is stored, so the dashboard can never show it again.
 *
 * Throws {@link ProjectInputError} for an empty or overlong name, a malformed
 * origin, or a repo URL that isn't `https://github.com/owner/repo`.
 */
export async function createProject(
  ownerId: string,
  name: string,
  allowedOrigins: string[],
  repoUrl?: string,
): Promise<{ project: Project; secretKey: string }> {
  const cleanName = name.trim();
  if (!cleanName) throw new ProjectInputError("Project name is required");
  if (cleanName.length > 100) throw new ProjectInputError("Project name must be at most 100 characters");
  const repo = repoUrl?.trim() || undefined;
  if (repo && !GITHUB_REPO.test(repo)) throw new ProjectInputError("Invalid repository URL");

  const secretKey = `sk_${randomBytes(16).toString("hex")}`;
  // ponytail: a key collision (2^-96 or less) would fail the unique index and surface as an error; no retry loop.
  const project = await prisma.project.create({
    data: {
      ownerId,
      name: cleanName,
      allowedOrigins: normalizeOrigins(allowedOrigins),
      repoUrl: repo ?? null,
      publicKey: `pk_${randomBytes(12).toString("hex")}`,
      secretKeyHash: hashKey(secretKey),
    },
  });
  return { project, secretKey };
}

/**
 * The project with `projectId`, but only if `userId` owns it; otherwise null.
 *
 * This is the single ownership check: every dashboard page, action and route
 * that takes a project id must go through it, so one user can never read
 * another user's project or spans by changing the id in the URL.
 */
export function getOwnedProject(userId: string, projectId: string): Promise<Project | null> {
  return prisma.project.findFirst({ where: { id: projectId, ownerId: userId } });
}

/** The user's projects for the list page, newest first. Leaves out the secret key hash. */
export function listProjects(ownerId: string) {
  return prisma.project.findMany({
    where: { ownerId },
    orderBy: { createdAt: "desc" },
    select: { id: true, name: true, publicKey: true, allowedOrigins: true, repoUrl: true, createdAt: true },
  });
}
