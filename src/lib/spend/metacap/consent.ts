/**
 * Wall (a), consent and state (docs/SPEND-CONTROLS-SPEC.md 5.1, 5.8, 8.1 MetaLimitCard, 8.4, 12.1c R3).
 *
 * - Only the workspace OWNER turns Meta's limit on. An admin who asks gets 403 with "Only the workspace owner can turn on
 *   Meta's spending limit. We've let them know.", the row becomes `pending_owner` and the owner gets a banner task. A
 *   pending_owner row never holds the one-manager slot (R3).
 * - Consent is append-only (SpendConsent, kind meta_spend_cap, subject the ad account) with textVersion 'meta-cap-v1' and the
 *   SHA-256 of the exact 5.1 text the owner saw.
 * - Only the workspace's spending ad account is offered, because M is that account's ads pot.
 * - One manager per real ad account (decision 2.3.14): turning it on sets mode `managed`, and the partial unique index on
 *   accountExternalId (mode = managed) makes a second workspace's attempt fail, so that row becomes `other_workspace`.
 * - Start values (5.3): mid-month, monthStartAmountSpent = A - the account's month-to-date (floored at 0); without the fast
 *   sync's month-to-date the first write waits for one. The customer's own cap at consent is kept, both as a ceiling on the
 *   target and for "Put back my old limit".
 * - getMetaLimitDTO() gives the card every state of 8.1. Turning it off, and every offboarding, is in offboard.ts.
 */
import { createHash } from "node:crypto";
import { prisma } from "@/lib/db";
import { enqueue as enqueueJob } from "@/lib/queue";
import { describeError } from "@/lib/safe-error";
import { HttpError } from "@/lib/tenancy";
import { tenantMayRunBackground } from "@/lib/tenant-state";
import { effectiveLimits } from "../allowances";
import { isMetaLimitManaged, toMetaLimitRow } from "../commitments";
import { getControl } from "../control";
import { isDemoAsset } from "../demo";
import { SpendBlockedError } from "../errors";
import { spendCapMode } from "../flags";
import { appendStandalone, type LedgerDb } from "../ledger";
import { formatMinor, isCurrencyCode, toMoneyDTOOrNull } from "../money";
import { notifySpend } from "../notify";
import { monthKey, resolveTimeZone } from "../periods";
import { SPEND_QUEUES, type MetaLimitDTO, type MetaLimitState, type MetaOffboardChoice, type MetaSpendLimitMode, type SpendActor, type SpendRole } from "../types";
import { actPath, assetToken, CONNECT_AGAIN_LABEL, LOOSE_COPY, NO_PERMISSION_COPY, readCap, type CapRead, type MetaCapDb, type MetaCapIo } from "./client";
import { isOffboardChoice, offboardAccount, offeredChoices, type OffboardResult } from "./offboard";
import { metaRoomMinor, monthStartAtConsent, toMetaCapRow } from "./plan";
import { accountMonthToDate, replanTenant, type SyncResult } from "./sync";

export const META_CAP_TEXT_VERSION = "meta-cap-v1";

/** The 5.1 consent copy, verbatim. Its SHA-256 is stored with every consent. */
export const META_CAP_CONSENT = {
  textVersion: META_CAP_TEXT_VERSION,
  title: "Let Edwyz manage the spending limit on this ad account",
  body: [
    "Meta will stop every ad on this account, including ads you make yourself in Meta Ads Manager, once it has spent your monthly ads limit.",
    "Edwyz updates this limit for you, at most a few times a day. A change can take a few hours to reach Meta.",
    "If you press Stop all spending and an ad can't be paused, we set the limit so the account stops.",
    "You can turn this off here at any time, or remove the limit in Meta Ads Manager > Billing > Payment settings.",
  ],
  checkbox: "I'm the owner of this workspace and I agree.",
  button: "Turn on Meta's limit",
} as const;

export const ADMIN_PENDING_COPY = "Only the workspace owner can turn on Meta's spending limit. We've let them know.";
export const OWNER_ONLY_OFF_COPY = "Only the workspace owner can turn off Meta's spending limit.";
export const OTHER_WORKSPACE_COPY = "Another Edwyz workspace already manages Meta's spending limit on this ad account. Your Edwyz limits still apply here.";

