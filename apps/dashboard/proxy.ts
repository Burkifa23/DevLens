/**
 * Next.js 16 "proxy" (formerly middleware): runs before matching requests.
 *
 * This is only an early, optimistic redirect to /login for signed-out
 * visitors (via the `authorized` callback in auth.ts). It is NOT the security
 * boundary: every page, server action and route handler still checks the
 * session itself with `requireUserId()`, because proxy rules are easy to get
 * wrong (a missed path, a matcher typo).
 */
export { auth as proxy } from "@/auth";

export const config = {
  matcher: ["/projects/:path*"],
};
