import { afterAll, beforeEach } from "vitest";
import { prisma } from "@/lib/db";

/** Empties every table in the test database, so each test starts from nothing. */
export async function resetDb(): Promise<void> {
  await prisma.$executeRaw`TRUNCATE TABLE "Span", "Project", "User" CASCADE`;
}

/** Builds the FormData a browser form would submit, for testing server actions. */
export function form(fields: Record<string, string>): FormData {
  const data = new FormData();
  for (const [key, value] of Object.entries(fields)) data.set(key, value);
  return data;
}

beforeEach(resetDb);
afterAll(() => prisma.$disconnect());
