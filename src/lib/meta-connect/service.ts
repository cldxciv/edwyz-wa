import { audit } from "@/lib/auth/audit";
import { GRAPH_API_VERSION, siteUrl } from "@/lib/config";
import { openSecret, sealSecret } from "@/lib/crypto/secrets";
import { prisma } from "@/lib/db";
import { appGraphFetch, graphFetchAs } from "@/lib/graph";
import { describeError } from "@/lib/safe-error";
import { formatMinor } from "@/lib/spend/money";
import { HttpError, type Actor } from "@/lib/tenancy";
import type { Prisma } from "@/generated/prisma/client";
import { activeTenantIds, discoverAssets, pagesLiveElsewhere, runPool, SUBSCRIBE_CONCURRENCY, unsubscribePageFromApp } from "./discovery";
import { missingScopes, scopeSummary, unusedScopes } from "./scopes";
import { consumeState, issueState } from "./state";

export const EXPIRING_SOON_MS = 7 * 86_400_000;

/**
 * Total time discovery may take inside the OAuth callback or a refresh request. The default of 60 seconds
 * (SUBSCRIBE_BUDGET_MS) equals the nginx proxy_read_timeout in front of these routes, so a request that used all of it
 * would be cut off with a 504 after the work was done. Requests stop 15 seconds earlier; the Pages left over keep their pending
 * or failed status and are subscribed by the next refresh. The health worker has no such limit.
 */
export const REQUEST_DISCOVERY_BUDGET_MS = 45_000;

export const redirectUri = () => `${siteUrl()}/api/meta-connect/callback`;

/**
 * Facebook Login for Business in a popup (docs/EDDY-SPEC.md 12.1a decision 11). A popup attempt carries this marker after
 * the signed state, so the callback answers with a small page that tells the opener the outcome and closes, instead of
 * the full-page redirect (which stays the fallback when the browser blocks the popup).
 *
 * The marker sits outside the signed part on purpose. It only chooses the shape of the answer: a page that posts one
 * outcome word ("connected", "cancelled" or "failed") to this site's own origin, or the redirect. It never changes what is
 * connected, and the signed, session-bound, single-use part is verified exactly as before.
 */
export const POPUP_STATE_MARKER = ".popup";

/**
 * What the popup's closing page and its opener agree on: the message `source`, the BroadcastChannel name and the meta tag
 * the opener reads when the page's script cannot run. src/components/meta-connect/useFacebookLoginPopup.ts holds the same
 * values (it is browser code and cannot import this file); tests/eddy-guides.test.ts pins both.
 */
export const CONNECT_POPUP = { source: "edwyz-meta-connect", channel: "edwyz-meta-connect", meta: "edwyz-meta-connect" } as const;
export type ConnectPopupOutcome = "connected" | "cancelled" | "failed";

/** The signed state and whether the attempt runs in a popup. */
export function splitConnectState(raw: string | null | undefined): { state: string | null; popup: boolean } {
  if (typeof raw !== "string" || raw.length === 0) return { state: null, popup: false };
  if (raw.endsWith(POPUP_STATE_MARKER)) return { state: raw.slice(0, -POPUP_STATE_MARKER.length), popup: true };
  return { state: raw, popup: false };
}

export async function startConnect(actor: Actor, opts: { popup?: boolean } = {}): Promise<{ url: string }> {
  const { META_APP_ID: appId, META_LOGIN_CONFIG_ID: configId } = process.env;
  if (!appId || !configId) throw new HttpError(503, "Meta connection is not configured yet.");
  const signed = await issueState(actor.tenantId, actor.userId);
  const state = opts.popup ? `${signed}${POPUP_STATE_MARKER}` : signed;
  const params = new URLSearchParams({
    client_id: appId,
    redirect_uri: redirectUri(),
    state,
    config_id: configId,
    response_type: "code",
    override_default_response_type: "true",
  });
  await audit({ tenantId: actor.tenantId, userId: actor.userId, action: "meta_connect.started" });
  return { url: `https://www.facebook.com/${GRAPH_API_VERSION}/dialog/oauth?${params.toString()}` };
}

type TokenResponse = { access_token?: string; expires_in?: number };
export type DebugInfo = { valid: boolean; userId: string | null; scopes: string[]; expiresAt: Date | null };

