"use client";

/**
 * AdStep (docs/IG-PAGE-ADS-SPEC.md 3.4 step 2, 3.8, 7.3, D21, D34): "Your ad" for every new-ad flow.
 *
 * - Source tabs: Image, Video (hidden while PROMOTE_VIDEO is off), Carousel, and "Use a post", which hands over to Boost
 *   step 1 (onUsePost). The selected tab is the value's source, so a draft loaded or changed later (Eddy, an undo) shows as
 *   it is; a source that isn't offered (a video draft while video is off) is switched to the first one that is.
 * - MediaPicker for the picture or video. One picture is enough: a 1:1 or 4:5 picture offers "Add a tall version (9:16) for
 *   Stories and Reels", which opens CropTool (lazy-loaded) at 9:16; the crop is uploaded, then prepared for Meta. A video
 *   can't be cropped, so its tall version is another video. "Crop this picture" crops the feed picture to 4:5 or 1:1.
 * - CopyFields for the text, with the counters and Instagram's stops.
 * - "Add a version to compare" adds version B, then C (3.8). Each starts as a copy of version A, to change. A carousel uses
 *   version A's text only (see AdStepValue).
 * - The call to action sits under More options, with the goal's buttons (default first).
 *
 * Controlled: the page keeps the value and saves the draft (usePromoteDraft, PRM-14). The media in the value are the
 * AdMediaView answers, so the page stores their ids. What applies to the ad comes from adStepInUse(value).
 */
import { lazy, Suspense, useEffect, useId, useRef, useState } from "react";
import { Button, buttonVariants, cn, Dialog, Select, Spinner, Tabs } from "@/components/ui";
import type { GoalKey, PlacementKey, PromoteLang } from "@/lib/promote/types";
import {
  AD_SOURCE_KEYS,
  adSourceTabs,
  adStepView,
  canAddVersion,
  ctaOptions,
  emptyVersion,
  mediaFileUrl,
  needsTallVersion,
  patchVersion,
  VERSION_LETTERS,
  type AdSource,
  type AdStepValue,
  type AdVersionValue,
  type CropRatio,
} from "./creative-helpers";
import { CarouselEditor, emptyCard } from "./CarouselEditor";
import { CopyFields } from "./CopyFields";
import type { CropResult } from "./CropTool";
import { MediaPicker, prepareAdMedia } from "./MediaPicker";
import { usePromoteCopy } from "./usePromoteCopy";

export { adStepInUse, emptyVersion, type AdStepInUse, type AdStepValue, type AdVersionValue } from "./creative-helpers";

const CropTool = lazy(() => import("./CropTool"));

export const AD_STEP_TEST_IDS = {
  root: "ad-step",
  sources: "ad-source-tabs",
  addTall: "ad-add-tall",
  crop: "ad-crop",
  addVersion: "ad-add-version",
  more: "ad-more",
  cta: "ad-cta-select",
  usePost: "ad-use-post",
} as const;

export const initialAdStep = (): AdStepValue => ({ source: "image", versions: [emptyVersion()], cards: [emptyCard(), emptyCard()], ctaType: null });

export type AdStepProps = {
  value: AdStepValue;
  onChange: (value: AdStepValue) => void;
  goal: GoalKey;
  /** The chosen positions; empty means Automatic. */
  placements: readonly PlacementKey[];
  hasInstagramIdentity: boolean;
  /** PromoteAccess.video is not 'off' (D21). */
  videoEnabled: boolean;
  /** "Use a post": go to Boost step 1. */
  onUsePost: () => void;
  /** Lead form ads have one form for every carousel card. */
  linkMode?: "link" | "lead_form" | "none";
  lang?: PromoteLang;
  className?: string;
};

type CropTarget = { version: number; slot: "feed" | "vertical"; src: string; ratio: CropRatio; ratios: CropRatio[] };

/** A secondary button whose long label wraps at 360 px instead of overflowing ("Add a tall version (9:16) for Stories and Reels"). */
const wrapButton = cn(
  "inline-flex min-h-10 max-w-full items-center justify-center rounded-full px-4 py-2 text-left text-sm font-semibold transition-colors duration-(--dur-fast) pointer-coarse:min-h-11",
  buttonVariants.secondary,
);

