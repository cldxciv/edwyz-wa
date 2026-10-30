import { beforeEach, describe, expect, it, vi } from "vitest";
import type { FakeSpendDb, Row } from "./helpers/fake-spend-db";

/**
 * The daily spending summary (docs/SPEND-CONTROLS-SPEC.md 9.3; WP-15 acceptance 5): once per local day at 09:00 or later,
 * quiet and demo workspaces skipped, numbers matching the stored figures, partial workspaces without empty ads lines, the
 * in-app "Yesterday" strip stored, and the WhatsApp spend_daily_v1 with its fixed slots. The real digest, notifier, claims
 * and spend models run on the in-memory database; only the month figures of the book (headroom) are fixtures.
 */

process.env.SPEND_NOTIFY_SECRET = "n".repeat(40);

const h = vi.hoisted(() => ({
  db: null as unknown as FakeSpendDb,
  ids: 0,
  sends: [] as Record<string, unknown>[],
  headroom: { ads: null as unknown, messaging: null as unknown, ai: null as unknown } as Record<string, unknown>,
}));

vi.mock("@/lib/db", async () => {
  const { createFakeSpendDb, FAKE_SPEND_MODELS } = await import("./helpers/fake-spend-db");
  h.db = createFakeSpendDb();
  const spend = new Set(FAKE_SPEND_MODELS);
  const prisma = new Proxy({} as Record<string, unknown>, {
    get(_t, prop: string) {
      const target = (h.db.prisma as Record<string, unknown>)[prop];
      if (typeof prop !== "string" || spend.has(prop) || prop.startsWith("$") || !target || typeof target !== "object") return target;
      const d = target as Record<string, (...a: unknown[]) => Promise<unknown>>;
      return {
        ...d,
        // Postgres gives ids, and PlatformSetting's key is its primary key (claimOnce relies on the unique violation).
        create: async (args: { data: Row; select?: Row }) => {
          if (prop === "platformSetting" && h.db.rows("platformSetting").some((r) => r.key === args.data.key)) throw Object.assign(new Error("Unique constraint failed"), { code: "P2002" });
          return d.create({ ...args, data: { id: `${prop}_${++h.ids}`, createdAt: new Date(), updatedAt: new Date(), ...args.data } });
        },
      };
    },
  });
  return { prisma };
});

vi.mock("@/lib/spend/book", async (orig) => ({
  ...(await orig<typeof import("@/lib/spend/book")>()),
  headroom: vi.fn(async (_tenantId: string, pot: string) => h.headroom[pot]),
}));

vi.mock("@/lib/inbox/service", () => ({
  sendTemplateMessage: vi.fn(async (input: Record<string, unknown>) => {
    h.sends.push(input);
    const m = { id: `msg_${++h.ids}`, tenantId: input.tenantId, conversationId: `cv_${String(input.contactId)}`, direction: "outbound", origin: input.origin, statusTimeline: [{ source: input.source }], createdAt: new Date() };
    h.db.rows("message").push(m);
    return m;
  }),
  sendText: vi.fn(),
}));

import { createPlatformNotifier, setSpendNotifier } from "@/lib/spend/notify";
import {
  DIGEST_BATCH,
  claimKey,
  costPerLead,
  dayLabelOf,
  defaultDigestSources,
  digestDue,
  digestLines,
  digestNotice,
  digestSlots,
  runDigestPass,
  type DigestFigures,
  type DigestSources,
} from "@/lib/spend/notify/digest";
import { resetNotifierState } from "@/lib/spend/notify/platform-sender";
import { NOTIFY_TEMPLATES } from "@/lib/spend/notify/templates";
import { periodic } from "@/lib/spend/tasks/digest";
import { dayKeyToDate } from "@/lib/spend/periods";
import type { NotifyResult, SpendNotice } from "@/lib/spend/types";

const T = "t1";
const N = "t_notifier";
// Thursday 29 Oct 2026, 10:30 in Asia/Kolkata: "yesterday" is 28 Oct.
const NOW = new Date("2026-10-29T05:00:00Z");
const IST_YESTERDAY_NOON = new Date("2026-10-28T06:30:00Z");
const rows = (name: string) => h.db.rows(name);

