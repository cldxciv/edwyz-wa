import { androidPackage, assetLinkFingerprints } from "@/lib/env-rules.mjs";

/**
 * Digital Asset Links for the Android app (docs/PLAY-STORE.md): a Trusted Web Activity opens wa.edwyz.com without a browser bar
 * only when /.well-known/assetlinks.json names its package and the SHA-256 fingerprints of the keys that signed it (the upload
 * key and Google Play's app signing key). The values come from ANDROID_PACKAGE (default com.edwyz.wa) and the comma-separated
 * ANDROID_ASSETLINKS_SHA256; malformed and placeholder fingerprints are dropped by the same rules the startup check warns about
 * (src/lib/env-rules.mjs). With no valid fingerprint, or an invalid package name, there is no file: a 404, never a placeholder.
 */

export type AssetLinkStatement = {
  relation: string[];
  target: { namespace: "android_app"; package_name: string; sha256_cert_fingerprints: string[] };
};

/** How long browsers and Google's verifier may keep the file: a few minutes, so a new fingerprint is picked up quickly. */
export const ASSET_LINKS_MAX_AGE_SECONDS = 300;

/** The statements to publish, or null when the configuration does not allow publishing any. */
export function assetLinks(env: Record<string, string | undefined> = process.env): AssetLinkStatement[] | null {
  const packageName = androidPackage(env);
  const { valid } = assetLinkFingerprints(env.ANDROID_ASSETLINKS_SHA256);
  if (!packageName || valid.length === 0) return null;
  return [
    {
      relation: ["delegate_permission/common.handle_all_urls"],
      target: { namespace: "android_app", package_name: packageName, sha256_cert_fingerprints: valid },
    },
  ];
}

export function assetLinksResponse(env: Record<string, string | undefined> = process.env): Response {
  const statements = assetLinks(env);
  if (!statements) return new Response(null, { status: 404, headers: { "Cache-Control": "no-store" } });
  return new Response(JSON.stringify(statements), {
    status: 200,
    headers: { "Content-Type": "application/json", "Cache-Control": `public, max-age=${ASSET_LINKS_MAX_AGE_SECONDS}` },
  });
}
