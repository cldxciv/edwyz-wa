import { prisma } from "@/lib/db";
import { GraphError, graphFetchAs } from "@/lib/graph";
import { getAssetAccess, listAssets } from "@/lib/meta-connect";
import { sanitizeMessage } from "@/lib/safe-error";
import { HttpError } from "@/lib/tenancy";

/*
 * Read-only Graph pickers for the campaign wizard, so nobody has to paste Meta ids (docs/IG-PAGE-ADS-SPEC.md): the Page's
 * published posts, the Instagram account's media, the Page's lead forms (registered as LeadForm rows, so their consent
 * settings apply from the first lead), and Meta's interest and city search. Every call is a GET with the asset's own
 * token; nothing here writes to Meta. Field names marked VERIFY must be checked against the pinned GRAPH_API_VERSION.
 */

export const PICKER_KINDS = ["posts", "instagram_media", "lead_forms", "interests", "cities"] as const;
export type PickerKind = (typeof PICKER_KINDS)[number];
export const isPickerKind = (v: unknown): v is PickerKind => typeof v === "string" && (PICKER_KINDS as readonly string[]).includes(v);

export type PostItem = { id: string; text: string; createdAt: string | null; picture: string | null; link: string | null; eligible: boolean | null };
export type MediaItem = { id: string; caption: string; mediaType: string; picture: string | null; link: string | null; createdAt: string | null };
export type LeadFormItem = { id: string; metaFormId: string; name: string; status: string; active: boolean; pageAssetId: string; pageName: string | null };
export type InterestItem = { id: string; name: string; audienceLow: number | null; audienceHigh: number | null; path: string[] };
export type CityItem = { key: string; name: string; region: string | null; countryCode: string | null };

const LIST_LIMIT = "25";
const FORM_LIMIT = "100";
const MAX_QUERY = 100;
// VERIFY: is_eligible_for_promotion on Page posts; Instagram media eligibility is checked by Meta when the ad is created.
export const POST_FIELDS = "id,message,created_time,full_picture,permalink_url,is_eligible_for_promotion";
export const MEDIA_FIELDS = "id,caption,media_type,media_url,thumbnail_url,permalink,timestamp";
export const FORM_FIELDS = "id,name,status,created_time";

type Page<T> = { data?: T[] };
const text = (v: unknown, max: number) => (typeof v === "string" ? v.trim().slice(0, max) : "");
const opt = (v: unknown, max = 1000) => text(v, max) || null;
const num = (v: unknown) => (typeof v === "number" && Number.isFinite(v) ? v : typeof v === "string" && /^\d+$/.test(v) ? Number(v) : null);

/** Meta's refusals in words a shop owner can act on. The login wording matches the wizard's reconnect hint. */
function friendly(e: unknown): HttpError {
  if (e instanceof HttpError) return e;
  if (e instanceof GraphError) {
    if (e.code === 190 || e.status === 401) return new HttpError(409, "The saved Facebook login no longer works (access token expired or removed). Reconnect under Meta connections.");
    if (e.code === 10 || (e.code !== undefined && e.code >= 200 && e.code < 300) || e.status === 403) {
      return new HttpError(409, "Meta did not give this workspace permission to read that. Reconnect your Facebook login and allow access to your Pages, Instagram accounts and ad accounts.");
    }
    if (e.retryable || e.status >= 500 || e.status === 429) return new HttpError(503, "Meta could not answer right now. Try again in a minute.");
    return new HttpError(502, `Meta refused the request: ${sanitizeMessage(e.message)}`);
  }
  return new HttpError(502, "Meta could not answer right now. Try again in a minute.");
}

async function read<T>(token: string, path: string, query: Record<string, string>): Promise<T[]> {
  try {
    const res = await graphFetchAs<Page<T>>(token, { path, method: "GET", query });
    return Array.isArray(res?.data) ? res.data : [];
  } catch (e) {
    throw friendly(e);
  }
}

