"use client";

/**
 * CropTool (docs/IG-PAGE-ADS-SPEC.md 3.4 step 2, 7.3, D21, D34): crops a picture in the browser, with a canvas, to
 *
 *   4:5 (1080x1350) for feeds, 9:16 (1080x1920) for Stories and Reels, 1:1 (1080x1080) for carousel cards,
 *
 * exports a JPEG at quality 0.9 and uploads it through /api/content/media (marked ?purpose=ad_crop, 5.5). The caller then
 * prepares the crop for Meta (POST /api/promote/media {from:'crop'}), which is the member's tap of D34.
 *
 * - Drag the picture, or use the keyboard on the crop area: arrows move (Shift for bigger moves), + and - zoom, Enter saves.
 *   Zoom buttons do the same for touch and switch users.
 * - 9:16 shows SafeZoneOverlay (Reels or Stories) and its text equivalent.
 * - Videos are never cropped here (D21: no transcoding).
 * - Lazy-loaded: AdStep imports it with React.lazy, so the canvas code is not in the route bundle (7.6).
 * - The picture must be same-origin (the content library or Creative Studio), so the canvas can read it.
 */
import { useEffect, useId, useRef, useState, type KeyboardEvent, type PointerEvent } from "react";
import { Alert, Button, buttonVariants, cn } from "@/components/ui";
import { promoteText } from "@/lib/promote/copy";
import type { PromoteLang } from "@/lib/promote/types";
import {
  applyCropKey,
  CROP_LABEL_KEYS,
  CROP_OUTPUT,
  CROP_RATIOS,
  CROP_MIME,
  CROP_ZOOM_STEP,
  CROP_MAX_ZOOM,
  cropImageStyle,
  cropPlan,
  cropRect,
  cropUpscaled,
  dragCrop,
  initialCrop,
  setCropRatio,
  zoomCrop,
  type CropRatio,
  type CropState,
  type SafeZoneGroup,
  type Size,
} from "./creative-helpers";
import { uploadToLibrary } from "./MediaPicker";
import { SafeZoneLegend, SafeZoneOverlay } from "./SafeZoneOverlay";

export const CROP_TEST_IDS = { root: "crop-tool", area: "crop-area", save: "crop-save", cancel: "crop-cancel", zoomIn: "crop-zoom-in", zoomOut: "crop-zoom-out" } as const;

export type CropResult = { key: string; ratio: CropRatio; width: number; height: number };

export type CropToolProps = {
  /** A same-origin address of the picture (content library or Creative Studio). */
  src: string;
  /** The shape to start with. */
  ratio?: CropRatio;
  /** The shapes the member may pick; one shape hides the choice. */
  ratios?: readonly CropRatio[];
  onCancel: () => void;
  /** Called with the uploaded crop's library key. */
  onCropped: (result: CropResult) => void | Promise<void>;
  /** Injected in tests; defaults to the content media upload with ?purpose=ad_crop. */
  upload?: (blob: Blob) => Promise<{ key: string }>;
  lang?: PromoteLang;
};

// CROP_MIME at CROP_UPLOAD_PATH: the content media library, marked as an ad crop (5.5).
const defaultUpload = (blob: Blob) => uploadToLibrary(blob, CROP_MIME, { adCrop: true });

const choiceClass = (on: boolean) =>
  cn(
    "min-h-11 rounded-full border px-3 text-xs font-medium transition-colors duration-(--dur-fast)",
    on ? "border-accent-ink bg-raised text-foreground shadow-raised" : "border-border text-muted hover:text-foreground",
  );

/** Draws the crop onto a canvas of the exact output size and returns the JPEG. */
function exportCrop(img: HTMLImageElement, size: Size, state: CropState): Promise<Blob> {
  const plan = cropPlan(size, state);
  const canvas = document.createElement("canvas");
  canvas.width = plan.output.width;
  canvas.height = plan.output.height;
  const ctx = canvas.getContext("2d");
  if (!ctx) return Promise.reject(new Error("canvas"));
  // JPEG has no transparency: a transparent PNG gets white behind it instead of black.
  ctx.fillStyle = "white";
  ctx.fillRect(0, 0, plan.output.width, plan.output.height);
  ctx.imageSmoothingQuality = "high";
  ctx.drawImage(img, plan.source.x, plan.source.y, plan.source.width, plan.source.height, 0, 0, plan.output.width, plan.output.height);
  return new Promise((resolve, reject) => canvas.toBlob((b) => (b ? resolve(b) : reject(new Error("blob"))), plan.mime, plan.quality));
}