const appToken = () => `${process.env.META_APP_ID}|${process.env.META_APP_SECRET}`;

export async function debugToken(token: string): Promise<DebugInfo> {
  const res = await graphFetchAs<{ data?: { is_valid?: boolean; user_id?: string; scopes?: string[]; expires_at?: number } }>(appToken(), {
    path: "debug_token",
    query: { input_token: token },
  });
  const d = res?.data;
  return {
    valid: d?.is_valid === true,
    userId: typeof d?.user_id === "string" ? d.user_id : null,
    scopes: Array.isArray(d?.scopes) ? d.scopes : [],
    expiresAt: d?.expires_at ? new Date(d.expires_at * 1000) : null,
  };
}

async function exchangeForLongLived(code: string): Promise<{ token: string; expiresAt: Date | null }> {
  const short = await appGraphFetch<TokenResponse>({ path: "oauth/access_token", query: { code, redirect_uri: redirectUri() } });
  if (!short?.access_token) throw new HttpError(502, "Meta did not return an access token.");
  const long = await appGraphFetch<TokenResponse>({
    path: "oauth/access_token",
    query: { grant_type: "fb_exchange_token", fb_exchange_token: short.access_token },
  });
  if (!long?.access_token) throw new HttpError(502, "Meta did not return a long-lived access token.");
  const expiresAt = long.expires_in ? new Date(Date.now() + long.expires_in * 1000) : null;
  return { token: long.access_token, expiresAt };
}

export function healthStatus(info: Pick<DebugInfo, "valid" | "expiresAt">, now = Date.now()): "active" | "expiring" | "expired" {
  if (!info.valid) return "expired";
  if (!info.expiresAt) return "active";
  const left = info.expiresAt.getTime() - now;
  return left <= 0 ? "expired" : left <= EXPIRING_SOON_MS ? "expiring" : "active";
}

/** Completes the login redirect: verifies state for this tenant and user, exchanges the code, stores the sealed token, and discovers assets. */
export async function completeConnect(actor: Actor, code: string, state: string | null): Promise<{ connectionId: string }> {
  await consumeState(actor.tenantId, actor.userId, splitConnectState(state).state);
  if (!code || code.length > 2048) throw new HttpError(400, "Missing authorization code.");
  const { token, expiresAt: exchangeExpiry } = await exchangeForLongLived(code);
  const info = await debugToken(token);
  if (!info.valid || !info.userId) throw new HttpError(502, "Meta did not confirm the login. Please try again.");
  const expiresAt = info.expiresAt ?? exchangeExpiry;
  const data = {
    scopes: info.scopes,
    tokenEnc: sealSecret(actor.tenantId, token),
    tokenExpiresAt: expiresAt,
    status: healthStatus({ valid: true, expiresAt }),
    connectedByUserId: actor.userId,
    lastCheckedAt: new Date(),
  };
  const connection = await prisma.metaConnection.upsert({
    where: { tenantId_metaUserId: { tenantId: actor.tenantId, metaUserId: info.userId } },
    create: { tenantId: actor.tenantId, metaUserId: info.userId, ...data },
    update: data,
  });
  const found = await discoverAssets(actor.tenantId, connection.id, token, { subscribeBudgetMs: REQUEST_DISCOVERY_BUDGET_MS });
  if (found.businessId) await prisma.metaConnection.updateMany({ where: { id: connection.id, tenantId: actor.tenantId }, data: { businessId: found.businessId } });
  // Meta's spending limit (docs/SPEND-CONTROLS-SPEC.md 5.1): only the owner can turn it on. When an admin connected, the
  // owner gets the task; the owner sees the consent step on the Connections page. Best effort, never fails the connect.
  if (actor.role === "admin") {
    await import("@/lib/spend/metacap/consent")
      .then((m) => m.notePendingOwnerAfterConnect(actor))
      .catch(() => undefined);
  }
  await audit({
    tenantId: actor.tenantId,
    userId: actor.userId,
    action: "meta_connect.connected",
    target: connection.id,
    meta: { scopes: info.scopes.length, assets: Object.values(found.counts).reduce((a, b) => a + b, 0) },
  });
  return { connectionId: connection.id };
}

