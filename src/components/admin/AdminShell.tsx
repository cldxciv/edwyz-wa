import type { ReactNode } from "react";
import { buttonSizes, buttonVariants, cn } from "@/components/ui";

const NAV = [
  { href: "/admin", label: "Overview" },
  { href: "/admin/tenants", label: "Workspaces" },
  { href: "/admin/users", label: "Users" },
  { href: "/admin/plans", label: "Plans" },
  { href: "/admin/payments", label: "Payments" },
  { href: "/admin/audit", label: "Audit log" },
  { href: "/admin/ratecard", label: "Rate card" },
  { href: "/admin/spending", label: "Spending" },
  { href: "/admin/settings", label: "Settings" },
  { href: "/admin/security", label: "Security" },
];

export function AdminShell({ email, current, children }: { email: string; current: string; children: ReactNode }) {
  return (
    <>
      <a
        href="#admin-main"
        data-shell-skip
        className="sr-only rounded-full bg-accent px-4 py-2 text-sm font-semibold text-on-accent focus:not-sr-only focus:fixed focus:left-4 focus:top-4 focus:z-(--z-toast)"
      >
        Skip to content
      </a>
      <header className="border-b border-border bg-raised">
        <div className="mx-auto flex max-w-6xl flex-wrap items-center justify-between gap-x-4 gap-y-1 px-4 py-3 sm:px-6">
          <p className="text-sm font-semibold">Edwyz WA platform admin</p>
          <p className="min-w-0 truncate text-xs text-muted">Signed in as {email}</p>
        </div>
        <nav aria-label="Admin sections" className="mx-auto flex max-w-6xl gap-1 overflow-x-auto px-4 pb-2 sm:px-6">
          {NAV.map((n) => {
            const active = n.href === current;
            return (
              <a
                key={n.href}
                href={n.href}
                aria-current={active ? "page" : undefined}
                className={cn(
                  "inline-flex min-h-10 items-center whitespace-nowrap rounded-full px-4 text-sm font-medium transition-colors duration-(--dur-fast)",
                  active ? "bg-accent text-on-accent" : "text-foreground hover:bg-surface-2",
                )}
              >
                {n.label}
              </a>
            );
          })}
        </nav>
      </header>
      <main id="admin-main" className="mx-auto max-w-6xl px-4 py-8 sm:px-6">
        {children}
      </main>
    </>
  );
}

const pagerLink = cn("inline-flex items-center justify-center rounded-full font-semibold", buttonVariants.secondary, buttonSizes.md);

export function Pager({ base, page, total, size }: { base: string; page: number; total: number; size: number }) {
  const pages = Math.max(1, Math.ceil(total / size));
  const href = (p: number) => `${base}${base.includes("?") ? "&" : "?"}page=${p}`;
  const first = total === 0 ? 0 : (page - 1) * size + 1;
  const last = Math.min(total, page * size);
  return (
    <nav aria-label="Pagination" className="mt-4 flex flex-wrap items-center justify-between gap-3 text-sm">
      <span className="text-muted">
        {total === 0 ? "Nothing to show" : `Showing ${first.toLocaleString()} to ${last.toLocaleString()} of ${total.toLocaleString()} (page ${page} of ${pages})`}
      </span>
      <span className="flex gap-2">
        {page > 1 && (
          <a className={pagerLink} href={href(page - 1)} rel="prev">
            Previous page
          </a>
        )}
        {page < pages && (
          <a className={pagerLink} href={href(page + 1)} rel="next">
            Next page
          </a>
        )}
      </span>
    </nav>
  );
}

export { when } from "./helpers";
