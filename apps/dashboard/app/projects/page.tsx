import type { Metadata } from "next";
import Link from "next/link";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { listProjects } from "@/lib/projects";
import { requireUserId } from "@/lib/session";
import { CreateProjectForm } from "./create-project-form";

export const metadata: Metadata = { title: "Projects" };

/** /projects — the signed-in user's projects, plus the form to create one. */
export default async function ProjectsPage() {
  const userId = await requireUserId();
  const projects = await listProjects(userId);

  return (
    <main className="mx-auto grid w-full max-w-4xl gap-8 px-4 py-10">
      <header className="flex items-center justify-between gap-4">
        <h1 className="text-2xl font-semibold tracking-tight">Projects</h1>
        <Link href="/" className="text-sm text-muted-foreground hover:text-foreground">
          DevLens
        </Link>
      </header>

      <section aria-labelledby="your-projects" className="grid gap-3">
        <h2 id="your-projects" className="sr-only">
          Your projects
        </h2>
        {projects.length === 0 ? (
          <p className="text-muted-foreground">No projects yet. Create one below to get your API keys.</p>
        ) : (
          <ul className="grid gap-3">
            {projects.map((p) => (
              <li key={p.id}>
                <Link
                  href={`/projects/${p.id}/settings`}
                  className="flex flex-col gap-1 rounded-lg border p-4 transition-colors hover:bg-muted/50 sm:flex-row sm:items-center sm:justify-between"
                >
                  <span className="font-medium">{p.name}</span>
                  <span className="flex flex-wrap gap-x-4 gap-y-1 text-sm text-muted-foreground">
                    <code className="font-mono">{p.publicKey}</code>
                    <span>
                      {p.allowedOrigins.length} origin{p.allowedOrigins.length === 1 ? "" : "s"}
                    </span>
                    <time dateTime={p.createdAt.toISOString()}>{p.createdAt.toLocaleDateString("en-GB")}</time>
                  </span>
                </Link>
              </li>
            ))}
          </ul>
        )}
      </section>

      <Card>
        <CardHeader>
          <CardTitle>New project</CardTitle>
          <CardDescription>One project per app you want to trace.</CardDescription>
        </CardHeader>
        <CardContent>
          <CreateProjectForm />
        </CardContent>
      </Card>
    </main>
  );
}
