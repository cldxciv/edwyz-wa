import { prisma } from "@/lib/db";

export type ConversionSettings = { enabled: boolean; datasetAssetId: string | null };

const settingKey = (tenantId: string) => `conversions:${tenantId}`;

export async function getConversionSettings(tenantId: string): Promise<ConversionSettings> {
  const row = await prisma.platformSetting.findUnique({ where: { key: settingKey(tenantId) } });
  const value = (row?.value ?? {}) as { enabled?: unknown; datasetAssetId?: unknown };
  return {
    enabled: value.enabled !== false,
    datasetAssetId: typeof value.datasetAssetId === "string" && value.datasetAssetId ? value.datasetAssetId : null,
  };
}

export async function saveConversionSettings(tenantId: string, settings: ConversionSettings): Promise<void> {
  const value = { enabled: settings.enabled, datasetAssetId: settings.datasetAssetId };
  await prisma.platformSetting.upsert({ where: { key: settingKey(tenantId) }, create: { key: settingKey(tenantId), value }, update: { value } });
}
