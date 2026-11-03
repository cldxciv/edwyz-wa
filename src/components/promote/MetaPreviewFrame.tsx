"use client";

/**
 * MetaPreviewFrame (docs/IG-PAGE-ADS-SPEC.md 7.4, D18): Meta's own preview of one position, in a sandboxed iframe.
 *
 * - `src` is only ever what POST /api/promote/previews answered: the server keeps nothing from Meta's body but an iframe
 *   src on Meta's preview page (previews.ts, the one named exemption), so this component never builds or edits an address
 *   and names no Meta host. Anything that is not an https address renders nothing.
 * - The iframe has exactly sandbox="allow-scripts allow-same-origin", referrerpolicy="no-referrer" and loading="lazy",
 *   and the title "Meta preview: {position}". The CSP's frame-src allows Meta's hosts.
 * - The tab is labelled "Meta's preview".
 */
import { cn } from "@/components/ui";
import type { PlacementKey, PromoteLang } from "@/lib/promote/types";
import { iframeTitle, isHttpsUrl, previewLabel } from "./creative-helpers";

export const META_PREVIEW_TEST_ID = "meta-preview";
export const META_PREVIEW_SANDBOX = "allow-scripts allow-same-origin";

export type MetaPreviewFrameProps = {
  /** The preview page the server validated. */
  src: string;
  placement: PlacementKey;
  lang?: PromoteLang;
  className?: string;
};

export function MetaPreviewFrame({ src, placement, lang = "en", className }: MetaPreviewFrameProps) {
  if (!isHttpsUrl(src)) return null;
  return (
    <figure className={cn("m-0 flex w-full flex-col items-center gap-2", className)} data-testid={META_PREVIEW_TEST_ID}>
      <iframe
        src={src}
        title={iframeTitle(placement, lang)}
        sandbox={META_PREVIEW_SANDBOX}
        referrerPolicy="no-referrer"
        loading="lazy"
        className="h-[36rem] w-full max-w-[22.5rem] rounded-card border border-border bg-raised"
      />
      <figcaption className="text-xs font-medium text-muted">{previewLabel(false, lang)}</figcaption>
    </figure>
  );
}

export default MetaPreviewFrame;
