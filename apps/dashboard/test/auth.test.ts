import bcrypt from "bcryptjs";
import { expect, test } from "vitest";
import { signUp } from "@/app/(auth)/actions";
import { prisma } from "@/lib/db";
import { form } from "./setup";

test("signUp stores a bcrypt hash, never the password", async () => {
  await signUp(form({ email: "a@b.co", password: "correct horse 1" }));
  const u = await prisma.user.findUniqueOrThrow({ where: { email: "a@b.co" } });
  expect(u.passwordHash).not.toContain("correct horse");
  expect(await bcrypt.compare("correct horse 1", u.passwordHash)).toBe(true);
});

test("signUp rejects duplicate email and passwords < 10 chars", async () => {
  await signUp(form({ email: "a@b.co", password: "correct horse 1" }));
  expect(await signUp(form({ email: "a@b.co", password: "correct horse 1" }))).toEqual({ error: "Email already registered" });
  expect(await signUp(form({ email: "c@d.co", password: "short" }))).toEqual({ error: "Password must be at least 10 characters" });
});

test("signUp treats emails case-insensitively", async () => {
  await signUp(form({ email: "A@B.co", password: "correct horse 1" }));
  expect(await signUp(form({ email: " a@b.CO ", password: "correct horse 1" }))).toEqual({ error: "Email already registered" });
});

test("signUp rejects invalid emails and passwords bcrypt would truncate", async () => {
  expect(await signUp(form({ email: "not-an-email", password: "correct horse 1" }))).toEqual({ error: "Enter a valid email address" });
  // bcrypt only uses the first 72 bytes, so longer passwords would be silently shortened.
  expect(await signUp(form({ email: "e@f.co", password: "x".repeat(73) }))).toEqual({ error: "Password must be at most 72 characters" });
  expect(await prisma.user.count()).toBe(0);
});
