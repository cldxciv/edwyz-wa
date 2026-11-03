import { describe, expect, it } from "vitest";
import {
  adAccountScope,
  BUSY_HOLD_MS,
  BUSY_PCT,
  cooldownMsFor,
  createThrottle,
  DEFAULT_COOLDOWN_MS,
  HOURLY_COOLDOWN_MS,
  instagramScope,
  isThrottleError,
  MAX_COOLDOWN_MS,
  pageScope,
  parseUsageHeaders,
  PRIORITY,
  PromoteThrottledError,
  readRecord,
  type SettingStore,
  THROTTLE_613_SUBCODES,
  THROTTLE_CODES,
  throttleKey,
  type ThrottlePriority,
} from "@/lib/promote/throttle";

/**
 * docs/IG-PAGE-ADS-SPEC.md 4.9 (promote-throttle): the cooldown in PlatformSetting `promote:throttle:<act>` is set on 17, 32,
 * 80000 to 80014 and 613 (with subcodes 1487632, 5044001, 4841018) and read before every call; above 75% usage only priorities
 * 1 and 2 run; the three usage headers are parsed.
 */

const T0 = Date.parse("2026-10-31T10:00:00Z");
const MIN = 60_000;
const ACT = "act_777";

function memoryStore() {
  const rows = new Map<string, unknown>();
  let writes = 0;
  const store: SettingStore = {
    get: async (key) => (rows.has(key) ? structuredClone(rows.get(key)) : null),
    set: async (key, value) => {
      writes++;
      rows.set(key, structuredClone(value));
    },
  };
  return { store, rows, writes: () => writes };
}

function setup() {
  let now = T0;
  const mem = memoryStore();
  const t = createThrottle({ store: mem.store, now: () => now });
  return { t, mem, advance: (ms: number) => void (now += ms), now: () => now };
}

const buc = (entries: Record<string, unknown>[], id = "1800000000000001") => JSON.stringify({ [id]: entries });
const ALL_PRIORITIES: ThrottlePriority[] = [1, 2, 3, 4, 5];

async function held(t: ReturnType<typeof createThrottle>, scope: string, p: ThrottlePriority): Promise<PromoteThrottledError | null> {
  try {
    await t.check(scope, p);
    return null;
  } catch (e) {
    if (e instanceof PromoteThrottledError) return e;
    throw e;
  }
}

describe("codes that start a cooldown", () => {
  const LISTED = [17, 32, 613, ...Array.from({ length: 15 }, (_, i) => 80000 + i)];

  it("are exactly 17, 32, 613 and 80000 to 80014, plus the three 613 subcodes", () => {
    expect([...THROTTLE_CODES].sort((a, b) => a - b)).toEqual(LISTED.sort((a, b) => a - b));
    expect(THROTTLE_613_SUBCODES).toEqual([1487632, 5044001, 4841018]);
    for (const code of LISTED) expect(isThrottleError(code), String(code)).toBe(true);
    for (const subcode of THROTTLE_613_SUBCODES) expect(isThrottleError(613, subcode)).toBe(true);
    for (const code of [4, 100, 190, 200, 2655, 79999, 80015, 130429]) expect(isThrottleError(code), String(code)).toBe(false);
    expect(isThrottleError(undefined)).toBe(false);
  });

  it.each([...LISTED.map((c) => [c, undefined] as const), ...THROTTLE_613_SUBCODES.map((s) => [613, s] as const)])("code %s (subcode %s) stores {until, code} and holds every call", async (code, subcode) => {
    const { t, mem, advance } = setup();
    const cd = await t.noteError(ACT, { code, subcode });
    expect(cd).not.toBeNull();
    const stored = mem.rows.get(`promote:throttle:${ACT}`) as Record<string, unknown>;
    expect(stored).toMatchObject({ code, until: cd!.until.toISOString() });
    if (subcode) expect(stored.subcode).toBe(subcode);
    for (const p of ALL_PRIORITIES) {
      const e = await held(t, ACT, p);
      expect(e?.reason, `priority ${p}`).toBe("cooldown");
      expect(e?.metaCode).toBe(code);
    }
    advance(cd!.until.getTime() - T0 + 1);
    for (const p of ALL_PRIORITIES) expect(await held(t, ACT, p)).toBeNull();
  });

  it("any other error sets nothing", async () => {
    const { t, mem } = setup();
    expect(await t.noteError(ACT, { code: 100 })).toBeNull();
    expect(await t.noteError(ACT, { code: null })).toBeNull();
    expect(mem.writes()).toBe(0);
    expect(await held(t, ACT, 5)).toBeNull();
  });
});