async function ownConnection(tenantId: string, connectionId: string) {
  const connection = await prisma.metaConnection.findFirst({ where: { id: connectionId, tenantId } });
  if (!connection) throw new HttpError(404, "Connection not found.");
  return connection;
}

export async function refreshConnection(actor: Actor, connectionId: string): Promise<{ counts: Record<string, number> }> {
  const connection = await ownConnection(actor.tenantId, connectionId);
  if (connection.status === "revoked" || !connection.tokenEnc) throw new HttpError(409, "This connection was disconnected. Connect again.");
  const token = openSecret(actor.tenantId, connection.tokenEnc);
  const info = await debugToken(token);
  const status = healthStatus(info);
  await prisma.metaConnection.updateMany({
    where: { id: connection.id, tenantId: actor.tenantId },
    // debug_token answering with no permissions is an unusable answer, not "no permissions": keep what was stored (same as the health worker).
    data: { status, scopes: info.scopes.length ? info.scopes : connection.scopes, tokenExpiresAt: info.expiresAt, lastCheckedAt: new Date() },
  });
  if (status === "expired") throw new HttpError(409, "The Meta login has expired. Reconnect to continue.");
  const found = await discoverAssets(actor.tenantId, connection.id, token, { subscribeBudgetMs: REQUEST_DISCOVERY_BUDGET_MS });
  await audit({ tenantId: actor.tenantId, userId: actor.userId, action: "meta_connect.refreshed", target: connection.id });
  return { counts: found.counts };
}

// =====================================================================================================================
// Disconnect protection (docs/SPEND-CONTROLS-SPEC.md 5.9, 5.8)
// =====================================================================================================================

/** The word the owner types to disconnect while some campaigns could not be paused. */
export const DISCONNECT_CONFIRM_WORD = "DISCONNECT";

/** Disconnecting would leave campaigns running that Edwyz could not pause. Lists them; nothing was revoked. */
export class DisconnectBlockedError extends HttpError {
  readonly code = "meta_connect.pause_failed" as const;
  constructor(
    readonly failedCampaigns: { id: string; name: string }[],
    readonly canForce: boolean,
  ) {
    super(409, disconnectBlockedCopy(failedCampaigns.length, canForce));
    this.name = "DisconnectBlockedError";
  }
}

/** 5.9 (critic) copy: in-app actions first; Meta Ads Manager only under "More help", never a required step. */
export function disconnectBlockedCopy(campaigns: number, canForce: boolean): string {
  const what = `${campaigns} campaign${campaigns === 1 ? "" : "s"}`;
  const head = `We couldn't pause ${what} on Meta yet. Try again pauses them again from here.`;
  return canForce
    ? `${head} To disconnect anyway, type ${DISCONNECT_CONFIRM_WORD}. They may keep running until Meta's spending limit stops them.`
    : `${head} Only the workspace owner can disconnect anyway.`;
}

/** The success line (5.9): names Meta's limit when Edwyz manages it. */
export function disconnectSuccessCopy(capText: string | null): string | null {
  return capText ? `Your Meta spending limit stays at ${capText}, so nothing can overspend after you disconnect.` : null;
}

export type BeforeDisconnectOptions = {
  /** The owner confirms a disconnect although some campaigns are still running. */
  force?: boolean;
  /** Must be exactly DISCONNECT when force is set. */
  confirm?: unknown;
  /** The 5.8 choice for Meta's limit on the connection's ad accounts (default keep). */
  metaLimitChoice?: unknown;
};

export type BeforeDisconnectResult = {
  paused: number;
  failed: number;
  forced: boolean;
  /** The 5.9 success line, or null when Edwyz manages no Meta limit here. */
  metaLimitText: string | null;
  offboard: { adAccountAssetId: string; applied: string; text: string }[];
};

/**
 * Runs before a disconnect revokes anything (5.9):
 * 1. pauses everything Edwyz runs on the connection's ad accounts (stopCommitments, lowering only);
 * 2. when a pause failed or an object was unreachable, sets Meta's limit to stop the account (P0, where Edwyz manages it)
 *    and refuses with 409 and the in-app copy, unless the OWNER forces it with the typed word DISCONNECT;
 * 3. applies the owner's 5.8 choice for Meta's limit (default keep) while the token still works.
 * Returns the success line naming Meta's limit.
 */
