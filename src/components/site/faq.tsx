import Link from "next/link";
import type { Faq as FaqItem } from "./content";
import { Icon } from "./icons";

/** Native disclosure elements: keyboard and screen-reader accessible, and no client JavaScript. */
export function Faq({ items }: { items: readonly FaqItem[] }) {
  return (
    <div className="mt-10 max-w-3xl divide-y divide-border rounded-2xl border border-border bg-surface">
      {items.map((item) => (
        <details key={item.q} className="group px-5">
          <summary className="flex min-h-14 cursor-pointer list-none items-center justify-between gap-4 py-4 text-left font-semibold [&::-webkit-details-marker]:hidden">
            {item.q}
            <span className="pub-ink shrink-0 transition-transform group-open:rotate-180">
              <Icon name="chevron" />
            </span>
          </summary>
          <div className="pb-5 leading-relaxed text-muted">
            <p>{item.a}</p>
            {item.link && (
              <p className="mt-2">
                <Link href={item.link.href} className="pub-ink font-medium underline underline-offset-2">
                  {item.link.label}
                </Link>
              </p>
            )}
          </div>
        </details>
      ))}
    </div>
  );
}
