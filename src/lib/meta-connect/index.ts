import { prisma } from "@/lib/db";
import { openSecret } from "@/lib/crypto/secrets";
import { HttpError } from "@/lib/tenancy";

export type AssetType = "page" | "instagram" | "ad_account" | "dataset" | "catalog" | "threads";

export type AssetAccess = { assetId: string; type: AssetType; externalId: string; name: string | null; token: string };

const USABLE = new Set(["active", "expiring"]);

/** Decrypted access for one connected asset of the tenant (MetaAsset.id). Throws HttpError(404) when the asset is not the tenant's, HttpError(409) when its connection is expired or revoked. Never log the token. */
export async function getAssetAccess(tenantId: string, assetId: string): Promise<AssetAccess> {
  const asset = await prisma.metaAsset.findFirst({ where: { id: assetId, tenantId }, include: { connection: true } });
  if (!asset || asset.connection.tenantId !== tenantId) throw new HttpError(404, "Asset not found.");
  const c = asset.connection;
  const lapsed = c.tokenExpiresAt !== null && c.tokenExpiresAt.getTime() <= Date.now();
  if (!USABLE.has(c.status) || lapsed || !c.tokenEnc) throw new HttpError(409, "The Meta connection for this asset has expired or been disconnected. Reconnect it in Settings.");
  if (asset.status !== "active") throw new HttpError(409, "This asset is no longer available on the connected Meta account.");
  const token = openSecret(tenantId, asset.tokenEnc ?? c.tokenEnc);
  return { assetId: asset.id, type: asset.type as AssetType, externalId: asset.externalId, name: asset.name, token };
}

export type AssetSummary = { id: string; type: AssetType; externalId: string; name: string | null; status: string; meta: unknown };

export async function listAssets(tenantId: string, type?: AssetType): Promise<AssetSummary[]> {
  const rows = await prisma.metaAsset.findMany({
    where: { tenantId, ...(type ? { type } : {}) },
    orderBy: [{ type: "asc" }, { name: "asc" }],
    select: { id: true, type: true, externalId: true, name: true, status: true, meta: true },
  });
  return rows.map((r) => ({ ...r, type: r.type as AssetType }));
}
