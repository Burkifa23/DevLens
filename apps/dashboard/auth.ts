import bcrypt from "bcryptjs";
import NextAuth from "next-auth";
import Credentials from "next-auth/providers/credentials";
import { z } from "zod";
import { prisma } from "@/lib/db";

const CredentialsSchema = z.object({
  email: z.email().transform((e) => e.trim().toLowerCase()),
  password: z.string().min(1).max(72),
});

// A real bcrypt hash of a random string. Comparing against it when the email
// is unknown makes "no such user" take as long as "wrong password", so login
// timing does not reveal which emails are registered.
const DUMMY_HASH = "$2b$12$1PLfzKOIz8Sk6mgfM.BlOuxIj0/zg2iG.7boq.pdrLmZKCYti39Ii";

/**
 * Auth.js setup for the dashboard: email + password login, sessions stored in
 * a signed JWT cookie (no session table needed).
 *
 * - `auth()` reads the session (server components, actions, `proxy.ts`)
 * - `signIn` / `signOut` are called from server actions
 * - `handlers` serve `/api/auth/*`
 */
export const { handlers, auth, signIn, signOut } = NextAuth({
  session: { strategy: "jwt" },
  pages: { signIn: "/login" },
  // Render runs the app behind its own proxy, so trust its Host header.
  trustHost: true,
  providers: [
    Credentials({
      credentials: { email: {}, password: {} },
      /** Returns the user when email + password match, otherwise null (Auth.js then reports a login error). */
      async authorize(raw) {
        const parsed = CredentialsSchema.safeParse(raw);
        if (!parsed.success) return null;
        const { email, password } = parsed.data;
        const user = await prisma.user.findUnique({ where: { email } });
        const ok = await bcrypt.compare(password, user?.passwordHash ?? DUMMY_HASH);
        return user && ok ? { id: user.id, email: user.email } : null;
      },
    }),
  ],
  callbacks: {
    /** Exposes the user id (stored as the JWT `sub`) on `session.user.id`. */
    session({ session, token }) {
      if (token.sub) session.user.id = token.sub;
      return session;
    },
    /** Used by `proxy.ts`: signed-out visitors of protected paths are sent to /login. */
    authorized({ auth }) {
      return !!auth?.user;
    },
  },
});
