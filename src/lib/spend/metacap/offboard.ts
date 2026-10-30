/**
 * Wall (a), turning it off and offboarding (docs/SPEND-CONTROLS-SPEC.md 5.8, 4.17, 3.5).
 *
 * The owner picks one of three choices, each ledgered:
 * - "Keep the current limit on Meta" (the default, no write);
 * - "Put back my old limit (₹X)" (one write of the customer's own cap from before consent);
 * - "Remove the limit" (spend_cap_action=delete, one write).
 *
 * The same choice is applied, while the token still works, when the owner turns Meta's limit off, changes the spending ad
 * account, closes or erases the workspace, disconnects the account, or a platform admin suspends or soft-deletes the
 * workspace. A suspend with "keep" keeps managing it the 4.17 way (lowering only, never a raise). The write is routine when
 * the change budget allows it and emergency-class otherwise, because it hands control back to the customer. When no choice
 * can be applied (the token is gone), the owner is told in Edwyz that Meta's limit stays where it is.
 *
 * Demo assets are never touched (8.4); sandbox accounts were never written. SPEND_CAP_MODE observe or off sends nothing.
 */
import type { Prisma } from "@/generated/prisma/client";
import { prisma } from "@/lib/db";
import { describeError } from "@/lib/safe-error";
import { HttpError } from "@/lib/tenancy";
import { isDemoAsset } from "../demo";
import { spendCapMode } from "../flags";
import { appendStandalone, type LedgerDb } from "../ledger";
import { formatMinor, isCurrencyCode, toMoneyDTOOrNull, type MoneyDTO } from "../money";
import { notifySpend } from "../notify";
import type { MetacapOffboardJob, MetaOffboardChoice, MetaSpendLimitMode, SpendActor } from "../types";
import { actPath, assetToken, loadCapWrites, readCap, writeCap, type MetaCapDb, type MetaCapIo } from "./client";
import { offboardClass, toMetaCapRow, type MetaCapRow } from "./plan";

export const OFFBOARD_CHOICES: readonly MetaOffboardChoice[] = ["keep", "restore", "remove"];
export type OffboardTrigger = MetacapOffboardJob["trigger"] | "soft_delete";
export const OFFBOARD_TRIGGERS: readonly OffboardTrigger[] = ["turn_off", "account_change", "close", "erase", "suspend", "disconnect", "soft_delete"];

/** Stored choices for a later offboarding (the close dialog, the admin suspend form). The key holds the workspace id, so erasure removes it. */
export const offboardChoicesKey = (tenantId: string): string => `spend:metacap:choices:${tenantId}`;

const SYSTEM: SpendActor = { type: "system", job: "metacap.offboard" };

export function isOffboardChoice(value: unknown): value is MetaOffboardChoice {
  return typeof value === "string" && (OFFBOARD_CHOICES as readonly string[]).includes(value);
}

/** The 5.8 label of a choice. */
export function offboardChoiceLabel(choice: MetaOffboardChoice, previousCapMinor: bigint | null, currency: string): string {
  if (choice === "restore") return previousCapMinor !== null && previousCapMinor > 0n ? `Put back my old limit (${formatMinor(previousCapMinor, currency)})` : "Put back my old limit";
  if (choice === "remove") return "Remove the limit";
  return "Keep the current limit on Meta";
}

/** The choices offered for an account: "restore" only when there was an old limit to put back. */
export function offeredChoices(previousCapMinor: bigint | null): MetaOffboardChoice[] {
  return previousCapMinor !== null && previousCapMinor > 0n ? ["keep", "restore", "remove"] : ["keep", "remove"];
}

export type OffboardResult = {
  adAccountAssetId: string;
  choice: MetaOffboardChoice;
  trigger: OffboardTrigger;
  applied: "kept" | "restored" | "removed" | "not_needed" | "not_applied" | "observed";
  /** Meta's limit as it stands afterwards, when known. */
  capMinor: bigint | null;
  /** Plain words for the owner. */
  text: string;
};

