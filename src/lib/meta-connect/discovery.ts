import { randomBytes } from "node:crypto";
import { prisma } from "@/lib/db";
import { graphFetchAs } from "@/lib/graph";
import { openSecret, sealSecret } from "@/lib/crypto/secrets";
import { createPromoteMeta, type InstagramIdentity, type PromoteMeta, type PromoteMetaDeps } from "@/lib/promote/meta";
import type { Prisma } from "@/generated/prisma/client";
import type { AssetAccess, AssetType } from "./index";

export const PAGE_SIZE = 100;
export const MAX_ITEMS = 500;
export const MAX_PAGES = 10;
export const MAX_AD_ACCOUNTS_FOR_DATASETS = 25;
export const MAX_BUSINESSES = 10;
export const MAX_LEADGEN_SUBSCRIBES = 50;
export const SUBSCRIBE_CONCURRENCY = 4;
export const SUBSCRIBE_BUDGET_MS = 60_000;
export const SUBSCRIBE_CALL_TIMEOUT_MS = 6_000;
export const VERIFY_INTERVAL_MS = 24 * 3_600_000;

/** at is the time of the last attempt (success or failure); verifiedAt is the last time Meta confirmed the subscription exists. */
export type LeadgenSubscription = { status: "subscribed" | "failed" | "pending"; at: string; reason?: string; verifiedAt?: string };

type Paged<T> = { data?: T[]; paging?: { cursors?: { after?: string }; next?: string } };
export type Fetched<T> = { items: T[]; complete: boolean };

/** Follows cursors up to the caps. complete is false when a cap cut the list short, so absent assets must not be marked inactive. */
export async function fetchAll<T>(token: string, path: string, fields: string, maxItems = MAX_ITEMS): Promise<Fetched<T>> {
  const items: T[] = [];
  let after: string | undefined;
  for (let page = 0; page < MAX_PAGES; page++) {
    const query: Record<string, string> = { fields, limit: String(PAGE_SIZE) };
    if (after) query.after = after;
    const res = await graphFetchAs<Paged<T>>(token, { path, query });
    items.push(...(res?.data ?? []));
    after = res?.paging?.next ? res.paging.cursors?.after : undefined;
    if (items.length >= maxItems) return { items: items.slice(0, maxItems), complete: !after && items.length <= maxItems };
    if (!after) return { items, complete: true };
  }
  return { items, complete: false };
}

type Found = { type: AssetType; externalId: string; name: string | null; token?: string; meta: Record<string, unknown> };
type Part = { found: Found[]; types: AssetType[] };
type PageRow = {
  id: string;
  name?: string;
  access_token?: string;
  tasks?: string[];
  picture?: { data?: { url?: string } };
  instagram_business_account?: { id: string; username?: string; name?: string; profile_picture_url?: string };
};

/** C1 (docs/IG-PAGE-ADS-SPEC.md 4.2): Pages with their tasks and picture, and the linked Instagram account with its picture. */
export const PAGE_FIELDS = "id,name,access_token,tasks,picture{url},instagram_business_account{id,username,name,profile_picture_url}";

/** A picture address Meta returned: https only, capped; anything else is dropped. */
export function pictureUrl(value: unknown): string | null {
  if (typeof value !== "string" || value.length === 0 || value.length > 2000) return null;
  try {
    return new URL(value).protocol === "https:" ? value : null;
  } catch {
    return null;
  }
}

const TASKS_MAX = 20;
const taskList = (v: unknown): string[] => (Array.isArray(v) ? v.filter((t): t is string => typeof t === "string" && /^[A-Z_]{1,40}$/.test(t)).slice(0, TASKS_MAX) : []);
type AdAccountRow = {
  id: string;
  name?: string;
  currency?: string;
  account_status?: number;
  timezone_name?: string;
  spend_cap?: string | number;
  amount_spent?: string | number;
  is_prepay_account?: boolean;
  min_campaign_group_spend_cap?: string | number;
};

/** Meta's spending-limit fields for the consent screen (docs/SPEND-CONTROLS-SPEC.md 5.1): read as minor units, 0 = no limit. */
export const AD_ACCOUNT_FIELDS = "id,name,currency,account_status,timezone_name,spend_cap,amount_spent,is_prepay_account,min_campaign_group_spend_cap";

/** A counter Meta returns as minor units, kept as a decimal string (JSON has no bigint); null when absent or unreadable. */
export function minorString(value: unknown): string | null {
  if (typeof value === "number" && Number.isSafeInteger(value) && value >= 0) return String(value);
  if (typeof value === "string" && /^\d{1,30}$/.test(value.trim())) return value.trim().replace(/^0+(?=\d)/, "");
  return null;
}
type SimpleRow = { id: string; name?: string };

/**
 * C1: the Pages this login manages. `canAdvertise` is the ADVERTISE task (ads for the Page need it) and `canCreateContent`
 * the CREATE_CONTENT task (posting and video uploads); the linked Instagram professional account comes with its picture.
 */
async function discoverPages(token: string): Promise<Part> {
  const res = await fetchAll<PageRow>(token, "me/accounts", PAGE_FIELDS);
  const found: Found[] = [];
  const checkedAt = { listing: new Date().toISOString() };
  for (const p of res.items) {
    const tasks = taskList(p.tasks);
    found.push({
      type: "page",
      externalId: p.id,
      name: p.name ?? null,
      token: p.access_token,
      meta: { tasks, pictureUrl: pictureUrl(p.picture?.data?.url), canAdvertise: tasks.includes("ADVERTISE"), canCreateContent: tasks.includes("CREATE_CONTENT"), checkedAt },
    });
    const ig = p.instagram_business_account;
    if (ig?.id)
      found.push({
        type: "instagram",
        externalId: ig.id,
        name: ig.username ?? ig.name ?? null,
        token: p.access_token,
        meta: { pageId: p.id, username: ig.username ?? null, displayName: ig.name ?? null, profilePictureUrl: pictureUrl(ig.profile_picture_url), pageBacked: false, checkedAt },
      });
  }
  return { found, types: res.complete ? ["page", "instagram"] : [] };
}

