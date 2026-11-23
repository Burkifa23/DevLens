"use server";

import bcrypt from "bcryptjs";
import { AuthError } from "next-auth";
import { z } from "zod";
import { signIn } from "@/auth";
import { Prisma } from "@/generated/prisma/client";
import { prisma } from "@/lib/db";

/** What the login/signup forms show after a submit: nothing, or one error message. */
export type FormState = { error?: string };

const SignUpSchema = z.object({
  email: z.email("Enter a valid email address").transform((e) => e.trim().toLowerCase()),
  password: z
    .string()
    .min(10, "Password must be at least 10 characters")
    // bcrypt only uses the first 72 bytes; longer passwords would be silently cut.
    .refine((p) => new TextEncoder().encode(p).length <= 72, "Password must be at most 72 characters"),
});

/**
 * Creates a dashboard account. Stores only a bcrypt hash (cost 12) of the
 * password; emails are trimmed and lowercased so `A@B.co` and `a@b.co` are the
 * same account.
 *
 * Duplicate emails are detected from the database's unique constraint
 * (Prisma error P2002) rather than by checking first, so two simultaneous
 * sign-ups with one email cannot both succeed.
 */
export async function signUp(formData: FormData): Promise<FormState> {
  const parsed = SignUpSchema.safeParse({
    email: String(formData.get("email") ?? "").trim(),
    password: String(formData.get("password") ?? ""),
  });
  if (!parsed.success) return { error: parsed.error.issues[0]?.message ?? "Invalid input" };

  const { email, password } = parsed.data;
  try {
    await prisma.user.create({ data: { email, passwordHash: await bcrypt.hash(password, 12) } });
    return {};
  } catch (e) {
    if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === "P2002") {
      return { error: "Email already registered" };
    }
    throw e;
  }
}

/**
 * Login form action. On success Auth.js sets the session cookie and redirects
 * to /projects (the redirect is thrown, so it must not be caught here). Any
 * credential failure gets the same message, so the form never reveals whether
 * an email is registered.
 */
export async function logIn(_prev: FormState, formData: FormData): Promise<FormState> {
  try {
    await signIn("credentials", {
      email: formData.get("email"),
      password: formData.get("password"),
      redirectTo: "/projects",
    });
    return {};
  } catch (e) {
    if (e instanceof AuthError) return { error: "Invalid email or password" };
    throw e;
  }
}

/** Signup form action: creates the account, then logs straight in. */
export async function signUpAndLogIn(prev: FormState, formData: FormData): Promise<FormState> {
  const result = await signUp(formData);
  return result.error ? result : logIn(prev, formData);
}
