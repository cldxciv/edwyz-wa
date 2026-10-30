import Link from "next/link";
import type { ReactNode } from "react";

export const DOC_LINKS = [
  { href: "/docs", label: "Overview" },
  { href: "/docs/authentication", label: "Authentication" },
  { href: "/docs/endpoints", label: "Endpoints" },
  { href: "/docs/webhooks", label: "Webhooks" },
  { href: "/docs/rate-limits", label: "Rate limits" },
  { href: "/docs/errors", label: "Errors" },
  { href: "/docs/openapi.json", label: "OpenAPI (JSON)", file: true },
] as const;

export function DocShell({ title, intro, children }: { title: string; intro: string; children: ReactNode }) {
  return (
    <main className="mx-auto max-w-4xl px-4 pt-12 pb-16 sm:px-6 sm:pt-16">
      <nav aria-label="API documentation" className="mb-8 flex flex-wrap gap-x-4 gap-y-2 border-b border-border pb-3 text-sm">
        {DOC_LINKS.map((l) =>
          "file" in l ? (
            <a key={l.href} href={l.href} className="underline-offset-2 hover:underline">
              {l.label}
            </a>
          ) : (
            <Link key={l.href} href={l.href} className="underline-offset-2 hover:underline">
              {l.label}
            </Link>
          ),
        )}
      </nav>
      <h1 className="text-3xl font-semibold tracking-tight">{title}</h1>
      <p className="mt-3 text-muted">{intro}</p>
      <div className="mt-8 space-y-6 break-words text-sm leading-relaxed [&_h2]:mt-8 [&_h2]:text-xl [&_h2]:font-semibold [&_li]:ml-5 [&_li]:list-disc [&_a]:underline">
        {children}
      </div>
    </main>
  );
}

export function Code({ children, label }: { children: string; label?: string }) {
  return (
    <pre aria-label={label} className="overflow-x-auto rounded-lg border border-border bg-surface p-3 text-xs leading-relaxed">
      <code>{children}</code>
    </pre>
  );
}