export async function beforeDisconnect(actor: Actor, connectionId: string, opts: BeforeDisconnectOptions = {}): Promise<BeforeDisconnectResult> {
  await ownConnection(actor.tenantId, connectionId);
  const accounts = ((await prisma.metaAsset.findMany({ where: { tenantId: actor.tenantId, connectionId, type: "ad_account" }, select: { id: true } })) ?? []) as { id: string }[];
  const forced = opts.force === true;
  if (forced) {
    if (actor.role !== "owner") throw new HttpError(403, "Only the workspace owner can disconnect while campaigns are still running.");
    if (opts.confirm !== DISCONNECT_CONFIRM_WORD) throw new HttpError(400, `Type ${DISCONNECT_CONFIRM_WORD} to disconnect anyway.`);
  }
  const choice = opts.metaLimitChoice === undefined || opts.metaLimitChoice === null ? "keep" : opts.metaLimitChoice;
  if (choice !== "keep" && choice !== "restore" && choice !== "remove") throw new HttpError(400, "Choose to keep Meta's limit, put back your old limit, or remove it.");
  const who = { type: "user" as const, userId: actor.userId, role: actor.role };

  // 1. Pause first, with the token that still works.
  const { stopCommitments } = await import("@/lib/ads/stop");
  let paused = 0;
  const failedCampaigns = new Map<string, string>();
  for (const a of accounts) {
    const stop = await stopCommitments(actor.tenantId, { origin: "all", adAccountAssetId: a.id }, who, "Paused before the Meta account is disconnected.");
    paused += stop.done;
    for (const item of stop.items) if (item.result === "failed" || item.result === "unreachable") failedCampaigns.set(item.campaignId, item.campaignName);
  }

  const { p0Stop } = await import("@/lib/spend/metacap/sync");
  const managed = accounts.length
    ? (((await prisma.metaSpendLimit.findMany({ where: { tenantId: actor.tenantId, adAccountAssetId: { in: accounts.map((a) => a.id) } } })) ?? []) as { adAccountAssetId: string; mode: string }[])
    : [];
  if (failedCampaigns.size > 0) {
    // 2. Meta's own limit stops the account where Edwyz manages it (P0, emergency class).
    for (const m of managed.filter((r) => r.mode === "managed")) {
      await p0Stop(actor.tenantId, m.adAccountAssetId, "disconnect", { actor: who }).catch((e: unknown) => console.error(`[meta-connect] P0 before disconnect failed: ${describeError(e)}`));
    }
    if (!forced) throw new DisconnectBlockedError([...failedCampaigns].map(([id, name]) => ({ id, name })), actor.role === "owner");
    await audit({ tenantId: actor.tenantId, userId: actor.userId, action: "meta_connect.disconnect_forced", target: connectionId, meta: { campaigns: failedCampaigns.size } });
  }

  // 3. The 5.8 choice, applied while the token still works.
  const { offboardAccount } = await import("@/lib/spend/metacap/offboard");
  const offboard: BeforeDisconnectResult["offboard"] = [];
  let capText: string | null = null;
  for (const m of managed.filter((r) => r.mode !== "off" && r.mode !== "withdrawn")) {
    const out = await offboardAccount(actor.tenantId, m.adAccountAssetId, choice, "disconnect", who).catch(() => null);
    if (!out) continue;
    offboard.push({ adAccountAssetId: m.adAccountAssetId, applied: out.applied, text: out.text });
    if (out.capMinor !== null && out.capMinor > 0n && out.applied !== "removed") {
      const row = (await prisma.metaSpendLimit.findFirst({ where: { adAccountAssetId: m.adAccountAssetId, tenantId: actor.tenantId }, select: { currency: true } })) as { currency?: string | null } | null;
      capText = formatMinor(out.capMinor, row?.currency ?? "INR");
    }
  }
  return { paused, failed: failedCampaigns.size, forced, metaLimitText: disconnectSuccessCopy(capText), offboard };
}

export type DisconnectResult = {
  revokedAtMeta: boolean;
  skippedSharedUser: boolean;
  pagesUnsubscribed: number;
  pagesUnsubscribeFailed: number;
  pagesKeptForOtherWorkspace: number;
};

