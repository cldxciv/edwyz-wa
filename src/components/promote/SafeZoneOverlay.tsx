"use client";

/**
 * SafeZoneOverlay (docs/IG-PAGE-ADS-SPEC.md 4.6, 7.3): the parts of a 9:16 frame that Instagram and Facebook may cover,
 * from catalog/formats: top 14%, bottom 35% for Reels or 20% for Stories, and 6% on each side.
 *
 * - SafeZoneOverlay draws the bands inside a `relative` frame (CropTool's viewport, PhoneFrame's tall screen). The bands
 *   never take pointer events, so dragging the picture still works. Its text equivalent is in the markup for screen
 *   readers unless the visible legend is shown next to it (`announce={false}`).
 * - SafeZoneLegend is that text equivalent, visible: "Text in the top 14% may be hidden by the profile name"...
 *
 * Tokens only: the bands use the overlay colour and a dashed edge in the on-accent colour.
 */
import { cn } from "@/components/ui";
import { promoteText } from "@/lib/promote/copy";
import type { PromoteLang } from "@/lib/promote/types";
import { safeZoneFor, type SafeZoneGroup } from "./creative-helpers";

export const SAFE_ZONE_TEST_ID = "safe-zone";

export type SafeZoneOverlayProps = {
  group: SafeZoneGroup;
  lang?: PromoteLang;
  /** Keep the text equivalent in the markup for screen readers (turn off when SafeZoneLegend is shown beside it). */
  announce?: boolean;
  className?: string;
};

export function SafeZoneOverlay({ group, lang = "en", announce = true, className }: SafeZoneOverlayProps) {
  const zone = safeZoneFor(group, lang);
  const band = "absolute bg-overlay/60 border-dashed border-on-accent/80";
  return (
    <div className={cn("pointer-events-none absolute inset-0", className)} data-testid={SAFE_ZONE_TEST_ID} data-safe-zone={group}>
      <div aria-hidden>
        <span className={cn(band, "inset-x-0 top-0 border-b")} style={{ height: `${zone.topPct}%` }} data-band="top" />
        <span className={cn(band, "inset-x-0 bottom-0 border-t")} style={{ height: `${zone.bottomPct}%` }} data-band="bottom" />
        <span className={cn(band, "left-0 border-r")} style={{ top: `${zone.topPct}%`, bottom: `${zone.bottomPct}%`, width: `${zone.sidesPct}%` }} data-band="left" />
        <span className={cn(band, "right-0 border-l")} style={{ top: `${zone.topPct}%`, bottom: `${zone.bottomPct}%`, width: `${zone.sidesPct}%` }} data-band="right" />
      </div>
      {announce && (
        <ul className="sr-only">
          {zone.lines.map((line) => (
            <li key={line}>{line}</li>
          ))}
        </ul>
      )}
    </div>
  );
}

/** The visible text equivalent: a title ("What may cover your picture in Reels") and one line per band. */
export function SafeZoneLegend({ group, lang = "en", className }: { group: SafeZoneGroup; lang?: PromoteLang; className?: string }) {
  const zone = safeZoneFor(group, lang);
  const where = promoteText(group === "reels" ? "crop.zone.reels" : "crop.zone.stories", {}, lang);
  return (
    <div className={cn("text-xs text-muted", className)} data-testid="safe-zone-legend">
      <p className="font-medium text-foreground">{promoteText("safe_zone.title", { where }, lang)}</p>
      <ul className="mt-1 list-disc space-y-0.5 pl-4">
        {zone.lines.map((line) => (
          <li key={line}>{line}</li>
        ))}
      </ul>
    </div>
  );
}

export default SafeZoneOverlay;
