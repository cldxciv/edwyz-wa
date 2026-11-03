"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";

/**
 * aria-current for a link to `href` while the browser is at `pathname`: "page" on that page itself and, unless `exact`, "true"
 * anywhere below it (the header's Docs link on /docs/endpoints). In-page links such as /#features never count: they point at a section.
 */
export function currentFor(href: string, pathname: string | null, exact = false): "page" | "true" | undefined {
  if (!pathname || href.includes("#")) return undefined;
  if (pathname === href) return "page";
  return !exact && href !== "/" && pathname.startsWith(`${href}/`) ? "true" : undefined;
}

type Props = { href: string; exact?: boolean; className?: string; currentClassName?: string; onClick?: () => void; children: React.ReactNode };

/** A Link that marks itself as the current page, for screen readers (aria-current) and on screen (currentClassName). */
export function NavLink({ href, exact, className = "", currentClassName = "", onClick, children }: Props) {
  const current = currentFor(href, usePathname(), exact);
  return (
    <Link href={href} aria-current={current} className={current ? `${className} ${currentClassName}` : className} onClick={onClick}>
      {children}
    </Link>
  );
}
