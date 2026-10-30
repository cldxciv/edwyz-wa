import { prisma } from "@/lib/db";
import { siteUrl } from "@/lib/config";
import { openSecret, sealSecret } from "@/lib/crypto/secrets";
import { createLimiter } from "@/lib/ratelimit";
import { HttpError } from "@/lib/tenancy";
import { verifyShopOwnership, isAdminToken } from "./admin-verify";
import { claimShopDomain, demoteUnverified, holdsClaim, isUniqueViolation, releaseShopDomain } from "./claims";
import { deleteSettings } from "./settings";
import { normalizeShopDomain } from "./shop";
import { forgetMissing } from "./webhook-guard";

const STATUSES = ["active", "disabled"];
export const PENDING = "pending_verification";

type StoreRow = { id: string; shopDomain: string; status: string; webhookSecretEnc: string | null; createdAt: Date };

const select = { id: true, shopDomain: true, status: true, webhookSecretEnc: true, createdAt: true } as const;

export const webhookUrl = () => `${siteUrl()}/webhooks/shopify`;

function present(row: StoreRow) {
  return {
    id: row.id,
    shopDomain: row.shopDomain,
    status: row.status,
    verified: row.status === "active",
    hasWebhookSecret: Boolean(row.webhookSecretEnc),
    createdAt: row.createdAt,
    webhookUrl: webhookUrl(),
  };
}

function secretField(value: unknown, field: string, min: number): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "string" || /\s/.test(value.trim()) || value.trim().length < min || value.length > 300) {
    throw new HttpError(400, `${field} looks invalid.`);
  }
  return value.trim();
}

function adminToken(value: unknown): string | undefined {
  if (value === undefined || value === null || value === "") return undefined;
  if (!isAdminToken(value)) throw new HttpError(422, "The Admin API access token looks invalid. Copy it again from the custom app in your Shopify admin.");
  return value.trim();
}

export async function listStores(tenantId: string) {
  const rows = await prisma.shopifyStore.findMany({ where: { tenantId }, orderBy: { createdAt: "asc" }, select });
  return rows.map(present);
}

export async function getStore(tenantId: string, id: string) {
  const row = await prisma.shopifyStore.findFirst({ where: { id, tenantId }, select });
  if (!row) throw new HttpError(404, "Store not found.");
  return present(row);
}

type VerifyDeps = Parameters<typeof verifyShopOwnership>[2];
type Written = { tokenEnc?: string; webhookSecretEnc?: string };

// Each check is an outbound request to Shopify, so a workspace gets a handful per ten minutes.
const checkLimiter = createLimiter(12, 10 * 60_000, "shopify-ownership");
export const resetOwnershipChecks = () => checkLimiter.clear();

async function proveOwnership(tenantId: string, shopDomain: string, token: string, deps: VerifyDeps) {
  if (!checkLimiter.consume(tenantId)) throw new HttpError(429, "Too many verification attempts. Wait a few minutes and try again.");
  await verifyShopOwnership(shopDomain, token, deps);
}

/**
 * Takes the domain claim and makes the store active, writing `data` (a rotated token, a new webhook secret) in the same update. Call only
 * after verifyShopOwnership succeeded for this shop. The newest proof wins: a claim held by another workspace is taken over and its store
 * goes back to pending_verification (see claimShopDomain), as does every other active store for the domain without a claim, which covers
 * stores that were active before ownership proof existed. `from` is the status the store was read in; nothing is written when it changed
 * meanwhile, and a claim lost to a concurrent takeover puts the store back in the status it was read in (an active store goes to pending), so the claim holder is the only active store.
 */