const money = (minor: bigint, currency = "INR") => ({ minor, currency });
function headroomFixture(pot: string, monthSpent: bigint, monthly: bigint | null, left: bigint | null, currency = "INR") {
  return { tenantId: T, pot, currency, limits: { pot, currency, daily: null, monthly }, month: { spent: monthSpent, committed: 0n, held: 0n, left }, today: { spent: 0n, committed: 0n, held: 0n, left: null } };
}

function seedWorkspace(opts: { account?: boolean; managed?: boolean; accountTz?: string } = {}) {
  h.db.seed("tenant", [{ id: T, name: "Sharma Sweets", status: "active", deletedAt: null, billingExempt: false }]);
  h.db.seed("spendControl", [{ tenantId: T, timezone: "Asia/Kolkata", digestEnabled: true, approverUserIds: [], spendingAdAccountAssetId: opts.account === false ? null : "acc1" }]);
  if (opts.account !== false) {
    h.db.seed("metaAsset", [{ id: "acc1", tenantId: T, type: "ad_account", externalId: "act_111", name: "Shop ads", status: "active", meta: { currency: "INR", timezone: opts.accountTz ?? "Asia/Kolkata" } }]);
  }
  h.db.seed("phoneNumber", [{ id: "pn1", tenantId: T, wabaRefId: "w1", phoneNumberId: "meta1", displayPhone: "+91 80000 00000" }]);
  h.headroom = {
    ads: headroomFixture("ads", 620_000n, 2_000_000n, 1_380_000n),
    messaging: headroomFixture("messaging", 4_500n, 500_000n, 495_500n),
    ai: headroomFixture("ai", 12n, 500n, 488n, "CRD"),
  };
}

/** Yesterday's activity (28 Oct in IST), matching the expected figures below. */
function seedYesterday(opts: { managed?: boolean } = {}) {
  const day = dayKeyToDate("2026-10-28");
  h.db.seed("spendDaily", [
    { tenantId: T, pot: "ads", scopeType: "adset", scopeId: "as1", day, currency: "INR", amountMinor: 120_000n, origin: "platform", results: 4, source: "fast_sync", syncedAt: NOW },
    { tenantId: T, pot: "ads", scopeType: "account", scopeId: "acc1", day, currency: "INR", amountMinor: 150_000n, origin: "all", source: "fast_sync", syncedAt: NOW },
    { tenantId: T, pot: "ads", scopeType: "account", scopeId: "acc1", day, currency: "INR", amountMinor: 30_000n, origin: "external", source: "fast_sync", syncedAt: NOW },
  ]);
  if (opts.managed) {
    h.db.seed("metaSpendLimit", [{ adAccountAssetId: "acc1", tenantId: T, accountExternalId: "act_111", mode: "managed", unitMode: "major", semantics: "cumulative", managedCapMinor: 2_000_000n, lastWriteAt: new Date(NOW.getTime() - 7_200_000), lastReadAt: new Date(NOW.getTime() - 3_600_000), lastError: null }]);
  }
  h.db.seed("lead", [1, 2, 3].map((i) => ({ id: `l${i}`, tenantId: T, createdAt: IST_YESTERDAY_NOON })));
  h.db.seed("lead", [{ id: "l_today", tenantId: T, createdAt: NOW }]);
  h.db.seed("spendCounter", [
    { tenantId: T, pot: "messaging", periodKind: "day", periodKey: "2026-10-28", currency: "INR", spentMinor: 4_000n, reservedMinor: 500n },
    { tenantId: T, pot: "ai", periodKind: "day", periodKey: "2026-10-28", currency: "CRD", spentMinor: 12n, reservedMinor: 0n },
    { tenantId: T, pot: "ai", periodKind: "day", periodKey: "2026-10-29", currency: "CRD", spentMinor: 99n, reservedMinor: 0n },
  ]);
  h.db.seed("spendLedger", [
    { tenantId: T, pot: "ads", action: "ads.adset.pause", phase: "applied", actorType: "assistant", correlationId: "c1", reason: "x", createdAt: IST_YESTERDAY_NOON },
    { tenantId: T, pot: "ads", action: "ads.adset.budget_raise", phase: "applied", actorType: "assistant", correlationId: "c2", reason: "x", createdAt: IST_YESTERDAY_NOON },
    { tenantId: T, pot: "ads", action: "ads.adset.budget_raise", phase: "applied", actorType: "user", correlationId: "c3", reason: "x", createdAt: IST_YESTERDAY_NOON },
  ]);
  h.db.seed("assistantShadowRecord", [1, 2, 3].map((i) => ({ id: `sh${i}`, tenantId: T, assistantKey: "ads_optimizer", createdAt: IST_YESTERDAY_NOON })));
  h.db.seed("spendBreaker", [{ id: "sb1", tenantId: T, kind: "efficiency", scopeType: "adset", scopeId: "as1", state: "tripped", effect: "pause_scope", reason: "x", trippedAt: IST_YESTERDAY_NOON }]);
  h.db.seed("spendApproval", [{ id: "ap1", tenantId: T, status: "pending", expiresAt: new Date(NOW.getTime() + 3_600_000), tokenHash: "h" }]);
}

