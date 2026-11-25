import { endSpan, prismaMessage, safely, spanContext, startSpan, type ActiveSpan } from "./context";
import { sourceFromStack } from "./stack";

/** What Prisma passes to a `$allOperations` query hook. */
type QueryParams = { model: string; operation: string; args: unknown; query: (args: unknown) => Promise<unknown> };

/**
 * The only part of a Prisma client DevLens relies on. Prisma 7 generates a
 * client class per app, so the SDK accepts any object with `$extends` instead
 * of depending on one generated `PrismaClient` type.
 */
export type PrismaClientLike = { $extends(extension: never): unknown };

/**
 * Returns a Prisma client whose model queries are recorded as `database` spans.
 *
 * Uses Prisma's `$extends` query hook. Each span is named `"<Model>.<operation>"`
 * (e.g. `DemoUser.create`) and stores only `{ model, operation }` — never the
 * query arguments, which hold user data such as emails. A failed query is an
 * `error` span; the original Prisma error is rethrown unchanged so the app can
 * still handle it (e.g. P2002 → 409).
 *
 * @example export const prisma = instrumentPrisma(new PrismaClient({ adapter }));
 */
export function instrumentPrisma<T extends PrismaClientLike>(client: T): T {
  const extension = {
    query: {
      $allModels: {
        async $allOperations({ model, operation, args, query }: QueryParams) {
          let active: ActiveSpan | undefined;
          try {
            active = startSpan(`${model}.${operation}`, "database", spanContext.getStore());
          } catch {
            active = undefined;
          }
          if (!active) return query(args);
          const running = active;
          const attributes = { model, operation };

          let result: unknown;
          try {
            result = await query(args);
          } catch (err) {
            safely(() =>
              endSpan(running, {
                status: "error",
                errorMessage: prismaMessage(err),
                source: err instanceof Error ? sourceFromStack(err.stack) : undefined,
                attributes,
              }),
            );
            throw err;
          }
          safely(() => endSpan(running, { status: "ok", attributes }));
          return result;
        },
      },
    },
  };
  // Called as a method so Prisma's `$extends` keeps its `this`.
  return (client as unknown as { $extends(ext: typeof extension): T }).$extends(extension);
}
