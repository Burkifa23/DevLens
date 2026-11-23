import type { Metadata } from "next";
import Link from "next/link";
import { Card, CardContent, CardDescription, CardFooter, CardHeader, CardTitle } from "@/components/ui/card";
import { logIn } from "../actions";
import { AuthForm } from "../auth-form";

export const metadata: Metadata = { title: "Log in" };

/** /login — email + password sign-in. Success redirects to /projects. */
export default function LoginPage() {
  return (
    <Card>
      <CardHeader>
        <CardTitle>Log in</CardTitle>
        <CardDescription>Open your projects and traces.</CardDescription>
      </CardHeader>
      <CardContent>
        <AuthForm action={logIn} submitLabel="Log in" />
      </CardContent>
      <CardFooter className="text-sm text-muted-foreground">
        No account?&nbsp;
        <Link href="/signup" className="font-medium text-primary underline-offset-4 hover:underline">
          Sign up
        </Link>
      </CardFooter>
    </Card>
  );
}