const FULL: DigestFigures = {
  tenantId: T,
  workspaceName: "Sharma Sweets",
  day: "2026-10-28",
  dayLabel: "28 Oct",
  timezone: "Asia/Kolkata",
  ads: { currency: "INR", timezone: "Asia/Kolkata", day: "2026-10-28", spentYesterday: 120_000n, monthSpent: 620_000n, monthLimit: 2_000_000n, monthLeft: 1_380_000n },
  leads: 4,
  messaging: { currency: "INR", spentYesterday: 4_500n, monthLeft: 495_500n, connected: true },
  ai: { usedYesterday: 12n, monthLeft: 488n },
  assistantActions: { applied: 2, lowering: 1 },
  shadow: 3,
  breakers: { tripped: 1, open: 1 },
  approvalsWaiting: 1,
};

beforeEach(() => {
  h.db.reset();
  h.sends.length = 0;
  h.ids = 0;
  resetNotifierState();
});

// =====================================================================================================================
describe("what the summary says (9.3, pure)", () => {
  it("one short sentence per figure, and the nine WhatsApp slots", () => {
    expect(digestLines(FULL)).toEqual([
      "Ads spent ₹1,200 (₹6,200 of ₹20,000 this month).",
      "4 new leads, ₹300 per lead.",
      "WhatsApp messages about ₹45.",
      "AI: 12 credits used.",
      "Automatic changes: 2 (1 lowering).",
      "While learning, assistants would have made 3 changes.",
      "Safety stops: 1 tripped, 1 still on.",
      "Requests waiting for you: 1.",
      "Left this month: ads ₹13,800, WhatsApp ₹4,955, AI 488 credits.",
    ]);
    expect(digestSlots(FULL)).toEqual(["Sharma Sweets", "28 Oct", "₹1,200", "4", "₹300", "₹45", "2 (1 lowering)", "1", "₹13,800"]);
    expect(costPerLead(FULL)).toBe(30_000n);
    expect(dayLabelOf("2026-10-28")).toBe("28 Oct");
  });

  it("a workspace with no ad account gets no ads lines in the app, and 'no ads connected' in the template's ads slots", () => {
    const partial: DigestFigures = { ...FULL, ads: null, leads: 0, assistantActions: { applied: 0, lowering: 0 }, shadow: 0, breakers: { tripped: 0, open: 0 } };
    const lines = digestLines(partial);
    expect(lines.join(" ")).not.toMatch(/Ads spent|per lead|No leads|₹0/);
    expect(lines).toEqual(["WhatsApp messages about ₹45.", "AI: 12 credits used.", "Requests waiting for you: 1.", "Left this month: WhatsApp ₹4,955, AI 488 credits."]);
    const slots = digestSlots(partial);
    expect([slots[2], slots[3], slots[4], slots[8]]).toEqual(["no ads connected", "no ads connected", "no ads connected", "no ads connected"]);
    expect(slots[6]).toBe("none");
  });

  it("empty lines are left out rather than shown as zero; no leads reads 'No leads yet'; two time zones are named", () => {
    const quietDay: DigestFigures = { ...FULL, leads: 0, messaging: { ...FULL.messaging, spentYesterday: 0n }, ai: { usedYesterday: 0n, monthLeft: null }, assistantActions: { applied: 0, lowering: 0 }, shadow: 0, breakers: { tripped: 0, open: 0 }, approvalsWaiting: 0 };
    expect(digestLines(quietDay)).toEqual(["Ads spent ₹1,200 (₹6,200 of ₹20,000 this month).", "No leads yet.", "Left this month: ads ₹13,800, WhatsApp ₹4,955."]);
    expect(digestSlots(quietDay)[4]).toBe("no leads yet");
    const ny: DigestFigures = { ...FULL, ads: { ...FULL.ads!, timezone: "America/New_York" } };
    expect(digestLines(ny).at(-1)).toBe("Ads figures follow the ad account's time zone (America/New_York); the rest follow Asia/Kolkata.");
  });

  it("becomes an fyi notice for the owner and admins, keyed by workspace and day, with the slots for WhatsApp", () => {
    const n = digestNotice(FULL);
    expect(n).toMatchObject({ tenantId: T, kind: "digest", severity: "fyi", audience: "admins", dedupeKey: "spend-digest:t1:2026-10-28", title: "Daily summary for 28 Oct", link: "/app/settings/spending" });
    expect(n.body).toBe(digestLines(FULL).join(" "));
    expect(Object.values(n.params ?? {})).toEqual(digestSlots(FULL));
  });
});