/** The exact text the owner agrees to: title, the four sentences and the checkbox line, one per line. */
export function metaCapConsentText(): string {
  return [META_CAP_CONSENT.title, ...META_CAP_CONSENT.body, META_CAP_CONSENT.checkbox].join("\n");
}

export function metaCapConsentSha256(): string {
  return createHash("sha256").update(metaCapConsentText(), "utf8").digest("hex");
}

export type MetaLimitActor = { userId: string; role: SpendRole };

type Asset = { id: string; tenantId?: string; externalId: string; name: string | null; meta: unknown; sandbox?: boolean; status?: string };

const metaField = (asset: Asset | null, key: string): unknown => (asset?.meta && typeof asset.meta === "object" ? (asset.meta as Record<string, unknown>)[key] : undefined);
const bigOf = (v: unknown): bigint | null => {
  if (typeof v === "bigint") return v;
  if (typeof v === "number" && Number.isSafeInteger(v) && v >= 0) return BigInt(v);
  if (typeof v === "string" && /^\d{1,30}$/.test(v)) return BigInt(v);
  return null;
};
const userActor = (a: MetaLimitActor): SpendActor => ({ type: "user", userId: a.userId, role: a.role });
const dbOf = (io: MetaCapIo): MetaCapDb => io.db ?? (prisma as unknown as MetaCapDb);

async function spendingAsset(db: MetaCapDb, tenantId: string, adAccountAssetId: string | null): Promise<Asset | null> {
  if (!adAccountAssetId) return null;
  return (await db.metaAsset.findFirst({ where: { id: adAccountAssetId, tenantId, type: "ad_account" } })) as Asset | null;
}

/** The consent screen (5.1), with "This account already has a Meta limit of ₹X" when discovery found one. */
export function consentScreen(asset: Pick<Asset, "meta"> | null, currency: string | null) {
  const cap = bigOf(metaField(asset as Asset | null, "metaCapMinor"));
  return {
    ...META_CAP_CONSENT,
    body: [...META_CAP_CONSENT.body],
    existingCap: cap !== null && cap > 0n && currency ? `This account already has a Meta limit of ${formatMinor(cap, currency)}.` : null,
  };
}

/** The consent screen for the workspace's spending ad account, or null when there is none to offer. */
export async function metaLimitConsentScreen(tenantId: string, io: MetaCapIo = {}): Promise<ReturnType<typeof consentScreen> | null> {
  const db = dbOf(io);
  const control = await getControl(tenantId, { db, prune: false });
  const asset = await spendingAsset(db, tenantId, control.spendingAdAccountAssetId);
  if (!asset || isDemoAsset(asset)) return null;
  const currency = metaField(asset, "currency");
  return consentScreen(asset, isCurrencyCode(currency) ? currency : null);
}

/**
 * An admin asked: the row waits for the owner (pending_owner, which never holds the one-manager slot) and the owner gets a
 * banner task. Never throws.
 */
export async function markPendingOwner(tenantId: string, actor: MetaLimitActor, asset: Asset, io: MetaCapIo = {}): Promise<void> {
  const db = dbOf(io);
  try {
    const existing = (await db.metaSpendLimit.findUnique({ where: { adAccountAssetId: asset.id } })) as Record<string, unknown> | null;
    const mode = existing ? String(existing.mode) : "off";
    if (!existing || ["off", "withdrawn", "no_permission"].includes(mode)) {
      const currency = metaField(asset, "currency");
      const tz = metaField(asset, "timezone");
      const data = { tenantId, accountExternalId: actPath(asset.externalId), mode: "pending_owner", currency: isCurrencyCode(currency) ? currency : null, timezone: typeof tz === "string" ? tz : null };
      await db.metaSpendLimit.upsert({ where: { adAccountAssetId: asset.id }, create: { adAccountAssetId: asset.id, ...data }, update: { mode: "pending_owner" } });
    }
    if (mode === "managed" || mode === "other_workspace") return;
    await appendStandalone(
      { tenantId, pot: "ads", action: "consent.meta_cap", phase: "info", actor: userActor(actor), reason: "An admin asked to turn on Meta's spending limit. It waits for the owner.", reasonCodes: ["pending_owner"], targetType: "ad_account", targetId: asset.id, metaObjectId: actPath(asset.externalId), idempotencyKey: `metacap:pending:${asset.id}:${actor.userId}` },
      { db: db as unknown as LedgerDb },
    );
    await (io.notify ?? notifySpend)({
      tenantId,
      kind: "meta_limit",
      severity: "action_needed",
      audience: "owner",
      dedupeKey: `metacap:pending_owner:${asset.id}`,
      title: "Turn on Meta's spending limit",
      body: `An admin connected ${asset.name?.trim() || actPath(asset.externalId)}. Only you can let Edwyz keep Meta's spending limit in line with your monthly ads limit. Open Settings > Spending limits to turn it on.`,
      link: "/app/settings/spending",
      subjectType: "ad_account",
      subjectId: asset.id,
    });
  } catch (error) {
    console.error(`[spend] pending_owner not recorded: ${describeError(error)}`);
  }
}

