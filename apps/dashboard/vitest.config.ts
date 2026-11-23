import path from "node:path";
import { defineConfig } from "vitest/config";
import { testDatabaseUrl } from "./test/test-db-url";

// Tests always run against the *_test database, never the development one:
// test/setup.ts wipes every table before each test.
const url = testDatabaseUrl();

export default defineConfig({
  resolve: { alias: { "@": __dirname } },
  test: {
    environment: "node",
    globalSetup: [path.join(__dirname, "test/global-setup.ts")],
    setupFiles: [path.join(__dirname, "test/setup.ts")],
    fileParallelism: false, // all test files share one database
    // next-auth imports "next/server" without a file extension, which Node's
    // ESM loader rejects; letting Vitest bundle it resolves the import.
    server: { deps: { inline: ["next-auth"] } },
    env: {
      // The Prisma CLI only accepts sslmode=require; the pg driver used at
      // runtime warns about it, so give the runtime the explicit equivalent.
      DATABASE_URL: url.replace("sslmode=require", "sslmode=verify-full"),
      DIRECT_URL: url,
      AUTH_SECRET: "test-only-secret-not-used-anywhere-else",
    },
  },
});