async function activateVerified(tenantId: string, id: string, shopDomain: string, from: string, data: Written = {}): Promise<void> {
  if (!(await claimShopDomain(shopDomain, tenantId, id, { takeover: true }))) throw new HttpError(409, "Another workspace is verifying this store right now. Try again in a moment.");
  const { count } = await prisma.shopifyStore.updateMany({ where: { id, tenantId, status: from }, data: { ...data, status: "active" } });
  if (count === 0) {
    await releaseShopDomain(shopDomain, id);
    throw new HttpError(409, "The store changed while it was being verified. Try again.");
  }
  if (!(await holdsClaim(shopDomain, id))) {
    await prisma.shopifyStore.updateMany({ where: { id, tenantId, status: "active" }, data: { status: from === "active" ? PENDING : from } });
    throw new HttpError(409, "Another workspace verified this store at the same moment. Try again in a moment.");
  }
  await demoteUnverified(shopDomain, id);
  forgetMissing(shopDomain);
}

/**
 * Stores the pasted webhook signing secret and Admin API access token sealed (never returned). Ownership is proven first: the token is used
 * for GET /admin/api/<version>/shop.json on the shop's own host and Shopify must name the same myshopify domain. Only then is the store
 * created active and the domain claimed; on any failure (422) nothing is stored. Without a token (older clients) the store stays
 * pending_verification, receives nothing, claims nothing, and is verified later with verifyStore or updateStore { accessToken }. A
 * signature made with a secret the caller chose proves nothing about the shop, so webhooks never activate a store.
 */
export async function connectStore(tenantId: string, raw: Record<string, unknown>, deps: VerifyDeps = {}) {
  const shopDomain = normalizeShopDomain(raw.shopDomain);
  if (!shopDomain) throw new HttpError(400, "Enter the myshopify.com domain, for example my-store.myshopify.com.");
  const webhookSecret = secretField(raw.webhookSecret, "webhookSecret", 8);
  if (!webhookSecret) throw new HttpError(400, "The webhook signing secret is required.");
  const token = adminToken(raw.accessToken);

  const mine = await prisma.shopifyStore.findFirst({ where: { shopDomain, tenantId }, select: { id: true } });
  if (mine) throw new HttpError(409, "This store is already connected.");
  if (token) await proveOwnership(tenantId, shopDomain, token, deps);

  let row: StoreRow;
  try {
    row = await prisma.shopifyStore.create({
      data: { tenantId, shopDomain, status: PENDING, tokenEnc: sealSecret(tenantId, token ?? ""), webhookSecretEnc: sealSecret(tenantId, webhookSecret) },
      select,
    });
  } catch (e) {
    if (isUniqueViolation(e)) throw new HttpError(409, "This store is already connected.");
    throw e;
  }
  forgetMissing(shopDomain);
  if (!token) return present(row);
  try {
    await activateVerified(tenantId, row.id, shopDomain, PENDING);
  } catch (e) {
    await prisma.shopifyStore.deleteMany({ where: { id: row.id, tenantId } });
    throw e;
  }
  return getStore(tenantId, row.id);
}

/** The Admin API token saved with the store, when there is a usable one (older rows hold none). */
function storedToken(tenantId: string, tokenEnc: string | null | undefined): string | null {
  if (!tokenEnc) return null;
  try {
    const value = openSecret(tenantId, tokenEnc);
    return isAdminToken(value) ? value.trim() : null;
  } catch {
    return null;
  }
}

const NEEDS_TOKEN = "Paste the store's Admin API access token to verify it.";
const tokenSelect = { id: true, shopDomain: true, status: true, tokenEnc: true } as const;

/**
 * Verifies an already-created store (POST /api/commerce/stores/[id]/verify): calls Shopify with the pasted token, or with the one saved
 * with the store when none is sent. A pending store becomes active, and an active store (every store from before ownership proof
 * included) takes the domain claim and demotes the other unproven stores for it. A pasted token replaces the saved one only once Shopify
 * has accepted it. A paused store is resumed through updateStore.
 */
