import type { Metadata } from "next";
import Link from "next/link";
import { Card, CardContent, CardDescription, CardFooter, CardHeader, CardTitle } from "@/components/ui/card";
import { signUpAndLogIn } from "../actions";
import { AuthForm } from "../auth-form";

export const metadata: Metadata = { title: "Sign up" };

/** /signup — creates an account, then logs straight in. */
export default function SignupPage() {
  return (
    <Card>
      <CardHeader>
        <CardTitle>Create an account</CardTitle>
        <CardDescription>Connect your app and start tracing failures.</CardDescription>
      </CardHeader>
      <CardContent>
        <AuthForm action={signUpAndLogIn} submitLabel="Create account" newPassword />
      </CardContent>
      <CardFooter className="text-sm text-muted-foreground">
        Already have an account?&nbsp;
        <Link href="/login" className="font-medium text-foreground underline underline-offset-4 hover:decoration-2">
          Log in
        </Link>
      </CardFooter>
    </Card>
  );
}
