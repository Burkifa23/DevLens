import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { KeyField } from "@/components/copy-button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { getOwnedProject } from "@/lib/projects";
import { requireUserId } from "@/lib/session";

export const metadata: Metadata = { title: "Project settings" };

/**
 * /projects/[projectId]/settings — keys and setup for one project.
 *
 * A project the user doesn't own gives the same 404 as one that doesn't exist,
 * so the page never confirms that someone else's project id is real.
 */
export default async function ProjectSettingsPage({ params }: { params: Promise<{ projectId: string }> }) {
  const userId = await requireUserId();
  const { projectId } = await params;
  const project = await getOwnedProject(userId, projectId);
  if (!project) notFound();

  const envSnippet = [
    `NEXT_PUBLIC_DEVLENS_ENDPOINT="<dashboard URL>/api/ingest"`,
    `NEXT_PUBLIC_DEVLENS_KEY="${project.publicKey}"`,
    `DEVLENS_SECRET_KEY="<the sk_ key you copied when you created the project>"`,
  ].join("\n");

  return (
    <main className="mx-auto grid w-full max-w-3xl gap-6 px-4 py-10">
      <nav aria-label="Breadcrumb" className="text-sm text-muted-foreground">
        <Link href="/projects" className="hover:text-foreground">
          Projects
        </Link>{" "}
        / <span className="text-foreground">{project.name}</span>
      </nav>
      <h1 className="text-2xl font-semibold tracking-tight">{project.name}</h1>

      <Card>
        <CardHeader>
          <CardTitle>API keys</CardTitle>
          <CardDescription>
            The public key goes in browser code. The secret key was shown once, when you created the project; only
            its hash is stored, so it cannot be shown again.
          </CardDescription>
        </CardHeader>
        <CardContent className="grid gap-4">
          <div className="grid gap-1">
            <span className="text-sm font-medium">Public key</span>
            <KeyField value={project.publicKey} label="Copy public key" />
          </div>
          <div className="grid gap-1">
            <span className="text-sm font-medium">Secret key</span>
            <p className="text-sm text-muted-foreground">Hidden. Lost it? Create a new project for now.</p>
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Allowed origins</CardTitle>
          <CardDescription>Browsers on these sites may send spans with the public key.</CardDescription>
        </CardHeader>
        <CardContent>
          {project.allowedOrigins.length === 0 ? (
            <p className="text-sm text-muted-foreground">None: the public key can&apos;t be used from any browser yet.</p>
          ) : (
            <ul className="grid gap-1 font-mono text-sm">
              {project.allowedOrigins.map((o) => (
                <li key={o}>{o}</li>
              ))}
            </ul>
          )}
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Source links</CardTitle>
          <CardDescription>Used to link failing spans to the exact line on GitHub.</CardDescription>
        </CardHeader>
        <CardContent className="text-sm">
          {project.repoUrl ? (
            // Safe to render as a link: createProject only accepts https://github.com/owner/repo.
            <a href={project.repoUrl} target="_blank" rel="noopener noreferrer" className="font-mono text-primary underline-offset-4 hover:underline">
              {project.repoUrl}
            </a>
          ) : (
            <p className="text-muted-foreground">No repository set.</p>
          )}
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Connect your app</CardTitle>
          <CardDescription>Add these to the instrumented app&apos;s environment.</CardDescription>
        </CardHeader>
        <CardContent>
          <pre className="overflow-x-auto rounded-md bg-muted p-3 font-mono text-xs">{envSnippet}</pre>
        </CardContent>
      </Card>
    </main>
  );
}
