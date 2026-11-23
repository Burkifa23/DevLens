// Prisma CLI configuration (migrate, seed, generate).
// Migrations use DIRECT_URL because Neon's pooled connection (DATABASE_URL)
// does not support the session features `prisma migrate` needs.
import "dotenv/config";
import { defineConfig, env } from "prisma/config";

export default defineConfig({
  schema: "prisma/schema.prisma",
  migrations: {
    path: "prisma/migrations",
    seed: "tsx prisma/seed.ts",
  },
  datasource: {
    url: env("DIRECT_URL"),
  },
});
