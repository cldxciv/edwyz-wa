import { siteUrl } from "@/lib/config";
import { prisma } from "@/lib/db";
import { HttpError } from "@/lib/tenancy";
import type { CreativeInput } from "./types";

/** A signed link lasts at most 7 days (creative/signed.ts). Ads are created at launch, so the link is re-signed then. */
const LINK_TTL_SECONDS = 24 * 3600;

const publicPrefix = () => `${siteUrl()}/api/creative/public/`;

/** Meta cannot use SVG, so the built-in placeholder pictures never become an ad image. */
export function usableAssetImage(asset: { kind: string; storageKey: string | null }): boolean {
  return asset.kind === "image" && !!asset.storageKey && !asset.storageKey.endsWith(".svg");
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

/** At launch: a picture that came from a saved creative gets a fresh signed link; anything the user typed is left alone. */
export async function withFreshAssetImage(tenantId: string, creativeAssetId: string | null, creative: CreativeInput): Promise<CreativeInput> {
  if (!creativeAssetId || !creative.imageUrl?.startsWith(publicPrefix())) return creative;
  const asset = await prisma.creativeAsset.findFirst({ where: { id: creativeAssetId, tenantId }, select: { id: true, kind: true, storageKey: true } });
  const url = asset ? await assetImageUrl(tenantId, asset) : null;
  return url ? { ...creative, imageUrl: url } : creative;
}
