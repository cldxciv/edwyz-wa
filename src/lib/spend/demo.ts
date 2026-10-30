/**
 * The demo workspace and demo assets (docs/SPEND-CONTROLS-SPEC.md 8.4; Eddy 6.14). scripts/seed-demo.mjs marks its Meta
 * assets with `meta.demo = true` and gives the workspace a placeholder token and a fake WABA `demo-waba-<tenant>`.
 *
 * isDemoAsset() keeps every Meta call away from demo assets (no metacap reads or writes, no fast or structure sync, no
 * quality poll). isDemoWorkspace() lets every raise be refused with spend.demo ("This is a demo workspace, so nothing can be
 * spent."), the admin list label it "Demo" and the digest skip it. Real AI calls still go through the gateway and count.
 */
import { prisma } from "@/lib/db";
import type { SpendDb } from "./control";
import { SpendBlockedError } from "./errors";

/** The WABA id prefix scripts/seed-demo.mjs uses; a second signal next to meta.demo. */
export const DEMO_WABA_PREFIX = "demo-waba-";

/** True when a MetaAsset (or anything with its `meta` JSON) is a demo asset. Never throws. */
export function isDemoAsset(asset: { meta?: unknown } | null | undefined): boolean {
  const meta = asset?.meta;
  if (!meta || typeof meta !== "object" || Array.isArray(meta)) return false;
  return (meta as { demo?: unknown }).demo === true;
}

/** True when the workspace has a demo Meta asset or the seeded demo WABA. */
export async function isDemoWorkspace(tenantId: string, db: SpendDb = prisma): Promise<boolean> {
  if (!tenantId) return false;
  const asset = await db.metaAsset.findFirst({ where: { tenantId, meta: { path: ["demo"], equals: true } }, select: { id: true } });
  if (asset) return true;
  const waba = await db.waba.findFirst({ where: { tenantId, wabaId: { startsWith: DEMO_WABA_PREFIX } }, select: { id: true } });
  return !!waba;
}

/** Refuses a raise in the demo workspace with the 8.4 copy. */
export async function assertNotDemoWorkspace(tenantId: string, db: SpendDb = prisma): Promise<void> {
  if (await isDemoWorkspace(tenantId, db)) throw new SpendBlockedError("spend.demo");
}
