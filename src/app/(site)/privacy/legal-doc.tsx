import type { ReactNode } from "react";
import { COMPANY } from "@/lib/config";
import { DISCLAIMER_NOT_LEGAL_ADVICE, LEGAL, type Section } from "@/lib/legal";

type Props = { title: string; summary: readonly string[]; sections: readonly Section[]; children: ReactNode };

export function LegalDoc({ title, summary, sections, children }: Props) {
  return (
    <main className="mx-auto max-w-3xl px-4 pt-12 sm:px-6 sm:pt-16">
      <h1 className="text-3xl font-semibold tracking-tight">{title}</h1>
      <p className="mt-2 text-sm text-muted">
        Last updated {LEGAL.lastUpdated} &middot; Version {LEGAL.version} &middot; {COMPANY.legalName}
      </p>

      <aside aria-label="Summary" className="mt-6 rounded-lg border border-border bg-surface p-4 sm:p-5">
        <h2 className="text-base font-semibold">In short</h2>
        <ul className="mt-2 list-disc space-y-1 pl-5 text-sm leading-relaxed text-muted">
          {summary.map((line) => (
            <li key={line}>{line}</li>
          ))}
        </ul>
      </aside>

      <nav aria-label="Table of contents" className="mt-6">
        <h2 className="text-base font-semibold">Contents</h2>
        <ol className="mt-2 list-decimal space-y-1 pl-5 text-sm sm:columns-2">
          {sections.map((s) => (
            <li key={s.id}>
              <a href={`#${s.id}`} className="underline underline-offset-2">
                {s.title}
              </a>
            </li>
          ))}
        </ol>
      </nav>

      <div className="prose-legal mt-4 break-words">{children}</div>

      <p className="mt-10 border-t border-border pt-4 text-xs text-muted">{DISCLAIMER_NOT_LEGAL_ADVICE}</p>
    </main>
  );
}

export function Sec({ section, children }: { section: Section; children: ReactNode }) {
  return (
    // No scroll-margin here: html already has scroll-padding-top for the sticky header (globals.css), and the two would add up.
    <section id={section.id} aria-labelledby={`${section.id}-h`}>
      <h2 id={`${section.id}-h`}>{section.title}</h2>
      {children}
    </section>
  );
}

export function find(sections: readonly Section[], id: string): Section {
  const s = sections.find((x) => x.id === id);
  if (!s) throw new Error(`unknown legal section ${id}`);
  return s;
}
