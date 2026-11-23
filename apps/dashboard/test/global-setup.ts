import { execSync } from "node:child_process";
import path from "node:path";
import { testDatabaseUrl } from "./test-db-url";

/** Runs once before all tests: applies the Prisma migrations to the test database. */
export default function setup() {
  execSync("pnpm exec prisma migrate deploy", {
    cwd: path.join(__dirname, ".."),
    env: { ...process.env, DIRECT_URL: testDatabaseUrl() },
    stdio: "inherit",
  });
}