type Client = Pick<Prisma.TransactionClient, "metaConnection" | "metaAsset" | "tenant">;

const LIVE_STATUSES = ["active", "expiring"];
const MAX_SHARED_LOOKUP = 500;
const MAX_PAGE_LOCKS = 500;
const UNSUBSCRIBE_BUDGET_MS = 20_000;
/** A revoked connection that still holds a token is finished by the sweep only after this long, so it never races a disconnect that is still talking to Meta. */
export const PENDING_DISCONNECT_GRACE_MS = 10 * 60_000;

/**
 * Meta users that still have a usable connection somewhere else: live status, a stored token that has not lapsed, and a
 * workspace that is active and not deleted. Expired, errored and revoked rows, and rows of suspended or deleted
 * workspaces, never block a revoke.
 */
async function usersLiveElsewhere(client: Client, userIds: string[], exclude: { connectionId?: string; tenantId?: string }): Promise<Set<string>> {
  if (userIds.length === 0) return new Set();
  const rows =
    (await client.metaConnection.findMany({
      where: {
        metaUserId: { in: userIds },
        status: { in: LIVE_STATUSES },
        tokenEnc: { not: "" },
        OR: [{ tokenExpiresAt: null }, { tokenExpiresAt: { gt: new Date() } }],
        ...(exclude.connectionId ? { id: { not: exclude.connectionId } } : {}),
        ...(exclude.tenantId ? { tenantId: { not: exclude.tenantId } } : {}),
      },
      select: { tenantId: true, metaUserId: true },
      take: MAX_SHARED_LOOKUP,
    })) ?? [];
  const active = await activeTenantIds(client, [...new Set(rows.map((r) => r.tenantId))]);
  return new Set(rows.filter((r) => active.has(r.tenantId)).map((r) => r.metaUserId));
}

type PageRow = { id: string; externalId: string; status: string; tokenEnc: string | null; meta: unknown };

/**
 * Serialises everything that decides "does another workspace still use this Page" for the same Page, across different Meta
 * users: one transaction-scoped advisory lock per Page id, taken in sorted order. Two workspaces that share a Page and
 * disconnect together then run one after the other: the second sees the first as inactive and removes the subscription, where
 * without the lock each could see the other as still active and neither would. Released at commit.
 */