/** Edwyz may have written Meta's limit on this account (otherwise there is nothing to undo). */
const wroteBefore = (row: MetaCapRow): boolean => row.lastWriteAt !== null || row.managedCapMinor !== null;

const ACTIVE_MODES: readonly MetaSpendLimitMode[] = ["managed", "error", "pending_owner", "no_permission", "currency_mismatch", "unavailable_prepaid", "sandbox", "other_workspace"];

async function setMode(db: MetaCapDb, adAccountAssetId: string, mode: MetaSpendLimitMode): Promise<void> {
  await db.metaSpendLimit.update({ where: { adAccountAssetId }, data: { mode, pendingTargetMinor: null, deferredUntil: null, version: { increment: 1 } } as never });
}

function accountLabel(asset: { name?: string | null; externalId?: string } | null, row: MetaCapRow): string {
  return asset?.name?.trim() || actPath(row.accountExternalId);
}

/**
 * Applies one 5.8 choice to one ad account. Never throws for Meta's answers: a choice that cannot be applied tells the owner
 * where Meta's limit stays. The row ends `withdrawn` (Edwyz stops managing it), except a suspend that keeps the limit.
 */
export async function offboardAccount(
  tenantId: string,
  adAccountAssetId: string,
  choice: MetaOffboardChoice,
  trigger: OffboardTrigger,
  actor: SpendActor = SYSTEM,
  io: MetaCapIo & { reason?: string } = {},
): Promise<OffboardResult> {
  const db = io.db ?? (prisma as unknown as MetaCapDb);
  const env = io.env ?? process.env;
  const now = io.now ?? new Date();
  const notify = io.notify ?? ((n) => notifySpend(n));
  if (!isOffboardChoice(choice)) throw new HttpError(400, "Choose to keep the limit, put back your old limit, or remove it.");
  const raw = (await db.metaSpendLimit.findUnique({ where: { adAccountAssetId } })) as Record<string, unknown> | null;
  if (!raw || String(raw.tenantId) !== tenantId) return { adAccountAssetId, choice, trigger, applied: "not_needed", capMinor: null, text: "Meta's limit was not managed by Edwyz on this ad account." };
  const row = toMetaCapRow(raw);
  const asset = (await db.metaAsset.findFirst({ where: { id: adAccountAssetId, tenantId } })) as { name?: string | null; externalId?: string; meta?: unknown; sandbox?: boolean } | null;
  const metaCurrency = asset?.meta && typeof asset.meta === "object" ? (asset.meta as { currency?: unknown }).currency : null;
  const currency = row.currency ?? (isCurrencyCode(metaCurrency) ? metaCurrency : "INR");
  const keepManaging = trigger === "suspend" && choice === "keep" && row.mode === "managed";
  const finalMode: MetaSpendLimitMode = keepManaging ? row.mode : ACTIVE_MODES.includes(row.mode) ? "withdrawn" : row.mode;
  const name = accountLabel(asset, row);
  const capNow = row.lastReadCapMinor ?? row.managedCapMinor;
  const stays = capNow !== null && capNow > 0n ? `Meta's spending limit on ${name} stays at ${formatMinor(capNow, currency)}. You can change it in Meta Ads Manager if you need to.` : `Meta's spending limit on ${name} stays as it is. You can change it in Meta Ads Manager if you need to.`;
  const base = {
    tenantId,
    pot: "ads" as const,
    action: "meta.spend_cap.offboard",
    phase: "info" as const,
    actor,
    targetType: "ad_account",
    targetId: adAccountAssetId,
    metaObjectId: actPath(row.accountExternalId),
    currency,
    sandbox: asset?.sandbox === true,
  };
  const record = (reason: string, codes: string[], extra: { observe?: boolean; after?: unknown } = {}) =>
    appendStandalone({ ...base, reason, reasonCodes: [trigger, choice, ...codes], before: { cap: capNow, mode: row.mode }, after: extra.after ?? { mode: finalMode }, observe: extra.observe ?? false }, { db: db as unknown as LedgerDb });

  // Nothing to write: keep, never written, a demo or sandbox account.
  if (choice === "keep" || !wroteBefore(row) || isDemoAsset(asset) || asset?.sandbox === true) {
    const text = choice === "keep" ? (capNow !== null && capNow > 0n ? `Kept the current limit on Meta (${formatMinor(capNow, currency)}).` : "Kept Meta's limit as it is.") : "Edwyz never changed Meta's limit on this ad account, so there was nothing to undo.";
    await record(text, choice === "keep" ? [] : ["not_needed"]);
    if (finalMode !== row.mode) await setMode(db, adAccountAssetId, finalMode);
    return { adAccountAssetId, choice, trigger, applied: choice === "keep" ? "kept" : "not_needed", capMinor: capNow, text };
  }

  const previous = row.customerCapMinor !== null && row.customerCapMinor > 0n ? row.customerCapMinor : null;
  const effective: MetaOffboardChoice = choice === "restore" && previous === null ? "remove" : choice;
  const wouldText = effective === "restore" ? `Put back the old limit of ${formatMinor(previous!, currency)} on Meta.` : "Removed Meta's spending limit.";

  const mode = spendCapMode(env);
  if (mode !== "enforce") {
    // Observe or off: Edwyz never wrote a limit for real, so there is nothing on Meta to undo. Recorded for the audit trail.
    await record(`${wouldText} (Meta's limit was not switched on yet, so nothing was sent.)`, ["observe"], { observe: mode === "observe" });
    if (finalMode !== row.mode) await setMode(db, adAccountAssetId, finalMode);
    return { adAccountAssetId, choice, trigger, applied: "observed", capMinor: capNow, text: "Meta's limit was not switched on yet, so nothing changed on Meta." };
  }

  const notApplied = async (why: string): Promise<OffboardResult> => {
    await record(`${stays} (${why})`, ["not_applied"]);
    await notify({ tenantId, kind: "meta_limit", severity: "heads_up", audience: "owner", dedupeKey: `metacap:offboard:${adAccountAssetId}:${trigger}`, title: "Meta's spending limit stays", body: stays, link: "/app/settings/spending", subjectType: "ad_account", subjectId: adAccountAssetId }).catch(() => undefined);
    if (finalMode !== row.mode) await setMode(db, adAccountAssetId, finalMode).catch(() => undefined);
    return { adAccountAssetId, choice, trigger, applied: "not_applied", capMinor: capNow, text: stays };
  };

  let token: string;
  try {
    token = (await assetToken(io, tenantId, adAccountAssetId)).token;
  } catch {
    return notApplied("the Meta connection is no longer usable");
  }
  let before;
  try {
    before = await readCap(token, row.accountExternalId);
  } catch (error) {
    console.error(`[spend] offboard read failed: ${describeError(error)}`);
    return notApplied("Meta could not be read");
  }
  const writeClass = offboardClass(await loadCapWrites(tenantId, adAccountAssetId, now, db), now);
  if (!writeClass) return notApplied("Meta's daily change limit is used up");
  const result = await writeCap({
    tenantId,
    row,
    token,
    action: effective === "restore" ? "write" : "delete",
    target: effective === "restore" ? previous! : 0n,
    priority: "offboard",
    writeClass,
    actor,
    reason: io.reason?.trim() || (effective === "restore" ? `Puts back your old limit of ${formatMinor(previous!, currency)} on Meta.` : "Removes Meta's spending limit, as you chose."),
    before,
    monthlyLimitMinor: null,
    spentBeforeMinor: null,
    db,
    env,
    now,
    enqueue: io.enqueue,
    notify,
    access: io.access,
  });
  if (result.outcome !== "applied") return notApplied(result.outcome === "failed" ? result.message : "Meta did not confirm the change");
  await setMode(db, adAccountAssetId, finalMode);
  const text = effective === "restore" ? `Put back your old limit of ${formatMinor(result.read.capMinor, currency)} on Meta.` : `Removed Meta's spending limit on ${name}.`;
  return { adAccountAssetId, choice: effective, trigger, applied: effective === "restore" ? "restored" : "removed", capMinor: result.read.capMinor, text };
}

