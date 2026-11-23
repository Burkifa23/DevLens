"use client";

import { CircleAlert } from "lucide-react";
import { useActionState } from "react";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import type { FormState } from "./actions";

/**
 * Email + password form used by both /login and /signup.
 *
 * `useActionState` runs the server action and keeps its returned error, so the
 * form shows "Invalid email or password" etc. without a page reload, and the
 * button is disabled while the request is in flight.
 */
export function AuthForm({
  action,
  submitLabel,
  newPassword,
}: {
  action: (prev: FormState, formData: FormData) => Promise<FormState>;
  submitLabel: string;
  /** Signup: hints browsers to suggest a new password and enforces the 10-character minimum. */
  newPassword?: boolean;
}) {
  const [state, formAction, pending] = useActionState(action, {});

  return (
    <form action={formAction} className="grid gap-4">
      <div className="grid gap-2">
        <Label htmlFor="email">Email</Label>
        <Input id="email" name="email" type="email" autoComplete="email" required />
      </div>
      <div className="grid gap-2">
        <Label htmlFor="password">Password</Label>
        <Input
          id="password"
          name="password"
          type="password"
          autoComplete={newPassword ? "new-password" : "current-password"}
          minLength={newPassword ? 10 : undefined}
          maxLength={72}
          required
          aria-describedby={newPassword ? "password-hint" : undefined}
        />
        {newPassword && (
          <p id="password-hint" className="text-sm text-muted-foreground">
            At least 10 characters.
          </p>
        )}
      </div>
      {state.error && (
        <Alert variant="destructive" aria-live="polite">
          <CircleAlert aria-hidden />
          <AlertDescription>{state.error}</AlertDescription>
        </Alert>
      )}
      <Button type="submit" disabled={pending}>
        {pending ? "Please wait…" : submitLabel}
      </Button>
    </form>
  );
}
