"use client";

/**
 * The "Opens Meta" button (docs/IG-PAGE-ADS-SPEC.md 8.4, D19). It is shown only for the screens Meta offers no API for, and
 * it says so: an external-link icon, the label "Opens Meta", and "Meta doesn't let apps do this, so it opens in Meta. Come
 * back here after."
 *
 * It never builds an address. The server resolves `href` from the allowlist (src/lib/meta-connect/meta-screens.ts,
 * metaScreenHref or opensMetaLink) and passes it down; anything that is not an https address renders nothing. The link opens
 * a new tab with rel="noopener noreferrer", so Meta's page can't reach back into Edwyz.
 */
import { useId } from "react";
import { buttonVariants, cn } from "@/components/ui";
import { promoteText } from "@/lib/promote/copy";
import type { MetaScreenKey, PromoteLang } from "@/lib/promote/types";

export const OPENS_META_TEST_ID = "opens-meta";

export type OpensMetaButtonProps = {
  /** The address the server resolved from the allowlist. */
  href: string | null | undefined;
  /** The allowlist key, for tests and analytics. */
  screen: MetaScreenKey;
  /** What the step does, in the member's language ("Accept Meta's lead ad terms"). Without it the button reads "Opens Meta". */
  label?: string | null;
  lang?: PromoteLang;
  className?: string;
  "data-testid"?: string;
};

/** The href when it is an https address with no credentials, else null. Hosts are checked on the server, where the allowlist is. */
export function safeOpensMetaHref(href: unknown): string | null {
  if (typeof href !== "string" || href.length > 2048) return null;
  try {
    const u = new URL(href);
    return u.protocol === "https:" && !u.username && !u.password ? u.toString() : null;
  } catch {
    return null;
  }
}

function ExternalIcon() {
  return (
    <svg viewBox="0 0 16 16" className="h-3.5 w-3.5 shrink-0" aria-hidden="true" focusable="false">
      <path d="M9 3h4v4M13 3L7.5 8.5M11 9.5V13H3V5h3.5" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

export function OpensMetaButton({ href, screen, label, lang = "en", className, "data-testid": testId = OPENS_META_TEST_ID }: OpensMetaButtonProps) {
  const noteId = useId();
  const safe = safeOpensMetaHref(href);
  if (!safe) return null;
  const opens = promoteText("opens_meta.label", {}, lang);
  const sentence = promoteText("opens_meta.sentence", {}, lang);
  const text = label?.trim() || null;
  return (
    <div className={cn("flex min-w-0 flex-col gap-1", className)} data-testid={testId} data-opens-meta={screen}>
      <a
        href={safe}
        target="_blank"
        rel="noopener noreferrer"
        aria-describedby={noteId}
        className={cn(
          "inline-flex min-h-10 max-w-full flex-wrap items-center gap-2 self-start rounded-full px-4 py-2 text-left text-sm font-semibold no-underline transition-colors duration-(--dur-fast) pointer-coarse:min-h-11",
          buttonVariants.secondary,
        )}
      >
        {text && <span className="min-w-0 break-words">{text}</span>}
        <span className={text ? "rounded-full bg-surface-2 px-2 py-0.5 text-xs font-medium text-muted" : undefined}>{opens}</span>
        <ExternalIcon />
      </a>
      <p id={noteId} className="text-xs text-muted">
        {sentence}
      </p>
    </div>
  );
}
