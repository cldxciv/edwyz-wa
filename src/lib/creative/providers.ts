import { meteredProvider, type AiRef } from "@/lib/spend/exec/ai";
import type { SpendActor } from "@/lib/spend/types";
import { HttpError } from "@/lib/tenancy";
import { CREDIT_COST } from "@/lib/usage";
import { PLACEMENT_SIZES, type Placement } from "./constants";
import { createHttpImageProvider } from "./http-image";

export type ImageRequest = { brandName: string; colors: string[]; headline: string; subline?: string; placement: Placement; prompt?: string };
/** fallback is true when a metered provider could not deliver and this file is the free placeholder instead: nothing is charged for it. */
export type GeneratedFile = { data: Buffer; contentType: string; ext: string; fallback?: boolean };

export interface ImageProvider {
  name: string;
  /** Metered providers cost AI credits (CREDIT_COST.image); the built-in placeholder does not. */
  metered: boolean;
  generate(req: ImageRequest): Promise<GeneratedFile>;
}

export interface VideoProvider {
  name: string;
  metered: boolean;
  generate(req: ImageRequest & { seconds: number }): Promise<GeneratedFile>;
}

const HEX = /^#[0-9a-fA-F]{6}$/;
const xmlEscape = (s: string) => s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);

function wrap(text: string, maxChars: number, maxLines: number): string[] {
  const lines: string[] = [];
  let line = "";
  for (const word of text.replace(/[\u0000-\u001f]/g, " ").split(/\s+/).filter(Boolean)) {
    if (line && (line + " " + word).length > maxChars) {
      lines.push(line);
      line = word;
    } else line = line ? line + " " + word : word;
  }
  if (line) lines.push(line);
  if (lines.length > maxLines) {
    const kept = lines.slice(0, maxLines);
    kept[maxLines - 1] = kept[maxLines - 1].slice(0, Math.max(0, maxChars - 1)) + "…";
    return kept;
  }
  return lines;
}

function pickColors(colors: string[]): { bg: string; fg: string } {
  const valid = colors.filter((c) => HEX.test(c));
  const bg = valid[0] ?? "#1f2a44";
  const r = parseInt(bg.slice(1, 3), 16), g = parseInt(bg.slice(3, 5), 16), b = parseInt(bg.slice(5, 7), 16);
  const light = (r * 299 + g * 587 + b * 114) / 1000 > 150;
  return { bg, fg: valid[1] && valid[1] !== bg ? valid[1] : light ? "#111111" : "#ffffff" };
}

/** Pure function: all user text is XML-escaped and colours are validated hex, so the SVG carries no script or external reference. */
export function renderPlaceholderSvg(req: ImageRequest): string {
  const { width, height } = PLACEMENT_SIZES[req.placement];
  const { bg, fg } = pickColors(req.colors);
  const size = Math.round(width * 0.075);
  const lines = wrap(req.headline, Math.floor((width * 0.84) / (size * 0.55)), 6);
  const startY = Math.round(height / 2 - ((lines.length - 1) * size * 1.2) / 2);
  const tspans = lines.map((l, i) => `<text x="${width / 2}" y="${startY + Math.round(i * size * 1.2)}" text-anchor="middle" font-size="${size}" font-weight="700" fill="${fg}" font-family="Arial, Helvetica, sans-serif">${xmlEscape(l)}</text>`).join("");
  const brand = xmlEscape(req.brandName.slice(0, 40));
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}"><rect width="100%" height="100%" fill="${bg}"/><rect x="${width * 0.06}" y="${width * 0.06}" width="${width * 0.88}" height="${height - width * 0.12}" fill="none" stroke="${fg}" stroke-opacity="0.35" stroke-width="4"/>${tspans}<text x="${width / 2}" y="${height - width * 0.1}" text-anchor="middle" font-size="${Math.round(size * 0.5)}" fill="${fg}" fill-opacity="0.85" font-family="Arial, Helvetica, sans-serif">${brand}</text><text x="${width * 0.08}" y="${width * 0.11}" font-size="${Math.round(size * 0.36)}" fill="${fg}" fill-opacity="0.6" font-family="Arial, Helvetica, sans-serif">PLACEHOLDER</text></svg>`;
}

export const placeholderProvider: ImageProvider = {
  name: "placeholder",
  metered: false,
  async generate(req) {
    return { data: Buffer.from(renderPlaceholderSvg(req), "utf8"), contentType: "image/svg+xml", ext: "svg" };
  },
};

const registry = new Map<string, ImageProvider>([
  ["placeholder", placeholderProvider],
  ["http", createHttpImageProvider({ fallback: placeholderProvider })],
]);

/** Slot for an external provider: register an implementation here, then select it with env CREATIVE_IMAGE_PROVIDER. */
export function registerImageProvider(p: ImageProvider): void {
  registry.set(p.name, p);
}

export function getImageProvider(name = process.env.CREATIVE_IMAGE_PROVIDER || "placeholder"): ImageProvider {
  const p = registry.get(name);
  if (!p) throw new HttpError(501, `Image provider "${name}" is not implemented yet.`);
  return p;
}

export function getVideoProvider(): VideoProvider {
  throw new HttpError(501, "Video generation is not available yet. No video provider is configured.");
}

// ===== Metered generation through the AI gateway (docs/SPEND-CONTROLS-SPEC.md 4.10) =====

/** Creative Studio is something a person asks for, so a spending stop does not stop it (decision 2.3.11). */
export const CREATIVE_ACTOR: SpendActor = Object.freeze({ type: "system", job: "creative_studio" }) as SpendActor;

export type MeteredMediaCtx = {
  tenantId: string;
  /** Who asked; defaults to CREATIVE_ACTOR. An assistant actor is stopped by "Stop assistants". */
  actor?: SpendActor;
  /** The UsageLedger reference of the charge, for example { type: "creative_asset", id }. */
  ref?: AiRef | null;
};

/** What a generated file costs: nothing when the free placeholder stood in for the metered provider. */
export const mediaCharge = (cost: number) => (file: GeneratedFile) => (file.fallback ? 0 : cost);

/**
 * An image from `provider`. A metered provider runs inside the AI gateway's meteredProvider(): the image's credits are
 * held across every process first (402 ai_quota when the AI limit is used up), a failure gives them back, and a placeholder
 * fallback is charged 0. The built-in placeholder costs nothing and runs as is.
 */
export async function generateImageMetered(ctx: MeteredMediaCtx, provider: ImageProvider, req: ImageRequest): Promise<GeneratedFile> {
  if (!provider.metered) return provider.generate(req);
  return meteredProvider(
    { tenantId: ctx.tenantId, feature: "creative", actor: ctx.actor ?? CREATIVE_ACTOR, credits: CREDIT_COST.image, ref: ctx.ref ?? null },
    () => provider.generate(req),
    { charge: mediaCharge(CREDIT_COST.image) },
  );
}

/** A short video from `provider`, metered like generateImageMetered() at the video price. */
export async function generateVideoMetered(ctx: MeteredMediaCtx, provider: VideoProvider, req: ImageRequest & { seconds: number }): Promise<GeneratedFile> {
  if (!provider.metered) return provider.generate(req);
  return meteredProvider(
    { tenantId: ctx.tenantId, feature: "creative", actor: ctx.actor ?? CREATIVE_ACTOR, credits: CREDIT_COST.video, ref: ctx.ref ?? null },
    () => provider.generate(req),
    { charge: mediaCharge(CREDIT_COST.video) },
  );
}