async function discoverAdAccounts(token: string): Promise<Part> {
  const res = await fetchAll<AdAccountRow>(token, "me/adaccounts", AD_ACCOUNT_FIELDS);
  const found = res.items.map<Found>((a) => ({
    type: "ad_account",
    externalId: a.id,
    name: a.name ?? null,
    meta: {
      currency: a.currency ?? null,
      accountStatus: a.account_status ?? null,
      timezone: a.timezone_name ?? null,
      // So the consent step can say "This account already has a Meta limit of ₹X" (5.1); prepaid accounts have no limit to manage.
      metaCapMinor: minorString(a.spend_cap),
      amountSpentMinor: minorString(a.amount_spent),
      isPrepay: typeof a.is_prepay_account === "boolean" ? a.is_prepay_account : null,
      minCampaignGroupCapMinor: minorString(a.min_campaign_group_spend_cap),
    },
  }));
  return { found, types: res.complete ? ["ad_account"] : [] };
}

async function discoverDatasets(token: string, adAccounts: Found[]): Promise<Part> {
  const found = new Map<string, Found>();
  let complete = adAccounts.length <= MAX_AD_ACCOUNTS_FOR_DATASETS;
  for (const account of adAccounts.slice(0, MAX_AD_ACCOUNTS_FOR_DATASETS)) {
    try {
      const res = await fetchAll<SimpleRow>(token, `${account.externalId}/adspixels`, "id,name");
      complete &&= res.complete;
      for (const d of res.items) if (!found.has(d.id)) found.set(d.id, { type: "dataset", externalId: d.id, name: d.name ?? null, meta: { adAccountId: account.externalId } });
    } catch {
      complete = false;
    }
  }
  return { found: [...found.values()], types: complete ? ["dataset"] : [] };
}

async function discoverBusinesses(token: string): Promise<{ rows: SimpleRow[]; complete: boolean }> {
  try {
    const res = await fetchAll<SimpleRow>(token, "me/businesses", "id,name", MAX_BUSINESSES);
    return { rows: res.items, complete: res.complete };
  } catch {
    return { rows: [], complete: false };
  }
}

async function discoverCatalogs(token: string, businesses: { rows: SimpleRow[]; complete: boolean }): Promise<Part> {
  const found = new Map<string, Found>();
  let complete = businesses.complete;
  for (const b of businesses.rows) {
    try {
      const res = await fetchAll<SimpleRow>(token, `${b.id}/owned_product_catalogs`, "id,name");
      complete &&= res.complete;
      for (const c of res.items) if (!found.has(c.id)) found.set(c.id, { type: "catalog", externalId: c.id, name: c.name ?? null, meta: { businessId: b.id } });
    } catch {
      complete = false;
    }
  }
  return { found: [...found.values()], types: complete ? ["catalog"] : [] };
}

const failedWith = (e: unknown, at: string): LeadgenSubscription => {
  const code = (e as { code?: unknown } | null)?.code;
  return { status: "failed", at, reason: typeof code === "number" ? `Meta refused the subscription (error ${code}).` : "The subscription request failed." };
};

class CallTimeout extends Error {}

/** Settles after ms even when the underlying request hangs; the abandoned request keeps its own timeout inside graphFetchAs. */
function withTimeout<T>(run: Promise<T>, ms: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout>;
  const limit = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new CallTimeout()), ms);
  });
  return Promise.race([run, limit]).finally(() => clearTimeout(timer));
}

/** Best effort: subscribes one Page to leadgen with its own page token. Never throws, never includes the token or Meta's message in the result. */
export async function subscribePageToLeadgen(pageId: string, pageToken: string, timeoutMs = SUBSCRIBE_CALL_TIMEOUT_MS): Promise<LeadgenSubscription> {
  const at = new Date().toISOString();
  try {
    const res = await withTimeout(graphFetchAs<{ success?: boolean }>(pageToken, { path: `${pageId}/subscribed_apps`, method: "POST", query: { subscribed_fields: "leadgen" } }), timeoutMs);
    return res?.success === true ? { status: "subscribed", at, verifiedAt: at } : { status: "failed", at, reason: "Meta did not confirm the subscription." };
  } catch (e) {
    return e instanceof CallTimeout ? { status: "failed", at, reason: "Meta did not answer in time." } : failedWith(e, at);
  }
}

/** Best effort: removes this app's subscription from a Page. Returns whether Meta confirmed it. Never throws. */
export async function unsubscribePageFromApp(pageId: string, pageToken: string, timeoutMs = SUBSCRIBE_CALL_TIMEOUT_MS): Promise<boolean> {
  try {
    const res = await withTimeout(graphFetchAs<{ success?: boolean }>(pageToken, { path: `${pageId}/subscribed_apps`, method: "DELETE" }), timeoutMs);
    return res?.success === true;
  } catch {
    return false;
  }
}

export type SubscriptionCheck = "subscribed" | "missing" | "unknown";

/**
 * Reads GET {pageId}/subscribed_apps with the page token and looks for this app with the leadgen field. "missing" is
 * returned only when Meta answered with a list that does not contain it; any failure, a missing META_APP_ID or an
 * unreadable answer is "unknown", so an outage never resets a working subscription. Never throws.
 */
export async function checkPageSubscription(pageId: string, pageToken: string, timeoutMs = SUBSCRIBE_CALL_TIMEOUT_MS): Promise<SubscriptionCheck> {
  const appId = process.env.META_APP_ID;
  if (!appId) return "unknown";
  try {
    const res = await withTimeout(
      graphFetchAs<{ data?: { id?: unknown; subscribed_fields?: unknown }[] }>(pageToken, { path: `${pageId}/subscribed_apps`, query: { fields: "id,subscribed_fields" } }),
      timeoutMs,
    );
    if (!Array.isArray(res?.data)) return "unknown";
    const mine = res.data.find((a) => String(a?.id) === appId);
    return mine && Array.isArray(mine.subscribed_fields) && mine.subscribed_fields.includes("leadgen") ? "subscribed" : "missing";
  } catch {
    return "unknown";
  }
}

/**
 * Runs fn over items with bounded concurrency inside a hard deadline: no new item starts once it has passed, and an item still
 * running at the deadline is abandoned (its own request timeouts finish it in the background) instead of being waited for, so the
 * caller returns at the deadline whatever Meta does. Returns how many were started. An error thrown by fn is rethrown.
 */
