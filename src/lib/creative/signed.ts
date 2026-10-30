import { createHmac, timingSafeEqual } from "node:crypto";
import { siteUrl } from "@/lib/config";
import { HttpError } from "@/lib/tenancy";
import { mediaSigningSecret } from "./secret";

const ID = /^[A-Za-z0-9_-]{1,64}$/;
export const MAX_TTL_SECONDS = 7 * 24 * 3600;

const secret = () => mediaSigningSecret("CREATIVE_MEDIA_SECRET");

const mac = (tenantId: string, assetId: string, exp: number) => createHmac("sha256", secret()).update(`creative:${tenantId}:${assetId}:${exp}`).digest("hex");

/** Short-lived https URL for a stored asset, bound to the tenant and asset. The file is only served if the asset row still belongs to that tenant. */
export function signedAssetUrl(tenantId: string, assetId: string, ttlSeconds = 3600, now = Date.now()): string {
  if (!ID.test(tenantId) || !ID.test(assetId)) throw new HttpError(400, "Invalid asset reference.");
  const ttl = Math.min(Math.max(Math.floor(ttlSeconds), 1), MAX_TTL_SECONDS);
  const exp = Math.floor(now / 1000) + ttl;
  return `${siteUrl()}/api/creative/public/${tenantId}/${assetId}?exp=${exp}&sig=${mac(tenantId, assetId, exp)}`;
}

/** Throws HttpError(403) for tampered or expired signatures. */
export function verifySignedAsset(tenantId: string, assetId: string, expRaw: string | null, sig: string | null, now = Date.now()): void {
  const exp = Number(expRaw);
  if (!ID.test(tenantId) || !ID.test(assetId) || !Number.isInteger(exp) || !sig || !/^[0-9a-f]{64}$/.test(sig)) throw new HttpError(403, "Invalid link.");
  const a = Buffer.from(mac(tenantId, assetId, exp), "hex");
  const b = Buffer.from(sig, "hex");
  if (a.length !== b.length || !timingSafeEqual(a, b)) throw new HttpError(403, "Invalid link.");
  if (exp * 1000 < now) throw new HttpError(403, "This link has expired.");
  if (exp * 1000 > now + MAX_TTL_SECONDS * 1000) throw new HttpError(403, "Invalid link.");
}