/** The choices stored for a later offboarding (close dialog, admin form). */
export async function storedOffboardChoices(tenantId: string, db: MetaCapDb = prisma as unknown as MetaCapDb): Promise<Record<string, MetaOffboardChoice>> {
  const row = (await db.platformSetting.findUnique({ where: { key: offboardChoicesKey(tenantId) } })) as { value?: unknown } | null;
  const v = row?.value;
  const out: Record<string, MetaOffboardChoice> = {};
  if (v && typeof v === "object" && !Array.isArray(v)) for (const [k, c] of Object.entries(v as Record<string, unknown>)) if (isOffboardChoice(c)) out[k] = c;
  return out;
}

/**
 * Stores the owner's (or a platform admin's) choice per ad account for an offboarding that happens later (closing the
 * workspace is carried out by the platform team; a suspend form). Only accounts of this workspace with a MetaSpendLimit row.
 */
export async function saveOffboardChoices(tenantId: string, choices: Record<string, unknown>, actor: SpendActor, trigger: OffboardTrigger, io: MetaCapIo = {}): Promise<Record<string, MetaOffboardChoice>> {
  const db = io.db ?? (prisma as unknown as MetaCapDb);
  const rows = (((await db.metaSpendLimit.findMany({ where: { tenantId } })) ?? []) as Record<string, unknown>[]).map(toMetaCapRow);
  const known = new Set(rows.map((r) => r.adAccountAssetId));
  const clean: Record<string, MetaOffboardChoice> = {};
  for (const [assetId, choice] of Object.entries(choices ?? {})) {
    if (!isOffboardChoice(choice)) throw new HttpError(400, "Choose to keep the limit, put back your old limit, or remove it.");
    if (known.has(assetId)) clean[assetId] = choice;
  }
  const merged = { ...(await storedOffboardChoices(tenantId, db)), ...clean };
  const key = offboardChoicesKey(tenantId);
  const value = merged as Prisma.InputJsonValue;
  await db.platformSetting.upsert({ where: { key }, create: { key, value }, update: { value } });
  for (const [assetId, choice] of Object.entries(clean)) {
    const row = rows.find((r) => r.adAccountAssetId === assetId)!;
    await appendStandalone(
      {
        tenantId,
        pot: "ads",
        action: "meta.spend_cap.offboard_choice",
        phase: "info",
        actor,
        reason: `When this happens, Edwyz will ${choice === "keep" ? "keep the current limit on Meta" : choice === "restore" ? "put back your old limit on Meta" : "remove Meta's spending limit"}.`,
        reasonCodes: [trigger, choice],
        targetType: "ad_account",
        targetId: assetId,
        metaObjectId: actPath(row.accountExternalId),
        currency: row.currency,
      },
      { db: db as unknown as LedgerDb },
    );
  }
  return merged;
}

