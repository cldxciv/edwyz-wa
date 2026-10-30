import type { Metadata } from "next";
import Link from "next/link";
import { Footer, Header } from "@/components/shell";

export const metadata: Metadata = { title: "Page not found", robots: { index: false, follow: false } };

/**
 * The one "page not found" screen for everything outside the signed-in app: unknown addresses, and admin pages answering a visitor
 * who is not an admin. It must look the same in both cases, so it never mentions which it was.
 */
export default function NotFound() {
  return (
    <>
      <Header />
      <main className="mx-auto max-w-md px-4 py-20 text-center sm:px-6">
        <p className="text-sm font-semibold uppercase tracking-widest text-muted">Error 404</p>
        <h1 className="mt-3 text-3xl font-semibold tracking-tight">We could not find that page</h1>
        <p className="mt-4 text-base leading-relaxed text-muted">Check the address for typing mistakes, or go back to the home page and start from there.</p>
        <div className="mt-8 flex flex-col justify-center gap-3 sm:flex-row">
          <Link href="/" className="inline-flex items-center justify-center rounded-full bg-accent px-6 py-3 text-base font-semibold text-white hover:bg-accent-strong">
            Go to the home page
          </Link>
          <Link href="/login" className="inline-flex items-center justify-center rounded-full border border-border bg-background px-6 py-3 text-base font-semibold hover:bg-surface">
            Sign in
          </Link>
        </div>
      </main>
      <Footer />
    </>
  );
}
