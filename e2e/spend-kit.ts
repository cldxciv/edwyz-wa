/**
 * Playwright helpers for the spend-control specs (docs/SPEND-CONTROLS-SPEC.md 10.4). Every spend spec runs with
 * SPEND_DRY_RUN=1, so no Meta write leaves the machine (the ads client returns fake ids), and seeds state straight into the
 * local database through db() from ./helpers (refused for anything but localhost).
 *
 *   test.skip(!spendDryRun(), "Spend specs need SPEND_DRY_RUN=1 on the app under test.");
 *   const ads = await connectSpendingAdAccount(owner.tenantId, { currency: "INR" });
 *   await setAllowance(owner.tenantId, "ads", { currency: "INR", dailyMinor: 200_000n, monthlyMinor: 2_000_000n });
 *   await liftNewWorkspaceLimits(owner.tenantId);
 *
 * Amounts are bigint (or whole numbers) in minor units of an explicit currency, exactly as the database stores them.
 * SpendLedger and SpendConsent are append-only by trigger, so resetSpend() leaves them alone.
 */
import { createHash, randomBytes } from "node:crypto";
import { seal } from "./growth-helpers";
import { db, stamp } from "./helpers";

export type Pot = "ads" | "messaging" | "ai";
export type Freeze = "none" | "assistants" | "all";
type Minor = bigint | number;

const str = (v: Minor | null | undefined): string | null => (v === null || v === undefined ? null : BigInt(v).toString());

/** Meta's worst case for one day of a daily budget: ceil(1.75 x). The CapPanel's C becomes this daily limit (4.8). */
export const ceil175 = (x: Minor): bigint => (7n * BigInt(x) + 3n) / 4n;

/** True when the specs may run: SPEND_DRY_RUN=1 for the app (read from the same .env the app uses). */
export function spendDryRun(env: Record<string, string | undefined> = process.env): boolean {
  return ["1", "true", "yes", "on"].includes((env.SPEND_DRY_RUN ?? "").trim().toLowerCase());
}

/** Upserts the workspace's SpendControl row with the given fields (the rest keep their defaults). */
export async function seedSpendControl(
  tenantId: string,
  patch: Partial<{
    freeze: Freeze;
    frozenByKind: "owner" | "admin" | "platform_admin" | "breaker" | null;
    frozenByUserId: string | null;
    frozenReason: string | null;
    probation: "auto" | "lifted" | "forced";
    verifiedAt: Date | null;
    timezone: string;
    spendingAdAccountAssetId: string | null;
    approverUserIds: string[];
    approvalTtlHours: number;
    digestEnabled: boolean;
  }> = {},
): Promise<void> {
  const d = await db();
  await d.query(`INSERT INTO "SpendControl" ("tenantId","updatedAt") VALUES ($1, now()) ON CONFLICT ("tenantId") DO NOTHING`, [tenantId]);
  const entries = Object.entries(patch);
  if (entries.length === 0) return;
  if (patch.freeze && patch.freeze !== "none" && !("frozenAt" in patch)) entries.push(["frozenAt", new Date()]);
  const sets = entries.map(([k], i) => `"${k}" = $${i + 2}`).join(", ");
  await d.query(`UPDATE "SpendControl" SET ${sets}, "version" = "version" + 1, "updatedAt" = now() WHERE "tenantId" = $1`, [tenantId, ...entries.map(([, v]) => v)]);
}

/** Lifts the new-workspace limits, so specs about the owner's own limits are not capped at INR 2,000 a day. */
export async function liftNewWorkspaceLimits(tenantId: string): Promise<void> {
  await seedSpendControl(tenantId, { probation: "lifted" });
}

/**
 * Sets the owner's limits for one pot (null = Not set) and bumps the version, like a save from the Spending page. The
 * daily limit must not be above the monthly one (database CHECK).
 */
export async function setAllowance(tenantId: string, pot: Pot, limits: { currency?: string; dailyMinor?: Minor | null; monthlyMinor?: Minor | null }): Promise<{ version: number }> {
  const d = await db();
  const currency = limits.currency ?? (pot === "ai" ? "CRD" : "INR");
  const { rows } = await d.query(
    `INSERT INTO "SpendAllowance" ("id","tenantId","pot","currency","dailyLimitMinor","monthlyLimitMinor","updatedAt")
     VALUES ($1,$2,$3,$4,$5,$6,now())
     ON CONFLICT ("tenantId","pot") DO UPDATE SET "currency" = EXCLUDED."currency", "dailyLimitMinor" = EXCLUDED."dailyLimitMinor",
       "monthlyLimitMinor" = EXCLUDED."monthlyLimitMinor", "version" = "SpendAllowance"."version" + 1, "updatedAt" = now()
     RETURNING "version"`,
    [`sa_e2e_${stamp()}`, tenantId, pot, currency, str(limits.dailyMinor), str(limits.monthlyMinor)],
  );
  return { version: Number(rows[0].version) };
}