describe("cooldown length", () => {
  it("is 5 minutes by default, an hour for 613/1487632 (budget changes per hour), and what Meta says when it says so", async () => {
    expect(cooldownMsFor(17, null, null)).toBe(DEFAULT_COOLDOWN_MS);
    expect(DEFAULT_COOLDOWN_MS).toBe(5 * MIN);
    expect(cooldownMsFor(613, 1487632, null)).toBe(HOURLY_COOLDOWN_MS);
    const usage = parseUsageHeaders({ "x-business-use-case-usage": buc([{ type: "ads_management", call_count: 100, estimated_time_to_regain_access: 12 }]) });
    expect(cooldownMsFor(613, 1487632, usage)).toBe(12 * MIN);
    const huge = parseUsageHeaders({ "x-business-use-case-usage": buc([{ call_count: 100, estimated_time_to_regain_access: 10_000_000 }]) });
    expect(cooldownMsFor(17, null, huge)).toBe(MAX_COOLDOWN_MS);
  });

  it("is never shortened by a later error", async () => {
    const { t } = setup();
    const long = await t.noteError(ACT, { code: 613, subcode: 1487632 });
    const short = await t.noteError(ACT, { code: 17 });
    expect(short!.until.getTime()).toBe(long!.until.getTime());
    expect((await t.cooldown(ACT))!.code).toBe(17);
  });

  it("the refusal is plain and says when to try again", async () => {
    const { t } = setup();
    await t.noteError(ACT, { code: 17 });
    const e = await held(t, ACT, 1);
    expect(e).toBeInstanceOf(PromoteThrottledError);
    expect(e!.status).toBe(503);
    expect(e!.message).toBe("Meta is busy right now. Try again in 5 minutes.");
    expect(e!.until.getTime()).toBe(T0 + 5 * MIN);
    expect(new PromoteThrottledError({ reason: "busy", until: new Date(T0 + 30_000), scope: ACT, now: T0 }).message).toBe("Meta is busy right now. Try again in 1 minute.");
  });

  it("scopes are separate: one ad account's cooldown does not hold another, or a Page", async () => {
    const { t } = setup();
    await t.noteError(ACT, { code: 17 });
    expect(await held(t, "act_888", 3)).toBeNull();
    expect(await held(t, pageScope("104857600123"), 3)).toBeNull();
  });
});

