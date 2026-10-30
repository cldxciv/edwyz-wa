import { readAssetFile } from "@/lib/creative/service";
import { MediaSecretError } from "@/lib/creative/secret";
import { verifySignedAsset } from "@/lib/creative/signed";
import { errorResponse } from "@/lib/tenancy";

export const dynamic = "force-dynamic";

/** Public, signed and short-lived file link (see signedAssetUrl). No session: the HMAC binds tenant, asset and expiry. */
export async function GET(request: Request, { params }: { params: Promise<{ tenantId: string; assetId: string }> }) {
  try {
    const { tenantId, assetId } = await params;
    const q = new URL(request.url).searchParams;
    verifySignedAsset(tenantId, assetId, q.get("exp"), q.get("sig"));
    const { data, contentType } = await readAssetFile(tenantId, assetId);
    return new Response(new Uint8Array(data), {
      headers: {
        "content-type": contentType,
        "content-security-policy": "default-src 'none'; style-src 'unsafe-inline'; sandbox",
        "x-content-type-options": "nosniff",
        "cache-control": "private, max-age=60",
      },
    });
  } catch (e) {
    if (e instanceof MediaSecretError) {
      console.error("[creative] public link refused: the signing secret is not configured correctly");
      return new Response("Not found", { status: 404 });
    }
    return errorResponse(e);
  }
}