/** After a Meta connect: when an admin connected and Meta's limit is not on yet, the owner gets the task (5.1). Never throws. */
export async function notePendingOwnerAfterConnect(actor: { userId: string; tenantId: string; role: string }, io: MetaCapIo = {}): Promise<void> {
  try {
    if (actor.role !== "admin") return;
    const db = dbOf(io);
    const control = await getControl(actor.tenantId, { db, prune: false });
    const asset = await spendingAsset(db, actor.tenantId, control.spendingAdAccountAssetId);
    if (!asset || isDemoAsset(asset) || asset.sandbox === true) return;
    await markPendingOwner(actor.tenantId, { userId: actor.userId, role: "admin" }, asset, io);
  } catch (error) {
    console.error(`[spend] pending_owner after connect skipped: ${describeError(error)}`);
  }
}

/**
 * The owner turns Meta's limit on for the spending ad account (5.1). An admin gets 403 and the row waits for the owner.
 * Returns the card's new state.
 */
export async function turnOnMetaLimit(tenantId: string, actor: MetaLimitActor, input: { adAccountAssetId?: unknown; agreed?: unknown; textVersion?: unknown }, io: MetaCapIo = {}): Promise<MetaLimitDTO> {
  const db = dbOf(io);
  const env = io.env ?? process.env;
  const now = io.now ?? new Date();
  const control = await getControl(tenantId, { db, prune: false });
  const assetId = control.spendingAdAccountAssetId;
  if (!assetId) throw new HttpError(409, "Choose your spending ad account first. Meta's limit is offered only for that account.");
  if (input.adAccountAssetId !== undefined && input.adAccountAssetId !== null && input.adAccountAssetId !== assetId) throw new HttpError(409, "Meta's limit can be turned on only for your spending ad account.");
  const asset = await spendingAsset(db, tenantId, assetId);
  if (!asset) throw new HttpError(404, "That ad account is no longer connected. Connect it again in Settings > Connections.");
  if (isDemoAsset(asset)) throw new SpendBlockedError("spend.demo");
  if (actor.role !== "owner") {
    await markPendingOwner(tenantId, actor, asset, io);
    throw new HttpError(403, ADMIN_PENDING_COPY);
  }
  if (input.agreed !== true || input.textVersion !== META_CAP_TEXT_VERSION) throw new HttpError(400, "Tick the box to confirm you're the owner and agree, then try again.");

  const consent = (await db.spendConsent.create({
    data: { tenantId, userId: actor.userId, kind: "meta_spend_cap", subjectId: assetId, granted: true, textVersion: META_CAP_TEXT_VERSION, textSha256: metaCapConsentSha256() },
  })) as { id: string };

  // A fresh read for the start values (best effort; discovery's values otherwise).
  let read: CapRead | null = null;
  if (spendCapMode(env) !== "off" && asset.sandbox !== true) {
    try {
      const { token } = await assetToken(io, tenantId, assetId);
      read = await readCap(token, asset.externalId);
    } catch (error) {
      console.error(`[spend] Meta limit read at consent failed: ${describeError(error)}`);
    }
  }
  const metaCurrency = metaField(asset, "currency");
  const accountCurrency = read?.currency ?? (isCurrencyCode(metaCurrency) ? metaCurrency : null);
  const metaTz = metaField(asset, "timezone");
  const tz = resolveTimeZone(read?.timezone ?? (typeof metaTz === "string" ? metaTz : null) ?? control.timezone);
  const limits = await effectiveLimits(tenantId, "ads", accountCurrency ?? undefined, db, { now, env, control });
  const prepaid = read?.isPrepay ?? (typeof metaField(asset, "isPrepay") === "boolean" ? (metaField(asset, "isPrepay") as boolean) : null);
  const a = read?.amountSpentMinor ?? bigOf(metaField(asset, "amountSpentMinor"));
  const c = read?.capMinor ?? bigOf(metaField(asset, "metaCapMinor"));
  const mtd = await accountMonthToDate(db, tenantId, assetId, asset.externalId, now, tz);
  const existing = (await db.metaSpendLimit.findUnique({ where: { adAccountAssetId: assetId } })) as Record<string, unknown> | null;
  const prev = existing ? toMetaCapRow(existing) : null;
  // A cap Edwyz itself wrote earlier is not the customer's own.
  const ours = prev?.managedCapMinor !== null && prev?.managedCapMinor !== undefined && c !== null && (c - prev.managedCapMinor <= 1n && prev.managedCapMinor - c <= 1n);
  const customerCap = ours ? (prev?.customerCapMinor ?? null) : c !== null && c > 0n ? c : null;

  let mode: MetaSpendLimitMode = asset.sandbox === true ? "sandbox" : prepaid === true ? "unavailable_prepaid" : accountCurrency && !limits.currencyMatches ? "currency_mismatch" : "managed";
  const data = {
    tenantId,
    accountExternalId: actPath(asset.externalId),
    consentId: consent.id,
    customerCapAtConsentMinor: customerCap,
    customerAmountSpentAtConsentMinor: a,
    managedCapMinor: ours ? prev!.managedCapMinor : null,
    pendingTargetMinor: null,
    deferredUntil: null,
    lastError: null,
    monthKey: monthKey(now, tz),
    monthStartAmountSpentMinor: monthStartAtConsent(a, mtd),
    spentAtLastWriteMinor: null,
    currency: accountCurrency,
    timezone: tz,
    isPrepay: prepaid,
    ...(read ? { lastReadCapMinor: read.capMinor, lastReadAmountSpentMinor: read.amountSpentMinor, lastReadAt: now, accountStatus: read.accountStatus } : {}),
  };
  const save = (m: MetaSpendLimitMode) => db.metaSpendLimit.upsert({ where: { adAccountAssetId: assetId }, create: { adAccountAssetId: assetId, ...data, mode: m }, update: { ...data, mode: m, version: { increment: 1 } } as never });
  try {
    await save(mode);
  } catch (error) {
    // One manager per real ad account: another workspace already manages it (the unique index refused this one).
    if ((error as { code?: unknown })?.code !== "P2002" || mode !== "managed") throw error;
    mode = "other_workspace";
    await save(mode);
  }
  await appendStandalone(
    {
      tenantId,
      pot: "ads",
      action: "consent.meta_cap",
      phase: "info",
      actor: userActor(actor),
      reason: mode === "managed" ? "The owner turned on Meta's spending limit." : mode === "other_workspace" ? OTHER_WORKSPACE_COPY : "The owner agreed to Meta's spending limit, but it can't be used on this ad account.",
      reasonCodes: [META_CAP_TEXT_VERSION, mode],
      targetType: "ad_account",
      targetId: assetId,
      metaObjectId: actPath(asset.externalId),
      currency: accountCurrency,
      snapshot: { consentId: consent.id, textVersion: META_CAP_TEXT_VERSION, textSha256: metaCapConsentSha256(), customerCapMinor: customerCap, amountSpentMinor: a, monthToDateMinor: mtd },
      sandbox: asset.sandbox === true,
    },
    { db: db as unknown as LedgerDb },
  );
  if (mode === "managed") {
    await (io.enqueue ?? enqueueJob)(SPEND_QUEUES.metacapReplan, { tenantId, adAccountAssetId: assetId, reason: "consent" }).catch((e: unknown) => console.error(`[spend] metacap re-plan not queued: ${describeError(e)}`));
  }
  return (await getMetaLimitDTO(tenantId, "owner", io))!;
}

