import { errorResponse } from "@/lib/tenancy";
import { readActor, writeActor, readJson, type Ctx } from "@/lib/creative/http";
import { readAssetFile } from "@/lib/creative/service";

export const dynamic = "force-dynamic";

/** Authenticated file download. Tenant-checked through the asset row; the storage key never comes from the URL. */
export async function GET(request: Request, { params }: Ctx) {
  try {
    const actor = await readActor(request);
    const { data, contentType } = await readAssetFile(actor.tenantId, (await params).id);
    return new Response(new Uint8Array(data), {
      headers: {
        "content-type": contentType,
        "content-security-policy": "default-src 'none'; style-src 'unsafe-inline'; sandbox",
        "x-content-type-options": "nosniff",
        "cache-control": "private, max-age=300",
      },
    });
  } catch (e) {
    return errorResponse(e);
  }
}