export async function verifyStore(tenantId: string, id: string, raw: Record<string, unknown>, deps: VerifyDeps = {}) {
  const row = await prisma.shopifyStore.findFirst({ where: { id, tenantId }, select: tokenSelect });
  if (!row) throw new HttpError(404, "Store not found.");
  if (row.status !== PENDING && row.status !== "active") throw new HttpError(409, "This store is paused. Resume it to verify it again.");
  const supplied = adminToken(raw.accessToken);
  const token = supplied ?? storedToken(tenantId, row.tokenEnc);
  if (!token) throw new HttpError(422, NEEDS_TOKEN);
  await proveOwnership(tenantId, row.shopDomain, token, deps);
  await activateVerified(tenantId, id, row.shopDomain, row.status, supplied ? { tokenEnc: sealSecret(tenantId, supplied) } : {});
  return getStore(tenantId, id);
}

/**
 * PATCH. Anything that needs proof of ownership goes through Shopify before a byte is written, and verification and activation are one
 * step, so a failure (422 or 409) leaves the store exactly as it was.
 * - status "active" on a paused or pending store, or a pasted accessToken on a pending or active store: verify, then activate.
 * - accessToken on a paused store without a status: verify and save the new token; the store stays paused.
 * - status "disabled": no check; the domain claim is released. A token cannot be sent with it (400), it would be dropped silently.
 * - webhookSecret alone: saved as is.
 */
export async function updateStore(tenantId: string, id: string, raw: Record<string, unknown>, deps: VerifyDeps = {}) {
  const row = await prisma.shopifyStore.findFirst({ where: { id, tenantId }, select: tokenSelect });
  if (!row) throw new HttpError(404, "Store not found.");
  if (raw.status === undefined && raw.webhookSecret === undefined && raw.accessToken === undefined) throw new HttpError(400, "Nothing to update.");
  let want: string | undefined;
  if (raw.status !== undefined) {
    if (typeof raw.status !== "string" || !STATUSES.includes(raw.status)) throw new HttpError(400, "status must be active or disabled.");
    want = raw.status;
  }
  const supplied = adminToken(raw.accessToken);
  if (want === "disabled" && supplied) throw new HttpError(400, "Send the access token in a separate request from disabling the store.");
  const secret = secretField(raw.webhookSecret, "webhookSecret", 8);

  const data: Written & { status?: string } = {};
  if (secret) data.webhookSecretEnc = sealSecret(tenantId, secret);
  if (supplied) data.tokenEnc = sealSecret(tenantId, supplied);

  const activate = (want === "active" && row.status !== "active") || (Boolean(supplied) && row.status !== "disabled");
  if (activate || (supplied && row.status === "disabled")) {
    const token = supplied ?? storedToken(tenantId, row.tokenEnc);
    if (!token) throw new HttpError(422, NEEDS_TOKEN);
    await proveOwnership(tenantId, row.shopDomain, token, deps);
  }
  if (activate) {
    await activateVerified(tenantId, id, row.shopDomain, row.status, data);
    return getStore(tenantId, id);
  }
  if (want === "disabled" && row.status !== "disabled") data.status = "disabled";
  if (Object.keys(data).length > 0) {
    const { count } = await prisma.shopifyStore.updateMany({ where: { id, tenantId }, data });
    if (count === 0) throw new HttpError(404, "Store not found.");
    if (data.status === "disabled") await releaseShopDomain(row.shopDomain, id);
  }
  forgetMissing(row.shopDomain);
  return getStore(tenantId, id);
}

export async function deleteStore(tenantId: string, id: string) {
  const row = await prisma.shopifyStore.findFirst({ where: { id, tenantId }, select: { shopDomain: true } });
  const { count } = await prisma.shopifyStore.deleteMany({ where: { id, tenantId } });
  if (count === 0) throw new HttpError(404, "Store not found.");
  if (row) {
    await releaseShopDomain(row.shopDomain, id);
    forgetMissing(row.shopDomain);
  }
  await deleteSettings(tenantId, id);
}

/** The store's webhook signing secret, or null when missing or unreadable. */
export function storeWebhookSecret(store: { tenantId: string; webhookSecretEnc: string | null }): string | null {
  if (!store.webhookSecretEnc) return null;
  try {
    return openSecret(store.tenantId, store.webhookSecretEnc);
  } catch {
    return null;
  }
}
