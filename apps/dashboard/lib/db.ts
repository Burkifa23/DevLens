import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "@/generated/prisma/client";

const globalForPrisma = globalThis as unknown as { prisma?: PrismaClient };

/**
 * The one Prisma client for the dashboard. It connects with DATABASE_URL
 * (Neon's pooled URL in production) through the `pg` driver adapter that
 * Prisma 7 requires.
 *
 * In development, Next.js reloads modules on every edit; caching the client on
 * `globalThis` stops each reload from opening a new connection pool.
 */
export const prisma =
  globalForPrisma.prisma ??
  new PrismaClient({ adapter: new PrismaPg({ connectionString: process.env.DATABASE_URL }) });

if (process.env.NODE_ENV !== "production") globalForPrisma.prisma = prisma;