describe("priorities above 75% usage", () => {
  it("1 and 2 run; 3, 4 and 5 are held", async () => {
    expect(PRIORITY).toEqual({ leads: 1, review: 2, interactive: 3, audiences: 4, breakdowns: 5 });
    expect(BUSY_PCT).toBe(75);
    const { t } = setup();
    await t.noteHeaders(ACT, { "x-ad-account-usage": JSON.stringify({ acc_id_util_pct: 80 }) });
    expect(await held(t, ACT, PRIORITY.leads)).toBeNull();
    expect(await held(t, ACT, PRIORITY.review)).toBeNull();
    for (const p of [PRIORITY.interactive, PRIORITY.audiences, PRIORITY.breakdowns]) expect((await held(t, ACT, p))?.reason, `priority ${p}`).toBe("busy");
  });

  it("exactly 75% is not above 75%", async () => {
    const { t } = setup();
    await t.noteHeaders(ACT, { "x-business-use-case-usage": buc([{ call_count: 75, total_cputime: 40, total_time: 40 }]) });
    for (const p of ALL_PRIORITIES) expect(await held(t, ACT, p)).toBeNull();
  });

  it("a later reading at or below 75% releases the hold and clears the shared record", async () => {
    const { t, mem } = setup();
    await t.noteHeaders(ACT, { "x-ad-account-usage": JSON.stringify({ acc_id_util_pct: 92 }) });
    expect((mem.rows.get(`promote:throttle:${ACT}`) as { busy?: unknown }).busy).toMatchObject({ pct: 92 });
    await t.noteHeaders(ACT, { "x-ad-account-usage": JSON.stringify({ acc_id_util_pct: 20 }) });
    expect((mem.rows.get(`promote:throttle:${ACT}`) as { busy?: unknown }).busy).toBeUndefined();
    for (const p of ALL_PRIORITIES) expect(await held(t, ACT, p)).toBeNull();
  });

  it("is shared through PlatformSetting: another process holds the same work, until the hold ends", async () => {
    let now = T0;
    const mem = memoryStore();
    const worker = createThrottle({ store: mem.store, now: () => now });
    const web = createThrottle({ store: mem.store, now: () => now });
    await worker.noteHeaders(ACT, { "x-business-use-case-usage": buc([{ call_count: 88 }]) });
    expect((await held(web, ACT, PRIORITY.interactive))?.reason).toBe("busy");
    expect(await held(web, ACT, PRIORITY.review)).toBeNull();
    now += BUSY_HOLD_MS + 1;
    expect(await held(web, ACT, PRIORITY.interactive)).toBeNull();
  });

  it("does not rewrite the shared record on every busy answer", async () => {
    const { t, mem, advance } = setup();
    for (let i = 0; i < 20; i++) {
      await t.noteHeaders(ACT, { "x-ad-account-usage": JSON.stringify({ acc_id_util_pct: 90 }) });
      advance(1000);
    }
    expect(mem.writes()).toBe(1);
  });

  it("a busy hold lasts as long as Meta's own wait when that is longer", async () => {
    const { t, mem } = setup();
    await t.noteHeaders(ACT, { "x-business-use-case-usage": buc([{ call_count: 99, estimated_time_to_regain_access: 20 }]) });
    const busy = (mem.rows.get(`promote:throttle:${ACT}`) as { busy: { until: string } }).busy;
    expect(Date.parse(busy.until)).toBe(T0 + 20 * MIN);
  });
});