/** A connected, active asset of the workspace, by its row id. */
async function connectedAsset(tenantId: string, type: "page" | "instagram" | "ad_account", assetId: unknown) {
  const label = type === "page" ? "Facebook Page" : type === "instagram" ? "Instagram account" : "ad account";
  if (typeof assetId !== "string" || !assetId) throw new HttpError(400, `Choose a ${label} first.`);
  const asset = (await listAssets(tenantId, type)).find((a) => a.id === assetId);
  if (!asset) throw new HttpError(404, `That ${label} is not connected to this workspace.`);
  if (asset.status !== "active") throw new HttpError(409, `That ${label} is no longer available on the connected Meta account. Reconnect it in Meta connections.`);
  return asset;
}

const tokenOf = async (tenantId: string, assetId: string) => (await getAssetAccess(tenantId, assetId)).token;

/** A search term: trimmed, at least two characters. */
export function searchTerm(q: unknown): string {
  const term = text(q, MAX_QUERY);
  if (term.length < 2) throw new HttpError(400, "Type at least two letters to search.");
  return term;
}

/** The Page's latest published posts, newest first. */
export async function listPagePosts(tenantId: string, pageAssetId: unknown): Promise<PostItem[]> {
  const page = await connectedAsset(tenantId, "page", pageAssetId);
  const rows = await read<Record<string, unknown>>(await tokenOf(tenantId, page.id), `${page.externalId}/published_posts`, { fields: POST_FIELDS, limit: LIST_LIMIT });
  return rows
    .filter((r) => typeof r.id === "string" && r.id)
    .map((r) => ({
      id: String(r.id),
      text: text(r.message, 200),
      createdAt: opt(r.created_time, 40),
      picture: opt(r.full_picture),
      link: opt(r.permalink_url),
      eligible: typeof r.is_eligible_for_promotion === "boolean" ? r.is_eligible_for_promotion : null,
    }));
}

/** The Instagram account's latest posts and reels, newest first. */
export async function listInstagramMedia(tenantId: string, instagramAssetId: unknown): Promise<MediaItem[]> {
  const ig = await connectedAsset(tenantId, "instagram", instagramAssetId);
  const rows = await read<Record<string, unknown>>(await tokenOf(tenantId, ig.id), `${ig.externalId}/media`, { fields: MEDIA_FIELDS, limit: LIST_LIMIT });
  return rows
    .filter((r) => typeof r.id === "string" && r.id)
    .map((r) => ({
      id: String(r.id),
      caption: text(r.caption, 200),
      mediaType: text(r.media_type, 40) || "IMAGE",
      picture: opt(r.thumbnail_url) ?? opt(r.media_url),
      link: opt(r.permalink),
      createdAt: opt(r.timestamp, 40),
    }));
}

const isUniqueViolation = (e: unknown) => (e as { code?: unknown })?.code === "P2002";

/**
 * The Page's lead forms. Each one is registered as a LeadForm row of the workspace (idempotent: a known form only gets its
 * name and status filled in), so it shows on the Lead forms page before its first lead. Only ACTIVE forms can be used in
 * an ad.
 */
