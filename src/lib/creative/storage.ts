import { promises as fs } from "node:fs";
import path from "node:path";
import { HttpError } from "@/lib/tenancy";

export interface CreativeStorage {
  put(tenantId: string, name: string, data: Buffer): Promise<string>;
  get(tenantId: string, key: string): Promise<Buffer>;
  remove(tenantId: string, key: string): Promise<void>;
}

const SAFE_ID = /^[A-Za-z0-9_-]{1,64}$/;
const SAFE_KEY = /^[A-Za-z0-9_-]{1,80}\.[a-z0-9]{2,5}$/;

export function baseDir(): string {
  return path.resolve(process.env.DATA_DIR || "./data", "creative");
}

/** Resolves <DATA_DIR>/creative/<tenantId>/<key> and refuses anything that could leave that directory. */
export function resolveSafe(tenantId: string, key: string, root = baseDir()): string {
  if (!SAFE_ID.test(tenantId) || !SAFE_KEY.test(key)) throw new HttpError(400, "Invalid file reference.");
  const dir = path.resolve(root, tenantId);
  const full = path.resolve(dir, key);
  if (path.dirname(full) !== dir || !dir.startsWith(root + path.sep)) throw new HttpError(400, "Invalid file reference.");
  return full;
}

export const DEFAULT_CREATIVE_QUOTA_MB = 500;
export const DEFAULT_CREATIVE_MAX_FILES = 2000;
const BLOCK = 4096;

const positive = (raw: string | undefined, fallback: number) => (Number.isFinite(Number(raw)) && Number(raw) > 0 ? Number(raw) : fallback);

/** Per-workspace cap on stored creative files (CREATIVE_MEDIA_QUOTA_MB, default 500). Files cost whole disk blocks. */
export const creativeQuotaBytes = () => positive(process.env.CREATIVE_MEDIA_QUOTA_MB, DEFAULT_CREATIVE_QUOTA_MB) * 1048576;
export const creativeMaxFiles = () => Math.floor(positive(process.env.CREATIVE_MEDIA_MAX_FILES, DEFAULT_CREATIVE_MAX_FILES));

const locks = new Map<string, Promise<unknown>>();

function withTenantLock<T>(tenantId: string, work: () => Promise<T>): Promise<T> {
  const run = (locks.get(tenantId) ?? Promise.resolve()).then(work, work);
  const tail = run.catch(() => undefined);
  locks.set(tenantId, tail);
  void tail.then(() => {
    if (locks.get(tenantId) === tail) locks.delete(tenantId);
  });
  return run;
}

async function assertRoom(dir: string, key: string, incoming: number): Promise<void> {
  const names = await fs.readdir(dir).catch(() => [] as string[]);
  let charged = 0;
  let files = 0;
  for (const name of names) {
    if (name === key) continue;
    const st = await fs.stat(path.join(dir, name)).catch(() => null);
    if (!st) continue;
    files += 1;
    charged += Math.max(Math.ceil(st.size / BLOCK), 1) * BLOCK;
  }
  if (files >= creativeMaxFiles()) throw new HttpError(413, "This workspace has reached its creative file limit. Delete assets you no longer need.");
  if (charged + Math.max(Math.ceil(incoming / BLOCK), 1) * BLOCK > creativeQuotaBytes()) throw new HttpError(413, "This workspace has used its creative storage. Delete assets you no longer need.");
}

export const localStorage: CreativeStorage = {
  async put(tenantId, name, data) {
    const full = resolveSafe(tenantId, name);
    await fs.mkdir(path.dirname(full), { recursive: true });
    await withTenantLock(tenantId, async () => {
      await assertRoom(path.dirname(full), name, data.length);
      await fs.writeFile(full, data);
    });
    return name;
  },
  async get(tenantId, key) {
    try {
      return await fs.readFile(resolveSafe(tenantId, key));
    } catch (e) {
      if (e instanceof HttpError) throw e;
      throw new HttpError(404, "File not found.");
    }
  },
  async remove(tenantId, key) {
    await fs.rm(resolveSafe(tenantId, key), { force: true });
  },
};

let current: CreativeStorage = localStorage;
export const getStorage = (): CreativeStorage => current;
export function setStorageForTests(s: CreativeStorage): void {
  current = s;
}
