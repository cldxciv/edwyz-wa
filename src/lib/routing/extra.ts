import { prisma } from "@/lib/db";
import { EXTRA_KEY_PREFIX, extraKey, parseExtra, type RoutingExtra } from "./extra-config";

export * from "./extra-config";

export async function getExtra(tenantId: string): Promise<RoutingExtra> {
  const row = await prisma.platformSetting.findUnique({ where: { key: extraKey(tenantId) } });
  return parseExtra(row?.value);
}

export async function saveExtra(tenantId: string, value: RoutingExtra): Promise<void> {
  const key = extraKey(tenantId);
  await prisma.platformSetting.upsert({ where: { key }, create: { key, value }, update: { value } });
}

/** Tenants that have saved extra settings, for the worker. */
export async function tenantsWithExtra(): Promise<{ tenantId: string; extra: RoutingExtra }[]> {
  const rows = await prisma.platformSetting.findMany({ where: { key: { startsWith: EXTRA_KEY_PREFIX } }, select: { key: true, value: true }, take: 5000 });
  return rows.map((r) => ({ tenantId: r.key.slice(EXTRA_KEY_PREFIX.length), extra: parseExtra(r.value) }));
}