export async function runPool<T>(items: T[], limit: number, deadline: number, fn: (item: T) => Promise<void>): Promise<number> {
  let next = 0;
  const lane = async () => {
    while (next < items.length) {
      const left = deadline - Date.now();
      if (left <= 0) return;
      try {
        await withTimeout(fn(items[next++]), left);
      } catch (e) {
        if (!(e instanceof CallTimeout)) throw e;
        return;
      }
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, lane));
  return next;
}

const rank = (s: LeadgenSubscription | undefined) => (!s ? 0 : s.status === "pending" ? 1 : 2);
const atMs = (s: LeadgenSubscription | undefined) => (s ? Math.max(Date.parse(s.at) || 0, Date.parse(s.verifiedAt ?? "") || 0) : 0);
const subOf = (meta: unknown) => (meta as { leadgenSubscription?: LeadgenSubscription } | null)?.leadgenSubscription;

/** A stored "subscribed" is trusted for 24 hours after the last confirmation, then read back from Meta. Anything else is always due. */
export function verificationDue(s: LeadgenSubscription | undefined, now = Date.now()): boolean {
  if (!s || s.status !== "subscribed") return true;
  const last = Date.parse(s.verifiedAt ?? s.at);
  return Number.isNaN(last) || now - last >= VERIFY_INTERVAL_MS;
}

/** Pages never attempted come first, then those still pending, then the rest by oldest attempt, so a cap or time budget rotates through every Page instead of retrying the same ones. */
export function orderForSubscribe<T extends { id: string }>(pages: T[], previous: Map<string, LeadgenSubscription>): T[] {
  return [...pages].sort((a, b) => {
    const pa = previous.get(a.id);
    const pb = previous.get(b.id);
    return rank(pa) - rank(pb) || atMs(pa) - atMs(pb);
  });
}

/**
 * The stored meta of every asset this run found, by Meta id (Meta ids are unique across object types). One query: the leadgen
 * subscription status of each Page and the readiness blocks of every asset are carried over from it.
 */
async function previousMetas(tenantId: string, ids: string[]): Promise<Map<string, Record<string, unknown>>> {
  const out = new Map<string, Record<string, unknown>>();
  if (ids.length === 0) return out;
  try {
    const rows = (await prisma.metaAsset.findMany({ where: { tenantId, externalId: { in: ids } }, select: { externalId: true, type: true, meta: true } })) ?? [];
    for (const r of rows) if (r.meta && typeof r.meta === "object" && !Array.isArray(r.meta)) out.set(r.externalId, r.meta as Record<string, unknown>);
  } catch {
    return new Map();
  }
  return out;
}

function subscriptionsOf(previous: Map<string, Record<string, unknown>>, pageIds: string[]): Map<string, LeadgenSubscription> {
  const out = new Map<string, LeadgenSubscription>();
  for (const id of pageIds) {
    const sub = subOf(previous.get(id));
    if (sub && typeof sub.status === "string") out.set(id, sub);
  }
  return out;
}

// =====================================================================================================================
// Readiness blocks (docs/IG-PAGE-ADS-SPEC.md 3.2, 4.2 C1 to C6, 5.4 MetaAsset.meta)
// =====================================================================================================================

/**
 * The 5.4 keys each extra read stores, by asset type and block. Each block has its own time in `meta.checkedAt[block]`, set
 * only when that read succeeded; a block whose read failed or ran out of time keeps what the previous run stored.
 */
export const META_BLOCKS = {
  page: { leadgen: ["leadgenTosAccepted", "whatsappNumber", "whatsappLinkState"], pageBacked: ["pageBackedIgId", "pageBackedCreatedAt"] },
  instagram: { authorized: ["authorizedAdAccountIds"] },
  ad_account: { health: ["accountStatus", "disableReason", "businessId", "customAudienceTos", "userTosAccepted", "fundingPresent"], minBudget: ["minDailyBudgetMinor"] },
} as const satisfies Partial<Record<AssetType, Record<string, readonly string[]>>>;

type BlockType = keyof typeof META_BLOCKS;
const isBlockType = (t: AssetType): t is BlockType => t in META_BLOCKS;

export const ENRICH_CONCURRENCY = 4;
/** Pages read for C2 and C3, and ad accounts for C4 to C6, per run at most (the same caps as subscribing and datasets). */
export const MAX_ENRICH_PAGES = MAX_LEADGEN_SUBSCRIBES;
export const MAX_ENRICH_AD_ACCOUNTS = MAX_AD_ACCOUNTS_FOR_DATASETS;
/**
 * Meta key on a Page or ad account: when its readiness reads were last tried, whether or not they succeeded. The caps above
 * rotate on it (orderForEnrich), so a Page whose reads keep failing moves to the back instead of starving the rest.
 */
export const READINESS_TRIED_KEY = "readinessTriedAt";
/**
 * Meta may not list an identity Edwyz just made (C8) in C3 for a while. For this long after `pageBackedCreatedAt`, an empty C3
 * answer keeps the stored `pageBackedIgId` instead of clearing it.
 */
export const PAGE_BACKED_LISTING_GRACE_MS = 15 * 60_000;

const checkedAtOf = (meta: Record<string, unknown> | undefined): Record<string, string> => {
  const v = meta?.checkedAt;
  if (!v || typeof v !== "object" || Array.isArray(v)) return {};
  return Object.fromEntries(Object.entries(v as Record<string, unknown>).filter((e): e is [string, string] => typeof e[1] === "string"));
};

/**
 * The previous run's blocks for this asset, so a failed or late read never wipes what is known. Only blocks that this run's
 * listing does not produce are carried, each with its own checkedAt.
 */
export function carriedBlocks(type: AssetType, previous: Record<string, unknown> | undefined): Record<string, unknown> {
  if (!previous || !isBlockType(type)) return {};
  const out: Record<string, unknown> = {};
  const times = checkedAtOf(previous);
  const carriedTimes: Record<string, string> = {};
  for (const [block, keys] of Object.entries(META_BLOCKS[type]) as [string, readonly string[]][]) {
    if (!times[block]) continue;
    for (const k of keys) if (k in previous) out[k] = previous[k];
    carriedTimes[block] = times[block];
  }
  if (Object.keys(carriedTimes).length) out.checkedAt = carriedTimes;
  if ((type === "page" || type === "ad_account") && typeof previous[READINESS_TRIED_KEY] === "string") out[READINESS_TRIED_KEY] = previous[READINESS_TRIED_KEY];
  return out;
}