export function CropTool({ src, ratio = "4:5", ratios = CROP_RATIOS, onCancel, onCropped, upload = defaultUpload, lang = "en" }: CropToolProps) {
  const uid = useId();
  const keysId = `${uid}-keys`;
  const imgRef = useRef<HTMLImageElement>(null);
  const areaRef = useRef<HTMLDivElement>(null);
  const drag = useRef<{ id: number; x: number; y: number } | null>(null);
  const [size, setSize] = useState<Size | null>(null);
  const [crop, setCrop] = useState<CropState | null>(null);
  const [loadFailed, setLoadFailed] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [zone, setZone] = useState<SafeZoneGroup>("reels");
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);

  // A picture already in the browser cache may finish loading before React attaches onLoad.
  useEffect(() => {
    const img = imgRef.current;
    if (img && img.complete && img.naturalWidth > 0 && !size) {
      const s = { width: img.naturalWidth, height: img.naturalHeight };
      setSize(s);
      setCrop(initialCrop(s, ratio));
    }
  }, [ratio, size]);

  const t = (key: Parameters<typeof promoteText>[0], vars?: Parameters<typeof promoteText>[1]) => promoteText(key, vars ?? {}, lang);
  const shape = crop?.ratio ?? ratio;
  const out = CROP_OUTPUT[shape];
  const rect = size && crop ? cropRect(size, crop) : null;

  async function save() {
    if (!size || !crop || !imgRef.current || saving) return;
    setSaving(true);
    setError(null);
    try {
      const blob = await exportCrop(imgRef.current, size, crop);
      const { key } = await upload(blob);
      await onCropped({ key, ratio: crop.ratio, ...CROP_OUTPUT[crop.ratio] });
    } catch (e) {
      if (mounted.current) setError(e instanceof Error && e.message && !["canvas", "blob"].includes(e.message) ? e.message : t("crop.failed"));
    } finally {
      if (mounted.current) setSaving(false);
    }
  }

  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    if (!size || !crop) return;
    const r = applyCropKey(size, crop, e.key, e.shiftKey);
    if (!r.handled) return;
    e.preventDefault();
    e.stopPropagation();
    if (r.confirm) void save();
    else setCrop(r.state);
  };

  const onPointerDown = (e: PointerEvent<HTMLDivElement>) => {
    if (!size || !crop || saving) return;
    drag.current = { id: e.pointerId, x: e.clientX, y: e.clientY };
    e.currentTarget.setPointerCapture?.(e.pointerId);
  };
  const onPointerMove = (e: PointerEvent<HTMLDivElement>) => {
    const d = drag.current;
    if (!d || d.id !== e.pointerId || !size) return;
    const dx = e.clientX - d.x;
    const dy = e.clientY - d.y;
    drag.current = { id: d.id, x: e.clientX, y: e.clientY };
    const width = areaRef.current?.clientWidth ?? 0;
    setCrop((c) => (c ? dragCrop(size, c, dx, dy, width) : c));
  };
  const endDrag = () => {
    drag.current = null;
  };

  const zoom = (factor: number) => size && setCrop((c) => (c ? zoomCrop(size, c, factor) : c));

  return (
    <div className="flex min-w-0 flex-col gap-4" data-testid={CROP_TEST_IDS.root}>
      {ratios.length > 1 && (
        <div role="group" aria-label={t("crop.shape")} className="flex flex-wrap gap-2">
          {ratios.map((r) => (
            <button key={r} type="button" aria-pressed={shape === r} className={choiceClass(shape === r)} onClick={() => size && crop && setCrop(setCropRatio(size, crop, r))} disabled={!size || saving}>
              {t(CROP_LABEL_KEYS[r])}
            </button>
          ))}
        </div>
      )}

      <div
        ref={areaRef}
        role="application"
        aria-roledescription={t("crop.title")}
        aria-label={t("crop.area", { shape: t(CROP_LABEL_KEYS[shape]) })}
        aria-describedby={keysId}
        aria-busy={saving || undefined}
        tabIndex={0}
        data-autofocus
        data-testid={CROP_TEST_IDS.area}
        onKeyDown={onKeyDown}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={endDrag}
        onPointerCancel={endDrag}
        className={cn("relative mx-auto w-full touch-none overflow-hidden rounded-control border border-border-strong bg-surface-2 select-none", shape === "9:16" ? "max-w-64" : "max-w-sm", size ? "cursor-grab active:cursor-grabbing" : undefined)}
        style={{ aspectRatio: `${out.width} / ${out.height}` }}
      >
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img
          ref={imgRef}
          src={src}
          alt=""
          draggable={false}
          onLoad={(e) => {
            const s = { width: e.currentTarget.naturalWidth, height: e.currentTarget.naturalHeight };
            setSize(s);
            setCrop((c) => c ?? initialCrop(s, ratio));
          }}
          onError={() => setLoadFailed(true)}
          className={cn("pointer-events-none absolute max-w-none", !rect && "invisible")}
          style={size && rect ? cropImageStyle(size, rect) : undefined}
        />
        {shape === "9:16" && <SafeZoneOverlay group={zone} lang={lang} announce={false} />}
      </div>

      <p id={keysId} className="text-xs text-muted">
        {t("crop.keys")}
      </p>

      <div className="flex flex-wrap items-center gap-2">
        <Button type="button" variant="secondary" className="pointer-coarse:min-h-11" onClick={() => zoom(1 / CROP_ZOOM_STEP)} disabled={!crop || crop.zoom <= 1 || saving} data-testid={CROP_TEST_IDS.zoomOut}>
          <span aria-hidden>−</span> {t("crop.zoom_out")}
        </Button>
        <Button type="button" variant="secondary" className="pointer-coarse:min-h-11" onClick={() => zoom(CROP_ZOOM_STEP)} disabled={!crop || crop.zoom >= CROP_MAX_ZOOM || saving} data-testid={CROP_TEST_IDS.zoomIn}>
          <span aria-hidden>+</span> {t("crop.zoom_in")}
        </Button>
      </div>

      {shape === "9:16" && (
        <div className="flex flex-col gap-2">
          <div role="group" aria-label={t("crop.zone")} className="flex flex-wrap items-center gap-2">
            <span className="text-xs font-medium text-muted" aria-hidden>
              {t("crop.zone")}
            </span>
            {(["reels", "stories"] as const).map((g) => (
              <button key={g} type="button" aria-pressed={zone === g} className={choiceClass(zone === g)} onClick={() => setZone(g)}>
                {t(g === "reels" ? "crop.zone.reels" : "crop.zone.stories")}
              </button>
            ))}
          </div>
          <SafeZoneLegend group={zone} lang={lang} />
        </div>
      )}

      {size && crop && cropUpscaled(size, crop) && <Alert tone="warn">{t("crop.small", { width: out.width, height: out.height })}</Alert>}
      {loadFailed && <Alert tone="bad">{t("crop.load_failed")}</Alert>}

      <p aria-live="polite" className="sr-only">
        {saving ? t("crop.saving") : ""}
      </p>
      {error && (
        <p role="alert" className="text-sm font-medium text-bad-fg">
          {error}
        </p>
      )}

      <div className="flex flex-col-reverse gap-2 sm:flex-row sm:justify-end">
        <button type="button" className={cn("inline-flex min-h-11 items-center justify-center rounded-full px-5 text-sm font-semibold transition-colors duration-(--dur-fast)", buttonVariants.ghost)} onClick={onCancel} disabled={saving} data-testid={CROP_TEST_IDS.cancel}>
          {t("card.cancel")}
        </button>
        <Button type="button" size="lg" loading={saving} disabled={!crop || loadFailed} onClick={() => void save()} data-testid={CROP_TEST_IDS.save}>
          {t("crop.save")}
        </Button>
      </div>
    </div>
  );
}

export default CropTool;