export async function clearAllowances(tenantId: string): Promise<void> {
  await (await db()).query(`DELETE FROM "SpendAllowance" WHERE "tenantId" = $1`, [tenantId]);
}

/** A ceiling row (platform, probation and plan scopes are shared by every workspace: restore them after the spec). */
export async function setCeiling(row: { scope: "platform" | "probation" | "plan" | "tenant"; scopeId: string; pot: Pot; currency: string; dailyMinor: Minor | null; monthlyMinor: Minor | null; expiresAt?: Date | null }): Promise<void> {
  await (await db()).query(
    `INSERT INTO "SpendCeiling" ("id","scope","scopeId","pot","currency","dailyMinor","monthlyMinor","reason","expiresAt","updatedAt")
     VALUES ($1,$2,$3,$4,$5,$6,$7,'e2e fixture',$8,now())
     ON CONFLICT ("scope","scopeId","pot","currency") DO UPDATE SET "dailyMinor" = EXCLUDED."dailyMinor", "monthlyMinor" = EXCLUDED."monthlyMinor", "expiresAt" = EXCLUDED."expiresAt", "updatedAt" = now()`,
    [`sc_e2e_${stamp()}`, row.scope, row.scopeId, row.pot, row.currency, str(row.dailyMinor), str(row.monthlyMinor), row.expiresAt ?? null],
  );
}

/**
 * A connected Meta account with one ad account, chosen as the workspace's spending ad account. The token is a sealed fake;
 * with SPEND_DRY_RUN=1 the app never sends it anywhere.
 */
export async function connectSpendingAdAccount(
  tenantId: string,
  opts: { userId?: string; currency?: string; timezone?: string; sandbox?: boolean; demo?: boolean; name?: string; choose?: boolean } = {},
): Promise<{ connectionId: string; assetId: string; externalId: string; name: string }> {
  const d = await db();
  const tag = stamp();
  const connectionId = `conn_sp_${tag}`;
  const assetId = `asset_sp_${tag}`;
  const externalId = `act_${tag}`;
  const name = opts.name ?? `Spend test ads ${tag.slice(-4)}`;
  await d.query(
    `INSERT INTO "MetaConnection" ("id","tenantId","metaUserId","scopes","tokenEnc","status","connectedByUserId","updatedAt") VALUES ($1,$2,$3,$4,$5,'active',$6,now())`,
    [connectionId, tenantId, `meta_user_${tag}`, ["ads_management", "ads_read"], seal(tenantId, "fake-token"), opts.userId ?? "e2e"],
  );
  const meta = { currency: opts.currency ?? "INR", timezone: opts.timezone ?? "Asia/Kolkata", ...(opts.demo ? { demo: true } : {}) };
  await d.query(
    `INSERT INTO "MetaAsset" ("id","tenantId","connectionId","type","externalId","name","tokenEnc","status","meta","sandbox","updatedAt") VALUES ($1,$2,$3,'ad_account',$4,$5,$6,'active',$7,$8,now())`,
    [assetId, tenantId, connectionId, externalId, name, seal(tenantId, "fake-token"), JSON.stringify(meta), opts.sandbox === true],
  );
  if (opts.choose !== false) await seedSpendControl(tenantId, { spendingAdAccountAssetId: assetId });
  return { connectionId, assetId, externalId, name };
}

/** Spent and held amounts for a messaging or AI counter (day and month keys in the workspace zone, default Asia/Kolkata). */
export async function seedCounter(tenantId: string, pot: "messaging" | "ai", figures: { spentMinor: Minor; reservedMinor?: Minor; timezone?: string; at?: Date }): Promise<{ day: string; month: string }> {
  const at = figures.at ?? new Date();
  const day = new Intl.DateTimeFormat("en-CA", { timeZone: figures.timezone ?? "Asia/Kolkata", year: "numeric", month: "2-digit", day: "2-digit" }).format(at);
  const keys = { day, month: day.slice(0, 7) };
  const d = await db();
  for (const [kind, key] of [["day", keys.day], ["month", keys.month]] as const) {
    await d.query(
      `INSERT INTO "SpendCounter" ("tenantId","pot","periodKind","periodKey","currency","spentMinor","reservedMinor","updatedAt") VALUES ($1,$2,$3,$4,$5,$6,$7,now())
       ON CONFLICT ("tenantId","pot","periodKind","periodKey") DO UPDATE SET "spentMinor" = EXCLUDED."spentMinor", "reservedMinor" = EXCLUDED."reservedMinor", "updatedAt" = now()`,
      [tenantId, pot, kind, key, pot === "ai" ? "CRD" : "INR", str(figures.spentMinor), str(figures.reservedMinor ?? 0)],
    );
  }
  return keys;
}

