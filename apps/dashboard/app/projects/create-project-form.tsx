"use client";

import { CircleAlert, KeyRound } from "lucide-react";
import Link from "next/link";
import { useActionState } from "react";
import { KeyField } from "@/components/copy-button";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { createProjectAction, type CreateProjectState } from "./actions";

/**
 * Create-project form. After a successful submit it shows both keys; the
 * secret key is shown only here, once, with a warning to copy it now.
 */
export function CreateProjectForm() {
  const [state, formAction, pending] = useActionState<CreateProjectState, FormData>(createProjectAction, {});

  return (
    <div className="grid gap-6">
      {state.created && (
        <Alert>
          <KeyRound aria-hidden />
          <AlertTitle>“{state.created.name}” created. Copy the secret key now.</AlertTitle>
          <AlertDescription className="grid w-full gap-3">
            <p>It will not be shown again. Put it in your server&apos;s environment as DEVLENS_SECRET_KEY; never in browser code.</p>
            <div className="grid gap-1">
              <span className="text-xs font-medium">Secret key (server only)</span>
              <KeyField value={state.created.secretKey} label="Copy secret key" />
            </div>
            <div className="grid gap-1">
              <span className="text-xs font-medium">Public key (safe in the browser)</span>
              <KeyField value={state.created.publicKey} label="Copy public key" />
            </div>
            <Link href={`/projects/${state.created.id}/settings`} className="text-sm font-medium text-primary underline-offset-4 hover:underline">
              Open project settings
            </Link>
          </AlertDescription>
        </Alert>
      )}

      <form action={formAction} className="grid gap-4">
        <div className="grid gap-2">
          <Label htmlFor="name">Project name</Label>
          <Input id="name" name="name" required maxLength={100} placeholder="Demo app" defaultValue={state.values?.name} />
        </div>
        <div className="grid gap-2">
          <Label htmlFor="origins">Allowed origins</Label>
          <Textarea
            id="origins"
            name="origins"
            defaultValue={state.values?.origins}
            rows={3}
            placeholder={"http://localhost:3001\nhttps://demo.example.com"}
            aria-describedby="origins-hint"
          />
          <p id="origins-hint" className="text-sm text-muted-foreground">
            One per line. Only browsers on these sites can send spans with the public key.
          </p>
        </div>
        <div className="grid gap-2">
          <Label htmlFor="repoUrl">GitHub repository (optional)</Label>
          <Input id="repoUrl" name="repoUrl" type="url" placeholder="https://github.com/owner/repo" aria-describedby="repo-hint" defaultValue={state.values?.repoUrl} />
          <p id="repo-hint" className="text-sm text-muted-foreground">
            Lets the explorer link a failing span to the exact line of code.
          </p>
        </div>
        {state.error && (
          <Alert variant="destructive" aria-live="polite">
            <CircleAlert aria-hidden />
            <AlertDescription>{state.error}</AlertDescription>
          </Alert>
        )}
        <Button type="submit" disabled={pending} className="justify-self-start">
          {pending ? "Creating…" : "Create project"}
        </Button>
      </form>
    </div>
  );
}
