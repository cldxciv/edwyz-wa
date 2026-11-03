/**
 * The website pixel for sales and website audiences (docs/IG-PAGE-ADS-SPEC.md 3.2 pixel row, 4.2 C7 and C9, 8.4).
 *
 * Meta has an API to create a pixel (C9) and to read when it last saw a visit (C7), so Edwyz does both instead of sending the
 * owner to Events Manager:
 * - one pixel per ad account: a pixel or dataset discovery already found on the workspace's spending ad account is reused, and
 *   a new one is stored as a dataset asset at once, so a second create reuses it;
 * - the install code (Meta's own snippet) comes back with it, for [Copy code] and "Add this to every page of your website, or
 *   ask your web developer";
 * - "fired recently" means a visit in the last 7 days; otherwise the readiness row says "Your pixel hasn't seen a visit in 7
 *   days. Check it's installed on your website."
 *
 * Both calls go through promote/meta.ts (classified not_spend; faked under SPEND_DRY_RUN). Creating is an admin's tap (Eddy's
 * create_pixel is a confirm card) and at most 3 a day per workspace (POST /api/promote/pixel).
 */
import { HttpError, type Actor } from "@/lib/tenancy";
import type { PromoteMeta } from "./meta";

export const PIXEL_FIRED_WITHIN_MS = 7 * 24 * 3_600_000;
export const PIXEL_CREATES_PER_DAY = 3;
export const DEFAULT_PIXEL_NAME = "Website pixel";
const CODE_MAX = 20_000;

export const PIXEL_COPY = {
  noAccount: "Choose a spending ad account in Settings > Spending limits first. The pixel is made on that account.",
  noCode: "Meta didn't send the install code this time. Try again in a minute.",
  tooMany: "You can create up to 3 pixels a day. Try again tomorrow.",
} as const;

export type PixelAccount = { assetId: string; externalId: string; connectionId: string; name: string | null };
export type PixelDataset = { assetId: string; externalId: string; name: string | null };

export type PixelView = {
  id: string;
  name: string | null;
  /** When Meta last saw a visit (ISO), or null. */
  lastFiredAt: string | null;
  firedRecently: boolean;
  unavailable: boolean | null;
  /** Meta's install code for every page of the website. Null when Meta didn't send it. */
  code: string | null;
  /** The account already had this pixel: nothing was created. */
  reused: boolean;
  /** The workspace's dataset asset for it (null in a dry run). */
  datasetAssetId: string | null;
};

export type PixelStatus =
  | { state: "no_account" }
  | { state: "none" }
  | { state: "unknown"; pixel: PixelDataset }
  | { state: "ok" | "stale"; pixel: PixelDataset & { lastFiredAt: string | null } };

export type PixelDeps = {
  meta: Pick<PromoteMeta, "createPixel" | "getPixel">;
  /** The workspace's Phase 0 spending ad account (D3), active, or null. */
  spendingAccount: (tenantId: string) => Promise<PixelAccount | null>;
  /** The pixels and datasets stored for an ad account (discovery's datasets, and ones made here). */
  datasets: (tenantId: string, account: PixelAccount) => Promise<PixelDataset[]>;
  /** Stores a new pixel as a dataset asset of the ad account's connection; returns its asset id. */
  saveDataset: (tenantId: string, account: PixelAccount, pixel: { id: string; name: string }) => Promise<string>;
  audit: (entry: { tenantId: string; userId: string; action: string; target?: string; meta?: Record<string, string | number | boolean | null> }) => Promise<void>;
  now: () => number;
  /** SPEND_DRY_RUN: Meta answers with a fake id, nothing is stored and no code is read. */
  dryRun: boolean;
};

/** A visit in the last 7 days. */
export function firedRecently(lastFiredAt: string | null | undefined, now: number): boolean {
  const t = lastFiredAt ? Date.parse(lastFiredAt) : NaN;
  return Number.isFinite(t) && now - t <= PIXEL_FIRED_WITHIN_MS && t <= now + 5 * 60_000;
}

