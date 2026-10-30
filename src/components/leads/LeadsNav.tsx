import Link from "next/link";

const TABS = [
  { href: "/app/leads", label: "Leads" },
  { href: "/app/leads/sequences", label: "Follow-ups" },
  { href: "/app/leads/forms", label: "Forms" },
];

export function LeadsNav({ current }: { current: string }) {
  return (
    <nav aria-label="Lead sections" className="-mx-4 mb-6 overflow-x-auto px-4 sm:mx-0 sm:px-0">
      <ul className="flex gap-2">
        {TABS.map((t) => {
          const active = t.href === current;
          return (
            <li key={t.href}>
              <Link
                href={t.href}
                aria-current={active ? "page" : undefined}
                className={`inline-flex min-h-10 items-center whitespace-nowrap rounded-full border px-4 text-sm font-medium transition-colors duration-(--dur-fast) ${active ? "border-accent bg-accent text-on-accent" : "border-border-strong bg-raised text-foreground hover:bg-surface-2"}`}
              >
                {t.label}
              </Link>
            </li>
          );
        })}
      </ul>
    </nav>
  );
}