async function lockPages(tx: Prisma.TransactionClient, pageIds: string[]): Promise<void> {
  for (const id of [...new Set(pageIds)].sort().slice(0, MAX_PAGE_LOCKS)) await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`meta-page:${id}`}))`;
}

type Decision = { sharedUser: boolean; sharedPages: Set<string> };

const stillRevoked = async (tenantId: string, connectionId: string): Promise<boolean> => {
  try {
    return Boolean(await prisma.metaConnection.findFirst({ where: { id: connectionId, tenantId, status: "revoked" }, select: { id: true } }));
  } catch {
    return false;
  }
};

/**
 * Second half of a disconnect, run after the revoked state is committed and with the tokens still stored: removes the lead-alert
 * subscription of each Page at Meta with that Page's own token (unless another active workspace uses the Page, and including
 * Pages that were already inactive but still hold a token), then revokes the Meta user's authorization unless the user is live
 * elsewhere, and only then deletes the tokens. Everything at Meta is best effort and tokens are deleted whatever it answers. If
 * the process dies before the tokens are deleted, they are still stored on a revoked connection and finishPendingDisconnects
 * completes the job, so a Page is never left subscribed with no token and no retry. If the workspace reconnected the same Meta
 * user in the meantime (the connection is no longer revoked), nothing is touched: the new login owns the subscriptions and the token.
 */
async function finishDisconnect(
  tenantId: string,
  connection: { id: string; metaUserId: string; tokenEnc: string },
  pageRows: PageRow[],
  decision: Decision,
): Promise<Pick<DisconnectResult, "revokedAtMeta" | "pagesUnsubscribed" | "pagesUnsubscribeFailed" | "pagesKeptForOtherWorkspace">> {
  const withToken = pageRows.filter((r) => r.tokenEnc);
  const toUnsubscribe = withToken.filter((r) => !decision.sharedPages.has(r.externalId));
  const pagesKeptForOtherWorkspace = withToken.filter((r) => decision.sharedPages.has(r.externalId)).length;
  let userToken: string | null = null;
  try {
    userToken = connection.tokenEnc ? openSecret(tenantId, connection.tokenEnc) : null;
  } catch {
    userToken = null;
  }
  let pagesUnsubscribed = 0;
  let revokedAtMeta = false;
  if (await stillRevoked(tenantId, connection.id)) {
    await runPool(toUnsubscribe, SUBSCRIBE_CONCURRENCY, Date.now() + UNSUBSCRIBE_BUDGET_MS, async (row) => {
      try {
        if (await unsubscribePageFromApp(row.externalId, openSecret(tenantId, row.tokenEnc as string))) pagesUnsubscribed++;
      } catch {
        return;
      }
    });
    if (userToken && !decision.sharedUser && (await stillRevoked(tenantId, connection.id))) {
      try {
        await graphFetchAs(userToken, { path: `${connection.metaUserId}/permissions`, method: "DELETE" });
        revokedAtMeta = true;
      } catch {
        revokedAtMeta = false;
      }
    }
    // Guarded by the revoked/inactive state: a reconnect that landed meanwhile has already put a new token on these rows.
    await prisma.metaAsset.updateMany({ where: { tenantId, connectionId: connection.id, status: "inactive" }, data: { tokenEnc: null } });
    await prisma.metaConnection.updateMany({ where: { id: connection.id, tenantId, status: "revoked" }, data: { tokenEnc: "", tokenExpiresAt: null } });
  }
  return { revokedAtMeta, pagesUnsubscribed, pagesUnsubscribeFailed: toUnsubscribe.length - pagesUnsubscribed, pagesKeptForOtherWorkspace };
}

/**
 * The connection is marked revoked and its assets inactive at once, and the lead-alert subscription status of its Pages is
 * cleared; the tokens are deleted at the end (finishDisconnect), whatever Meta answers. The lead-alert subscription of each Page
 * is removed at Meta before its token is deleted, unless another active workspace still uses that Page, because the
 * subscription belongs to the Page and not to the workspace. DELETE {user}/permissions removes the app's authorization for the
 * whole Meta user, so it runs only when no other usable connection of that user exists.
 *
 * The shared-user and shared-Page checks run in the same transaction as the revoke, after a row lock (SELECT ... FOR UPDATE, in
 * id order) on every connection of that Meta user and a transaction advisory lock on every Page of this connection (sorted).
 * Two workspaces disconnecting together, whether they share a Meta user or only a Page, cannot each see the other as still
 * live: the second waits, then sees the first as revoked. A connect that lands between the check and the Meta call is not
 * covered (no lock is held across the network call); finishDisconnect skips the Meta calls once the connection is no longer
 * revoked, and the health check marks a stale one expired.
 */
export async function disconnect(actor: Actor, connectionId: string): Promise<DisconnectResult> {
  const connection = await ownConnection(actor.tenantId, connectionId);
  const { decision, pageRows } = await prisma.$transaction(
    async (tx) => {
      await tx.$queryRaw`SELECT "id" FROM "MetaConnection" WHERE "metaUserId" = ${connection.metaUserId} ORDER BY "id" FOR UPDATE`;
      const rows = ((await tx.metaAsset.findMany({ where: { tenantId: actor.tenantId, connectionId: connection.id, type: "page" }, select: { id: true, externalId: true, status: true, tokenEnc: true, meta: true } })) ?? []) as PageRow[];
      if (rows.length) await lockPages(tx, rows.map((r) => r.externalId));
      await tx.metaAsset.updateMany({ where: { tenantId: actor.tenantId, connectionId: connection.id }, data: { status: "inactive" } });
      for (const row of rows) {
        const meta = (row.meta ?? {}) as Record<string, unknown>;
        if (!("leadgenSubscription" in meta)) continue;
        const { leadgenSubscription: _removed, ...rest } = meta;
        await tx.metaAsset.updateMany({ where: { id: row.id, tenantId: actor.tenantId }, data: { meta: rest as Prisma.InputJsonObject } });
      }
      await tx.metaConnection.updateMany({ where: { id: connection.id, tenantId: actor.tenantId }, data: { status: "revoked" } });
      const users = await usersLiveElsewhere(tx, [connection.metaUserId], { connectionId: connection.id });
      const pages = await pagesLiveElsewhere(tx, actor.tenantId, rows.map((r) => r.externalId));
      return { decision: { sharedUser: users.has(connection.metaUserId), sharedPages: pages }, pageRows: rows };
    },
    { timeout: 20_000 },
  );

  const finished = await finishDisconnect(actor.tenantId, connection, pageRows, decision);
  const result: DisconnectResult = { ...finished, skippedSharedUser: decision.sharedUser };
  await audit({ tenantId: actor.tenantId, userId: actor.userId, action: "meta_connect.disconnected", target: connection.id, meta: { ...result } });
  return result;
}

/**
 * Finishes disconnects that were interrupted (the process died after the revoke was committed but before the tokens were
 * deleted): a revoked connection that still has a token, older than the grace period. Takes the same locks and makes the same
 * shared-user and shared-Page decisions as disconnect, removes the Page subscriptions and the user's authorization at Meta where
 * appropriate, and deletes the tokens. Returns how many connections it finished. Never throws.
 */
export async function finishPendingDisconnects(now = new Date(), limit = 25): Promise<number> {
  let rows: { id: string; tenantId: string; metaUserId: string; tokenEnc: string }[] = [];
  try {
    rows = await prisma.metaConnection.findMany({
      where: { status: "revoked", tokenEnc: { not: "" }, updatedAt: { lt: new Date(now.getTime() - PENDING_DISCONNECT_GRACE_MS) } },
      select: { id: true, tenantId: true, metaUserId: true, tokenEnc: true },
      orderBy: { updatedAt: "asc" },
      take: limit,
    });
  } catch {
    return 0;
  }
  let done = 0;
  for (const c of rows) {
    try {
      const { decision, pageRows } = await prisma.$transaction(
        async (tx) => {
          await tx.$queryRaw`SELECT "id" FROM "MetaConnection" WHERE "metaUserId" = ${c.metaUserId} ORDER BY "id" FOR UPDATE`;
          const pages = ((await tx.metaAsset.findMany({ where: { tenantId: c.tenantId, connectionId: c.id, type: "page", tokenEnc: { not: null } }, select: { id: true, externalId: true, status: true, tokenEnc: true, meta: true } })) ?? []) as PageRow[];
          if (pages.length) await lockPages(tx, pages.map((r) => r.externalId));
          const users = await usersLiveElsewhere(tx, [c.metaUserId], { connectionId: c.id });
          const shared = await pagesLiveElsewhere(tx, c.tenantId, pages.map((r) => r.externalId));
          return { decision: { sharedUser: users.has(c.metaUserId), sharedPages: shared }, pageRows: pages };
        },
        { timeout: 20_000 },
      );
      const finished = await finishDisconnect(c.tenantId, c, pageRows, decision);
      await audit({ tenantId: c.tenantId, action: "meta_connect.disconnect_resumed", target: c.id, meta: { ...finished, skippedSharedUser: decision.sharedUser } });
      done++;
    } catch {
      console.warn("[meta-connect] could not finish a pending disconnect");
    }
  }
  return done;
}

export async function listConnections(tenantId: string) {
  const rows = await prisma.metaConnection.findMany({
    where: { tenantId },
    orderBy: { createdAt: "asc" },
    select: {
      id: true,
      metaUserId: true,
      businessId: true,
      scopes: true,
      status: true,
      tokenExpiresAt: true,
      lastCheckedAt: true,
      createdAt: true,
      assets: { select: { id: true, type: true, externalId: true, name: true, status: true, meta: true }, orderBy: [{ type: "asc" }, { name: "asc" }] },
    },
  });
  const shared = await usersLiveElsewhere(prisma, [...new Set(rows.map((r) => r.metaUserId))], { tenantId });
  return rows.map((r) => ({
    ...r,
    missingScopes: r.status === "revoked" ? [] : missingScopes(r.scopes),
    unusedScopes: r.status === "revoked" ? [] : unusedScopes(r.scopes),
    scopeSummary: scopeSummary(r.scopes, r.status === "revoked"),
    sharedWithOtherWorkspace: shared.has(r.metaUserId),
  }));
}
