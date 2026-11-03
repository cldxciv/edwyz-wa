import { siteUrl } from "@/lib/config";
import { MEDIA_KEY_PATTERN } from "@/lib/content/limits";
import { prisma } from "@/lib/db";
import { HttpError } from "@/lib/tenancy";
import type { CreativeInput } from "./types";

/** A signed link lasts at most 7 days (creative/signed.ts). Ads are created at launch, so the link is re-signed then. */
const LINK_TTL_SECONDS = 24 * 3600;

const publicPrefix = () => `${siteUrl()}/api/creative/public/`;

/** Meta ad pictures are JPG or PNG (docs: ad image formats). SVG placeholders and WebP pictures are never sent. */
const AD_PICTURE = /\.(jpe?g|png)$/i;

/** Why a saved picture cannot be an ad picture: a built-in placeholder (SVG), or a format Meta does not take (WebP and others). */
export type AssetImageProblem = "placeholder" | "format";

export function assetImageProblem(asset: { kind: string; storageKey: string | null }): AssetImageProblem | null {
  if (asset.kind !== "image" || !asset.storageKey) return null;
  if (asset.storageKey.toLowerCase().endsWith(".svg")) return "placeholder";
  return AD_PICTURE.test(asset.storageKey) ? null : "format";
}

/** Only a stored JPG or PNG becomes an ad image. */
export function usableAssetImage(asset: { kind: string; storageKey: string | null }): boolean {
  return asset.kind === "image" && !!asset.storageKey && AD_PICTURE.test(asset.storageKey);
}

/** A media library key that can be an ad picture: a stored JPEG or PNG (videos are not ad pictures here). */
export function isAdPictureKey(key: unknown): key is string {
  return typeof key === "string" && MEDIA_KEY_PATTERN.test(key) && /\.(jpg|png)$/.test(key);
}

async function sign(tenantId: string, assetId: string): Promise<string> {
  try {
    const { signedAssetUrl } = await import("@/lib/creative");
    return signedAssetUrl(tenantId, assetId, LINK_TTL_SECONDS);
  } catch {
    throw new HttpError(409, "Picture links are not set up on this server, so a saved picture cannot be used in an ad yet. Paste a picture link instead.");
  }
}

/** The public link Meta fetches for a saved picture, or null when the creative has no usable picture of its own. */
export async function assetImageUrl(tenantId: string, asset: { id: string; kind: string; storageKey: string | null }): Promise<string | null> {
  return usableAssetImage(asset) ? sign(tenantId, asset.id) : null;
}

/**
 * The short-lived public link Meta fetches for a media library picture. Refuses when the file is gone (deleted from the
 * library after the draft was saved) or links cannot be signed on this server.
 */
export async function mediaImageUrl(tenantId: string, key: string): Promise<string> {
  if (!isAdPictureKey(key)) throw new HttpError(400, "Choose a JPG or PNG picture for your ad.");
  const { mediaExists, mediaPublicUrl } = await import("@/lib/content/media");
  if (!(await mediaExists(tenantId, key))) throw new HttpError(409, "The picture for this ad is no longer in your media library. Edit the draft and choose another picture.");
  try {
    return mediaPublicUrl(tenantId, key);
  } catch {
    throw new HttpError(409, "Picture links are not set up on this server, so a library picture cannot be used in an ad yet. Paste a picture link instead.");
  }
}

/**
 * At launch: a picture from the media library or a saved creative gets a fresh signed link (a draft may wait longer than a
 * link lasts); anything the user typed is left alone.
 */
export async function withFreshAssetImage(tenantId: string, creativeAssetId: string | null, creative: CreativeInput): Promise<CreativeInput> {
  if (creative.mediaKey && !creative.imageHash) return { ...creative, imageUrl: await mediaImageUrl(tenantId, creative.mediaKey) };
  if (!creativeAssetId || !creative.imageUrl?.startsWith(publicPrefix())) return creative;
  const asset = await prisma.creativeAsset.findFirst({ where: { id: creativeAssetId, tenantId }, select: { id: true, kind: true, storageKey: true } });
  const url = asset ? await assetImageUrl(tenantId, asset) : null;
  return url ? { ...creative, imageUrl: url } : creative;
}