// =====================================================================================================================
describe("the figures match the stored data (acceptance 5)", () => {
  it("ads in the ad account's day (Edwyz's own ads unless Meta's limit is managed), WhatsApp and AI in the workspace's day", async () => {
    seedWorkspace();
    seedYesterday();
    const f = await defaultDigestSources().figures(T, NOW);
    expect(f).toEqual(FULL);
  });

  it("counts the whole ad account when Meta's limit is managed there", async () => {
    vi.stubEnv("SPEND_CAP_MODE", "enforce");
    try {
      seedWorkspace();
      seedYesterday({ managed: true });
      expect((await defaultDigestSources().figures(T, NOW)).ads?.spentYesterday).toBe(150_000n);
    } finally {
      vi.unstubAllEnvs();
    }
  });

  it("uses the ad account's own yesterday when its time zone differs", async () => {
    seedWorkspace({ accountTz: "America/Los_Angeles" });
    seedYesterday();
    const f = await defaultDigestSources().figures(T, NOW);
    // 05:00 UTC on 29 Oct is still 28 Oct in Los Angeles: its yesterday is 27 Oct, with no rows stored.
    expect(f.ads).toMatchObject({ timezone: "America/Los_Angeles", day: "2026-10-27", spentYesterday: 0n });
    expect(f.day).toBe("2026-10-28");
  });

  it("a workspace without an ad account has no ads figures", async () => {
    seedWorkspace({ account: false });
    seedYesterday();
    const f = await defaultDigestSources().figures(T, NOW);
    expect(f.ads).toBeNull();
    expect(f.leads).toBe(3);
  });

  it("quiet means no spend, leads, actions or anything waiting in the last 7 days", async () => {
    seedWorkspace();
    const sources = defaultDigestSources();
    expect(await sources.quiet(T, NOW)).toBe(true);
    h.db.seed("lead", [{ id: "old", tenantId: T, createdAt: new Date(NOW.getTime() - 6 * 86_400_000) }]);
    expect(await sources.quiet(T, NOW)).toBe(false);
    rows("lead").length = 0;
    h.db.seed("lead", [{ id: "older", tenantId: T, createdAt: new Date(NOW.getTime() - 8 * 86_400_000) }]);
    expect(await sources.quiet(T, NOW)).toBe(true);
    h.db.seed("spendApproval", [{ id: "ap9", tenantId: T, status: "pending", expiresAt: new Date(NOW.getTime() + 60_000), tokenHash: "x" }]);
    expect(await sources.quiet(T, NOW)).toBe(false);
  });
});

