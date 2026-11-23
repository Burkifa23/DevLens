import Link from "next/link";

/** Centered single-card layout for /login and /signup. */
export default function AuthLayout({ children }: { children: React.ReactNode }) {
  return (
    <main className="flex flex-1 flex-col items-center justify-center gap-6 px-4 py-12">
      <Link href="/" className="text-lg font-semibold tracking-tight">
        DevLens
      </Link>
      <div className="w-full max-w-sm">{children}</div>
    </main>
  );
}
