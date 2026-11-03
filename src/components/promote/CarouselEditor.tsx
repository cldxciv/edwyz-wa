"use client";

/**
 * CarouselEditor (docs/IG-PAGE-ADS-SPEC.md 3.4 step 2, 4.6, 7.3): 2 to 10 cards, each a 1:1 picture with a headline and a
 * link (a lead form ad has one form for every card, so its cards carry no link).
 *
 * - Each card's picture comes from MediaPicker with format 'carousel', so the server checks it as a carousel card (1:1 or
 *   4:5; "crop it to 1:1" otherwise). A picture that isn't 1:1 offers "Crop this picture", which opens CropTool
 *   (lazy-loaded) at 1:1 (1080x1080); the crop is uploaded and prepared for Meta like any pick (D34).
 * - Reorder with the move buttons ("Move card 2 earlier") or by dragging a card by its grip; every move is announced
 *   ("Card 2 is now card 3."). Add stops at 10 and remove at 2, with "A carousel needs 2 to 10 cards." below 2.
 * - The headline counter follows the carousel's visible length (20), counted in graphemes.
 */
import { lazy, Suspense, useId, useState, type DragEvent } from "react";
import { buttonVariants, Button, cn, Dialog, Input, Spinner } from "@/components/ui";
import { FORMAT_SPECS } from "@/lib/promote/catalog/formats";
import { promoteText } from "@/lib/promote/copy";
import type { AdMediaView } from "@/lib/promote/media";
import type { PlacementKey, PromoteLang } from "@/lib/promote/types";
import { CAROUSEL_LIMITS, canAddCard, canRemoveCard, cardLinkProblem, graphemes, mediaFileUrl, moveItem, type CarouselCardValue } from "./creative-helpers";
import type { CropResult } from "./CropTool";
import { MediaPicker, prepareAdMedia } from "./MediaPicker";

const CropTool = lazy(() => import("./CropTool"));

export const CAROUSEL_TEST_IDS = { root: "carousel-editor", card: (i: number) => `carousel-card-${i + 1}`, add: "carousel-add" } as const;

export type CarouselEditorProps = {
  cards: CarouselCardValue[];
  onChange: (cards: CarouselCardValue[]) => void;
  placements: readonly PlacementKey[];
  /** 'link': each card has its own link; 'lead_form': every card opens the same form; 'none': no links. */
  linkMode?: "link" | "lead_form" | "none";
  lang?: PromoteLang;
  className?: string;
};

let seq = 0;
/** A local id for a new card (React keys and drag); never sent to Meta. */
export function newCardId(): string {
  seq += 1;
  return `card-${Date.now().toString(36)}-${seq.toString(36)}`;
}

export const emptyCard = (): CarouselCardValue => ({ id: newCardId(), media: null, headline: "", link: "" });

const iconButton = cn(
  "inline-flex h-11 w-11 shrink-0 items-center justify-center rounded-full transition-colors duration-(--dur-fast) disabled:cursor-not-allowed disabled:opacity-40",
  buttonVariants.ghost,
);

