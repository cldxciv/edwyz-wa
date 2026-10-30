import Link from "next/link";

export default function AppNotFound() {
  return (
    <div className="mx-auto max-w-md py-16 text-center">
      <h1 className="text-2xl font-semibold tracking-tight">We could not find that page</h1>
      <p className="mt-3 text-sm text-muted">It may have moved, or you may not have access to it.</p>
      <Link href="/app" className="mt-6 inline-block rounded-full border border-border px-5 py-2.5 text-sm font-semibold hover:bg-surface">
        Back to your workspace
      </Link>
    </div>
  );
}