// =====================================================================================================================
describe("the pass: once per local day at 09:00 or later (acceptance 5)", () => {
  const stubSources = (over: Partial<DigestSources> = {}): DigestSources & { figures: ReturnType<typeof vi.fn> } => ({
    isDemo: vi.fn(async () => false),
    quiet: vi.fn(async () => false),
    figures: vi.fn(async (tenantId: string) => ({ ...FULL, tenantId })),
    ...over,
  }) as DigestSources & { figures: ReturnType<typeof vi.fn> };
  const sent: SpendNotice[] = [];
  const notify = vi.fn(async (n: SpendNotice): Promise<NotifyResult> => {
    sent.push(n);
    return { delivered: ["in_app"], skipped: [], deduplicated: false };
  });
  beforeEach(() => {
    sent.length = 0;
    notify.mockClear();
  });

  it("is registered every 15 minutes, with the hourly notifier check", () => {
    expect(periodic.map((p) => [p.name, p.everyMs])).toEqual([
      ["spend.digest", 15 * 60_000],
      ["spend.notify.health", 60 * 60_000],
    ]);
  });

  it("waits until 09:00 local, sends once that day, and again the next day", async () => {
    seedWorkspace();
    const sources = stubSources();
    const early = new Date("2026-10-29T03:29:00Z"); // 08:59 IST
    expect(digestDue(early, "Asia/Kolkata")).toBe(false);
    expect(await runDigestPass({ now: early, sources, notify })).toMatchObject({ sent: 0, skipped: { early: 1 } });
    expect(sent).toEqual([]);
    const nine = new Date("2026-10-29T03:30:00Z"); // 09:00 IST
    expect(await runDigestPass({ now: nine, sources, notify })).toMatchObject({ sent: 1 });
    expect(await runDigestPass({ now: new Date(nine.getTime() + 15 * 60_000), sources, notify })).toMatchObject({ sent: 0, skipped: { claimed: 1 } });
    expect(rows("platformSetting").some((r) => r.key === claimKey(T, "2026-10-29"))).toBe(true);
    expect(await runDigestPass({ now: new Date("2026-10-30T04:00:00Z"), sources, notify })).toMatchObject({ sent: 1 });
    expect(sent.map((n) => n.dedupeKey)).toEqual(["spend-digest:t1:2026-10-28", "spend-digest:t1:2026-10-28"]);
    // The figures source answers with yesterday's key for its own clock; the pass sent both days.
    expect(sources.figures).toHaveBeenCalledTimes(2);
  });

  it("follows each workspace's own time zone", async () => {
    seedWorkspace();
    rows("spendControl")[0].timezone = "America/New_York";
    // 10:30 IST is 01:00 in New York.
    expect(await runDigestPass({ now: NOW, sources: stubSources(), notify })).toMatchObject({ sent: 0, skipped: { early: 1 } });
  });

  it("skips quiet workspaces (keeping the claim), the demo workspace, workspaces with the summary off and inactive ones", async () => {
    seedWorkspace();
    h.db.seed("tenant", [
      { id: "t_demo", name: "Demo", status: "active", deletedAt: null },
      { id: "t_off", name: "Off", status: "active", deletedAt: null },
      { id: "t_gone", name: "Gone", status: "active", deletedAt: new Date() },
    ]);
    h.db.seed("spendControl", [
      { tenantId: "t_demo", timezone: "Asia/Kolkata", digestEnabled: true },
      { tenantId: "t_off", timezone: "Asia/Kolkata", digestEnabled: false },
      { tenantId: "t_gone", timezone: "Asia/Kolkata", digestEnabled: true },
    ]);
    h.db.seed("waba", [{ id: "wd", tenantId: "t_demo", wabaId: "demo-waba-t_demo" }]);
    const sources = { ...defaultDigestSources(), quiet: vi.fn(async (tenantId: string) => tenantId === T) };
    const out = await runDigestPass({ now: NOW, sources, notify });
    expect(out).toMatchObject({ considered: 3, sent: 0, skipped: { quiet: 1, demo: 1, disabled: 1 } });
    expect(sent).toEqual([]);
    expect(rows("platformSetting").some((r) => r.key === claimKey(T, "2026-10-29"))).toBe(true);
  });

  it("gives the claim back when the summary fails, so the next pass tries again", async () => {
    seedWorkspace();
    const sources = stubSources({ figures: vi.fn().mockRejectedValueOnce(new Error("db down")).mockResolvedValue(FULL) as never });
    expect(await runDigestPass({ now: NOW, sources, notify })).toMatchObject({ sent: 0, skipped: { failed: 1 } });
    expect(rows("platformSetting").some((r) => r.key === claimKey(T, "2026-10-29"))).toBe(false);
    expect(await runDigestPass({ now: NOW, sources, notify })).toMatchObject({ sent: 1 });
  });

  it("works in cursor batches of 50", async () => {
    const ids = Array.from({ length: 120 }, (_, i) => `t${String(i).padStart(3, "0")}`);
    h.db.seed("tenant", ids.map((id) => ({ id, name: id, status: "active", deletedAt: null })));
    h.db.seed("spendControl", ids.map((tenantId) => ({ tenantId, timezone: "Asia/Kolkata", digestEnabled: true })));
    const sources = stubSources();
    expect(DIGEST_BATCH).toBe(50);
    expect(await runDigestPass({ now: NOW, sources, notify, batches: 1 })).toMatchObject({ considered: 50, sent: 50 });
    expect(await runDigestPass({ now: NOW, sources, notify, batches: 1 })).toMatchObject({ considered: 50, sent: 50 });
    expect(await runDigestPass({ now: NOW, sources, notify, batches: 1 })).toMatchObject({ considered: 20, sent: 20 });
    expect(new Set(sent.map((n) => n.tenantId)).size).toBe(120);
    // The cursor wrapped: the next pass starts again and finds every workspace already done today.
    expect(await runDigestPass({ now: NOW, sources, notify })).toMatchObject({ sent: 0, skipped: { claimed: 120 } });
  });
});

