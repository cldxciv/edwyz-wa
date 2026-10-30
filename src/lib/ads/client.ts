import { graphFetchAs } from "@/lib/graph";
import { assertPermitValid, runUnderPermit } from "@/lib/spend/book";
import { SpendBlockedError, SpendGuardBypassError } from "@/lib/spend/errors";
import { fakeMetaWrites } from "@/lib/spend/sandbox";
import type { AdsGuard, AdsPermit, CreatePermit, LoweringPermit } from "@/lib/spend/types";
import { actId } from "./builders";

/*
 * The ads choke point (docs/SPEND-CONTROLS-SPEC.md 4.8). Every Marketing API write for an Edwyz campaign goes through this
 * client, and the client cannot be made without a guard (who acts, for which workspace and ad account), so a call site that
 * skips the Spend Book does not compile.
 *
 * - Creates (campaign, ad set, creative, ad) need a create permit (permitForPausedCreate). Campaigns, ad sets and ads must be
 *   sent with status PAUSED; creatives have no delivery status and must not carry one (erratum 12.1b). An assistant's ad set
 *   needs an end date (R2): end_time, which a lifetime budget also needs.
 * - Turning something ON (status ACTIVE) or raising a budget needs the AdsPermit reserveAds returned. The permit is checked
 *   against the book (assertPermitValid: still reserved, not frozen, no blocking breaker) BEFORE any network call, then the
 *   call runs inside the permit so the transport tripwire sees it.
 * - Pausing or archiving never needs a permit and is never blocked (I2). With the lowering permit recordLowering gives, the
 *   call is ledgered; without one the tripwire records it as an unledgered lowering.
 * - A budget cut needs recordLowering's `cut_budget` permit: the book decides the direction, never this client.
 * - Meta's spending limit is not written here (only src/lib/spend/metacap/client.ts writes it).
 * - SPEND_DRY_RUN=1 (never in production), or a sandbox ad account with SPEND_SIM=1, answers with fake ids and success and
 *   calls nothing (staging and e2e). The permit checks still run.
 *
 * The token is passed per call, never stored or logged.
 */

export type AdsClient = {
  createCampaign(body: Record<string, unknown>, permit: CreatePermit): Promise<string>;
  /**
   * Campaigns of the account whose name is exactly `name`, newest first, across every result page. Used to find one whose creation timed
   * out. Throws when the matches cannot be listed completely, so the caller never creates a duplicate on a partial view.
   * `onPage` runs after each page (the launcher uses it as a heartbeat).
   */
  findCampaignsByName(name: string, onPage?: () => Promise<void> | void): Promise<FoundCampaign[]>;
  createAdSet(body: Record<string, unknown>, permit: CreatePermit): Promise<string>;
  createCreative(body: Record<string, unknown>, permit: CreatePermit): Promise<string>;
  createAd(body: Record<string, unknown>, permit: CreatePermit): Promise<string>;
  /** Lowering: never blocked. Pass recordLowering's permit so the call is ledgered. */
  setStatus(metaId: string, status: "PAUSED" | "ARCHIVED", permit?: LoweringPermit | AdsPermit): Promise<void>;
  /** Turning on: only with the permit reserveAds returned for this object. */
  setStatus(metaId: string, status: "ACTIVE", permit: AdsPermit): Promise<void>;
  /** A raise needs reserveAds' permit covering this amount; a cut needs recordLowering's cut_budget permit. */
  setDailyBudget(metaAdSetId: string, dailyBudgetMinor: number | bigint, permit: AdsPermit | LoweringPermit): Promise<void>;
  /** Read only. */
  getObject<T = Record<string, unknown>>(metaId: string, fields: string | readonly string[]): Promise<T>;
  /** Read only: the ad account itself. */
  getAccount<T = Record<string, unknown>>(fields: string | readonly string[]): Promise<T>;
};

export type FoundCampaign = { id: string; name: string; status: string; createdAt: Date | null };

export type AdsClientOptions = { env?: Record<string, string | undefined> };

const LOOKUP_PAGE_SIZE = 100;
const MAX_LOOKUP_PAGES = 10;
const LOWERING_STATUSES = new Set(["PAUSED", "ARCHIVED"]);

const fieldList = (fields: string | readonly string[]) => (typeof fields === "string" ? fields : fields.join(","));
const upper = (v: unknown) => (typeof v === "string" ? v.trim().toUpperCase() : null);
const present = (v: unknown) => v !== undefined && v !== null && v !== "";

