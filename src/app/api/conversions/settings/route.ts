import { audit } from "@/lib/auth/audit";
import { assertSameOrigin } from "@/lib/auth/csrf";
import { getActor } from "@/lib/auth";
import { getConversionSettings, saveConversionSettings } from "@/lib/conversions/settings";
import { readJsonLimited } from "@/lib/http/body";
import { listAssets } from "@/lib/meta-connect";
import { HttpError, errorResponse, requireRole } from "@/lib/tenancy";

/** GET (admin or owner) -> { settings: { enabled, datasetAssetId }, datasets: [{ id, name, externalId, status }] } */
export async function GET(request: Request) {
  try {
    const actor = await getActor(request);
    requireRole(actor, "admin");
    const [settings, assets] = await Promise.all([getConversionSettings(actor.tenantId), listAssets(actor.tenantId, "dataset")]);
    const datasets = assets.map((a) => ({ id: a.id, name: a.name, externalId: a.externalId, status: a.status }));
    return Response.json({ settings, datasets });
  } catch (e) {
    return errorResponse(e);
  }
}

/** PUT { enabled: boolean, datasetAssetId: string | null } (admin or owner) -> { settings } */
export async function PUT(request: Request) {
  try {
    assertSameOrigin(request);
    const actor = await getActor(request);
    requireRole(actor, "admin");
    const body = await readJsonLimited(request, 4 * 1024);
    if (typeof body.enabled !== "boolean") throw new HttpError(400, "enabled must be true or false.");
    const datasetAssetId = body.datasetAssetId ?? null;
    if (datasetAssetId !== null && (typeof datasetAssetId !== "string" || datasetAssetId.length > 64)) throw new HttpError(400, "datasetAssetId must be a string or null.");
    if (datasetAssetId) {
      const assets = await listAssets(actor.tenantId, "dataset");
      if (!assets.some((a) => a.id === datasetAssetId)) throw new HttpError(400, "That dataset is not connected to this workspace.");
    }
    const settings = { enabled: body.enabled, datasetAssetId };
    await saveConversionSettings(actor.tenantId, settings);
    await audit({ tenantId: actor.tenantId, userId: actor.userId, action: "conversions.settings_update", meta: { enabled: settings.enabled, datasetAssetId } });
    return Response.json({ settings });
  } catch (e) {
    return errorResponse(e);
  }
}
