import Link from "next/link";
import type { ReactNode } from "react";
import { Icon } from "./Icon";

export type Crumb = { label: string; href?: string };

type Props = {
  title: string;
  description?: ReactNode;
  /** Trail above the title, for example [{ label: "Broadcasts", href: "/app/broadcasts" }, { label: "New" }]. The last crumb is the current page. */
  breadcrumbs?: Crumb[];
  /** Buttons or links aligned to the right; they wrap below the title on small screens. */
  actions?: ReactNode;
  /** Extra content under the description, such as tabs or filters. */
  children?: ReactNode;
};

/** Standard page heading for signed-in pages: optional breadcrumbs, one h1, description, and an actions slot. Server-component safe. */
export function PageHeader({ title, description, breadcrumbs, actions, children }: Props) {
  return (
    <header className="mb-6">
      {breadcrumbs && breadcrumbs.length > 0 && (
        <nav aria-label="Breadcrumb" className="mb-2">
          <ol className="flex flex-wrap items-center gap-1 text-xs text-muted">
            {breadcrumbs.map((crumb, i) => {
              const last = i === breadcrumbs.length - 1;
              return (
                <li key={`${crumb.label}-${i}`} className="flex items-center gap-1">
                  {i > 0 && <Icon name="chevron-right" className="h-3 w-3" />}
                  {crumb.href && !last ? (
                    <Link href={crumb.href} className="rounded underline-offset-2 hover:text-foreground hover:underline">
                      {crumb.label}
                    </Link>
                  ) : (
                    <span aria-current={last ? "page" : undefined} className={last ? "font-medium text-foreground" : undefined}>
                      {crumb.label}
                    </span>
                  )}
                </li>
              );
            })}
          </ol>
        </nav>
      )}
      <div className="flex flex-wrap items-start justify-between gap-x-6 gap-y-3">
        {/* A 16rem basis, not 0: on a phone the actions then wrap below instead of squeezing the title into a narrow column. */}
        <div className="min-w-0 grow basis-64">
          <h1 className="text-2xl font-semibold tracking-tight">{title}</h1>
          {description && <p className="mt-1 max-w-2xl text-sm text-muted">{description}</p>}
        </div>
        {actions && <div className="flex flex-wrap items-center gap-2">{actions}</div>}
      </div>
      {children && <div className="mt-4">{children}</div>}
    </header>
  );
}
