import Link from "next/link";
import { auth, signOut } from "@/auth";
import { Button, buttonVariants } from "@/components/ui/button";

/**
 * Home page. Signed-in users get a link to their projects and a log-out
 * button; everyone else gets log-in / sign-up links.
 */
export default async function Home() {
  const session = await auth();

  async function logOut() {
    "use server";
    await signOut({ redirectTo: "/" });
  }

  return (
    <main className="mx-auto flex w-full max-w-2xl flex-1 flex-col justify-center gap-6 px-4 py-16">
      <h1 className="text-3xl font-semibold tracking-tight">DevLens</h1>
      <p className="text-lg text-muted-foreground">
        Follow a failure from the browser click to the database query, find the step that broke, and hand that
        evidence to your AI coding agent.
      </p>
      {session?.user ? (
        <div className="flex flex-wrap items-center gap-3">
          <Link href="/projects" className={buttonVariants()}>Your projects</Link>
          <form action={logOut}>
            <Button type="submit" variant="ghost">
              Log out
            </Button>
          </form>
          <span className="text-sm text-muted-foreground">Signed in as {session.user.email}</span>
        </div>
      ) : (
        <div className="flex gap-3">
          <Link href="/login" className={buttonVariants()}>Log in</Link>
          <Link href="/signup" className={buttonVariants({ variant: "outline" })}>Sign up</Link>
        </div>
      )}
    </main>
  );
}
