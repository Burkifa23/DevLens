import { span } from "@devlens/sdk-node";
import type { prisma as dashboardPrisma } from "@/lib/db";

/**
 * A stand-in for the demo app's `services/registration.ts` (Task 7), used by
 * sdk-integration.test.ts. It is written the way an app would be, with
 * `span()` called inside the service, so the test can show which file and line
 * the SDK records for the function span and for a real Prisma error.
 */
export async function registerUser(prisma: typeof dashboardPrisma, email: string) {
  return span("RegistrationService.registerUser", async () => {
    const user = await prisma.user.create({ data: { email, passwordHash: "x" } }); // DB_CALL_LINE
    return user.id;
  });
}