/**
 * Applies the offboarding to every ad account of a workspace where Edwyz holds Meta's limit (close, erase, suspend, soft
 * delete): the given choice, else the stored one, else "keep". Never throws.
 */
export async function offboardTenant(
  tenantId: string,
  trigger: OffboardTrigger,
  io: MetaCapIo & { actor?: SpendActor; choices?: Record<string, MetaOffboardChoice> } = {},
): Promise<OffboardResult[]> {
  const db = io.db ?? (prisma as unknown as MetaCapDb);
  let rows: MetaCapRow[] = [];
  try {
    rows = (((await db.metaSpendLimit.findMany({ where: { tenantId } })) ?? []) as Record<string, unknown>[]).map(toMetaCapRow).filter((r) => r.mode !== "off" && r.mode !== "withdrawn");
  } catch (error) {
    console.error(`[spend] offboard: Meta limits not read: ${describeError(error)}`);
    return [];
  }
  if (rows.length === 0) return [];
  const stored = await storedOffboardChoices(tenantId, db).catch(() => ({}) as Record<string, MetaOffboardChoice>);
  const out: OffboardResult[] = [];
  for (const row of rows) {
    const choice = io.choices?.[row.adAccountAssetId] ?? stored[row.adAccountAssetId] ?? "keep";
    try {
      out.push(await offboardAccount(tenantId, row.adAccountAssetId, choice, trigger, io.actor ?? SYSTEM, io));
    } catch (error) {
      console.error(`[spend] offboard of ${row.adAccountAssetId} failed: ${describeError(error)}`);
      out.push({ adAccountAssetId: row.adAccountAssetId, choice, trigger, applied: "not_applied", capMinor: row.lastReadCapMinor, text: "Meta's spending limit stays as it is." });
    }
  }
  return out;
}

