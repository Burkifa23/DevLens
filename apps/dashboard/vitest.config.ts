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
    env: {
      DATABASE_URL: url,
      DIRECT_URL: url,
      AUTH_SECRET: "test-only-secret-not-used-anywhere-else",
    },
  },
});
