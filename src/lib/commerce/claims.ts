import { prisma } from "@/lib/db";

export const claimKey = (shopDomain: string) => `shopify:claim:${shopDomain}`;

export const isUniqueViolation = (e: unknown) => (e as { code?: string } | null)?.code === "P2002";

type Claim = { tenantId?: string; storeId?: string };

const PENDING = "pending_verification";
const MAX_CLAIM_ATTEMPTS = 3;

/**
 * One workspace at a time holds the verified store for a shop domain. The claim is a PlatformSetting row whose key is the domain, so the
 * primary key makes the create atomic. Callers claim only after proving they control the shop (verifyShopOwnership), so an unverified
 * connection never blocks the real owner. A claim whose store is gone, disabled or deleted is stale and is replaced (a store that is
 * still being activated counts as live).
 *
 * takeover: a caller that has just proved control with a valid Admin API token replaces a live claim held by another store. Only someone
 * with admin access to the shop can obtain such a token, so the newest proof wins; this is how a merchant recovers the domain from an
 * ex-agency or former workspace. The displaced store is demoted by demoteUnverified and must prove control again. Returns true when the
 * caller now holds the claim.
 */
export async function claimShopDomain(shopDomain: string, tenantId: string, storeId: string, options: { takeover?: boolean } = {}): Promise<boolean> {
  const key = claimKey(shopDomain);
  for (let attempt = 0; attempt < MAX_CLAIM_ATTEMPTS; attempt++) {
    try {
      await prisma.platformSetting.create({ data: { key, value: { tenantId, storeId, at: new Date().toISOString() } } });
      return true;
    } catch (e) {
      if (!isUniqueViolation(e)) throw e;
    }
    const row = await prisma.platformSetting.findUnique({ where: { key } });
    if (!row) continue;
    const held = (row.value ?? {}) as Claim;
    if (held.tenantId === tenantId && held.storeId === storeId) return true;
    if (!options.takeover) {
      const holder =
        held.storeId && held.tenantId
          ? await prisma.shopifyStore.findFirst({ where: { id: held.storeId, tenantId: held.tenantId, shopDomain, status: { in: ["active", PENDING] } }, select: { id: true } })
          : null;
      if (holder) return false;
    }
    await prisma.platformSetting.deleteMany({ where: held.storeId ? { key, value: { path: ["storeId"], equals: held.storeId } } : { key } });
  }
  return false;
}

/** True while the claim row for the domain still names this store (a concurrent takeover may have replaced it). */
export async function holdsClaim(shopDomain: string, storeId: string): Promise<boolean> {
  const row = await prisma.platformSetting.findUnique({ where: { key: claimKey(shopDomain) } });
  return ((row?.value ?? {}) as Claim).storeId === storeId;
}

/** Frees the domain, but only when this store is the one holding it. */
export async function releaseShopDomain(shopDomain: string, storeId: string): Promise<void> {
  await prisma.platformSetting.deleteMany({ where: { key: claimKey(shopDomain), value: { path: ["storeId"], equals: storeId } } });
}

/**
 * Active stores that predate verification, or that lost the domain to a workspace that proved control, have no claim. They go back to
 * pending_verification and stop receiving data until their owner proves control too.
 */
export async function demoteUnverified(shopDomain: string, keepStoreId: string): Promise<number> {
  const { count } = await prisma.shopifyStore.updateMany({ where: { shopDomain, status: "active", NOT: { id: keepStoreId } }, data: { status: PENDING } });
  return count;
}

/**
 * One-time (idempotent, safe to repeat) demotion of every active store that does not hold the claim for its domain, i.e. the stores that
 * became active before ownership proof existed. A store being activated takes its claim before it turns active, so a current activation
 * is never caught. Platform-wide maintenance for the worker: it reads across workspaces only to compare stores with claims and writes
 * nothing but the status of the stores it demotes. Returns how many stores were demoted.
 */
export async function demoteUnclaimedStores(limit = 500): Promise<number> {
  const active = await prisma.shopifyStore.findMany({ where: { status: "active" }, select: { id: true, tenantId: true, shopDomain: true }, orderBy: { createdAt: "asc" }, take: limit });
  if (active.length === 0) return 0;
  const claims = await prisma.platformSetting.findMany({ where: { key: { in: [...new Set(active.map((s) => claimKey(s.shopDomain)))] } }, select: { key: true, value: true } });
  const holder = new Map(claims.map((c) => [c.key, ((c.value ?? {}) as Claim).storeId]));
  let demoted = 0;
  for (const store of active) {
    if (holder.get(claimKey(store.shopDomain)) === store.id || (await holdsClaim(store.shopDomain, store.id))) continue;
    const { count } = await prisma.shopifyStore.updateMany({ where: { id: store.id, tenantId: store.tenantId, status: "active" }, data: { status: PENDING } });
    demoted += count;
  }
  return demoted;
}