function Arrow({ dir }: { dir: "up" | "down" }) {
  return (
    <svg viewBox="0 0 16 16" className="h-4 w-4" aria-hidden="true" focusable="false">
      <path d={dir === "up" ? "M8 13V3M3.5 7.5 8 3l4.5 4.5" : "M8 3v10M3.5 8.5 8 13l4.5-4.5"} fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

function Grip() {
  return (
    <svg viewBox="0 0 16 16" className="h-4 w-4" aria-hidden="true" focusable="false">
      <path d="M6 3.5h.01M10 3.5h.01M6 8h.01M10 8h.01M6 12.5h.01M10 12.5h.01" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" />
    </svg>
  );
}

function Cross() {
  return (
    <svg viewBox="0 0 16 16" className="h-4 w-4" aria-hidden="true" focusable="false">
      <path d="M4 4l8 8M12 4l-8 8" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
    </svg>
  );
}

export function CarouselEditor({ cards, onChange, placements, linkMode = "link", lang = "en", className }: CarouselEditorProps) {
  const uid = useId();
  const [announce, setAnnounce] = useState("");
  const [dragging, setDragging] = useState<number | null>(null);
  const t = (key: Parameters<typeof promoteText>[0], vars?: Parameters<typeof promoteText>[1]) => promoteText(key, vars ?? {}, lang);
  const headlineMax = FORMAT_SPECS.carousel.text.headline;

  const update = (i: number, patch: Partial<CarouselCardValue>) => onChange(cards.map((c, j) => (j === i ? { ...c, ...patch } : c)));
  const move = (from: number, to: number) => {
    if (to < 0 || to >= cards.length || from === to) return;
    onChange(moveItem(cards, from, to));
    setAnnounce(t("carousel.moved", { from: from + 1, to: to + 1 }));
  };
  const remove = (i: number) => {
    if (!canRemoveCard(cards.length)) return;
    onChange(cards.filter((_, j) => j !== i));
  };
  const add = () => {
    if (canAddCard(cards.length)) onChange([...cards, emptyCard()]);
  };

  // Only the grip drags, so text in the card's fields stays selectable; the whole card is the drag picture.
  const onDragStart = (i: number) => (e: DragEvent<HTMLSpanElement>) => {
    setDragging(i);
    e.dataTransfer.effectAllowed = "move";
    e.dataTransfer.setData("text/plain", String(i));
    const card = e.currentTarget.closest("li");
    if (card) e.dataTransfer.setDragImage(card, 24, 24);
  };
  const onDrop = (i: number) => (e: DragEvent<HTMLLIElement>) => {
    e.preventDefault();
    const from = dragging;
    setDragging(null);
    // Only a card's own grip reorders; a file or text dropped from elsewhere does nothing.
    if (from !== null) move(from, i);
  };

  const [crop, setCrop] = useState<{ id: string; src: string } | null>(null);
  const onCropped = async (r: CropResult) => {
    const target = crop;
    if (!target) return;
    // The crop is the member's tap that sends it to Meta (D34); an error shows inside CropTool.
    const media = await prepareAdMedia({ from: "crop", key: r.key }, placements, "carousel");
    onChange(cards.map((c) => (c.id === target.id ? { ...c, media } : c)));
    setCrop(null);
  };

  const tooFew = cards.length < CAROUSEL_LIMITS.min;

  return (
    <section aria-labelledby={`${uid}-title`} className={cn("flex min-w-0 flex-col gap-3", className)} data-testid={CAROUSEL_TEST_IDS.root}>
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <h3 id={`${uid}-title`} className="text-sm font-semibold">
          {t("carousel.label")}
        </h3>
        <p className="text-xs text-muted tabular-nums">{t("carousel.count", { count: cards.length, max: CAROUSEL_LIMITS.max })}</p>
      </div>
      <p className="text-xs text-muted">{t("carousel.drag_hint")}</p>
      {linkMode === "lead_form" && <p className="text-xs text-muted">{t("carousel.one_form")}</p>}

      <ol className="flex flex-col gap-3">
        {cards.map((card, i) => {
          const n = i + 1;
          const headlineId = `${uid}-${card.id}-headline`;
          const linkId = `${uid}-${card.id}-link`;
          const linkProblem = linkMode === "link" ? cardLinkProblem(card.link, lang) : null;
          const headlineCount = graphemes(card.headline).length;
          return (
            <li
              key={card.id}
              onDragOver={(e) => e.preventDefault()}
              onDrop={onDrop(i)}
              className={cn("flex min-w-0 flex-col gap-3 rounded-card border bg-raised p-3", dragging === i ? "border-accent opacity-70" : "border-border")}
              data-testid={CAROUSEL_TEST_IDS.card(i)}
            >
              <div className="flex items-center justify-between gap-2">
                <div className="flex min-w-0 items-center gap-1">
                  <span draggable onDragStart={onDragStart(i)} onDragEnd={() => setDragging(null)} aria-hidden className="flex h-11 w-6 shrink-0 cursor-grab items-center justify-center text-muted active:cursor-grabbing">
                    <Grip />
                  </span>
                  <h4 className="text-sm font-semibold">{t("carousel.card", { n })}</h4>
                </div>
                <div className="flex items-center">
                  <button type="button" className={iconButton} aria-label={t("carousel.earlier", { n })} disabled={i === 0} onClick={() => move(i, i - 1)}>
                    <Arrow dir="up" />
                  </button>
                  <button type="button" className={iconButton} aria-label={t("carousel.later", { n })} disabled={i === cards.length - 1} onClick={() => move(i, i + 1)}>
                    <Arrow dir="down" />
                  </button>
                  <button type="button" className={iconButton} aria-label={t("carousel.remove", { n })} disabled={!canRemoveCard(cards.length)} onClick={() => remove(i)}>
                    <Cross />
                  </button>
                </div>
              </div>

              <MediaPicker
                kind="image"
                format="carousel"
                placements={placements}
                value={card.media}
                onChange={(media: AdMediaView | null) => update(i, { media })}
                label={t(card.media ? "carousel.change_picture" : "carousel.picture")}
                lang={lang}
                actions={
                  card.media && card.media.kind === "image" && card.media.ratio !== "1:1" ? (
                    <Button type="button" variant="secondary" className="pointer-coarse:min-h-11" onClick={() => card.media && setCrop({ id: card.id, src: mediaFileUrl(card.media) })}>
                      {t("ad.crop")}
                    </Button>
                  ) : undefined
                }
              />

              <div className="flex flex-col gap-1.5">
                <label htmlFor={headlineId} className="text-sm font-medium">
                  {t("carousel.headline")}
                </label>
                <Input id={headlineId} value={card.headline} autoComplete="off" aria-describedby={`${headlineId}-count`} onChange={(e) => update(i, { headline: e.target.value })} />
                <p id={`${headlineId}-count`} className={cn("text-xs tabular-nums", headlineCount > headlineMax ? "font-medium text-warn-fg" : "text-muted")}>
                  {t("text.counter", { count: headlineCount, limit: headlineMax })}
                </p>
              </div>

              {linkMode === "link" && (
                <div className="flex flex-col gap-1.5">
                  <label htmlFor={linkId} className="text-sm font-medium">
                    {t("carousel.link")}
                  </label>
                  <Input
                    id={linkId}
                    type="url"
                    inputMode="url"
                    value={card.link}
                    autoComplete="off"
                    aria-invalid={linkProblem ? true : undefined}
                    aria-describedby={linkProblem ? `${linkId}-error` : undefined}
                    onChange={(e) => update(i, { link: e.target.value })}
                  />
                  {linkProblem && (
                    <p id={`${linkId}-error`} role="alert" className="text-xs font-medium text-bad-fg">
                      {linkProblem}
                    </p>
                  )}
                </div>
              )}
            </li>
          );
        })}
      </ol>

      {tooFew && (
        <p role="alert" className="text-sm font-medium text-bad-fg">
          {t("carousel.cards")}
        </p>
      )}
      <Button type="button" variant="secondary" className="self-start pointer-coarse:min-h-11" onClick={add} disabled={!canAddCard(cards.length)} data-testid={CAROUSEL_TEST_IDS.add}>
        {t("carousel.add")}
      </Button>
      <p aria-live="polite" className="sr-only">
        {announce}
      </p>
      {crop && (
        <Dialog title={t("crop.title")} onClose={() => setCrop(null)} size="md">
          <Suspense fallback={<Spinner label={t("crop.title")} />}>
            <CropTool src={crop.src} ratio="1:1" ratios={["1:1"]} lang={lang} onCancel={() => setCrop(null)} onCropped={onCropped} />
          </Suspense>
        </Dialog>
      )}
    </section>
  );
}

export default CarouselEditor;
