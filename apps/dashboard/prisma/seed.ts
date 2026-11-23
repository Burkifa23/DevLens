// Creates the demo dashboard user for local development and the deployed demo.
// Run with `pnpm --filter dashboard db:seed`. Task 7 adds the demo project here.
import bcrypt from "bcryptjs";
import { prisma } from "../lib/db";

async function main() {
  const email = "demo@devlens.test";
  const password = process.env.SEED_PASSWORD;
  if (!password || password.length < 10) {
    throw new Error("Set SEED_PASSWORD (at least 10 characters) before seeding.");
  }

  const passwordHash = await bcrypt.hash(password, 12);
  await prisma.user.upsert({ where: { email }, update: { passwordHash }, create: { email, passwordHash } });
  console.log(`Seeded ${email}`);
}

main().finally(() => prisma.$disconnect());