type EnrichType = "page" | "ad_account";

/**
 * How long ago an asset's readiness reads ran, as a time to sort on: when they were last tried, else the oldest time one of
 * its blocks was read, and 0 (first) when one of them never was.
 */
export function readinessAge(type: EnrichType, meta: Record<string, unknown> | undefined): number {
  const tried = typeof meta?.[READINESS_TRIED_KEY] === "string" ? Date.parse(meta[READINESS_TRIED_KEY] as string) : NaN;
  if (Number.isFinite(tried)) return tried;
  const times = checkedAtOf(meta);
  let oldest = Number.POSITIVE_INFINITY;
  for (const block of Object.keys(META_BLOCKS[type])) {
    const t = Date.parse(times[block] ?? "");
    oldest = Math.min(oldest, Number.isFinite(t) ? t : 0);
  }
  return oldest;
}

/**
 * The order the readiness reads take, so the per-run caps rotate through every Page and ad account: `first` (the workspace's
 * spending ad account) before all, then never read, then the longest ago. Ties keep Meta's listing order.
 */
export function orderForEnrich<T extends { externalId: string }>(type: EnrichType, items: T[], previous: Map<string, Record<string, unknown>>, first: string | null = null): T[] {
  const age = new Map(items.map((i) => [i.externalId, readinessAge(type, previous.get(i.externalId))]));
  return [...items].sort((a, b) => Number(b.externalId === first) - Number(a.externalId === first) || (age.get(a.externalId) ?? 0) - (age.get(b.externalId) ?? 0));
}

/** The Page-backed identity Edwyz made for this Page within PAGE_BACKED_LISTING_GRACE_MS, which C3 may not list yet; else null. */
export function justCreatedIdentity(pageMeta: Record<string, unknown> | undefined, now = Date.now()): string | null {
  const id = pageMeta?.pageBackedIgId;
  const created = typeof pageMeta?.pageBackedCreatedAt === "string" ? Date.parse(pageMeta.pageBackedCreatedAt) : NaN;
  if (typeof id !== "string" || !id || !Number.isFinite(created)) return null;
  return now - created < PAGE_BACKED_LISTING_GRACE_MS && created - now < 60_000 ? id : null;
}

/** The listing's meta with the carried blocks under it; the listing's own keys and times win. */
function mergeMeta(listing: Record<string, unknown>, carried: Record<string, unknown>): Record<string, unknown> {
  const times = { ...checkedAtOf(carried), ...checkedAtOf(listing) };
  const merged = { ...carried, ...listing };
  if (Object.keys(times).length) merged.checkedAt = times;
  else delete merged.checkedAt;
  return merged;
}

const digitsOf = (v: unknown): string => (typeof v === "string" ? v.replace(/\D/g, "") : "");

/** ok when the Page shows one of the workspace's WhatsApp numbers, missing when it shows none or another, unknown when either side can't be read (V-P12). */
export function whatsappLinkState(page: { number: string | null; checked: boolean }, workspaceNumbers: string[] | null): "ok" | "missing" | "unknown" {
  if (!page.checked || workspaceNumbers === null) return "unknown";
  const mine = digitsOf(page.number);
  if (!mine) return "missing";
  // The same number, or the same national number with and without the country code (at least 10 digits in common).
  const same = (d: string) => d === mine || (Math.min(d.length, mine.length) >= 10 && (d.endsWith(mine) || mine.endsWith(d)));
  return workspaceNumbers.some((n) => same(digitsOf(n))) ? "ok" : "missing";
}

/** The minimum daily amount for ads billed on impressions (C5, V-P10), in the account's minor units, or null. */
export function minDailyFrom(minimumsMinor: Record<string, number>): number | null {
  const v = minimumsMinor.min_daily_budget_imp;
  return typeof v === "number" && Number.isSafeInteger(v) && v >= 0 ? v : null;
}

/** Meta's terms maps hold 1 for an accepted term. */
const accepted = (terms: Record<string, number>, key: string): boolean => terms[key] === 1;

/**
 * Writes one asset's block keys and their checkedAt times into its stored meta as a JSON merge, so nothing else in the meta
 * (the lead-alert status a concurrent write keeps) is rewritten. Guarded like the subscription status: an active asset of
 * this connection, under a connection that is not revoked.
 */
export async function mergeBlocks(tenantId: string, connectionId: string, asset: Pick<Found, "type" | "externalId">, values: Record<string, unknown>, times: Record<string, string>): Promise<void> {
  const patch = JSON.stringify(values);
  const stamps = JSON.stringify(times);
  await prisma.$executeRaw`
    UPDATE "MetaAsset" AS a
    SET "meta" = (CASE WHEN jsonb_typeof(a."meta") = 'object' THEN a."meta" ELSE '{}'::jsonb END) || ${patch}::jsonb
          || jsonb_build_object('checkedAt', (CASE WHEN jsonb_typeof(a."meta"->'checkedAt') = 'object' THEN a."meta"->'checkedAt' ELSE '{}'::jsonb END) || ${stamps}::jsonb),
        "updatedAt" = now()
    FROM "MetaConnection" AS c
    WHERE c."id" = a."connectionId" AND c."status" <> 'revoked'
      AND a."tenantId" = ${tenantId} AND a."connectionId" = ${connectionId}
      AND a."type" = ${asset.type} AND a."externalId" = ${asset.externalId} AND a."status" = 'active'`;
}

/**
 * Stores a Page-backed identity as an Instagram asset of its Page's connection straight away (after C8, or when an existing id
 * is reused), so readiness finds it even when the next discovery's C3 does not reach that Page. One statement, guarded like
 * mergeBlocks: the Page must be active under a connection that is not revoked. The identity runs on the Page's token, so the
 * Page's sealed token is copied. A row that already exists keeps the rest of its meta (C6's answer). Returns whether a row was
 * written.
 */