let fakeSeq = 0;
/** A recognisable fake Meta id for dry runs: never confused with a real numeric id. */
const fakeId = (kind: string) => `dryrun_${kind}_${Date.now().toString(36)}${(++fakeSeq).toString(36)}`;

/** Budgets go to Meta as whole numbers of minor units. */
function budgetValue(minor: number | bigint): number | string {
  const b = typeof minor === "bigint" ? minor : BigInt(minor);
  return b <= BigInt(Number.MAX_SAFE_INTEGER) ? Number(b) : b.toString();
}

function toMinorBig(minor: number | bigint): bigint {
  if (typeof minor === "bigint") return minor;
  if (!Number.isInteger(minor)) throw new RangeError("A budget must be a whole number of minor units.");
  return BigInt(minor);
}

function assertCreatePermit(permit: CreatePermit | undefined, account: string): asserts permit is CreatePermit {
  if (!permit || typeof permit !== "object" || permit.type !== "create") throw new SpendGuardBypassError("create_without_permit");
  if (actId(permit.adAccountExternalId) !== account) throw new SpendGuardBypassError("create_wrong_account");
}

/** Campaigns, ad sets and ads are created PAUSED, then turned on through the book (I12). */
function assertPausedBody(body: Record<string, unknown>): void {
  if (upper(body.status) !== "PAUSED") throw new SpendGuardBypassError("create_not_paused");
  for (const k of ["configured_status", "effective_status"]) if (k in body && upper(body[k]) !== "PAUSED") throw new SpendGuardBypassError("create_not_paused");
}