// =====================================================================================================================
describe("end to end through the notifier", () => {
  it("stores the Yesterday strip in the app and sends spend_daily_v1 to verified owner channels", async () => {
    seedWorkspace();
    seedYesterday();
    h.db.seed("tenant", [{ id: N, name: "Edwyz alerts", status: "active", deletedAt: null, billingExempt: true }]);
    h.db.seed("membership", [{ id: "m1", tenantId: T, userId: "u_owner", role: "owner" }]);
    h.db.seed("platformSetting", [{ key: "spend:notify", value: { tenantId: N, phoneNumberId: "pn_n" } }]);
    h.db.seed("phoneNumber", [{ id: "pn_n", tenantId: N, wabaRefId: "w_n", phoneNumberId: "meta_pn", displayPhone: "+1 711-268-5789", qualityRating: "GREEN", status: "CONNECTED" }]);
    h.db.seed("template", [{ id: "tp", tenantId: N, wabaRefId: "w_n", name: NOTIFY_TEMPLATES.digest.name, language: "en", category: "UTILITY", status: "approved" }]);
    h.db.seed("ownerNotifyChannel", [{ id: "ch1", tenantId: T, userId: "u_owner", phoneE164: "+919876543210", verifiedAt: new Date(), optOutAt: null }]);
    const previous = setSpendNotifier(createPlatformNotifier());
    try {
      expect(await runDigestPass({ now: NOW })).toMatchObject({ sent: 1 });
    } finally {
      setSpendNotifier(previous);
    }
    const notice = rows("notice").find((n) => n.kind === "digest")!;
    expect(notice).toMatchObject({ tenantId: T, source: "spend", audienceMinRole: "admin", dedupeKey: "spend-digest:t1:2026-10-28" });
    expect((notice.payload as Row).body).toBe(digestLines(FULL).join(" "));
    expect(h.sends).toHaveLength(1);
    expect(h.sends[0]).toMatchObject({ tenantId: N, templateName: "spend_daily_v1", origin: "system_notify", source: `spend_notify:${T}` });
    const params = ((h.sends[0].components as Row[])[0].parameters as Row[]).map((p) => p.text);
    expect(params).toEqual(["Sharma Sweets", "28 Oct", "₹1,200", "4", "₹300", "₹45", "2 (1 lowering)", "1", "₹13,800"]);
    expect(rows("spendLedger").find((r) => r.action === "notify.digest")).toMatchObject({ phase: "info", tenantId: T });
  });
});