export async function storePageBackedIdentity(
  tenantId: string,
  page: { id: string; externalId: string; name: string | null },
  instagramId: string,
  username: string | null,
): Promise<boolean> {
  const now = new Date().toISOString();
  const created = JSON.stringify({ pageId: page.externalId, username, profilePictureUrl: null, pageBacked: true, checkedAt: { listing: now } });
  const patch = JSON.stringify({ pageId: page.externalId, pageBacked: true, ...(username ? { username } : {}) });
  const stamps = JSON.stringify({ listing: now });
  const id = `c${randomBytes(12).toString("hex")}`;
  const name = username ?? page.name;
  const count = await prisma.$executeRaw`
    INSERT INTO "MetaAsset" ("id", "tenantId", "connectionId", "type", "externalId", "name", "tokenEnc", "status", "meta", "updatedAt")
    SELECT ${id}, p."tenantId", p."connectionId", 'instagram', ${instagramId}, ${name}, p."tokenEnc", 'active', ${created}::jsonb, now()
    FROM "MetaAsset" AS p JOIN "MetaConnection" AS c ON c."id" = p."connectionId"
    WHERE p."id" = ${page.id} AND p."tenantId" = ${tenantId} AND p."type" = 'page' AND p."externalId" = ${page.externalId}
      AND p."status" = 'active' AND c."status" <> 'revoked'
    ON CONFLICT ("tenantId", "type", "externalId") DO UPDATE SET
      "connectionId" = EXCLUDED."connectionId",
      "tokenEnc" = COALESCE(EXCLUDED."tokenEnc", "MetaAsset"."tokenEnc"),
      "name" = EXCLUDED."name",
      "status" = 'active',
      "meta" = (CASE WHEN jsonb_typeof("MetaAsset"."meta") = 'object' THEN "MetaAsset"."meta" ELSE '{}'::jsonb END) || ${patch}::jsonb
            || jsonb_build_object('checkedAt', (CASE WHEN jsonb_typeof("MetaAsset"."meta"->'checkedAt') = 'object' THEN "MetaAsset"."meta"->'checkedAt' ELSE '{}'::jsonb END) || ${stamps}::jsonb),
      "updatedAt" = now()`;
  return count > 0;
}

type EnrichContext = {
  tenantId: string;
  connectionId: string;
  userToken: string;
  deadline: number;
  callTimeoutMs: number;
  metaDeps?: Partial<PromoteMetaDeps>;
};

/** A promote/meta client whose tokens come from this run's listing, so no stored token is opened. */
function discoveryClient(ctx: EnrichContext, pages: Found[], adAccounts: Found[]): PromoteMeta {
  const access = new Map<string, AssetAccess>();
  for (const p of pages) if (p.token) access.set(`page:${p.externalId}`, { assetId: `page:${p.externalId}`, type: "page", externalId: p.externalId, name: p.name, token: p.token });
  for (const a of adAccounts) access.set(`ad:${a.externalId}`, { assetId: `ad:${a.externalId}`, type: "ad_account", externalId: a.externalId, name: a.name, token: ctx.userToken });
  return createPromoteMeta({
    access: async (_tenantId, assetId) => {
      const a = access.get(assetId);
      if (!a) throw new Error("not in this discovery run");
      return a;
    },
    readTimeoutMs: ctx.callTimeoutMs,
    writeTimeoutMs: ctx.callTimeoutMs,
    ...ctx.metaDeps,
  });
}

/** The Meta id of the workspace's spending ad account (D3), whose readiness matters most; null when none is chosen or unreadable. */
async function spendingAdAccountExternalId(tenantId: string): Promise<string | null> {
  try {
    const control = (await prisma.spendControl.findUnique({ where: { tenantId }, select: { spendingAdAccountAssetId: true } })) as { spendingAdAccountAssetId?: string | null } | null;
    if (!control?.spendingAdAccountAssetId) return null;
    const row = (await prisma.metaAsset.findFirst({ where: { id: control.spendingAdAccountAssetId, tenantId, type: "ad_account" }, select: { externalId: true } })) as { externalId?: unknown } | null;
    return typeof row?.externalId === "string" ? row.externalId : null;
  } catch {
    return null;
  }
}

async function workspaceWhatsAppNumbers(tenantId: string): Promise<string[] | null> {
  try {
    const rows = (await prisma.phoneNumber.findMany({ where: { tenantId, status: "connected" }, select: { displayPhone: true }, take: 20 })) as { displayPhone?: unknown }[] | null;
    return Array.isArray(rows) ? rows.map((r) => digitsOf(r.displayPhone)).filter(Boolean) : null;
  } catch {
    return null;
  }
}

/**
 * Reads C2 and C3 for each Page and C4 to C6 for each ad account through promote/meta.ts (which classifies every request and
 * keeps the payment-method field list to itself), inside the same deadline as subscribing, at most ENRICH_CONCURRENCY at a
 * time. Each block that succeeds is stored with its own checkedAt, guarded like the subscription status (active asset,
 * connection not revoked); nothing is written once the deadline has passed. Page-backed Instagram identities (C3) become
 * Instagram assets with `pageBacked: true`. Never throws.
 *
 * The caps rotate: the workspace's spending ad account goes first, then whatever was tried longest ago (READINESS_TRIED_KEY,
 * written on every attempt), and ad accounts and Pages take turns, so many Pages can't use up the time the ad accounts need and
 * Pages beyond the cap are read on later runs.
 */
