"use client";

import { CircleAlert } from "lucide-react";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";

/**
 * Error state for the trace list (and the project's other pages): shown when
 * loading fails, for example if the database is unreachable. It never shows the
 * error's text, which could contain internal details.
 */
export default function ProjectError({ reset }: { error: Error & { digest?: string }; reset: () => void }) {
  return (
    <main className="mx-auto grid w-full max-w-5xl gap-4 px-4 py-10">
      <Alert variant="destructive">
        <CircleAlert aria-hidden />
        <AlertDescription>Couldn&apos;t load this project&apos;s traces. Try again in a moment.</AlertDescription>
      </Alert>
      <div>
        <Button variant="outline" onClick={reset}>
          Try again
        </Button>
      </div>
    </main>
  );
}