export function adsClient(token: string, accountExternalId: string, guard: AdsGuard, opts: AdsClientOptions = {}): AdsClient {
  if (!guard || typeof guard !== "object" || !guard.tenantId || !guard.adAccountAssetId || !guard.actor) throw new SpendGuardBypassError("ads_client_without_guard");
  const account = actId(accountExternalId);
  const env = opts.env ?? process.env;
  const fake = () => fakeMetaWrites(guard.sandbox === true, env);

  async function create(kind: "campaign" | "adset" | "adcreative" | "ad", path: string, body: Record<string, unknown>, permit: CreatePermit): Promise<string> {
    assertCreatePermit(permit, account);
    if (fake()) return fakeId(kind);
    const res = await runUnderPermit(permit, () => graphFetchAs<{ id?: string }>(token, { path, method: "POST", body }));
    if (!res?.id || typeof res.id !== "string") throw new Error("Meta did not return an object id.");
    return res.id;
  }

  async function write(metaId: string, body: Record<string, unknown>, permit?: AdsPermit | LoweringPermit): Promise<void> {
    if (fake()) return;
    if (permit) await runUnderPermit(permit, () => graphFetchAs(token, { path: metaId, method: "POST", body }));
    else await graphFetchAs(token, { path: metaId, method: "POST", body });
  }

  async function read<T>(path: string, fields: string | readonly string[]): Promise<T> {
    if (fake()) return { id: path } as T;
    return graphFetchAs<T>(token, { path, method: "GET", query: { fields: fieldList(fields) } });
  }

  async function setStatus(metaId: string, status: "ACTIVE" | "PAUSED" | "ARCHIVED", permit?: AdsPermit | LoweringPermit): Promise<void> {
    if (LOWERING_STATUSES.has(status)) {
      // A stop is never blocked (I2): a permit only adds the ledger link. A permit the book did not mint is refused before the
      // call is made, so the pause then goes out without one (the tripwire records it as an unledgered lowering).
      if (!permit || fake()) return write(metaId, { status }, permit);
      let started = false;
      try {
        await runUnderPermit(permit, () => {
          started = true;
          return graphFetchAs(token, { path: metaId, method: "POST", body: { status } });
        });
      } catch (error) {
        if (started) throw error;
        await write(metaId, { status });
      }
      return;
    }
    if (status !== "ACTIVE") throw new SpendGuardBypassError("unknown_status");
    if (!permit || typeof permit !== "object" || permit.type !== "ads") throw new SpendGuardBypassError("active_without_permit");
    if (permit.objects[metaId]?.status !== "ACTIVE") throw new SpendGuardBypassError("active_not_in_permit");
    // One fresh read of the book: reserved, unexpired, not frozen, no blocking breaker. No network call before it.
    await assertPermitValid(permit, metaId);
    await write(metaId, { status: "ACTIVE" }, permit);
  }

  return {
    async createCampaign(body, permit) {
      assertCreatePermit(permit, account);
      assertPausedBody(body);
      return create("campaign", `${account}/campaigns`, body, permit);
    },
    async findCampaignsByName(name, onPage) {
      if (fake()) return [];
      // VERIFY: the name filter operator; CONTAIN is used and the exact match is re-checked here.
      const found: FoundCampaign[] = [];
      let after: string | undefined;
      for (let page = 0; page < MAX_LOOKUP_PAGES; page++) {
        const res = await graphFetchAs<{ data?: { id?: unknown; name?: unknown; status?: unknown; created_time?: unknown }[]; paging?: { next?: unknown; cursors?: { after?: unknown } } }>(token, {
          path: `${account}/campaigns`,
          method: "GET",
          query: { fields: "id,name,status,created_time", filtering: JSON.stringify([{ field: "name", operator: "CONTAIN", value: name }]), limit: String(LOOKUP_PAGE_SIZE), ...(after ? { after } : {}) },
        });
        for (const r of Array.isArray(res?.data) ? res.data : []) {
          if (typeof r.id !== "string" || r.name !== name) continue;
          const created = typeof r.created_time === "string" ? new Date(r.created_time) : null;
          found.push({ id: r.id, name: r.name, status: typeof r.status === "string" ? r.status : "", createdAt: created && !Number.isNaN(created.getTime()) ? created : null });
        }
        await onPage?.();
        if (!res?.paging?.next) return found.sort((a, b) => (b.createdAt?.getTime() ?? 0) - (a.createdAt?.getTime() ?? 0));
        const cursor = res.paging.cursors?.after;
        if (typeof cursor !== "string" || !cursor) break;
        after = cursor;
      }
      throw new Error("Too many campaigns on the ad account match this name to check for an earlier attempt.");
    },
    async createAdSet(body, permit) {
      assertCreatePermit(permit, account);
      assertPausedBody(body);
      // R2: an assistant's ad set always has an end date (a lifetime budget needs one too).
      if (guard.actor.type === "assistant" && !present(body.end_time)) throw new SpendBlockedError("spend.end_date_required");
      if (present(body.lifetime_budget) && !present(body.end_time)) throw new RangeError("An ad set with a lifetime budget needs an end date.");
      return create("adset", `${account}/adsets`, body, permit);
    },
    async createCreative(body, permit) {
      assertCreatePermit(permit, account);
      // Erratum 12.1b: a creative has no delivery status; sending one would make Meta reject the request.
      if ("status" in body) throw new SpendGuardBypassError("creative_with_status");
      return create("adcreative", `${account}/adcreatives`, body, permit);
    },
    async createAd(body, permit) {
      assertCreatePermit(permit, account);
      assertPausedBody(body);
      return create("ad", `${account}/ads`, body, permit);
    },
    setStatus: setStatus as AdsClient["setStatus"],
    async setDailyBudget(metaAdSetId, dailyBudgetMinor, permit) {
      const minor = toMinorBig(dailyBudgetMinor);
      if (minor <= 0n) throw new RangeError("A daily budget must be above zero.");
      if (!permit || typeof permit !== "object") throw new SpendGuardBypassError("budget_without_permit");
      if (permit.type === "ads") {
        const max = permit.objects[metaAdSetId]?.maxDailyMinor;
        if (max === undefined || minor > max) throw new SpendGuardBypassError("budget_over_permit");
        await assertPermitValid(permit, metaAdSetId);
      } else if (permit.type === "lowering") {
        if (permit.kind !== "cut_budget" || !permit.metaObjectIds.includes(metaAdSetId)) throw new SpendGuardBypassError("budget_wrong_lowering_permit");
        // A cut permit covers the cut it was minted for, never more: anything above it would be a raise.
        if (typeof permit.maxBudgetMinor !== "bigint" || minor > permit.maxBudgetMinor) throw new SpendGuardBypassError("budget_over_permit");
      } else {
        throw new SpendGuardBypassError("budget_without_permit");
      }
      await write(metaAdSetId, { daily_budget: budgetValue(minor) }, permit);
    },
    getObject: (metaId, fields) => read(metaId, fields),
    getAccount: (fields) => read(account, fields),
  };
}