async function enrichAssets(ctx: EnrichContext, found: Found[], previous: Map<string, Record<string, unknown>>): Promise<void> {
  const allPages = found.filter((f) => f.type === "page" && f.token);
  const allAccounts = found.filter((f) => f.type === "ad_account");
  const instagram = found.filter((f) => f.type === "instagram");
  const late = () => Date.now() > ctx.deadline;
  if ((allPages.length === 0 && allAccounts.length === 0) || late()) return;
  if (await disconnectedMeanwhile(ctx.tenantId, ctx.connectionId)) return;
  const spending = allAccounts.length ? await spendingAdAccountExternalId(ctx.tenantId) : null;
  const pages = orderForEnrich("page", allPages, previous).slice(0, MAX_ENRICH_PAGES);
  const adAccounts = orderForEnrich("ad_account", allAccounts, previous, spending).slice(0, MAX_ENRICH_AD_ACCOUNTS);
  const meta = discoveryClient(ctx, pages, adAccounts);
  const at = () => new Date().toISOString();
  const numbers = pages.length ? await workspaceWhatsAppNumbers(ctx.tenantId) : null;

  /** What each asset's successful reads set, and the attempt time, written once per asset as a merge of just those keys. */
  const patches = new Map<Found, { values: Record<string, unknown>; times: Record<string, string> }>();
  const save = async (asset: Found) => {
    const patch = patches.get(asset);
    patches.delete(asset);
    if (!patch || late()) return;
    await mergeBlocks(ctx.tenantId, ctx.connectionId, asset, patch.values, patch.times).catch(() => undefined);
  };
  const stamp = (asset: Found, block: string, values: Record<string, unknown>) => {
    const time = at();
    Object.assign(asset.meta, values);
    asset.meta.checkedAt = { ...checkedAtOf(asset.meta), [block]: time };
    const patch = patches.get(asset) ?? { values: {}, times: {} };
    Object.assign(patch.values, values);
    patch.times[block] = time;
    patches.set(asset, patch);
  };
  /** Records the attempt, whatever the reads answer, so the next run starts with what this one did not reach. */
  const tried = (asset: Found) => {
    const time = at();
    asset.meta[READINESS_TRIED_KEY] = time;
    const patch = patches.get(asset) ?? { values: {}, times: {} };
    patch.values[READINESS_TRIED_KEY] = time;
    patches.set(asset, patch);
  };

  const backed: { page: Found; identities: InstagramIdentity[] }[] = [];
  /** Pages whose just-made identity C3 does not list yet: the stored id stays. */
  const kept: { page: Found; id: string }[] = [];
  /** act id -> the Instagram ids it may advertise as (C6), for the accounts whose read succeeded. */
  const authorized = new Map<string, Set<string>>();

  type Job = { kind: "page"; asset: Found } | { kind: "ad"; asset: Found };
  const jobs: Job[] = [];
  for (let i = 0; i < Math.max(pages.length, adAccounts.length); i++) {
    if (i < adAccounts.length) jobs.push({ kind: "ad", asset: adAccounts[i] });
    if (i < pages.length) jobs.push({ kind: "page", asset: pages[i] });
  }
  await runPool(jobs, ENRICH_CONCURRENCY, ctx.deadline, async (job) => {
    const { asset } = job;
    tried(asset);
    if (job.kind === "page") {
      const pageCtx = { tenantId: ctx.tenantId, pageAssetId: `page:${asset.externalId}` };
      try {
        const r = await meta.getPageReadiness(pageCtx);
        const number = r.whatsappNumberChecked ? digitsOf(r.whatsappNumber) || null : null;
        stamp(asset, "leadgen", {
          leadgenTosAccepted: r.leadgenTermsAccepted,
          whatsappNumber: number,
          whatsappLinkState: whatsappLinkState({ number, checked: r.whatsappNumberChecked }, numbers),
        });
      } catch {
        // Kept from the previous run (carriedBlocks).
      }
      if (late()) return;
      try {
        const identities = await meta.listPageBackedInstagram(pageCtx);
        const fresh = identities.length === 0 ? justCreatedIdentity(previous.get(asset.externalId)) : null;
        if (fresh) {
          kept.push({ page: asset, id: fresh });
        } else {
          stamp(asset, "pageBacked", { pageBackedIgId: identities[0]?.id ?? null });
          backed.push({ page: asset, identities });
        }
      } catch {
        // Kept from the previous run.
      }
    } else {
      const adCtx = { tenantId: ctx.tenantId, adAccountAssetId: `ad:${asset.externalId}` };
      try {
        const h = await meta.getAdAccountHealth(adCtx);
        stamp(asset, "health", {
          accountStatus: h.accountStatus ?? asset.meta.accountStatus ?? null,
          disableReason: h.disableReason,
          businessId: h.businessId,
          customAudienceTos: accepted(h.tosAccepted, "custom_audience_tos"),
          userTosAccepted: accepted(h.userTosAccepted, "custom_audience_tos"),
          fundingPresent: h.fundingPresent,
        });
      } catch {
        // Kept from the previous run.
      }
      if (late()) return;
      try {
        stamp(asset, "minBudget", { minDailyBudgetMinor: minDailyFrom((await meta.getMinimumBudgets(adCtx)).minimumsMinor) });
      } catch {
        // Kept from the previous run.
      }
      if (late()) return;
      try {
        const res = await meta.listAdAccountInstagram(adCtx);
        authorized.set(asset.externalId, new Set(res.items.map((i) => i.id)));
      } catch {
        // This account's answer stays as previously stored on each Instagram asset.
      }
    }
    await save(asset);
  });
  if (late()) return;
  if ((backed.length || kept.length) && (await disconnectedMeanwhile(ctx.tenantId, ctx.connectionId))) return;
  // What is stored on the identities (they are not in the listing, so not in `previous`): C6's answer is carried over.
  const identityIds = [...backed.flatMap((b) => b.identities.map((i) => i.id)), ...kept.map((k) => k.id)];
  const priorIdentities = identityIds.length ? await previousMetas(ctx.tenantId, identityIds) : new Map<string, Record<string, unknown>>();

  // C3: the ads-only identities become Instagram assets; one the Page no longer lists is set inactive.
  for (const { page, identities } of backed) {
    for (const ig of identities) {
      const prior = priorIdentities.get(ig.id);
      const igMeta = mergeMeta(
        { pageId: page.externalId, username: ig.username, profilePictureUrl: null, pageBacked: true, checkedAt: { listing: at() } },
        carriedBlocks("instagram", prior),
      );
      const data = { connectionId: ctx.connectionId, name: ig.username ?? page.name, status: "active", meta: igMeta as object, ...(page.token ? { tokenEnc: sealSecret(ctx.tenantId, page.token) } : {}) };
      try {
        await prisma.metaAsset.upsert({
          where: { tenantId_type_externalId: { tenantId: ctx.tenantId, type: "instagram", externalId: ig.id } },
          create: { tenantId: ctx.tenantId, type: "instagram", externalId: ig.id, ...data },
          update: data,
        });
      } catch {
        continue; // The next discovery tries again.
      }
      instagram.push({ type: "instagram", externalId: ig.id, name: data.name, token: page.token, meta: igMeta });
    }
    const before = previous.get(page.externalId)?.pageBackedIgId;
    if (typeof before === "string" && !identities.some((i) => i.id === before)) {
      try {
        await prisma.metaAsset.updateMany({ where: { tenantId: ctx.tenantId, connectionId: ctx.connectionId, type: "instagram", externalId: before, status: "active" }, data: { status: "inactive" } });
      } catch {
        // The next discovery tries again.
      }
    }
  }

  // A just-made identity C3 does not list yet keeps its asset (ensurePageBackedInstagram stored it) and still gets C6's answer.
  for (const { page, id } of kept) {
    const prior = priorIdentities.get(id);
    if (prior) instagram.push({ type: "instagram", externalId: id, name: page.name, token: page.token, meta: { ...prior } });
  }

  // C6: which ad accounts may run ads as each Instagram account. Accounts whose read failed keep their previous answer.
  if (authorized.size === 0) return;
  for (const ig of instagram) {
    const prior = Array.isArray(ig.meta.authorizedAdAccountIds) ? (ig.meta.authorizedAdAccountIds as unknown[]).filter((v): v is string => typeof v === "string") : [];
    const ids = new Set(prior.filter((act) => !authorized.has(act)));
    for (const [act, igs] of authorized) if (igs.has(ig.externalId)) ids.add(act);
    stamp(ig, "authorized", { authorizedAdAccountIds: [...ids].sort() });
    await save(ig);
  }
}