/** The owner turns Meta's limit off with one of the 5.8 choices. Works in every workspace state (4.17). */
export async function turnOffMetaLimit(tenantId: string, actor: MetaLimitActor, choice: unknown, io: MetaCapIo = {}): Promise<{ result: OffboardResult; metaLimit: MetaLimitDTO | null }> {
  if (actor.role !== "owner") throw new HttpError(403, OWNER_ONLY_OFF_COPY);
  const picked: MetaOffboardChoice = choice === undefined || choice === null ? "keep" : isOffboardChoice(choice) ? choice : (() => {
    throw new HttpError(400, "Choose to keep the limit, put back your old limit, or remove it.");
  })();
  const db = dbOf(io);
  const control = await getControl(tenantId, { db, prune: false });
  const rows = (((await db.metaSpendLimit.findMany({ where: { tenantId } })) ?? []) as Record<string, unknown>[]).map(toMetaCapRow).filter((r) => r.mode !== "off" && r.mode !== "withdrawn");
  const row = rows.find((r) => r.adAccountAssetId === control.spendingAdAccountAssetId) ?? rows[0];
  if (!row) throw new HttpError(409, "Meta's limit is already off.");
  await db.spendConsent.create({
    data: { tenantId, userId: actor.userId, kind: "meta_spend_cap", subjectId: row.adAccountAssetId, granted: false, textVersion: META_CAP_TEXT_VERSION, textSha256: metaCapConsentSha256() },
  });
  const result = await offboardAccount(tenantId, row.adAccountAssetId, picked, "turn_off", userActor(actor), io);
  return { result, metaLimit: await getMetaLimitDTO(tenantId, "owner", io) };
}

