"use client";

/**
 * PhoneFrame (docs/IG-PAGE-ADS-SPEC.md 7.4, D18): our own drawing of the ad in a phone, labelled "Our preview
 * (approximate)". It shows when Meta's previews are off, busy, capped or failing, and for positions Meta has no preview for.
 *
 * - Frames: 4:5 and 1:1 (feeds, carousels) and 9:16 (Stories and Reels), from the server's mock or catalog/formats.
 * - 9:16 media that isn't 9:16 gets Meta-style fill bars: the picture fitted inside, with a soft blurred copy filling the
 *   bars, and the note "Meta fills the space around pictures that aren't 9:16."
 * - The caption is cut at the catalog's visible length with "… more"; the profile name and picture (MetaAsset.meta) sit on
 *   top; the goal's button sits under the media (feeds) or above the caption (Stories and Reels).
 * - A post made in Edwyz that is being boosted shows as Content shows it: src/components/content/ChannelPreview, wrapped
 *   (not changed) in the phone, with the caption cut at the catalog limit and the button added under it.
 * - Nothing animates (a video never autoplays), so reduced motion needs no switch here; the accessible name is built from
 *   the ad text.
 */
import { ChannelPreview } from "@/components/content/ChannelPreview";
import { cn } from "@/components/ui";
import { placementRow } from "@/lib/promote/catalog/placements";
import { promoteText } from "@/lib/promote/copy";
import type { PreviewMock } from "@/lib/promote/previews";
import type { PlacementKey, PromoteLang } from "@/lib/promote/types";
import { feedAspect, fillBars, hasDevanagari, localMock, placementLabel, previewLabel, visibleCaption, type Size } from "./creative-helpers";

export const PHONE_FRAME_TEST_ID = "phone-frame";

export type PhoneFrameMedia = { url: string; kind: "image" | "video"; width?: number | null; height?: number | null };

export type PhoneFrameProps = {
  placement: PlacementKey;
  /** The server's mock for this tab (frame and visible text); else the same rule computed here. */
  mock?: PreviewMock | null;
  carousel?: boolean;
  profile: { name: string; pictureUrl?: string | null };
  text: { primary: string; headline?: string | null };
  /** The button's label ("Send WhatsApp message"); none for goals without one. */
  ctaLabel?: string | null;
  media?: PhoneFrameMedia | null;
  /** A post made in Edwyz being boosted: shown as Content's preview shows it. */
  post?: { contentKey?: string | null; body: string } | null;
  lang?: PromoteLang;
  className?: string;
};

const sizeOf = (m: PhoneFrameMedia | null | undefined): Size | null => (m && m.width && m.height ? { width: m.width, height: m.height } : null);

function Avatar({ name, pictureUrl, onDark }: { name: string; pictureUrl?: string | null; onDark?: boolean }) {
  if (pictureUrl) {
    // eslint-disable-next-line @next/next/no-img-element
    return <img src={pictureUrl} alt="" className="h-8 w-8 shrink-0 rounded-full object-cover" loading="lazy" />;
  }
  return (
    <span aria-hidden className={cn("flex h-8 w-8 shrink-0 items-center justify-center rounded-full text-xs font-semibold", onDark ? "bg-on-accent/20 text-on-accent" : "bg-accent-soft text-accent-ink")}>
      {name.charAt(0).toUpperCase() || "?"}
    </span>
  );
}

function MediaView({ media, fit, lang }: { media: PhoneFrameMedia | null | undefined; fit: "cover" | "contain"; lang: PromoteLang }) {
  if (!media) {
    return <div className="flex h-full w-full items-center justify-center bg-surface-2 p-4 text-center text-xs text-muted">{promoteText("preview.no_media", {}, lang)}</div>;
  }
  const cls = cn("h-full w-full", fit === "cover" ? "object-cover" : "object-contain");
  // No controls and no autoplay: the drawing shows the first frame, so nothing moves and nothing inside it takes focus.
  if (media.kind === "video") return <video src={media.url} className={cls} muted playsInline preload="metadata" aria-hidden />;
  // eslint-disable-next-line @next/next/no-img-element
  return <img src={media.url} alt="" className={cls} loading="lazy" />;
}

function Caption({ name, text, limit, lang, onDark }: { name: string; text: string; limit: number; lang: PromoteLang; onDark?: boolean }) {
  if (!text.trim()) return null;
  const visible = visibleCaption(text, limit);
  return (
    <p className={cn("whitespace-pre-wrap break-words text-xs", hasDevanagari(text) && "leading-[1.65]", onDark && "text-on-accent")}>
      <span className="font-semibold">{name}</span> {visible.text}
      {visible.truncated && <span className={onDark ? "text-on-accent/80" : "text-muted"}> {promoteText("preview.more", {}, lang)}</span>}
    </p>
  );
}

