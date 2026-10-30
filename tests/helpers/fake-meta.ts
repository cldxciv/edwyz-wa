/**
 * An in-memory Meta Graph API for the spend controls' tests (docs/SPEND-CONTROLS-SPEC.md 10.3). Never calls the network.
 *
 * It keeps ad accounts, campaigns, ad sets and ads (status, daily_budget, lifetime_budget, end_time) and enforces what the
 * book has to survive:
 * - 4 budget changes an hour per ad set or campaign; the 5th gets 613 / 1487632;
 * - spend_cap with switchable semantics (cumulative, or amount_spent resets on every write), a switchable write unit (Meta
 *   reads the written value as major units, or as minor units: 100x stricter), and a floor rule (the cap must be at least
 *   amount_spent, or 1.1x it) answered with "must be at least ₹X";
 * - 10 spending-limit changes per rolling 24 h; the 11th gets 17 / 1885172;
 * - prepaid accounts, permission errors (10, 200, 294) and injectable ambiguous 5xx or network failures, which may or may not
 *   have applied the write.
 * Reads return Meta's shapes: spend_cap and amount_spent as strings of minor units, budgets as strings of minor units,
 * insights spend as major-unit decimals.
 *
 * The adversarial spender spends the most Meta's rules allow: per budget object at most ceil(1.75 x the day's highest daily
 * budget) a day and 7 x the week's highest daily budget per Sunday-to-Saturday week (account time zone), never more than a
 * lifetime budget, nothing after end_time, and the account stops when amount_spent reaches spend_cap.
 *
 * Use `meta.fetch` as globalThis.fetch (vi.stubGlobal) for code that calls graph.facebook.com, or `meta.request` directly.
 */
import { currencyExponent, decimalToMinorBig, formatMinor, minorToMajorString } from "@/lib/spend/money";
import { addDays, dayKey, monthKeyOfDay, weekStartOfDay } from "@/lib/spend/periods";

export type CapSemantics = "cumulative" | "resets_on_write";
export type WriteUnit = "major" | "minor";
export type FloorRule = "none" | "spent" | "spent_1_1x";
export type MetaStatus = "ACTIVE" | "PAUSED" | "ARCHIVED" | "DELETED";
export type ObjectLevel = "campaign" | "adset" | "ad";
export type PermissionCode = 10 | 200 | 294;

const HOUR = 3_600_000;
const DAY = 24 * HOUR;
const ceil175 = (x: bigint) => (7n * x + 3n) / 4n;
const minB = (...xs: bigint[]) => xs.reduce((a, b) => (b < a ? b : a));
const maxB = (a: bigint, b: bigint) => (a > b ? a : b);

type Track = { key: string; peak: bigint; spent: bigint };

export type FakeObject = {
  id: string;
  level: ObjectLevel;
  accountId: string;
  campaignId: string | null;
  adSetId: string | null;
  name: string;
  status: MetaStatus;
  dailyBudgetMinor: bigint | null;
  lifetimeBudgetMinor: bigint | null;
  endTime: Date | null;
  spentLifetimeMinor: bigint;
  spentByDay: Map<string, bigint>;
  budgetChanges: number[];
  day: Track | null;
  week: Track | null;
};

export type FakeAccount = {
  id: string;
  currency: string;
  timezone: string;
  /** 0 = no spending limit. */
  spendCapMinor: bigint;
  amountSpentMinor: bigint;
  accountStatus: number;
  isPrepay: boolean;
  capWrites: number[];
  spentByDay: Map<string, bigint>;
};

export type FakeMetaOptions = {
  now?: Date;
  accountId?: string;
  currency?: string;
  timezone?: string;
  spendCapMinor?: bigint;
  amountSpentMinor?: bigint;
  semantics?: CapSemantics;
  writeUnit?: WriteUnit;
  floorRule?: FloorRule;
  prepaid?: boolean;
  /** Meta's per-object budget-change limit (4 an hour). */
  budgetChangesPerHour?: number;
  /** Meta's spending-limit change limit (10 a day). */
  capChangesPerDay?: number;
};