/**
 * A pending approval request with its single-use token. The stored hash is SHA-256 of the token text (hex); pass `hash`
 * when src/lib/spend/approval-token.ts hashes differently. Returns the token for the /s/<token> link.
 */
export async function seedApproval(
  tenantId: string,
  opts: { summary?: string; reason?: string; forecastMonthMinor?: Minor; currency?: string; expiresAt?: Date; status?: string; direction?: "raise" | "lower"; hash?: (token: string) => string } = {},
): Promise<{ id: string; token: string }> {
  const token = randomBytes(32).toString("base64url");
  const tokenHash = (opts.hash ?? ((t: string) => createHash("sha256").update(t).digest("hex")))(token);
  const id = `sp_e2e_${stamp()}`;
  await (await db()).query(
    `INSERT INTO "SpendApproval" ("id","tenantId","assistantKey","pot","actionKind","direction","intent","fingerprint","summary","reason","forecastMonthMinor","currency","status","tokenHash","expiresAt","correlationId")
     VALUES ($1,$2,'ads_optimizer','ads','raise_budget',$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)`,
    [
      id,
      tenantId,
      opts.direction ?? "raise",
      JSON.stringify({ kind: "raise_budget", adSetId: "e2e", metaAdSetId: "e2e", toMinor: "100000" }),
      `fp_${id}`,
      opts.summary ?? "Raise the daily budget of 'Diwali leads - Delhi' from ₹800 to ₹1,000",
      opts.reason ?? "Cost per lead is ₹62, well below your ₹100 target",
      str(opts.forecastMonthMinor ?? 455_000),
      opts.currency ?? "INR",
      opts.status ?? "pending",
      tokenHash,
      opts.expiresAt ?? new Date(Date.now() + 12 * 3_600_000),
      `c_${id}`,
    ],
  );
  return { id, token };
}

