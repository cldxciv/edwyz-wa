import { prisma } from "@/lib/db";
import { graphFetchAs } from "@/lib/graph";
import { openSecret, sealSecret } from "@/lib/crypto/secrets";
import type { Prisma } from "@/generated/prisma/client";
import type { AssetType } from "./index";

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
type PageRow = { id: string; name?: string; access_token?: string; tasks?: string[]; instagram_business_account?: { id: string; username?: string; name?: string } };
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

async function discoverPages(token: string): Promise<Part> {
  const res = await fetchAll<PageRow>(token, "me/accounts", "id,name,access_token,tasks,instagram_business_account{id,username,name}");
  const found: Found[] = [];
  for (const p of res.items) {
    found.push({ type: "page", externalId: p.id, name: p.name ?? null, token: p.access_token, meta: { tasks: p.tasks ?? [] } });
    const ig = p.instagram_business_account;
    if (ig?.id) found.push({ type: "instagram", externalId: ig.id, name: ig.username ?? ig.name ?? null, token: p.access_token, meta: { pageId: p.id, username: ig.username ?? null } });
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

async function previousSubscriptions(tenantId: string, ids: string[]): Promise<Map<string, LeadgenSubscription>> {
  const out = new Map<string, LeadgenSubscription>();
  if (ids.length === 0) return out;
  try {
    const rows = (await prisma.metaAsset.findMany({ where: { tenantId, type: "page", externalId: { in: ids } }, select: { externalId: true, meta: true } })) ?? [];
    for (const r of rows) {
      const sub = (r.meta as { leadgenSubscription?: LeadgenSubscription } | null)?.leadgenSubscription;
      if (sub && typeof sub.status === "string") out.set(r.externalId, sub);
    }
  } catch {
    return new Map();
  }
  return out;
}

export type DiscoverOptions = { subscribeBudgetMs?: number; subscribeCallTimeoutMs?: number };

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
  const previous = await previousSubscriptions(tenantId, pageAssets.map((p) => p.externalId));
  const now = new Date().toISOString();
  for (const page of pageAssets) page.meta.leadgenSubscription = previous.get(page.externalId) ?? { status: "pending", at: now };

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
  for (const type of parts.flatMap((r) => r.types)) {
    const seen = found.filter((f) => f.type === type).map((f) => f.externalId);
    await prisma.metaAsset.updateMany({
      where: { tenantId, connectionId, type, status: "active", externalId: { notIn: seen } },
      data: { status: "inactive" },
    });
  }
  // The budget covers the whole discovery, not just this phase: what the listing calls used is not available to subscribing.
  const deadline = startedAt + (opts.subscribeBudgetMs ?? SUBSCRIBE_BUDGET_MS);
  await subscribePages(tenantId, connectionId, pageAssets, previous, deadline, opts.subscribeCallTimeoutMs ?? SUBSCRIBE_CALL_TIMEOUT_MS).catch(() => undefined);
  const counts: Record<string, number> = {};
  for (const f of found) counts[f.type] = (counts[f.type] ?? 0) + 1;
  return { businessId: businesses.rows[0]?.id ?? null, counts };
}