export type GraphResult = { status: number; body: unknown };
export type CallRecord = { method: string; path: string; params: Record<string, unknown>; status: number; at: Date };
export type InjectedFailure = { match?: RegExp; method?: string; kind: "status" | "network"; status?: number; apply: boolean; code?: number };

export class FakeMetaNetworkError extends TypeError {
  readonly applied: boolean;
  constructor(applied: boolean) {
    super("fetch failed");
    this.applied = applied;
  }
}

const err = (status: number, code: number, message: string, subcode?: number): GraphResult => ({
  status,
  body: { error: { message, type: "OAuthException", code, ...(subcode !== undefined ? { error_subcode: subcode } : {}), fbtrace_id: "fake-trace" } },
});

const PERMISSION_MESSAGES: Record<PermissionCode, string> = {
  10: "(#10) Application does not have permission for this action",
  200: "(#200) Permissions error",
  294: "(#294) Managing advertisements requires the extended permission ads_management",
};

export function createFakeMeta(opts: FakeMetaOptions = {}) {
  let clock = (opts.now ?? new Date("2026-10-01T00:00:00+05:30")).getTime();
  let semantics: CapSemantics = opts.semantics ?? "cumulative";
  let writeUnit: WriteUnit = opts.writeUnit ?? "major";
  let floorRule: FloorRule = opts.floorRule ?? "spent";
  const budgetChangesPerHour = opts.budgetChangesPerHour ?? 4;
  const capChangesPerDay = opts.capChangesPerDay ?? 10;
  const accounts = new Map<string, FakeAccount>();
  const objects = new Map<string, FakeObject>();
  const calls: CallRecord[] = [];
  const failures: InjectedFailure[] = [];
  const permission: { code: PermissionCode | null; scope: "cap" | "ads" | "all" } = { code: null, scope: "all" };
  const sends: { phoneNumberId: string; to: unknown; at: Date }[] = [];
  let ids = 0;

  const now = () => new Date(clock);

  function addAccount(a: { id?: string; currency?: string; timezone?: string; spendCapMinor?: bigint; amountSpentMinor?: bigint; prepaid?: boolean; accountStatus?: number } = {}): FakeAccount {
    const id = a.id ?? opts.accountId ?? "act_1";
    const acc: FakeAccount = {
      id,
      currency: a.currency ?? opts.currency ?? "INR",
      timezone: a.timezone ?? opts.timezone ?? "Asia/Kolkata",
      spendCapMinor: a.spendCapMinor ?? opts.spendCapMinor ?? 0n,
      amountSpentMinor: a.amountSpentMinor ?? opts.amountSpentMinor ?? 0n,
      accountStatus: a.accountStatus ?? 1,
      isPrepay: a.prepaid ?? opts.prepaid ?? false,
      capWrites: [],
      spentByDay: new Map(),
    };
    accounts.set(id, acc);
    return acc;
  }
  addAccount();

  const account = (id = opts.accountId ?? "act_1"): FakeAccount => {
    const a = accounts.get(id);
    if (!a) throw new Error(`fake-meta: no ad account ${id}`);
    return a;
  };

  function makeObject(level: ObjectLevel, fields: Partial<FakeObject> & { accountId?: string }): FakeObject {
    const id = fields.id ?? `${level === "campaign" ? "c" : level === "adset" ? "s" : "a"}_${++ids}`;
    const o: FakeObject = {
      id,
      level,
      accountId: fields.accountId ?? opts.accountId ?? "act_1",
      campaignId: fields.campaignId ?? null,
      adSetId: fields.adSetId ?? null,
      name: fields.name ?? id,
      status: fields.status ?? "PAUSED",
      dailyBudgetMinor: fields.dailyBudgetMinor ?? null,
      lifetimeBudgetMinor: fields.lifetimeBudgetMinor ?? null,
      endTime: fields.endTime ?? null,
      spentLifetimeMinor: 0n,
      spentByDay: new Map(),
      budgetChanges: [],
      day: null,
      week: null,
    };
    objects.set(id, o);
    return o;
  }

  const addCampaign = (f: Partial<FakeObject> = {}) => makeObject("campaign", f);
  const addAdSet = (f: Partial<FakeObject> & { campaignId: string }) => makeObject("adset", { ...f, accountId: f.accountId ?? objects.get(f.campaignId)?.accountId });
  const addAd = (f: Partial<FakeObject> & { adSetId: string }) => makeObject("ad", { ...f, campaignId: f.campaignId ?? objects.get(f.adSetId)?.campaignId ?? null, accountId: f.accountId ?? objects.get(f.adSetId)?.accountId });

  const object = (id: string): FakeObject => {
    const o = objects.get(id);
    if (!o) throw new Error(`fake-meta: no object ${id}`);
    return o;
  };

  // ----- Budget peaks (Meta's 175% rule uses the day's highest budget; the weekly 7x the week's highest) -----

  function roll(o: FakeObject, at: Date): void {
    const tz = account(o.accountId).timezone;
    const day = dayKey(at, tz);
    const week = weekStartOfDay(day);
    const d = o.dailyBudgetMinor ?? 0n;
    if (!o.day || o.day.key !== day) o.day = { key: day, peak: d, spent: 0n };
    if (!o.week || o.week.key !== week) o.week = { key: week, peak: d, spent: 0n };
  }

  function setDailyBudget(o: FakeObject, minor: bigint, at: Date): void {
    roll(o, at);
    o.dailyBudgetMinor = minor;
    o.day!.peak = maxB(o.day!.peak, minor);
    o.week!.peak = maxB(o.week!.peak, minor);
  }

  /** The object that holds the budget: the campaign when it has one (campaign budget), else the ad set. */
  function budgetHolders(): FakeObject[] {
    const out: FakeObject[] = [];
    for (const o of objects.values()) {
      if (o.level === "campaign" && (o.dailyBudgetMinor !== null || o.lifetimeBudgetMinor !== null)) out.push(o);
      if (o.level === "adset" && (o.dailyBudgetMinor !== null || o.lifetimeBudgetMinor !== null)) {
        const c = o.campaignId ? objects.get(o.campaignId) : undefined;
        if (!c || (c.dailyBudgetMinor === null && c.lifetimeBudgetMinor === null)) out.push(o);
      }
    }
    return out;
  }

  function delivering(o: FakeObject, at: Date): boolean {
    if (o.status !== "ACTIVE") return false;
    if (o.endTime && at.getTime() >= o.endTime.getTime()) return false;
    const c = o.campaignId ? objects.get(o.campaignId) : undefined;
    if (o.level === "adset" && c && (c.status !== "ACTIVE" || (c.endTime && at.getTime() >= c.endTime.getTime()))) return false;
    if (o.level === "campaign") {
      const sets = [...objects.values()].filter((s) => s.level === "adset" && s.campaignId === o.id);
      if (sets.length > 0 && !sets.some((s) => s.status === "ACTIVE" && !(s.endTime && at.getTime() >= s.endTime.getTime()))) return false;
    }
    return account(o.accountId).accountStatus === 1;
  }

  /** What Meta still lets the account spend before its limit stops it (null = no limit). */
  function capRoom(a: FakeAccount): bigint | null {
    if (a.spendCapMinor <= 0n) return null;
    return maxB(0n, a.spendCapMinor - a.amountSpentMinor);
  }

  /** The most this budget object may still spend right now under the 1.75x day, 7x week and lifetime rules. */
  function roomFor(o: FakeObject, at: Date = now()): bigint {
    roll(o, at);
    const limits: bigint[] = [];
    if (o.dailyBudgetMinor !== null) {
      limits.push(ceil175(o.day!.peak) - o.day!.spent);
      limits.push(7n * maxB(o.dailyBudgetMinor, o.week!.peak) - o.week!.spent);
    }
    if (o.lifetimeBudgetMinor !== null) limits.push(o.lifetimeBudgetMinor - o.spentLifetimeMinor);
    if (limits.length === 0) return 0n;
    return maxB(0n, minB(...limits));
  }

  function record(o: FakeObject, amount: bigint, at: Date): void {
    if (amount <= 0n) return;
    const a = account(o.accountId);
    const day = dayKey(at, a.timezone);
    o.day!.spent += amount;
    o.week!.spent += amount;
    o.spentLifetimeMinor += amount;
    o.spentByDay.set(day, (o.spentByDay.get(day) ?? 0n) + amount);
    a.amountSpentMinor += amount;
    a.spentByDay.set(day, (a.spentByDay.get(day) ?? 0n) + amount);
  }

  /** Spends up to `amount` on a budget object, never past Meta's rules or the account limit. Returns what was spent. */
  function spend(objectId: string, amount: bigint, at: Date = now()): bigint {
    const o = object(objectId);
    if (!delivering(o, at)) return 0n;
    const cap = capRoom(account(o.accountId));
    const allowed = minB(amount, roomFor(o, at), ...(cap === null ? [] : [cap]));
    record(o, allowed, at);
    return allowed;
  }

  /**
   * The adversary: from now until `until`, in steps (default 15 min), every delivering budget object spends the most the
   * rules allow at that moment. Returns the total spent and the spend per object.
   */
  function runAdversary(o: { until: Date; stepMs?: number }): { total: bigint; byObject: Record<string, bigint> } {
    const step = o.stepMs ?? 15 * 60_000;
    const byObject: Record<string, bigint> = {};
    let total = 0n;
    for (let t = clock; t <= o.until.getTime(); t += step) {
      clock = t;
      const at = new Date(t);
      for (const holder of budgetHolders()) {
        const spent = spend(holder.id, roomFor(holder, at), at);
        if (spent > 0n) {
          byObject[holder.id] = (byObject[holder.id] ?? 0n) + spent;
          total += spent;
        }
      }
    }
    clock = o.until.getTime();
    return { total, byObject };
  }

  // ----- Graph handling -----

  const recent = (times: number[], windowMs: number) => times.filter((t) => clock - t < windowMs).length;

  function permissionError(kind: "cap" | "ads"): GraphResult | null {
    if (permission.code === null) return null;
    if (permission.scope !== "all" && permission.scope !== kind) return null;
    return err(400, permission.code, PERMISSION_MESSAGES[permission.code]);
  }

  function parseCapWrite(a: FakeAccount, raw: unknown): bigint {
    const text = String(raw ?? "").trim();
    if (writeUnit === "minor") {
      // Meta reading the value as minor units: "20000.00" becomes 20000 minor units (100x stricter for INR).
      return BigInt(Math.floor(Number(text)));
    }
    return decimalToMinorBig(text, currencyExponent(a.currency));
  }

  function floorFor(a: FakeAccount): bigint {
    if (floorRule === "none") return 0n;
    if (floorRule === "spent") return a.amountSpentMinor;
    return (11n * a.amountSpentMinor + 9n) / 10n;
  }

  function writeAccount(a: FakeAccount, params: Record<string, unknown>): GraphResult {
    const denied = permissionError("cap");
    if (denied) return denied;
    if (a.isPrepay) return err(400, 100, "Spending limits aren't available for prepaid ad accounts.", 1885080);
    if (recent(a.capWrites, DAY) >= capChangesPerDay) return err(400, 17, "(#17) User request limit reached", 1885172);
    const action = params.spend_cap_action;
    if (action === "delete") {
      a.spendCapMinor = 0n;
    } else if (action === "reset") {
      a.amountSpentMinor = 0n;
    } else if (params.spend_cap !== undefined) {
      let value: bigint;
      try {
        value = parseCapWrite(a, params.spend_cap);
      } catch {
        return err(400, 100, "(#100) Invalid parameter");
      }
      const floor = floorFor(a);
      if (value > 0n && value < floor) {
        return err(400, 100, `The spending limit must be at least ${formatMinor(floor, a.currency)}.`, 1885650);
      }
      a.spendCapMinor = value;
      if (semantics === "resets_on_write") a.amountSpentMinor = 0n;
    } else {
      return err(400, 100, "(#100) Invalid parameter");
    }
    a.capWrites.push(clock);
    return { status: 200, body: { success: true } };
  }

  function effectiveStatus(o: FakeObject): string {
    const c = o.campaignId ? objects.get(o.campaignId) : undefined;
    const s = o.adSetId ? objects.get(o.adSetId) : undefined;
    if (o.status !== "ACTIVE") return o.status;
    if (c && c.status !== "ACTIVE") return "CAMPAIGN_PAUSED";
    if (s && s.status !== "ACTIVE") return "ADSET_PAUSED";
    return "ACTIVE";
  }

  function readObject(o: FakeObject): Record<string, unknown> {
    return {
      id: o.id,
      name: o.name,
      status: o.status,
      effective_status: effectiveStatus(o),
      ...(o.dailyBudgetMinor !== null ? { daily_budget: o.dailyBudgetMinor.toString() } : {}),
      ...(o.lifetimeBudgetMinor !== null ? { lifetime_budget: o.lifetimeBudgetMinor.toString() } : {}),
      ...(o.endTime ? { end_time: o.endTime.toISOString() } : {}),
      ...(o.campaignId ? { campaign_id: o.campaignId } : {}),
      ...(o.adSetId ? { adset_id: o.adSetId } : {}),
    };
  }

  const STATUSES: readonly MetaStatus[] = ["ACTIVE", "PAUSED", "ARCHIVED", "DELETED"];

  function writeObject(o: FakeObject, params: Record<string, unknown>): GraphResult {
    const denied = permissionError("ads");
    if (denied) return denied;
    const at = now();
    const budgetKeys = ["daily_budget", "lifetime_budget"].filter((k) => params[k] !== undefined);
    if (budgetKeys.length > 0) {
      if (recent(o.budgetChanges, HOUR) >= budgetChangesPerHour) return err(400, 613, "There have been too many budget changes to this ad set. Try again later.", 1487632);
    }
    if (params.status !== undefined) {
      if (!STATUSES.includes(params.status as MetaStatus)) return err(400, 100, "(#100) Invalid parameter");
      o.status = params.status as MetaStatus;
    }
    if (params.daily_budget !== undefined) setDailyBudget(o, BigInt(String(params.daily_budget)), at);
    if (params.lifetime_budget !== undefined) o.lifetimeBudgetMinor = BigInt(String(params.lifetime_budget));
    if (params.end_time !== undefined) o.endTime = params.end_time ? new Date(String(params.end_time)) : null;
    if (params.name !== undefined) o.name = String(params.name);
    if (budgetKeys.length > 0) o.budgetChanges.push(clock);
    return { status: 200, body: { success: true } };
  }

  function createUnder(a: FakeAccount, edge: string, params: Record<string, unknown>): GraphResult {
    const denied = permissionError("ads");
    if (denied) return denied;
    const status = (params.status as MetaStatus | undefined) ?? "PAUSED";
    const common = {
      accountId: a.id,
      name: String(params.name ?? edge),
      status,
      dailyBudgetMinor: params.daily_budget !== undefined ? BigInt(String(params.daily_budget)) : null,
      lifetimeBudgetMinor: params.lifetime_budget !== undefined ? BigInt(String(params.lifetime_budget)) : null,
      endTime: params.end_time ? new Date(String(params.end_time)) : null,
    };
    if (edge === "campaigns") return { status: 200, body: { id: addCampaign(common).id } };
    if (edge === "adsets") {
      if (!params.campaign_id || !objects.has(String(params.campaign_id))) return err(400, 100, "(#100) Invalid parameter: campaign_id");
      const s = addAdSet({ ...common, campaignId: String(params.campaign_id) });
      if (s.dailyBudgetMinor !== null) setDailyBudget(s, s.dailyBudgetMinor, now());
      return { status: 200, body: { id: s.id } };
    }
    if (edge === "ads") {
      if (!params.adset_id || !objects.has(String(params.adset_id))) return err(400, 100, "(#100) Invalid parameter: adset_id");
      return { status: 200, body: { id: addAd({ ...common, adSetId: String(params.adset_id) }).id } };
    }
    if (edge === "adcreatives") return { status: 200, body: { id: `cr_${++ids}` } };
    return err(400, 100, "(#100) Unsupported post request");
  }

  /** Ids named by a Graph `filtering` param ([{field: 'adset.id', operator: 'IN', value: [...]}]) for that field, or null. */
  function filteredIds(params: Record<string, unknown>, field: string): Set<string> | null {
    let spec = params.filtering;
    if (typeof spec === "string") {
      try {
        spec = JSON.parse(spec);
      } catch {
        return null;
      }
    }
    if (!Array.isArray(spec)) return null;
    const rule = spec.find((f) => f && typeof f === "object" && (f as { field?: unknown }).field === field) as { value?: unknown } | undefined;
    return rule && Array.isArray(rule.value) ? new Set(rule.value.map(String)) : null;
  }

  /**
   * Insights in Meta's shape: spend as a major-unit decimal string, days in the account's time zone. Presets today,
   * yesterday and this_month; time_increment=1 gives one row per day. level=adset or level=campaign gives one row per object
   * (with adset_id / campaign_id), optionally filtered by `adset.id` / `campaign.id` IN [...]. Spend under a campaign budget
   * is recorded on the campaign, so an ad set row there shows only spend recorded on that ad set itself.
   */
  function insights(a: FakeAccount, params: Record<string, unknown>, only?: FakeObject): GraphResult {
    const preset = String(params.date_preset ?? "today");
    const today = dayKey(now(), a.timezone);
    const yesterday = addDays(today, -1);
    const keep = (d: string) => (preset === "this_month" ? monthKeyOfDay(d) === monthKeyOfDay(today) : preset === "yesterday" ? d === yesterday : d === today);
    const lastDay = preset === "yesterday" ? yesterday : today;
    const daily = String(params.time_increment ?? "") === "1";
    const rowsFor = (days: Map<string, bigint>, extra: Record<string, string>) => {
      const selected = [...days.entries()].filter(([d]) => keep(d)).sort(([x], [y]) => (x < y ? -1 : 1));
      if (daily) return selected.map(([d, v]) => ({ ...extra, date_start: d, date_stop: d, spend: minorToMajorString(v, a.currency) }));
      const total = selected.reduce((s, [, v]) => s + v, 0n);
      return [{ ...extra, date_start: selected[0]?.[0] ?? lastDay, date_stop: lastDay, spend: minorToMajorString(total, a.currency) }];
    };
    const level = String(params.level ?? "");
    if (!only && (level === "adset" || level === "campaign")) {
      const ids = filteredIds(params, `${level}.id`);
      const data = [...objects.values()]
        .filter((o) => o.accountId === a.id && o.level === level && (!ids || ids.has(o.id)))
        .flatMap((o) => rowsFor(o.spentByDay, level === "adset" ? { adset_id: o.id, campaign_id: o.campaignId ?? "" } : { campaign_id: o.id }));
      return { status: 200, body: { data } };
    }
    return { status: 200, body: { data: rowsFor(only ? only.spentByDay : a.spentByDay, {}) } };
  }

  function handle(method: string, path: string, params: Record<string, unknown>): GraphResult {
    const parts = path.replace(/^\/+|\/+$/g, "").split("/");
    const [head, edge] = parts;
    const acc = accounts.get(head);
    if (method === "GET") {
      if (acc && !edge) {
        return {
          status: 200,
          body: {
            id: acc.id,
            spend_cap: acc.spendCapMinor.toString(),
            amount_spent: acc.amountSpentMinor.toString(),
            currency: acc.currency,
            timezone_name: acc.timezone,
            account_status: acc.accountStatus,
            is_prepay_account: acc.isPrepay,
            min_campaign_group_spend_cap: "10000",
          },
        };
      }
      if (acc && edge === "insights") return insights(acc, params);
      if (acc && (edge === "campaigns" || edge === "adsets" || edge === "ads")) {
        // The structure sync's reads (4.6.1): campaigns filtered by `id`, ad sets by `campaign.id`, ads by `adset.id`.
        const level = edge === "campaigns" ? "campaign" : edge === "adsets" ? "adset" : "ad";
        const byId = filteredIds(params, "id");
        const byCampaign = filteredIds(params, "campaign.id");
        const byAdSet = filteredIds(params, "adset.id");
        const data = [...objects.values()]
          .filter((o) => o.accountId === acc.id && o.level === level)
          .filter((o) => (!byId || byId.has(o.id)) && (!byCampaign || byCampaign.has(o.campaignId ?? "")) && (!byAdSet || byAdSet.has(o.adSetId ?? "")))
          .map(readObject);
        return { status: 200, body: { data } };
      }
      const o = objects.get(head);
      if (o && edge === "insights") return insights(account(o.accountId), params, o);
      if (o && !edge) return { status: 200, body: readObject(o) };
      return err(400, 100, "(#100) Object does not exist");
    }
    if (method === "POST") {
      if (acc && !edge) return writeAccount(acc, params);
      if (acc && edge) return createUnder(acc, edge, params);
      if (edge === "messages") {
        sends.push({ phoneNumberId: head, to: params.to, at: now() });
        return { status: 200, body: { messaging_product: "whatsapp", messages: [{ id: `wamid.fake${++ids}` }] } };
      }
      const o = objects.get(head);
      if (o && !edge) return writeObject(o, params);
      return err(400, 100, "(#100) Object does not exist");
    }
    return err(400, 100, "(#100) Unsupported request");
  }

  /** One Graph request. Throws FakeMetaNetworkError for an injected network failure (applied or not). */
  function request(method: string, path: string, params: Record<string, unknown> = {}): GraphResult {
    const m = method.toUpperCase();
    const i = failures.findIndex((f) => (!f.method || f.method === m) && (!f.match || f.match.test(path)));
    let result: GraphResult;
    if (i >= 0) {
      const f = failures.splice(i, 1)[0];
      if (f.apply) handle(m, path, params);
      if (f.kind === "network") {
        calls.push({ method: m, path, params, status: 0, at: now() });
        throw new FakeMetaNetworkError(f.apply);
      }
      result = err(f.status ?? 500, f.code ?? 2, "An unexpected error has occurred. Please retry your request later.");
    } else result = handle(m, path, params);
    calls.push({ method: m, path, params, status: result.status, at: now() });
    return result;
  }

  /** A fetch() for graph.facebook.com URLs (query and body merged into params; the body may be JSON or form-encoded). */
  async function fetchImpl(input: string | URL | Request, init?: RequestInit): Promise<Response> {
    const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url);
    if (url.hostname !== "graph.facebook.com") throw new TypeError(`fake-meta only answers graph.facebook.com, not ${url.hostname}`);
    const path = url.pathname.replace(/^\/v\d+(?:\.\d+)?\//, "");
    const params: Record<string, unknown> = Object.fromEntries(url.searchParams.entries());
    if (init?.body instanceof URLSearchParams) Object.assign(params, Object.fromEntries(init.body.entries()));
    else if (init?.body) {
      const text = String(init.body);
      try {
        Object.assign(params, JSON.parse(text));
      } catch {
        Object.assign(params, Object.fromEntries(new URLSearchParams(text).entries()));
      }
    }
    const out = request(init?.method ?? "GET", path, params);
    return new Response(JSON.stringify(out.body), { status: out.status, headers: { "content-type": "application/json" } });
  }

  return {
    accounts,
    objects,
    calls,
    sends,
    now,
    setNow: (d: Date) => void (clock = d.getTime()),
    advance: (ms: number) => void (clock += ms),
    addAccount,
    account,
    addCampaign,
    addAdSet,
    addAd,
    object,
    request,
    fetch: fetchImpl,
    spend,
    roomFor: (id: string, at?: Date) => roomFor(object(id), at ?? now()),
    runAdversary,
    /** The next matching request fails: an HTTP status (5xx) or a network error, having applied the write or not. */
    failNext: (f: InjectedFailure) => void failures.push(f),
    setPermissionError: (code: PermissionCode | null, scope: "cap" | "ads" | "all" = "all") => {
      permission.code = code;
      permission.scope = scope;
    },
    setPrepaid: (prepaid: boolean, id?: string) => void (account(id).isPrepay = prepaid),
    setSemantics: (s: CapSemantics) => void (semantics = s),
    setWriteUnit: (u: WriteUnit) => void (writeUnit = u),
    setFloorRule: (r: FloorRule) => void (floorRule = r),
    capChangesInLast24h: (id?: string) => recent(account(id).capWrites, DAY),
    budgetChangesInLastHour: (objectId: string) => recent(object(objectId).budgetChanges, HOUR),
  };
}

export type FakeMeta = ReturnType<typeof createFakeMeta>;