/** Meta's install code, trimmed and capped; null when there is none. */
export function pixelSnippet(code: unknown): string | null {
  if (typeof code !== "string") return null;
  const trimmed = code.trim();
  return trimmed ? trimmed.slice(0, CODE_MAX) : null;
}

const actNumber = (externalId: string) => externalId.replace(/^act_/, "");

async function defaultDeps(): Promise<Omit<PixelDeps, "dryRun">> {
  const [{ prisma }, { promoteMeta }, { audit }] = await Promise.all([import("@/lib/db"), import("./meta"), import("@/lib/auth/audit")]);
  return {
    meta: promoteMeta,
    spendingAccount: async (tenantId) => {
      const control = await prisma.spendControl.findUnique({ where: { tenantId }, select: { spendingAdAccountAssetId: true } });
      if (!control?.spendingAdAccountAssetId) return null;
      const a = await prisma.metaAsset.findFirst({
        where: { id: control.spendingAdAccountAssetId, tenantId, type: "ad_account", status: "active" },
        select: { id: true, externalId: true, connectionId: true, name: true },
      });
      return a ? { assetId: a.id, externalId: a.externalId, connectionId: a.connectionId, name: a.name } : null;
    },
    datasets: async (tenantId, account) => {
      const rows = (await prisma.metaAsset.findMany({
        where: { tenantId, type: "dataset", status: "active" },
        select: { id: true, externalId: true, name: true, meta: true },
        orderBy: { createdAt: "asc" },
        take: 200,
      })) as { id: string; externalId: string; name: string | null; meta: unknown }[];
      const want = actNumber(account.externalId);
      return rows
        .filter((r) => {
          const owner = (r.meta as { adAccountId?: unknown } | null)?.adAccountId;
          return typeof owner === "string" && actNumber(owner) === want;
        })
        .map((r) => ({ assetId: r.id, externalId: r.externalId, name: r.name }));
    },
    saveDataset: async (tenantId, account, pixel) => {
      const data = { connectionId: account.connectionId, name: pixel.name, status: "active", meta: { adAccountId: account.externalId, createdInEdwyz: true } };
      const row = await prisma.metaAsset.upsert({
        where: { tenantId_type_externalId: { tenantId, type: "dataset", externalId: pixel.id } },
        create: { tenantId, type: "dataset", externalId: pixel.id, ...data },
        update: data,
        select: { id: true },
      });
      return row.id;
    },
    audit: (entry) => audit(entry),
    now: Date.now,
  };
}

async function resolveDeps(overrides: Partial<PixelDeps>): Promise<PixelDeps> {
  const keys = ["meta", "spendingAccount", "datasets", "saveDataset", "audit", "now"] as const;
  const base = keys.every((k) => overrides[k] !== undefined) ? ({} as Omit<PixelDeps, "dryRun">) : await defaultDeps();
  return { ...base, dryRun: false, ...overrides } as PixelDeps;
}

/**
 * The pixel row of the readiness checklist: no spending account, no pixel yet, a pixel Meta couldn't be asked about (unknown),
 * or one that did (ok) or didn't (stale) see a visit in the last 7 days (C7).
 */
export async function pixelStatus(tenantId: string, overrides: Partial<PixelDeps> = {}): Promise<PixelStatus> {
  const deps = await resolveDeps(overrides);
  const account = await deps.spendingAccount(tenantId);
  if (!account) return { state: "no_account" };
  const pixel = (await deps.datasets(tenantId, account))[0];
  if (!pixel) return { state: "none" };
  try {
    const p = await deps.meta.getPixel({ tenantId, adAccountAssetId: account.assetId }, pixel.externalId);
    return { state: firedRecently(p.lastFiredAt, deps.now()) ? "ok" : "stale", pixel: { ...pixel, lastFiredAt: p.lastFiredAt } };
  } catch {
    return { state: "unknown", pixel };
  }
}

