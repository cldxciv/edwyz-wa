import fs from "node:fs/promises";
import path from "node:path";
import { prisma } from "@/lib/db";

export type FileStore = "creative" | "content" | "inbound-media";
export const FILE_STORES: readonly FileStore[] = ["creative", "content", "inbound-media"];

const SAFE_ID = /^[A-Za-z0-9_-]{1,64}$/;
const SAFE_CREATIVE_KEY = /^[A-Za-z0-9_-]{1,80}\.[a-z0-9]{2,5}$/;
const DAY_MS = 86_400_000;
/** Files younger than this are never treated as orphans, so an upload in progress is safe. */
export const ORPHAN_GRACE_MS = DAY_MS;
const ORPHAN_TENANTS_PER_RUN = 200;
const ORPHAN_FILES_PER_TENANT = 2000;

const dataRoot = () => path.resolve(process.env.DATA_DIR || "./data");
const storeRoot = (store: FileStore) => path.resolve(dataRoot(), store);

/** Absolute <DATA_DIR>/<store>/<tenantId>, or null unless the id is plain and the result is a direct child of the store directory. */
export function resolveTenantDir(store: FileStore, tenantId: string): string | null {
  if (!SAFE_ID.test(tenantId)) return null;
  const root = storeRoot(store);
  const dir = path.resolve(root, tenantId);
  if (path.dirname(dir) !== root || !dir.startsWith(root + path.sep)) return null;
  return dir;
}

async function insideRoot(root: string, dir: string): Promise<boolean> {
  const [realRoot, realDir] = await Promise.all([fs.realpath(root), fs.realpath(dir)]);
  return realDir.startsWith(realRoot + path.sep);
}

async function removeDir(store: FileStore, tenantId: string): Promise<number> {
  const dir = resolveTenantDir(store, tenantId);
  if (!dir) throw new Error("Unsafe workspace id for file removal.");
  const info = await fs.lstat(dir).catch(() => null);
  if (!info) return 0;
  if (info.isSymbolicLink()) {
    await fs.unlink(dir);
    return 0;
  }
  if (!info.isDirectory()) return 0;
  if (!(await insideRoot(storeRoot(store), dir))) throw new Error("Refusing to remove a directory outside the data directory.");
  const count = (await fs.readdir(dir).catch(() => [] as string[])).length;
  await fs.rm(dir, { recursive: true, force: true });
  return count;
}

/** Removes every file a workspace has under DATA_DIR/creative, DATA_DIR/content and DATA_DIR/inbound-media (cached customer media). Never touches another workspace's directory. */
export async function removeTenantFiles(tenantId: string): Promise<Record<FileStore, number>> {
  const out: Record<FileStore, number> = { creative: 0, content: 0, "inbound-media": 0 };
  for (const store of FILE_STORES) out[store] = await removeDir(store, tenantId);
  return out;
}

/** Deletes creative files that no CreativeAsset row points at and that are older than the grace period. Counts only. */
export async function cleanupOrphanCreativeFiles(now = Date.now()): Promise<{ tenants: number; filesDeleted: number }> {
  const root = storeRoot("creative");
  const tenants = (await fs.readdir(root).catch(() => [] as string[])).filter((n) => SAFE_ID.test(n)).slice(0, ORPHAN_TENANTS_PER_RUN);
  let filesDeleted = 0;
  for (const tenantId of tenants) {
    const dir = resolveTenantDir("creative", tenantId);
    if (!dir) continue;
    const info = await fs.lstat(dir).catch(() => null);
    if (!info?.isDirectory()) continue;
    const keys = (await fs.readdir(dir).catch(() => [] as string[])).filter((k) => SAFE_CREATIVE_KEY.test(k)).slice(0, ORPHAN_FILES_PER_TENANT);
    if (keys.length === 0) continue;
    const rows = await prisma.creativeAsset.findMany({ where: { tenantId, storageKey: { in: keys } }, select: { storageKey: true } });
    const referenced = new Set(rows.map((r) => r.storageKey));
    for (const key of keys) {
      if (referenced.has(key)) continue;
      const file = path.resolve(dir, key);
      if (path.dirname(file) !== dir) continue;
      const stat = await fs.lstat(file).catch(() => null);
      if (!stat?.isFile() || now - stat.mtimeMs < ORPHAN_GRACE_MS) continue;
      await fs.rm(file, { force: true });
      filesDeleted++;
    }
  }
  return { tenants: tenants.length, filesDeleted };
}