describe("usage headers", () => {
  it("X-Business-Use-Case-Usage: the highest of call_count, total_cputime and total_time across every business and type", () => {
    const u = parseUsageHeaders({
      "X-Business-Use-Case-Usage": JSON.stringify({
        "1": [{ type: "ads_management", call_count: 12, total_cputime: 30, total_time: 8, estimated_time_to_regain_access: 0, ads_api_access_tier: "development_access" }],
        "2": [{ type: "custom_audience", call_count: 64, total_cputime: 2, total_time: 2 }],
      }),
    });
    expect(u).toEqual({ pct: 64, regainMs: null, tier: "development_access", sources: ["x-business-use-case-usage"] });
  });

  it("X-Ad-Account-Usage: acc_id_util_pct and reset_time_duration (seconds)", () => {
    expect(parseUsageHeaders({ "x-ad-account-usage": JSON.stringify({ acc_id_util_pct: 9.67, reset_time_duration: 0, ads_api_access_tier: "standard_access" }) })).toEqual({
      pct: 9.67,
      regainMs: null,
      tier: "standard_access",
      sources: ["x-ad-account-usage"],
    });
    expect(parseUsageHeaders({ "x-ad-account-usage": JSON.stringify({ acc_id_util_pct: 100, reset_time_duration: 300 }) })?.regainMs).toBe(5 * MIN);
  });

  it("X-FB-Ads-Insights-Throttle: app and account percentages", () => {
    expect(parseUsageHeaders({ "x-fb-ads-insights-throttle": JSON.stringify({ app_id_util_pct: 81, acc_id_util_pct: 10 }) })).toMatchObject({ pct: 81, sources: ["x-fb-ads-insights-throttle"] });
  });

  it("reads a Headers object (any case) and combines the three", () => {
    const h = new Headers();
    h.set("X-Business-Use-Case-Usage", buc([{ call_count: 10, estimated_time_to_regain_access: 3 }]));
    h.set("X-Ad-Account-Usage", JSON.stringify({ acc_id_util_pct: 50 }));
    h.set("X-FB-Ads-Insights-Throttle", JSON.stringify({ app_id_util_pct: 77, acc_id_util_pct: 1 }));
    expect(parseUsageHeaders(h)).toEqual({ pct: 77, regainMs: 3 * MIN, tier: null, sources: ["x-business-use-case-usage", "x-ad-account-usage", "x-fb-ads-insights-throttle"] });
  });

  it("ignores what it cannot trust: no headers, bad JSON, odd shapes, negative or huge numbers, oversized values", () => {
    expect(parseUsageHeaders(null)).toBeNull();
    expect(parseUsageHeaders({})).toBeNull();
    expect(parseUsageHeaders(new Headers({ "content-type": "application/json" }))).toBeNull();
    expect(parseUsageHeaders({ "x-ad-account-usage": "{not json" })).toBeNull();
    expect(parseUsageHeaders({ "x-ad-account-usage": "[1,2]" })).toBeNull();
    expect(parseUsageHeaders({ "x-business-use-case-usage": JSON.stringify({ a: "nope" }) })).toBeNull();
    expect(parseUsageHeaders({ "x-ad-account-usage": JSON.stringify({ acc_id_util_pct: -5 }) })?.pct).toBe(0);
    expect(parseUsageHeaders({ "x-ad-account-usage": JSON.stringify({ acc_id_util_pct: 5000 }) })?.pct).toBe(100);
    expect(parseUsageHeaders({ "x-ad-account-usage": JSON.stringify({ acc_id_util_pct: "abc", ads_api_access_tier: "<script>" }) })).toEqual({ pct: 0, regainMs: null, tier: null, sources: ["x-ad-account-usage"] });
    expect(parseUsageHeaders({ "x-ad-account-usage": JSON.stringify({ acc_id_util_pct: 90, pad: "x".repeat(10_000) }) })).toBeNull();
  });

  it("noteHeaders with no usage headers changes nothing", async () => {
    const { t, mem } = setup();
    expect(await t.noteHeaders(ACT, new Headers())).toBeNull();
    expect(t.usage(ACT)).toBeNull();
    expect(mem.writes()).toBe(0);
  });
});

describe("storage", () => {
  it("keys are promote:throttle:<scope>, and only known scope shapes are accepted", () => {
    expect(adAccountScope("123")).toBe("act_123");
    expect(adAccountScope("act_123")).toBe("act_123");
    expect(throttleKey(adAccountScope("123"))).toBe("promote:throttle:act_123");
    expect(throttleKey(pageScope("104857600123"))).toBe("promote:throttle:page_104857600123");
    expect(throttleKey(instagramScope("17841400000000001"))).toBe("promote:throttle:ig_17841400000000001");
    for (const bad of ["act_", "act_1/../x", "settings", "page_1 2", ""]) expect(() => throttleKey(bad), bad).toThrow();
  });

  it("drops a malformed record", () => {
    expect(readRecord(null)).toEqual({});
    expect(readRecord({ until: "not a date", code: 17 })).toEqual({});
    expect(readRecord({ until: "2026-10-31T10:05:00.000Z", code: "17" })).toEqual({});
    expect(readRecord({ until: "2026-10-31T10:05:00.000Z", code: 17, busy: { pct: "x", until: "2026" } })).toEqual({ until: "2026-10-31T10:05:00.000Z", code: 17 });
  });

  it("fails open: an unreadable or unwritable store never blocks or breaks a call", async () => {
    const broken: SettingStore = {
      get: async () => {
        throw new Error("database down");
      },
      set: async () => {
        throw new Error("database down");
      },
    };
    const t = createThrottle({ store: broken, now: () => T0 });
    expect(await held(t, ACT, 5)).toBeNull();
    const cd = await t.noteError(ACT, { code: 17 });
    expect(cd?.code).toBe(17);
    await expect(t.noteHeaders(ACT, { "x-ad-account-usage": JSON.stringify({ acc_id_util_pct: 99 }) })).resolves.toMatchObject({ pct: 99 });
    // The process still remembers the busy reading.
    expect((await held(t, ACT, 3))?.reason).toBe("busy");
  });
});