export type DiscoverOptions = {
  /** The whole discovery's time budget: listing, subscribing and the readiness reads (default SUBSCRIBE_BUDGET_MS). */
  subscribeBudgetMs?: number;
  subscribeCallTimeoutMs?: number;
  /** Test seams for the promote/meta client the readiness reads use (store, throttle, sleep, clock). */
  promoteMeta?: Partial<PromoteMetaDeps>;
};

/** The connection was disconnected (or removed) while this run was in flight. A run that cannot tell treats the connection as live. */
async function disconnectedMeanwhile(tenantId: string, connectionId: string): Promise<boolean> {
  try {
    return Boolean(await prisma.metaConnection.findFirst({ where: { id: connectionId, tenantId, status: "revoked" }, select: { id: true } }));
  } catch {
    return false;
  }
}

/**
 * Runs after the assets are saved, so a slow or hung Meta can never lose a discovery. A Page whose stored status is
 * "subscribed" and was confirmed in the last 24 hours is left alone. An older one is read back (GET subscribed_apps) and
 * re-subscribed only when Meta no longer lists the app, after being recorded as pending. Pending and failed Pages are
 * subscribed. At most MAX_LEADGEN_SUBSCRIBES Pages per run, SUBSCRIBE_CONCURRENCY at a time. `deadline` is a hard stop for the
 * whole phase (see runPool), and every request gets at most the time left, so the OAuth callback or refresh that awaits this
 * cannot outlast it. Never-attempted Pages go first, then pending, then the oldest attempt, and every attempt records its time,
 * so a Page that keeps failing moves to the back and cannot starve the others.
 *
 * A disconnect can land while a request is in flight. The result is therefore stored only for an asset that is still active
 * under a connection that is not revoked; when the store is refused because the connection was disconnected meanwhile, a
 * subscription this run just created is removed again (unless another active workspace uses the Page), so the Page is never
 * left subscribed at Meta with nothing in the database about it.
 */
async function subscribePages(tenantId: string, connectionId: string, pages: Found[], previous: Map<string, LeadgenSubscription>, deadline: number, callTimeoutMs: number): Promise<void> {
  const started = Date.now();
  const candidates = pages.filter((p) => p.token && verificationDue(previous.get(p.externalId), started));
  const eligible = orderForSubscribe(candidates.map((p) => ({ id: p.externalId, page: p })), previous).slice(0, MAX_LEADGEN_SUBSCRIBES);
  const callMs = () => Math.max(1, Math.min(callTimeoutMs, deadline - Date.now()));
  const save = async (page: Found, sub: LeadgenSubscription) => {
    page.meta.leadgenSubscription = sub;
    const res = await prisma.metaAsset
      .updateMany({
        where: { tenantId, connectionId, type: "page", externalId: page.externalId, status: "active", connection: { is: { status: { not: "revoked" } } } },
        data: { meta: page.meta as object },
      })
      .catch(() => undefined);
    if (res && res.count === 0 && sub.status === "subscribed" && (await disconnectedMeanwhile(tenantId, connectionId))) {
      // If the lookup fails, leave the Page subscribed: removing a subscription another workspace relies on is worse.
      const shared = await pagesLiveElsewhere(prisma, tenantId, [page.externalId]).catch(() => new Set([page.externalId]));
      if (!shared.has(page.externalId)) await unsubscribePageFromApp(page.externalId, page.token as string, callMs());
    }
  };
  await runPool(eligible, SUBSCRIBE_CONCURRENCY, deadline, async ({ page }) => {
    if (await disconnectedMeanwhile(tenantId, connectionId)) return;
    const prior = previous.get(page.externalId);
    if (prior?.status === "subscribed") {
      const check = await checkPageSubscription(page.externalId, page.token as string, callMs());
      if (check === "unknown") return;
      if (check === "subscribed") return save(page, { ...prior, verifiedAt: new Date().toISOString() });
      await save(page, { status: "pending", at: new Date().toISOString(), reason: "The subscription was no longer listed at Meta." });
    }
    await save(page, await subscribePageToLeadgen(page.externalId, page.token as string, callMs()));
  });
}

type TenantReader = Pick<Prisma.TransactionClient, "metaAsset" | "tenant">;

/** Ids of the given workspaces that are active and not deleted. */
export async function activeTenantIds(client: Pick<Prisma.TransactionClient, "tenant">, ids: string[]): Promise<Set<string>> {
  if (ids.length === 0) return new Set();
  const rows = (await client.tenant.findMany({ where: { id: { in: ids }, status: "active", deletedAt: null }, select: { id: true } })) ?? [];
  return new Set(rows.map((r) => r.id));
}