export async function listLeadForms(tenantId: string, pageAssetId: unknown): Promise<LeadFormItem[]> {
  const page = await connectedAsset(tenantId, "page", pageAssetId);
  const rows = (await read<Record<string, unknown>>(await tokenOf(tenantId, page.id), `${page.externalId}/leadgen_forms`, { fields: FORM_FIELDS, limit: FORM_LIMIT })).filter(
    (r) => typeof r.id === "string" && /^[A-Za-z0-9_-]{1,64}$/.test(r.id),
  );
  if (rows.length === 0) return [];
  const ids = rows.map((r) => String(r.id));
  const known = new Map((await prisma.leadForm.findMany({ where: { tenantId, metaFormId: { in: ids } }, select: { id: true, metaFormId: true, name: true, status: true } })).map((f) => [f.metaFormId, f]));
  const out: LeadFormItem[] = [];
  for (const r of rows) {
    const metaFormId = String(r.id);
    const name = text(r.name, 120) || null;
    const status = (text(r.status, 20) || "ACTIVE").toLowerCase();
    let row = known.get(metaFormId);
    if (!row) {
      try {
        row = await prisma.leadForm.create({ data: { tenantId, pageAssetId: page.id, metaFormId, name, status }, select: { id: true, metaFormId: true, name: true, status: true } });
      } catch (e) {
        if (!isUniqueViolation(e)) throw e;
        row = (await prisma.leadForm.findFirst({ where: { tenantId, metaFormId }, select: { id: true, metaFormId: true, name: true, status: true } })) ?? undefined;
        if (!row) continue;
      }
    } else if ((!row.name && name) || row.status !== status) {
      await prisma.leadForm.updateMany({ where: { id: row.id, tenantId }, data: { ...(!row.name && name ? { name } : {}), status } });
      row = { ...row, name: row.name ?? name, status };
    }
    out.push({ id: row.id, metaFormId, name: row.name ?? name ?? "Untitled form", status, active: status === "active", pageAssetId: page.id, pageName: page.name });
  }
  return out;
}

/** Lead forms of every connected Page (the Lead forms page's "Find my forms"). A Page Meta refuses is reported, not fatal. */
export async function listAllLeadForms(tenantId: string): Promise<{ items: LeadFormItem[]; problems: string[] }> {
  const pages = (await listAssets(tenantId, "page")).filter((p) => p.status === "active");
  const items: LeadFormItem[] = [];
  const problems: string[] = [];
  for (const p of pages) {
    try {
      items.push(...(await listLeadForms(tenantId, p.id)));
    } catch (e) {
      problems.push(`${p.name ?? "A Facebook Page"}: ${e instanceof HttpError ? e.message : "Meta could not answer right now."}`);
    }
  }
  return { items, problems };
}

/** Meta's interest search by name (detailed targeting), with the ad account's login. */
export async function searchInterests(tenantId: string, adAccountAssetId: unknown, q: unknown): Promise<InterestItem[]> {
  const account = await connectedAsset(tenantId, "ad_account", adAccountAssetId);
  const rows = await read<Record<string, unknown>>(await tokenOf(tenantId, account.id), "search", { type: "adinterest", q: searchTerm(q), limit: LIST_LIMIT });
  return rows
    .filter((r) => (typeof r.id === "string" || typeof r.id === "number") && /^\d+$/.test(String(r.id)) && typeof r.name === "string")
    .map((r) => ({
      id: String(r.id),
      name: text(r.name, 100),
      audienceLow: num(r.audience_size_lower_bound),
      audienceHigh: num(r.audience_size_upper_bound),
      path: Array.isArray(r.path) ? r.path.filter((x): x is string => typeof x === "string").slice(0, 5) : [],
    }));
}

/** Meta's location search for cities, optionally inside one country (two-letter code). */
export async function searchCities(tenantId: string, adAccountAssetId: unknown, q: unknown, country?: unknown): Promise<CityItem[]> {
  const account = await connectedAsset(tenantId, "ad_account", adAccountAssetId);
  const query: Record<string, string> = { type: "adgeolocation", location_types: JSON.stringify(["city"]), q: searchTerm(q), limit: LIST_LIMIT };
  if (typeof country === "string" && /^[A-Za-z]{2}$/.test(country)) query.country_code = country.toUpperCase();
  const rows = await read<Record<string, unknown>>(await tokenOf(tenantId, account.id), "search", query);
  return rows
    .filter((r) => (typeof r.key === "string" || typeof r.key === "number") && String(r.key) && typeof r.name === "string" && (r.type === undefined || r.type === "city"))
    .map((r) => ({ key: String(r.key), name: text(r.name, 100), region: opt(r.region, 100), countryCode: opt(r.country_code, 2) }));
}
