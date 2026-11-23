import path from "node:path";
import { config } from "dotenv";

/**
 * The test database URL: TEST_DATABASE_URL from the environment (CI) or from
 * apps/dashboard/.env (local). Throws unless the database name ends in `_test`,
 * because the tests wipe every table and must never touch real data.
 */
export function testDatabaseUrl(): string {
  const fromFile: Record<string, string> = {};
  config({ path: path.join(__dirname, "..", ".env"), processEnv: fromFile, quiet: true });
  const url = process.env.TEST_DATABASE_URL ?? fromFile.TEST_DATABASE_URL ?? "";
  const dbName = url ? new URL(url).pathname.slice(1) : "";
  if (!dbName.endsWith("_test")) {
    throw new Error(`TEST_DATABASE_URL must point at a database ending in "_test" (got "${dbName || "nothing"}").`);
  }
  return url;
}