/** Before the spending ad account changes (5.1, 5.8): the old account gets the owner's choice; the new one needs its own consent. */
export async function onSpendingAccountChange(
  tenantId: string,
  oldAssetId: string | null,
  newAssetId: string | null,
  choice: MetaOffboardChoice,
  actor: SpendActor,
  io: MetaCapIo = {},
): Promise<OffboardResult | null> {
  if (!oldAssetId || oldAssetId === newAssetId) return null;
  return offboardAccount(tenantId, oldAssetId, choice, "account_change", actor, io);
}

export type OffboardAccountDTO = {
  adAccountAssetId: string;
  accountName: string | null;
  accountExternalId: string;
  currency: string;
  mode: MetaSpendLimitMode;
  previousCap: MoneyDTO | null;
  currentCap: MoneyDTO | null;
  choices: { choice: MetaOffboardChoice; label: string }[];
  /** The stored choice, else "keep" (the default). */
  selected: MetaOffboardChoice;
};

/** The accounts the close dialog and the turn-off dialog ask about: every one where Edwyz manages or wrote Meta's limit. */
export async function offboardChoicesFor(tenantId: string, io: MetaCapIo = {}): Promise<OffboardAccountDTO[]> {
  const db = io.db ?? (prisma as unknown as MetaCapDb);
  const rows = (((await db.metaSpendLimit.findMany({ where: { tenantId } })) ?? []) as Record<string, unknown>[]).map(toMetaCapRow).filter((r) => r.mode === "managed" || r.mode === "error" || (r.mode !== "withdrawn" && wroteBefore(r)));
  if (rows.length === 0) return [];
  const stored = await storedOffboardChoices(tenantId, db).catch(() => ({}) as Record<string, MetaOffboardChoice>);
  const assets = ((await db.metaAsset.findMany({ where: { tenantId, id: { in: rows.map((r) => r.adAccountAssetId) } }, select: { id: true, name: true, meta: true } })) ?? []) as { id: string; name: string | null; meta: unknown }[];
  return rows.map((r) => {
    const asset = assets.find((a) => a.id === r.adAccountAssetId);
    const metaCurrency = asset?.meta && typeof asset.meta === "object" ? (asset.meta as { currency?: unknown }).currency : null;
    const currency = r.currency ?? (isCurrencyCode(metaCurrency) ? metaCurrency : "INR");
    const previous = r.customerCapMinor !== null && r.customerCapMinor > 0n ? r.customerCapMinor : null;
    const offered = offeredChoices(previous);
    const selected = stored[r.adAccountAssetId] && offered.includes(stored[r.adAccountAssetId]) ? stored[r.adAccountAssetId] : "keep";
    return {
      adAccountAssetId: r.adAccountAssetId,
      accountName: asset?.name ?? null,
      accountExternalId: r.accountExternalId,
      currency,
      mode: r.mode,
      previousCap: toMoneyDTOOrNull(previous, currency),
      currentCap: toMoneyDTOOrNull(r.lastReadCapMinor ?? r.managedCapMinor, currency),
      choices: offered.map((c) => ({ choice: c, label: offboardChoiceLabel(c, previous, currency) })),
      selected,
    };
  });
}