/** "Use my Edwyz limit" (5.6): the owner lets Edwyz raise a cap they lowered in Meta back to the plan. A raise. */
export async function useMyEdwyzLimit(tenantId: string, actor: MetaLimitActor, io: MetaCapIo = {}): Promise<SyncResult[]> {
  if (actor.role !== "owner") throw new HttpError(403, "Only the workspace owner can raise Meta's spending limit.");
  const db = dbOf(io);
  const control = await getControl(tenantId, { db, prune: false });
  const assetId = control.spendingAdAccountAssetId;
  const raw = assetId ? ((await db.metaSpendLimit.findUnique({ where: { adAccountAssetId: assetId } })) as Record<string, unknown> | null) : null;
  if (!raw || raw.mode !== "managed") throw new HttpError(409, "Meta's limit is not on for your spending ad account.");
  await db.metaSpendLimit.update({ where: { adAccountAssetId: assetId! }, data: { customerCapAtConsentMinor: null, customerAmountSpentAtConsentMinor: null, version: { increment: 1 } } as never });
  await appendStandalone(
    { tenantId, pot: "ads", action: "consent.meta_cap", phase: "info", actor: userActor(actor), reason: "The owner chose to use the Edwyz limit instead of the lower limit set in Meta.", reasonCodes: ["use_edwyz_limit"], targetType: "ad_account", targetId: assetId! },
    { db: db as unknown as LedgerDb },
  );
  return replanTenant(tenantId, assetId!, { ...io, request: { kind: "raise_requested" }, actor: userActor(actor) });
}

const STATE_TEXT: Partial<Record<MetaLimitState, string>> = {
  ready: "Ready. Meta's limit will be switched on after our final check.",
  off: "Off. Turn on Meta's limit for extra safety.",
  pending_owner: "Waiting for the owner to turn this on.",
  unavailable_prepaid: "Not available: this ad account uses prepaid funds. Your Edwyz limits still apply.",
  no_permission: NO_PERMISSION_COPY,
  other_workspace: OTHER_WORKSPACE_COPY,
  demo: "Demo account: Meta's limit isn't used.",
  sandbox: "Test account: Meta's limit isn't used.",
  deferred: "Meta's limit will update later today. Your Edwyz limits still apply now.",
  loose: LOOSE_COPY,
  needs_monthly_limit: "Set a monthly ads limit first.",
  kept_while_paused: "Meta's limit is kept at last month's level while your workspace is paused.",
  error: "Meta's limit needs a check by Edwyz support. Your Edwyz limits still apply.",
};

/**
 * The "Spending limit on Meta" card for the spending ad account, for any member (8.1). Null when there is no ad account to
 * show (no Meta card, 8.4).
 */