export function AdStep({ value, onChange, goal, placements, hasInstagramIdentity, videoEnabled, onUsePost, linkMode = "link", lang = "en", className }: AdStepProps) {
  const t = usePromoteCopy(lang);
  const ctaId = useId();
  const tabs = adSourceTabs(videoEnabled);
  const [postOpen, setPostOpen] = useState(false);
  const [active, setActive] = useState(0);
  const [crop, setCrop] = useState<CropTarget | null>(null);
  const [tallVideoOpen, setTallVideoOpen] = useState(false);

  // Async writes (a crop sent to Meta, a status poll) start from the value as it is when they land, not when they began.
  const latest = useRef({ value, onChange });
  useEffect(() => {
    latest.current = { value, onChange };
  });

  const view = adStepView(value, { active, postOpen }, videoEnabled);
  const { kind, format, versionIndex, letter, feed, vertical } = view;

  // A source that isn't offered (a saved video draft while PROMOTE_VIDEO is off) becomes the one shown, so the draft saves
  // what the member sees.
  useEffect(() => {
    const { value: v, onChange: change } = latest.current;
    if (view.source !== v.source) change({ ...v, source: view.source });
  }, [view.source, value.source]);

  const setVersion = (i: number, patch: Partial<AdVersionValue>) => {
    const { value: v, onChange: change } = latest.current;
    change(patchVersion(v, i, patch));
  };
  const selectTab = (id: AdSource) => {
    if (id === "post") {
      setPostOpen(true);
      return;
    }
    setPostOpen(false);
    if (id !== value.source) onChange({ ...value, source: id });
  };
  const addVersion = () => {
    if (!canAddVersion(value.versions.length)) return;
    const a = value.versions[0] ?? emptyVersion();
    onChange({ ...value, versions: [...value.versions, { feed: a.feed, vertical: a.vertical, text: { ...a.text } }] });
    setActive(value.versions.length);
  };
  const removeVersion = (i: number) => {
    if (i === 0) return;
    onChange({ ...value, versions: value.versions.filter((_, j) => j !== i) });
    setActive(0);
  };

  const onCropped = async (r: CropResult) => {
    const target = crop;
    if (!target) return;
    // Cropping is the member's tap that sends the file to Meta (D34); an error shows inside CropTool.
    const media = await prepareAdMedia({ from: "crop", key: r.key }, placements, "single_image");
    setVersion(target.version, target.slot === "feed" ? { feed: media } : { vertical: media });
    setCrop(null);
  };

  const showTallAdd = needsTallVersion(feed, vertical, placements) && !(kind === "video" && tallVideoOpen);
  const feedActions = feed ? (
    <>
      {kind === "image" && (
        <Button type="button" variant="secondary" className="pointer-coarse:min-h-11" onClick={() => setCrop({ version: versionIndex, slot: "feed", src: mediaFileUrl(feed), ratio: "4:5", ratios: ["4:5", "1:1"] })} data-testid={AD_STEP_TEST_IDS.crop}>
          {t("ad.crop")}
        </Button>
      )}
      {showTallAdd && (
        <button
          type="button"
          className={wrapButton}
          onClick={() => (kind === "image" ? setCrop({ version: versionIndex, slot: "vertical", src: mediaFileUrl(feed), ratio: "9:16", ratios: ["9:16"] }) : setTallVideoOpen(true))}
          data-testid={AD_STEP_TEST_IDS.addTall}
        >
          {t("ad.tall.add")}
        </button>
      )}
    </>
  ) : null;

  const showTallPicker = !!vertical || (kind === "video" && tallVideoOpen);
  const tallPicker = showTallPicker ? (
    <MediaPicker
      kind={kind}
      format={format}
      placements={placements}
      value={vertical}
      onChange={(m) => setVersion(versionIndex, { vertical: m })}
      label={t("ad.tall.label")}
      hint={kind === "video" ? t("ad.tall.video_note") : undefined}
      lang={lang}
      actions={
        <Button
          type="button"
          variant="ghost"
          className="pointer-coarse:min-h-11"
          onClick={() => {
            setTallVideoOpen(false);
            setVersion(versionIndex, { vertical: null });
          }}
        >
          {t("ad.tall.remove")}
        </Button>
      }
    />
  ) : null;

  const versions =
    value.versions.length > 1 ? (
      <div className="flex flex-col gap-2">
        <div role="group" aria-label={t("card.fact.versions")} className="flex flex-wrap items-center gap-2">
          {value.versions.map((_, i) => {
            const on = i === versionIndex;
            return (
              <button
                key={VERSION_LETTERS[i]}
                type="button"
                aria-pressed={on}
                onClick={() => setActive(i)}
                className={cn(
                  "min-h-11 rounded-full border px-4 text-sm font-medium transition-colors duration-(--dur-fast)",
                  on ? "border-accent-ink bg-raised text-foreground shadow-raised" : "border-border text-muted hover:text-foreground",
                )}
              >
                {t("ad.version", { letter: VERSION_LETTERS[i] })}
              </button>
            );
          })}
          {versionIndex > 0 && (
            <Button type="button" variant="ghost" className="pointer-coarse:min-h-11" onClick={() => removeVersion(versionIndex)}>
              {t("ad.version.remove", { letter })}
            </Button>
          )}
        </div>
        <p className="text-xs text-muted">{t("ad.version.note")}</p>
      </div>
    ) : null;

  const addVersionRow = canAddVersion(value.versions.length) ? (
    <Button type="button" variant="secondary" className="self-start pointer-coarse:min-h-11" onClick={addVersion} data-testid={AD_STEP_TEST_IDS.addVersion}>
      {t("version.add")}
    </Button>
  ) : (
    <p className="text-xs text-muted">{t("ad.version.limit")}</p>
  );

  // Both editors read and write the same version's text: view.textIndex (version A on a carousel).
  const singleEditor = (
    <div className="flex min-w-0 flex-col gap-5">
      {versions}
      <MediaPicker
        key={`${kind}-${versionIndex}`}
        kind={kind}
        format={format}
        placements={placements}
        value={feed}
        onChange={(m) => setVersion(versionIndex, { feed: m })}
        label={value.versions.length > 1 ? `${t(kind === "image" ? "ad.picture" : "ad.source.video")} · ${t("ad.version", { letter })}` : t(kind === "image" ? "ad.picture" : "ad.source.video")}
        actions={feedActions}
        lang={lang}
      />
      {tallPicker}
      <CopyFields value={view.text} onChange={(text) => setVersion(view.textIndex, { text })} placements={placements} hasInstagramIdentity={hasInstagramIdentity} format={format} lang={lang} />
      {addVersionRow}
    </div>
  );

  const carouselEditor = (
    <div className="flex min-w-0 flex-col gap-5">
      <CarouselEditor cards={value.cards} onChange={(cards) => onChange({ ...value, cards })} placements={placements} linkMode={linkMode} lang={lang} />
      <CopyFields value={view.text} onChange={(text) => setVersion(view.textIndex, { text })} placements={placements} hasInstagramIdentity={hasInstagramIdentity} format="carousel" showHeadline={false} lang={lang} />
    </div>
  );

  const postPanel = (
    <div className="flex flex-col items-start gap-3">
      <p className="text-sm text-muted">{t("ad.source.post_note")}</p>
      <Button type="button" className="pointer-coarse:min-h-11" onClick={onUsePost} data-testid={AD_STEP_TEST_IDS.usePost}>
        {t("ad.source.post_button")}
      </Button>
    </div>
  );

  const options = ctaOptions(goal, lang);

  return (
    <section className={cn("flex min-w-0 flex-col gap-5", className)} data-testid={AD_STEP_TEST_IDS.root}>
      <div data-testid={AD_STEP_TEST_IDS.sources}>
        <Tabs
          variant="pill"
          label={t("ad.source.label")}
          value={view.tab}
          onChange={(id) => selectTab(id as AdSource)}
          tabs={tabs.map((id) => ({ id, label: t(AD_SOURCE_KEYS[id]), content: id === "post" ? postPanel : id === "carousel" ? carouselEditor : singleEditor }))}
        />
      </div>

      {view.tab !== "post" && options.length > 0 && (
        <details className="rounded-card border border-border p-3" data-testid={AD_STEP_TEST_IDS.more}>
          <summary className="flex min-h-11 cursor-pointer items-center text-sm font-medium">{t("more.title")}</summary>
          <div className="mt-3 flex flex-col gap-1.5">
            <label htmlFor={ctaId} className="text-sm font-medium">
              {t("more.cta")}
            </label>
            <Select
              id={ctaId}
              value={value.ctaType && options.some((o) => o.type === value.ctaType) ? value.ctaType : options[0].type}
              onChange={(e) => onChange({ ...value, ctaType: e.target.value === options[0].type ? null : e.target.value })}
              data-testid={AD_STEP_TEST_IDS.cta}
            >
              {options.map((o) => (
                <option key={o.type} value={o.type}>
                  {o.label}
                </option>
              ))}
            </Select>
          </div>
        </details>
      )}

      {crop && (
        <Dialog title={t("crop.title")} onClose={() => setCrop(null)} size="md">
          <Suspense fallback={<Spinner label={t("crop.title")} />}>
            <CropTool src={crop.src} ratio={crop.ratio} ratios={crop.ratios} lang={lang} onCancel={() => setCrop(null)} onCropped={onCropped} />
          </Suspense>
        </Dialog>
      )}
    </section>
  );
}

export default AdStep;