/** Pages that another active workspace still uses; their lead-alert subscription belongs to the Page and must stay. */
export async function pagesLiveElsewhere(client: TenantReader, tenantId: string, pageIds: string[]): Promise<Set<string>> {
  if (pageIds.length === 0) return new Set();
  const rows = (await client.metaAsset.findMany({ where: { type: "page", externalId: { in: pageIds }, status: "active", tenantId: { not: tenantId } }, select: { tenantId: true, externalId: true } })) ?? [];
  const active = await activeTenantIds(client, [...new Set(rows.map((r) => r.tenantId))]);
  return new Set(rows.filter((r) => active.has(r.tenantId)).map((r) => r.externalId));
}

export type VerifyResult = { checked: number; reset: number };

/**
 * For the health worker: reads back the Pages of one connection whose stored status is "subscribed" and was last confirmed
 * more than 24 hours ago, and sets the ones Meta no longer lists back to pending. It does not re-subscribe (the next refresh
 * does). An inconclusive answer changes nothing. Stops starting new checks at the deadline.
 */
export async function verifyLeadSubscriptions(tenantId: string, connectionId: string, opts: { deadline?: number; now?: number } = {}): Promise<VerifyResult> {
  const now = opts.now ?? Date.now();
  const rows =
    (await prisma.metaAsset.findMany({
      where: { tenantId, connectionId, type: "page", status: "active", tokenEnc: { not: null } },
      select: { id: true, externalId: true, tokenEnc: true, meta: true },
      take: 500,
    })) ?? [];
  const due = rows
    .filter((r) => subOf(r.meta)?.status === "subscribed" && verificationDue(subOf(r.meta), now))
    .sort((a, b) => atMs(subOf(a.meta)) - atMs(subOf(b.meta)))
    .slice(0, MAX_LEADGEN_SUBSCRIBES);
  let reset = 0;
  const checked = await runPool(due, SUBSCRIBE_CONCURRENCY, opts.deadline ?? now + SUBSCRIBE_BUDGET_MS, async (row) => {
    let check: SubscriptionCheck;
    try {
      check = await checkPageSubscription(row.externalId, openSecret(tenantId, row.tokenEnc as string));
    } catch {
      return;
    }
    if (check === "unknown") return;
    const at = new Date().toISOString();
    const sub: LeadgenSubscription =
      check === "subscribed" ? { ...(subOf(row.meta) as LeadgenSubscription), verifiedAt: at } : { status: "pending", at, reason: "The subscription was no longer listed at Meta." };
    if (check === "missing") reset++;
    await prisma.metaAsset.updateMany({ where: { id: row.id, tenantId, status: "active" }, data: { meta: { ...(row.meta as object), leadgenSubscription: sub } as object } }).catch(() => undefined);
  });
  return { checked, reset };
}

async function safe(run: () => Promise<Part>): Promise<Part> {
  try {
    return await run();
  } catch {
    return { found: [], types: [] };
  }
}

export type DiscoveryResult = { businessId: string | null; counts: Record<string, number> };

/** Rediscovers everything the token can see, upserts by (tenantId, type, externalId), and marks assets no longer returned inactive for the types that were read completely. */
export async function discoverAssets(tenantId: string, connectionId: string, token: string, opts: DiscoverOptions = {}): Promise<DiscoveryResult> {
  const startedAt = Date.now();
  const businesses = await discoverBusinesses(token);
  const pages = await safe(() => discoverPages(token));
  const ads = await safe(() => discoverAdAccounts(token));
  const datasets = await safe(() => discoverDatasets(token, ads.found));
  const catalogs = await safe(() => discoverCatalogs(token, businesses));
  const parts = [pages, ads, datasets, catalogs];
  const found = parts.flatMap((r) => r.found);
  const pageAssets = found.filter((f) => f.type === "page");
  const metas = await previousMetas(tenantId, found.map((f) => f.externalId));
  const previous = subscriptionsOf(metas, pageAssets.map((p) => p.externalId));
  const now = new Date().toISOString();
  for (const page of pageAssets) page.meta.leadgenSubscription = previous.get(page.externalId) ?? { status: "pending", at: now };
  // A block this listing does not read (C2 to C6) keeps what the previous run stored until its own read succeeds.
  for (const a of found) a.meta = mergeMeta(a.meta, carriedBlocks(a.type, metas.get(a.externalId)));

  for (const a of found) {
    const data = {
      connectionId,
      name: a.name,
      status: "active",
      meta: { ...a.meta } as object,
      ...(a.token ? { tokenEnc: sealSecret(tenantId, a.token) } : {}),
    };
    await prisma.metaAsset.upsert({
      where: { tenantId_type_externalId: { tenantId, type: a.type, externalId: a.externalId } },
      create: { tenantId, type: a.type, externalId: a.externalId, ...data },
      update: data,
    });
  }
  // Page-backed Instagram identities are not in the Pages listing; they stay as long as their Page is listed, until C3 says otherwise.
  const pageBacked = pageAssets.map((p) => p.meta.pageBackedIgId).filter((id): id is string => typeof id === "string");
  for (const type of parts.flatMap((r) => r.types)) {
    const seen = found.filter((f) => f.type === type).map((f) => f.externalId);
    await prisma.metaAsset.updateMany({
      where: { tenantId, connectionId, type, status: "active", externalId: { notIn: type === "instagram" ? [...seen, ...pageBacked] : seen } },
      data: { status: "inactive" },
    });
  }
  // The budget covers the whole discovery, not just this phase: what the listing calls used is not available to subscribing.
  const deadline = startedAt + (opts.subscribeBudgetMs ?? SUBSCRIBE_BUDGET_MS);
  const callTimeoutMs = opts.subscribeCallTimeoutMs ?? SUBSCRIBE_CALL_TIMEOUT_MS;
  // Lead alerts first; the readiness reads get what is left of the same budget, so the request still ends on time.
  await subscribePages(tenantId, connectionId, pageAssets, previous, deadline, callTimeoutMs).catch(() => undefined);
  await enrichAssets({ tenantId, connectionId, userToken: token, deadline, callTimeoutMs, metaDeps: opts.promoteMeta }, found, metas).catch(() => undefined);
  const counts: Record<string, number> = {};
  for (const f of found) counts[f.type] = (counts[f.type] ?? 0) + 1;
  return { businessId: businesses.rows[0]?.id ?? null, counts };
}