export async function getMetaLimitDTO(tenantId: string, role: SpendRole, io: MetaCapIo & { workspaceActive?: boolean } = {}): Promise<MetaLimitDTO | null> {
  const db = dbOf(io);
  const env = io.env ?? process.env;
  const now = io.now ?? new Date();
  const control = await getControl(tenantId, { db, prune: false });
  const asset = await spendingAsset(db, tenantId, control.spendingAdAccountAssetId);
  if (!asset) return null;
  const raw = (await db.metaSpendLimit.findUnique({ where: { adAccountAssetId: asset.id } })) as Record<string, unknown> | null;
  const row = raw && String(raw.tenantId) === tenantId ? toMetaCapRow(raw) : null;
  const metaCurrency = metaField(asset, "currency");
  const currency = row?.currency ?? (isCurrencyCode(metaCurrency) ? metaCurrency : null);
  const limits = await effectiveLimits(tenantId, "ads", currency ?? undefined, db, { now, env, control });
  const mode: MetaSpendLimitMode = row?.mode ?? "off";
  const cur = currency ?? limits.currency;
  const cap = row?.lastReadCapMinor ?? null;
  const spent = row?.lastReadAmountSpentMinor ?? null;
  const room = metaRoomMinor(cap, spent);
  const demo = isDemoAsset(asset);
  const sandbox = asset.sandbox === true || mode === "sandbox";

  let state: MetaLimitState;
  let text: string;
  if (demo) state = "demo";
  else if (sandbox) state = "sandbox";
  else if (mode === "managed") {
    const workspaceActive = io.workspaceActive ?? (await tenantMayRunBackground(tenantId).catch(() => true));
    const blocked = row?.writesBlockedUntil && row.writesBlockedUntil.getTime() > now.getTime();
    const longDefer = row?.pendingTargetMinor !== null && row?.deferredUntil && row.deferredUntil.getTime() > now.getTime() + 15 * 60_000;
    if (limits.monthly === null) state = "needs_monthly_limit";
    else if (!workspaceActive) state = "kept_while_paused";
    else if (blocked || longDefer) state = "deferred";
    else if ((row?.loosenessMinor ?? 0n) > 0n) state = "loose";
    else if (raw && isMetaLimitManaged(toMetaLimitRow(raw), env)) state = "managed";
    else state = "ready";
  } else if (mode === "withdrawn" || mode === "off") state = "off";
  else state = mode as MetaLimitState;

  if (state === "managed") text = room !== null ? `Managed by Edwyz. Meta will stop this account after ${formatMinor(room, cur)} more this month.` : "Managed by Edwyz.";
  else if (state === "currency_mismatch") text = `This ad account uses ${currency ?? "another currency"}, but your ads limits are in ${limits.allowance?.currency ?? limits.currency}. Enter your ads limits in ${currency ?? "the account's currency"} to turn this on.`;
  else text = STATE_TEXT[state] ?? STATE_TEXT.off!;

  const owner = role === "owner";
  const canTurnOn = owner && !demo && !sandbox && ["off", "withdrawn", "pending_owner", "no_permission"].includes(mode);
  const canTurnOff = owner && (mode === "managed" || mode === "error");
  const previous = row?.customerCapMinor !== null && row?.customerCapMinor !== undefined && row.customerCapMinor > 0n ? row.customerCapMinor : null;
  const action: MetaLimitDTO["action"] =
    state === "no_permission" && role !== "agent"
      ? { kind: "connect_again", label: CONNECT_AGAIN_LABEL }
      : state === "needs_monthly_limit" && owner
        ? { kind: "set_monthly_limit", label: "Set a monthly limit" }
        : canTurnOn
          ? { kind: "turn_on", label: META_CAP_CONSENT.button }
          : null;
  return {
    adAccountAssetId: asset.id,
    accountName: asset.name ?? null,
    accountExternalId: actPath(asset.externalId),
    currency,
    mode,
    state,
    managed: !!raw && isMetaLimitManaged(toMetaLimitRow(raw), env),
    text,
    cap: cap !== null && cap > 0n ? toMoneyDTOOrNull(cap, cur) : null,
    amountSpent: toMoneyDTOOrNull(spent, cur),
    roomLeft: toMoneyDTOOrNull(room, cur),
    target: toMoneyDTOOrNull(row?.targetCapMinor ?? null, cur),
    looseBy: row?.loosenessMinor && row.loosenessMinor > 0n ? toMoneyDTOOrNull(row.loosenessMinor, cur) : null,
    previousCap: toMoneyDTOOrNull(previous, cur),
    deferredUntil: row?.deferredUntil ? row.deferredUntil.toISOString() : row?.writesBlockedUntil ? row.writesBlockedUntil.toISOString() : null,
    lastReadAt: row?.lastReadAt ? row.lastReadAt.toISOString() : null,
    canTurnOn,
    canTurnOff,
    offboardChoices: canTurnOff ? offeredChoices(previous) : [],
    action,
  };
}