function CtaBar({ headline, cta, onDark }: { headline?: string | null; cta?: string | null; onDark?: boolean }) {
  if (!headline && !cta) return null;
  return (
    <div className={cn("flex items-center justify-between gap-2 px-3 py-2", onDark ? "text-on-accent" : "border-t border-border bg-surface")}>
      {headline ? <p className="min-w-0 truncate text-xs font-semibold">{headline}</p> : <span />}
      {cta && <span className={cn("shrink-0 rounded-control px-2.5 py-1 text-xs font-semibold", onDark ? "bg-on-accent/20" : "bg-surface-2 text-foreground")}>{cta}</span>}
    </div>
  );
}

export function PhoneFrame({ placement, mock, carousel = false, profile, text, ctaLabel, media, post, lang = "en", className }: PhoneFrameProps) {
  const m = mock ?? localMock(placement, carousel);
  const position = placementLabel(placement, lang);
  const label = previewLabel(true, lang);
  const alt = promoteText("preview.alt", { position, text: visibleCaption(text.primary || text.headline || "", 100).text }, lang);
  const sponsored = promoteText("preview.sponsored", {}, lang);
  const facebook = placementRow(placement).platform === "facebook";

  let screen;
  if (m.frame === "9:16") {
    const bars = fillBars(sizeOf(media), "9:16");
    const hasBars = bars.vertical > 0 || bars.horizontal > 0;
    screen = (
      <>
        <div className="relative w-full overflow-hidden rounded-[1.25rem] bg-surface-2" style={{ aspectRatio: "9 / 16" }} data-fill-bars={hasBars ? "yes" : "no"}>
          {media && hasBars && media.kind === "image" && (
            // eslint-disable-next-line @next/next/no-img-element
            <img src={media.url} alt="" aria-hidden className="absolute inset-0 h-full w-full scale-110 object-cover opacity-60 blur-xl" />
          )}
          <div className="absolute inset-0">
            <MediaView media={media} fit={hasBars ? "contain" : "cover"} lang={lang} />
          </div>
          <div className="absolute inset-x-0 top-0 flex items-center gap-2 bg-overlay/60 px-3 py-2 text-on-accent">
            <Avatar name={profile.name} pictureUrl={profile.pictureUrl} onDark />
            <div className="min-w-0">
              <p className="truncate text-xs font-semibold">{profile.name}</p>
              <p className="text-[0.6875rem] opacity-80">{sponsored}</p>
            </div>
          </div>
          <div className="absolute inset-x-0 bottom-0 flex flex-col gap-1 bg-overlay/60 px-3 py-2">
            <Caption name={profile.name} text={text.primary} limit={m.textLimit} lang={lang} onDark />
            <CtaBar headline={text.headline} cta={ctaLabel} onDark />
          </div>
        </div>
        {hasBars && <p className="mt-1 text-center text-[0.6875rem] text-muted">{promoteText("preview.fill_bars", {}, lang)}</p>}
      </>
    );
  } else if (post) {
    const visible = visibleCaption(post.body, m.textLimit);
    const body = visible.truncated ? `${visible.text} ${promoteText("preview.more", {}, lang)}` : visible.text;
    screen = (
      // ChannelPreview counts characters for scheduling posts; the cut caption would make that count wrong, so it is hidden.
      <div className={cn("overflow-hidden rounded-[1.25rem] [&_figcaption]:hidden", m.frame === "1:1" ? "[&_img]:aspect-square" : "[&_img]:aspect-[4/5]")}>
        <ChannelPreview channel={facebook ? "facebook" : "instagram"} account={profile.name} body={body} mediaKey={post.contentKey ?? undefined} whenText={sponsored} />
        <CtaBar headline={text.headline} cta={ctaLabel} />
      </div>
    );
  } else {
    const aspect = m.frame === "1:1" ? 1 : feedAspect(sizeOf(media), m.frame);
    const caption = (
      <div className="px-3 py-2">
        <Caption name={profile.name} text={text.primary} limit={m.textLimit} lang={lang} />
      </div>
    );
    screen = (
      <div className="overflow-hidden rounded-[1.25rem] border border-border bg-raised">
        <div className="flex items-center gap-2 px-3 py-2">
          <Avatar name={profile.name} pictureUrl={profile.pictureUrl} />
          <div className="min-w-0">
            <p className="truncate text-xs font-semibold">{profile.name}</p>
            <p className="text-[0.6875rem] text-muted">{sponsored}</p>
          </div>
        </div>
        {facebook && caption}
        <div className="w-full overflow-hidden bg-surface-2" style={{ aspectRatio: String(aspect) }}>
          <MediaView media={media} fit="cover" lang={lang} />
        </div>
        <CtaBar headline={text.headline} cta={ctaLabel} />
        {!facebook && caption}
      </div>
    );
  }

  return (
    <figure aria-label={alt} className={cn("m-0 flex w-full flex-col items-center gap-2", className)} data-testid={PHONE_FRAME_TEST_ID} data-frame={m.frame}>
      <div className="w-full max-w-[18rem] rounded-[1.75rem] border-4 border-border-strong bg-raised p-1.5 shadow-raised">
        {screen}
      </div>
      <figcaption className="text-xs font-medium text-muted">{label}</figcaption>
    </figure>
  );
}

export default PhoneFrame;