const inFlight = new Map<string, Promise<PixelView>>();

/**
 * create_pixel (C9): the spending ad account's pixel, created only when it has none. A pixel already stored for the account
 * is reused (nothing is created); a new one is stored as a dataset asset before its code is read, so a second tap reuses it
 * even if reading the code fails. Two taps at the same time share one request. Returns the install code.
 */
export async function createOrReusePixel(actor: Pick<Actor, "tenantId" | "userId">, name: unknown, overrides: Partial<PixelDeps> = {}): Promise<PixelView> {
  const deps = await resolveDeps(overrides);
  const label = typeof name === "string" && name.trim() ? name.trim().slice(0, 100) : DEFAULT_PIXEL_NAME;
  const account = await deps.spendingAccount(actor.tenantId);
  if (!account) throw new HttpError(409, PIXEL_COPY.noAccount);
  const key = `${actor.tenantId}:${account.assetId}`;
  const running = inFlight.get(key);
  if (running) return running;
  const run = (async (): Promise<PixelView> => {
    const ctx = { tenantId: actor.tenantId, adAccountAssetId: account.assetId };
    const existing = (await deps.datasets(actor.tenantId, account))[0];
    let pixel: { id: string; name: string | null; datasetAssetId: string | null; reused: boolean };
    if (existing) {
      pixel = { id: existing.externalId, name: existing.name, datasetAssetId: existing.assetId, reused: true };
    } else {
      const { id } = await deps.meta.createPixel(ctx, label);
      const datasetAssetId = deps.dryRun ? null : await deps.saveDataset(actor.tenantId, account, { id, name: label });
      await deps.audit({ tenantId: actor.tenantId, userId: actor.userId, action: "promote.pixel_created", target: account.assetId, meta: { dryRun: deps.dryRun } });
      pixel = { id, name: label, datasetAssetId, reused: false };
    }
    if (deps.dryRun) return { ...pixel, lastFiredAt: null, firedRecently: false, unavailable: null, code: null };
    const read = await deps.meta.getPixel(ctx, pixel.id, { withCode: true }).catch(() => null);
    return {
      ...pixel,
      name: read?.name ?? pixel.name,
      lastFiredAt: read?.lastFiredAt ?? null,
      firedRecently: firedRecently(read?.lastFiredAt, deps.now()),
      unavailable: read?.unavailable ?? null,
      code: pixelSnippet(read?.code),
    };
  })();
  inFlight.set(key, run);
  try {
    return await run;
  } finally {
    inFlight.delete(key);
  }
}

/** The stored pixel of the spending account with its code, without creating anything (GET /api/promote/pixel). */
export async function currentPixel(actor: Pick<Actor, "tenantId">, overrides: Partial<PixelDeps> = {}): Promise<PixelView | null> {
  const deps = await resolveDeps(overrides);
  const account = await deps.spendingAccount(actor.tenantId);
  if (!account) return null;
  const existing = (await deps.datasets(actor.tenantId, account))[0];
  if (!existing) return null;
  if (deps.dryRun) return { id: existing.externalId, name: existing.name, lastFiredAt: null, firedRecently: false, unavailable: null, code: null, reused: true, datasetAssetId: existing.assetId };
  const read = await deps.meta.getPixel({ tenantId: actor.tenantId, adAccountAssetId: account.assetId }, existing.externalId, { withCode: true }).catch(() => null);
  return {
    id: existing.externalId,
    name: read?.name ?? existing.name,
    lastFiredAt: read?.lastFiredAt ?? null,
    firedRecently: firedRecently(read?.lastFiredAt, deps.now()),
    unavailable: read?.unavailable ?? null,
    code: pixelSnippet(read?.code),
    reused: true,
    datasetAssetId: existing.assetId,
  };
}
