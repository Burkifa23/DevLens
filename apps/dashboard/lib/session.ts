import { redirect } from "next/navigation";
import { auth } from "@/auth";

/**
 * Returns the signed-in user's id, or redirects to /login.
 *
 * This is the real authentication check: call it at the top of every
 * protected page, server action and route handler. `proxy.ts` only gives an
 * early redirect and must not be relied on alone.
 */
export async function requireUserId(): Promise<string> {
  const session = await auth();
  const id = session?.user?.id;
  if (!id) redirect("/login");
  return id;
}