/** An open safety stop. */
export async function seedBreaker(
  tenantId: string,
  opts: { kind?: string; scopeType?: string; scopeId?: string; effect?: string; reason?: string; autoClearAt?: Date | null } = {},
): Promise<{ id: string }> {
  const id = `sb_e2e_${stamp()}`;
  await (await db()).query(
    `INSERT INTO "SpendBreaker" ("id","tenantId","kind","scopeType","scopeId","effect","reason","autoClearAt") VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
    [id, tenantId, opts.kind ?? "pacing", opts.scopeType ?? "workspace", opts.scopeId ?? tenantId, opts.effect ?? "block_raises", opts.reason ?? "Spent ₹1,400 by noon on ₹1,000 of daily budgets", opts.autoClearAt ?? null],
  );
  return { id };
}

/**
 * The platform switch, written directly (fixtures only; the real switch needs STOP SPENDING, a reason and a step-up).
 * It affects every workspace on the instance: always call clearPlatformFreeze() in afterEach.
 */
export async function setPlatformFreeze(level: Freeze, reason = "e2e fixture"): Promise<void> {
  const value = { freeze: level, reason: level === "none" ? null : reason, byUserId: null, at: new Date().toISOString(), version: Date.now() };
  await (await db()).query(`INSERT INTO "PlatformSetting" ("key","value","updatedAt") VALUES ('spend:platform',$1,now()) ON CONFLICT ("key") DO UPDATE SET "value" = EXCLUDED."value", "updatedAt" = now()`, [JSON.stringify(value)]);
}

export async function clearPlatformFreeze(): Promise<void> {
  await setPlatformFreeze("none");
}

/**
 * A rate card for the WhatsApp cost gate (rates in minor units per message, "*" = any country). Returns a function that
 * puts the previous card back; the card is shared by every workspace on the instance.
 */
export async function useRateCard(rates: Record<string, Partial<Record<"MARKETING" | "UTILITY" | "AUTHENTICATION" | "SERVICE", number>>>, currency = "INR"): Promise<() => Promise<void>> {
  const d = await db();
  const before = (await d.query(`SELECT "value" FROM "PlatformSetting" WHERE "key" = 'ratecard'`)).rows[0]?.value ?? null;
  const value = { currency, rates, note: "e2e fixture", updatedAt: new Date().toISOString() };
  await d.query(`INSERT INTO "PlatformSetting" ("key","value","updatedAt") VALUES ('ratecard',$1,now()) ON CONFLICT ("key") DO UPDATE SET "value" = EXCLUDED."value", "updatedAt" = now()`, [JSON.stringify(value)]);
  return async () => {
    if (before === null) await d.query(`DELETE FROM "PlatformSetting" WHERE "key" = 'ratecard'`);
    else await d.query(`UPDATE "PlatformSetting" SET "value" = $1, "updatedAt" = now() WHERE "key" = 'ratecard'`, [JSON.stringify(before)]);
  };
}

/**
 * Exchange rates for limits ('spend:fx', INR per unit), each dated `updatedAt` (default now). A rate older than 35 days is
 * shown as "Out of date" and not used. Returns a function that puts the previous table back; the table is shared by every
 * workspace on the instance.
 */
export async function useFxRates(rates: Record<string, string>, updatedAt: Date = new Date()): Promise<() => Promise<void>> {
  const d = await db();
  const before = (await d.query(`SELECT "value" FROM "PlatformSetting" WHERE "key" = 'spend:fx'`)).rows[0]?.value ?? null;
  const at = updatedAt.toISOString();
  const value = { base: "INR", rates, rateUpdatedAt: Object.fromEntries(Object.keys(rates).map((c) => [c, at])), updatedAt: at, byUserId: null };
  await d.query(`INSERT INTO "PlatformSetting" ("key","value","updatedAt") VALUES ('spend:fx',$1,now()) ON CONFLICT ("key") DO UPDATE SET "value" = EXCLUDED."value", "updatedAt" = now()`, [JSON.stringify(value)]);
  return async () => {
    if (before === null) await d.query(`DELETE FROM "PlatformSetting" WHERE "key" = 'spend:fx'`);
    else await d.query(`UPDATE "PlatformSetting" SET "value" = $1, "updatedAt" = now() WHERE "key" = 'spend:fx'`, [JSON.stringify(before)]);
  };
}

/** Marks the workspace verified (lifts automatic new-workspace limits), or clears it. */
export async function setWorkspaceVerified(tenantId: string, verified = true): Promise<void> {
  await seedSpendControl(tenantId, { verifiedAt: verified ? new Date() : null });
}

/** Paid invoices with a total above 0 (two lift automatic new-workspace limits). */
export async function seedPaidInvoices(tenantId: string, count = 2, totalPaise = 118_000): Promise<void> {
  const d = await db();
  for (let i = 0; i < count; i++) {
    const tag = stamp();
    await d.query(
      `INSERT INTO "Invoice" ("id","tenantId","number","status","planName","amountPaise","gstRateBps","gstPaise","totalPaise","paidAt") VALUES ($1,$2,$3,'paid','Growth',$4,1800,$5,$6,now())`,
      [`inv_sp_${tag}`, tenantId, `E2E-SP-${tag}`, Math.round(totalPaise / 1.18), totalPaise - Math.round(totalPaise / 1.18), totalPaise],
    );
  }
}

export type LedgerRow = { seq: string; action: string; phase: string; actorType: string; actorId: string | null; reason: string; reasonCodes: string[]; observe: boolean; createdAt: Date };

/** The workspace's ledger, oldest first, optionally for one action. */
export async function ledgerRows(tenantId: string, action?: string): Promise<LedgerRow[]> {
  const { rows } = await (await db()).query(
    `SELECT "seq"::text AS "seq","action","phase","actorType","actorId","reason","reasonCodes","observe","createdAt" FROM "SpendLedger"
     WHERE "tenantId" = $1 AND ($2::text IS NULL OR "action" = $2) ORDER BY "seq"`,
    [tenantId, action ?? null],
  );
  return rows as LedgerRow[];
}

/** The freeze as stored now (workspace row and platform switch). */
export async function storedFreeze(tenantId: string): Promise<{ workspace: Freeze; platform: Freeze }> {
  const d = await db();
  const ws = (await d.query(`SELECT "freeze" FROM "SpendControl" WHERE "tenantId" = $1`, [tenantId])).rows[0]?.freeze ?? "none";
  const pf = (await d.query(`SELECT "value"->>'freeze' AS f FROM "PlatformSetting" WHERE "key" = 'spend:platform'`)).rows[0]?.f ?? "none";
  return { workspace: ws as Freeze, platform: pf as Freeze };
}

/** Removes a workspace's mutable spend state (not the append-only ledger and consents). */
export async function resetSpend(tenantId: string): Promise<void> {
  const d = await db();
  for (const table of ["SpendAllowance", "SpendCounter", "SpendReservation", "SpendBreaker", "SpendApproval", "SpendCommitment", "AssistantMandate", "MetaSpendLimit", "SpendControl"]) {
    await d.query(`DELETE FROM "${table}" WHERE "tenantId" = $1`, [tenantId]);
  }
  await d.query(`DELETE FROM "SpendCeiling" WHERE "scope" = 'tenant' AND "scopeId" = $1`, [tenantId]);
}
