import { readFileSync } from "node:fs";
import path from "node:path";
import { createElement as h, type ReactElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { FakeNoticesDb, Row } from "./helpers/fake-notices-db";

/**
 * docs/EDDY-SPEC.md 6.7, 6.9, 7.6, 8.3, 9.1 (tests/eddy-notices.test.ts), EDDY-16 acceptance 2 to 9, 12.1a decision 15.
 * Deterministic notices with no AI: the store (publish.ts), what each member sees (service.ts), every producer, the scan,
 * the routes, Eddy's retention and erasure, and the strip and menu views (rendered in light and dark, all three languages).
 * The database is the in-memory stand-in of tests/helpers/fake-notices-db.ts; no Meta or Anthropic call exists here.
 */

const clock = vi.hoisted(() => ({ now: new Date("2026-10-29T06:30:00.000Z") }));
const fake = vi.hoisted(() => ({ db: null as unknown as FakeNoticesDb }));
const bridge = vi.hoisted(() => ({
  isDemoWorkspace: vi.fn(async (tenantId: string) => tenantId === "t_demo"),
  aiHeadroom: vi.fn(async (_tenantId: string, _o?: unknown) => ({ usedToday: 0, limitToday: null as number | null, usedMonth: 0, limitMonth: 500 as number | null, leftToday: null as number | null, leftMonth: 500 as number | null, todayResetsOn: "2026-10-30", monthResetsOn: "2026-11-01", timezone: "Asia/Kolkata" })),
}));
const tokenHealth = vi.hoisted(() => ({ getWhatsAppTokenHealth: vi.fn(async (_t: string, _n?: Date) => ({ state: "ok" as string, expiresAt: null as string | null, daysLeft: null as number | null })) }));
const setup = vi.hoisted(() => ({ getSetup: vi.fn(async (_t: string, _n?: Date) => ({ steps: [] as { id: string; href: string }[], summary: { nextStepId: null as string | null } })) }));
const platform = vi.hoisted(() => ({ readPlatformFreeze: vi.fn(async () => ({ freeze: "none" as string, reason: null as string | null, byUserId: null as string | null, at: null as Date | null, version: 1 })) }));
const broadcastsProcess = vi.hoisted(() => ({ pauseBroadcastsForNumber: vi.fn(async () => 0) }));
const auth = vi.hoisted(() => ({ getActor: vi.fn() }));
const services = vi.hoisted(() => ({
  updateRule: vi.fn(async () => ({})),
  unpublishChatbot: vi.fn(async () => ({})),
  updateAgent: vi.fn(async () => ({})),
  updateSequence: vi.fn(async () => ({})),
  saveSettings: vi.fn(async () => ({ enabled: false })),
  getSettings: vi.fn(async () => ({ enabled: true })),
  audit: vi.fn(async () => undefined),
}));

vi.mock("@/lib/db", async () => {
  const { createFakeNoticesDb } = await import("./helpers/fake-notices-db");
  fake.db = createFakeNoticesDb(() => clock.now);
  return { prisma: fake.db.client };
});
vi.mock("@/lib/actions/spend-bridge", () => bridge);
vi.mock("@/lib/onboarding/token-health", () => tokenHealth);
vi.mock("@/lib/setup", () => setup);
vi.mock("@/lib/spend/kill", () => platform);
vi.mock("@/lib/spend/exec/ai", () => ({ aiNoticeKey: (tenantId: string, periodKey: string, level: 80 | 100) => `spend-ai:${tenantId}:${periodKey}:${level}` }));
vi.mock("@/lib/broadcasts/process", () => broadcastsProcess);
vi.mock("@/lib/auth", () => auth);
vi.mock("@/lib/auth/csrf", () => ({ assertSameOrigin: vi.fn() }));
vi.mock("@/lib/auth/audit", () => ({ audit: services.audit }));
vi.mock("@/lib/automation/rules", () => ({ updateRule: services.updateRule }));
vi.mock("@/lib/chatbots/service", () => ({ unpublishChatbot: services.unpublishChatbot }));
vi.mock("@/lib/ai-agent/agents", () => ({ updateAgent: services.updateAgent }));
vi.mock("@/lib/leads/service", () => ({ updateSequence: services.updateSequence }));
vi.mock("@/lib/commerce/settings", () => ({ saveSettings: services.saveSettings, getSettings: services.getSettings }));
vi.mock("@/lib/compat/idempotency", () => ({ IDEMPOTENCY_PRUNE_HOURS: 24, pruneIdempotencyClaims: vi.fn() }));

import { EDDY_LANGS, type EddyLang, type EddyStatusDTO, type NoticeDTO } from "@/lib/eddy/contract";
import { catalogue as noticesCatalogue, tn } from "@/lib/eddy/copy/notices";
import { hasKey, t } from "@/lib/eddy/i18n";
import { eraseContactFromEddy, runEddyErasureSweep } from "@/lib/eddy/erasure-sweep";
import { eddyForgetUser, eddyForgetUserEverywhere } from "@/lib/eddy/forget-user";
import { runEddyRetention } from "@/lib/eddy/retention";
import { NOTICE_KINDS, NOTICE_TTL_MS, PAYLOAD_KEYS, SELF, V2_KINDS, cleanActions, cleanPayload, dedupe, textKeyFor } from "@/lib/notices/kinds";
import { publishNotice, resolveNotices } from "@/lib/notices/publish";
import { claimToasts, isNoticeUpdate, listNotices, orderForStrip, updateNotice } from "@/lib/notices/service";
import { PRODUCERS, eligibleTenants, runNoticeScan, scanTenant, type NoticeProducer } from "@/lib/notices/scan";
import { producer as templatesProducer, templateKind } from "@/lib/notices/producers/templates";
import { producer as qualityProducer } from "@/lib/notices/producers/quality";
import { producer as failuresProducer } from "@/lib/notices/producers/failures";
import { producer as approvalsProducer, reviewPath } from "@/lib/notices/producers/approvals";
import { producer as tokenProducer } from "@/lib/notices/producers/token";
import { aiLevel, producer as aiProducer } from "@/lib/notices/producers/ai-limit";
import { producer as spendingProducer } from "@/lib/notices/producers/spending";
import { activityForViewer, producer as activityProducer, settingsPathFor, teamActivity } from "@/lib/notices/producers/activity";
import { producer as setupProducer } from "@/lib/notices/producers/setup";
import { GET as getNotices, POST as postNotices } from "@/app/api/notices/route";
import { PATCH as patchNoticeRoute } from "@/app/api/notices/[id]/route";
import { LanguagePicker, optionLabel, LANG_OPTIONS } from "@/components/eddy/LanguagePicker";
import { NoticeListView, NoticeText, STRIP_LIMIT, intentFor } from "@/components/eddy/NoticeList";
import { TeamActivityView, parseActivity, turnOnQuery, type ActivityItemDTO } from "@/components/eddy/TeamActivity";
import { UsageMeter, usageFigures } from "@/components/eddy/UsageMeter";
import { loadNotices, noticeText, parseNotice, parseNoticesResponse, patchNotice, readNoticesSnapshot, resetNoticesStore, showNoticeToasts } from "@/components/eddy/useNotices";
import { toast } from "@/components/ui";
import { checkDetail, EDDY_EVENTS } from "@/components/eddy/events";

// ===== Fixtures =====

const T = "t_acme";
const OWNER = { userId: "u_owner", tenantId: T, role: "owner" as const };
const ADMIN = { userId: "u_admin", tenantId: T, role: "admin" as const };
const APPROVER = { userId: "u_appr", tenantId: T, role: "admin" as const };
const AGENT = { userId: "u_agent", tenantId: T, role: "agent" as const };

/** Customer and Meta text that must never reach a notice row (6.7, 7.6: "Ids, counts and codes only. No customer text"). */
const CUSTOMER_TEXT = ["Ravi Kumar", "please refund my order 4411", "मेरा ऑर्डर कहाँ है", "Your template contains abusive content", "+91 98765 43210"];

const DAY = 24 * 60 * 60_000;
const ago = (ms: number) => new Date(clock.now.getTime() - ms);
const notices = () => fake.db.rows("notice");
const noticeBy = (key: string) => notices().find((n) => n.dedupeKey === key);

function seedMembers() {
  fake.db.seed("user", { id: OWNER.userId, name: "Anshu Attri" }, { id: ADMIN.userId, name: "Meera Shah" }, { id: APPROVER.userId, name: "Kabir Rao" }, { id: AGENT.userId, name: "Sana Ali" });
  fake.db.seed("membership", { id: "m1", ...OWNER }, { id: "m2", ...ADMIN }, { id: "m3", ...APPROVER }, { id: "m4", ...AGENT });
}

function ctxFor(tenantId: string, cursor: unknown = null) {
  return {
    tenantId,
    now: clock.now,
    demo: tenantId === "t_demo",
    hasNumber: true,
    cursor: cursor as never,
    publish: (n: Parameters<typeof publishNotice>[0] extends infer P ? Omit<P & object, "tenantId"> : never) => publishNotice({ ...(n as object), tenantId } as Parameters<typeof publishNotice>[0], { now: clock.now }),
    resolve: (f: Parameters<typeof resolveNotices>[1]) => resolveNotices(tenantId, f, { now: clock.now }),
  };
}

beforeEach(() => {
  clock.now = new Date("2026-10-29T06:30:00.000Z");
  fake.db.reset();
  vi.clearAllMocks();
  bridge.isDemoWorkspace.mockImplementation(async (tenantId: string) => tenantId === "t_demo");
  tokenHealth.getWhatsAppTokenHealth.mockResolvedValue({ state: "ok", expiresAt: null, daysLeft: null });
  setup.getSetup.mockResolvedValue({ steps: [], summary: { nextStepId: null } });
  platform.readPlatformFreeze.mockResolvedValue({ freeze: "none", reason: null, byUserId: null, at: null, version: 1 });
});
afterEach(() => vi.restoreAllMocks());

// =====================================================================================================================
// The store: publishNotice (one notice per dedupe key, counts in place, self-resolve, 7-day expiry)
// =====================================================================================================================

describe("publishNotice: one notice per (tenantId, dedupeKey)", () => {
  const base = { tenantId: T, kind: "failed_sends", severity: "heads_up" as const, dedupeKey: "failures:2026-10-29:131026", audience: { minRole: "admin" as const }, payload: { code: "131026" } };

  it("creates one row, then updates the count in place; the same input again changes nothing", async () => {
    const a = await publishNotice({ ...base, count: 3 }, { now: clock.now });
    expect(a.outcome).toBe("created");
    clock.now = new Date(clock.now.getTime() + 120_000);
    const b = await publishNotice({ ...base, count: 5 }, { now: clock.now });
    expect(b).toEqual({ id: a.id, outcome: "updated" });
    expect(notices()).toHaveLength(1);
    expect(notices()[0].count).toBe(5);
    const updatedAt = (notices()[0].updatedAt as Date).getTime();
    clock.now = new Date(clock.now.getTime() + 120_000);
    fake.db.writes.length = 0;
    expect((await publishNotice({ ...base, count: 5 }, { now: clock.now })).outcome).toBe("unchanged");
    expect(fake.db.writes).toEqual([]);
    expect((notices()[0].updatedAt as Date).getTime()).toBe(updatedAt);
  });

  it("expires 7 days after it starts; publishing after that starts a new occurrence with fresh receipts", async () => {
    const { id } = await publishNotice(base, { now: clock.now });
    expect((notices()[0].expiresAt as Date).getTime() - clock.now.getTime()).toBe(NOTICE_TTL_MS);
    fake.db.seed("noticeReceipt", { noticeId: id, userId: ADMIN.userId, tenantId: T, dismissedAt: clock.now });
    // A later count change keeps the expiry: 7 days from the start, not from the last update.
    clock.now = new Date(clock.now.getTime() + 3 * DAY);
    await publishNotice({ ...base, count: 2 }, { now: clock.now });
    expect((notices()[0].expiresAt as Date).getTime()).toBe(new Date("2026-11-05T06:30:00.000Z").getTime());
    clock.now = new Date(clock.now.getTime() + 5 * DAY);
    expect((await listNotices(ADMIN, { now: clock.now })).notices).toEqual([]);
    const again = await publishNotice({ ...base, count: 1 }, { now: clock.now });
    expect(again).toEqual({ id, outcome: "reopened" });
    expect(fake.db.rows("noticeReceipt")).toEqual([]);
    expect((await listNotices(ADMIN, { now: clock.now })).notices.map((n) => n.id)).toEqual([id]);
  });

  it("resolves itself when the condition clears (only the kinds and keys asked for), and comes back as new", async () => {
    await publishNotice({ ...base, kind: "token_expired", severity: "action_needed", dedupeKey: "token:expired" }, { now: clock.now });
    await publishNotice({ ...base, kind: "token_expiring", dedupeKey: "token:expiring" }, { now: clock.now });
    await publishNotice(base, { now: clock.now });
    expect(await resolveNotices(T, { kinds: ["token_expiring", "token_expired"], except: ["token:expired"] }, { now: clock.now })).toBe(1);
    expect(noticeBy("token:expiring")?.resolvedAt).toEqual(clock.now);
    expect(noticeBy("token:expired")?.resolvedAt).toBeNull();
    expect(noticeBy(base.dedupeKey)?.resolvedAt).toBeNull();
    expect(await resolveNotices(T, {}, { now: clock.now })).toBe(0);
    expect((await publishNotice({ ...base, kind: "token_expiring", dedupeKey: "token:expiring" }, { now: clock.now })).outcome).toBe("reopened");
  });

  it("never touches a row another source wrote under the same key (Phase 0's own rows, E6)", async () => {
    fake.db.seed("notice", { id: "n_spend", tenantId: T, kind: "ai_limit_80", severity: "heads_up", dedupeKey: "spend-ai:t_acme:2026-10:80", source: "spend", payload: { title: "AI credits are 80% used this month" }, expiresAt: new Date(clock.now.getTime() + 30 * DAY) });
    fake.db.writes.length = 0;
    const r = await publishNotice({ ...base, kind: "ai_limit_80", dedupeKey: "spend-ai:t_acme:2026-10:80", payload: { level: 80 } }, { now: clock.now });
    expect(r).toEqual({ id: "n_spend", outcome: "foreign" });
    expect(fake.db.writes).toEqual([]);
  });

  it("stores ids, counts and codes only: free text, unknown keys and unsafe buttons never reach the row", async () => {
    await publishNotice(
      {
        ...base,
        payload: { code: "131026", name: "Ravi Kumar", body: CUSTOMER_TEXT[1], reason: CUSTOMER_TEXT[3], conversationId: "please refund my order", templateId: "tpl_1", count: 4 },
        actions: [
          { kind: "navigate", path: "https://evil.example/app", labelKey: "btn.open" },
          { kind: "navigate", path: "javascript:alert(1)", labelKey: "btn.open" },
          { kind: "navigate", path: "//evil.example", labelKey: "btn.open" },
          { kind: "navigate", path: "/app/inbox?c=cv_1", labelKey: "btn.pick_template" },
          { kind: "open_eddy", ref: { kind: "notice", noticeId: "someone_else" }, labelKey: "btn.explain" },
          { kind: "card", action: "enable_automation", labelKey: "btn.open" },
        ] as never,
      },
      { now: clock.now },
    );
    const row = notices()[0];
    expect(row.payload).toEqual({ code: "131026", templateId: "tpl_1", count: 4 });
    expect(row.actions).toEqual([
      { kind: "navigate", path: "/app/inbox?c=cv_1", labelKey: "btn.pick_template" },
      { kind: "open_eddy", ref: { kind: "notice", noticeId: SELF }, labelKey: "btn.explain" },
      { kind: "card", action: "enable_automation", labelKey: "btn.open" },
    ]);
    for (const text of CUSTOMER_TEXT) expect(JSON.stringify(row)).not.toContain(text);
  });

  it("refuses a malformed notice and never throws when the database fails", async () => {
    expect((await publishNotice({ ...base, dedupeKey: "has spaces in it" }, { now: clock.now })).outcome).toBe("failed");
    expect((await publishNotice({ ...base, kind: "Bad Kind" }, { now: clock.now })).outcome).toBe("failed");
    expect((await publishNotice({ ...base, severity: "urgent" as never }, { now: clock.now })).outcome).toBe("failed");
    expect(notices()).toEqual([]);
    const spy = vi.spyOn(console, "error").mockImplementation(() => undefined);
    fake.db.failNext("notice", "create");
    await expect(publishNotice(base, { now: clock.now })).resolves.toEqual({ id: null, outcome: "failed" });
    spy.mockRestore();
  });
});

describe("kinds: payload and buttons", () => {
  it("cleanPayload keeps only listed keys with id, code, number, flag or null values", () => {
    expect(cleanPayload({ code: "131047", count: 2, ok: true, nope: null, templateId: "tpl_1" })).toEqual({ code: "131047", count: 2, templateId: "tpl_1" });
    expect(cleanPayload({ code: "has a space" })).toEqual({});
    expect(cleanPayload({ broadcastIds: "b_1,b_2,b_3" })).toEqual({ broadcastIds: "b_1,b_2,b_3" });
    expect(cleanPayload("x")).toEqual({});
    for (const key of ["name", "text", "body", "reason", "title", "message", "rejectionReason"]) expect(PAYLOAD_KEYS.has(key), key).toBe(false);
  });

  it("cleanActions fills a notice reference with the notice's own id when read", () => {
    expect(cleanActions([{ kind: "open_eddy", ref: { kind: "notice", noticeId: SELF }, labelKey: "btn.explain" }], "n_9")).toEqual([{ kind: "open_eddy", ref: { kind: "notice", noticeId: "n_9" }, labelKey: "btn.explain" }]);
    expect(cleanActions([{ kind: "open_eddy", ref: { kind: "message", messageId: "m 1" }, labelKey: "btn.explain" }])).toEqual([]);
    expect(cleanActions([{ kind: "navigate", path: "/app", labelKey: "Click here now" }])).toEqual([]);
    expect(cleanActions([{ kind: "write", path: "/app", labelKey: "btn.open" }, { kind: "card", action: "DROP TABLE", labelKey: "btn.open" }])).toEqual([]);
    expect(cleanActions(new Array(5).fill({ kind: "navigate", path: "/app", labelKey: "btn.open" }))).toHaveLength(3);
  });

  it("every v1 kind has a text key in all three languages; eddy_handoff is reserved for v2", () => {
    expect(V2_KINDS.has("eddy_handoff")).toBe(true);
    expect(NOTICE_KINDS).toContain("eddy_handoff");
    const payloads: Record<string, Record<string, string | number>[]> = {
      template_paused: [{ status: "paused" }, { status: "flagged" }],
      number_quality_dropped: [{ rating: "YELLOW" }, { rating: "RED", count: 2 }, { rating: "RED", count: 0 }],
      failed_sends: [{ code: "131047" }, { code: "131026" }, { code: "131049" }, { code: "500" }],
      approvals_waiting: [{ count: 1 }, { count: 3 }],
      ai_limit_80: [{ period: "month" }, { period: "day" }],
      ai_limit_100: [{ period: "month" }, { period: "day" }],
      spending_stopped: [{ scope: "platform" }, { level: "assistants" }, { byUserId: "u_1" }, {}],
      automation_digest: [{ ai: 3 }, { ai: 0 }],
      setup_next_step: ["connect", "template", "contacts", "broadcast", "invite", "routing", "automation", "facebook", "plan"].map((stepId) => ({ stepId })),
    };
    for (const kind of [...NOTICE_KINDS, "action_done", "action_failed", "action_unresolved"]) {
      for (const p of payloads[kind] ?? [{}]) {
        const key = textKeyFor(kind, p);
        expect(hasKey(key), `${kind} ${JSON.stringify(p)} -> ${key}`).toBe(true);
        expect(key).not.toBe("notices.generic");
      }
    }
    expect(textKeyFor("breaker_tripped", {}, "spend")).toBe("notices.spend_fallback");
    for (const lang of EDDY_LANGS) expect(Object.keys(noticesCatalogue[lang]).sort()).toEqual(Object.keys(noticesCatalogue.en).sort());
  });

  it("the AI notice shares Phase 0's dedupe key (src/lib/spend/exec/ai.ts aiNoticeKey)", () => {
    const src = readFileSync(path.resolve(__dirname, "../src/lib/spend/exec/ai.ts"), "utf8");
    expect(src).toContain("export const aiNoticeKey = (tenantId: string, periodKey: string, level: 80 | 100) => `spend-ai:${tenantId}:${periodKey}:${level}`;");
  });
});

// =====================================================================================================================
// What a member sees: role scoping, per-member notices, mutes, dismissals, toasts
// =====================================================================================================================

describe("listNotices: role scoping, mutes, dismissals and toasts", () => {
  beforeEach(async () => {
    seedMembers();
    await publishNotice({ tenantId: T, kind: "token_expired", severity: "action_needed", dedupeKey: "token:expired", audience: { minRole: "admin" } }, { now: clock.now });
    await publishNotice({ tenantId: T, kind: "spending_stopped", severity: "heads_up", dedupeKey: "spending:workspace:all", audience: { minRole: "agent" }, payload: { scope: "workspace", level: "all", byUserId: OWNER.userId } }, { now: clock.now });
    await publishNotice({ tenantId: T, kind: "failed_sends", severity: "action_needed", dedupeKey: `failures:2026-10-29:131047:u:${AGENT.userId}`, audience: { userId: AGENT.userId, minRole: "agent" }, payload: { code: "131047" }, count: 2 }, { now: clock.now });
    await publishNotice({ tenantId: T, kind: "automation_digest", severity: "fyi", dedupeKey: "digest:2026-10-29", audience: { minRole: "admin" }, payload: { ai: 3, handoff: 1 } }, { now: clock.now });
  });

  const kinds = async (actor: typeof OWNER | typeof ADMIN | typeof AGENT) => (await listNotices(actor, { now: clock.now })).notices.map((n) => n.kind);

  it("team members see workspace notices for every member and their own; admins see the workspace's, not a member's own", async () => {
    expect(await kinds(AGENT)).toEqual(["failed_sends", "spending_stopped"]);
    expect(await kinds(ADMIN)).toEqual(["token_expired", "spending_stopped", "automation_digest"]);
    expect(await kinds(OWNER)).toEqual(["token_expired", "spending_stopped", "automation_digest"]);
    const admin = await listNotices(ADMIN, { now: clock.now });
    expect(admin.needsYou).toBe(2);
  });

  it("muting a kind hides it for that member only; dismissing hides one notice for that member only", async () => {
    const stop = noticeBy("spending:workspace:all")!;
    expect(await updateNotice(AGENT, String(stop.id), { mute: true }, clock.now)).toEqual({ ok: true, kind: "spending_stopped" });
    expect(await kinds(AGENT)).toEqual(["failed_sends"]);
    expect(fake.db.rows("eddyUserPref")[0]).toMatchObject({ tenantId: T, userId: AGENT.userId, mutedNoticeKinds: ["spending_stopped"] });
    expect(await kinds(ADMIN)).toContain("spending_stopped");
    const token = noticeBy("token:expired")!;
    await updateNotice(ADMIN, String(token.id), { dismissed: true }, clock.now);
    expect(await kinds(ADMIN)).not.toContain("token_expired");
    expect(await kinds(OWNER)).toContain("token_expired");
  });

  it("a member cannot touch a notice they cannot see (another member's, or above their role)", async () => {
    const own = noticeBy(`failures:2026-10-29:131047:u:${AGENT.userId}`)!;
    expect(await updateNotice(ADMIN, String(own.id), { dismissed: true }, clock.now)).toBeNull();
    expect(await updateNotice(AGENT, String(noticeBy("token:expired")!.id), { seen: true }, clock.now)).toBeNull();
    expect(await updateNotice({ ...ADMIN, tenantId: "t_other" }, String(noticeBy("token:expired")!.id), { seen: true }, clock.now)).toBeNull();
  });

  it("one sticky toast per member per action-needed notice: claimed once, never for heads-up or fyi", async () => {
    const first = await listNotices(ADMIN, { now: clock.now });
    expect(await claimToasts(ADMIN, first.notices, clock.now)).toEqual([String(noticeBy("token:expired")!.id)]);
    const second = await listNotices(ADMIN, { now: clock.now });
    expect(second.notices.find((n) => n.kind === "token_expired")?.toastedAt).not.toBeNull();
    expect(await claimToasts(ADMIN, second.notices, clock.now)).toEqual([]);
    // Two tabs racing: the receipt claim lets only one through.
    expect(await claimToasts(OWNER, first.notices, clock.now)).toEqual([String(noticeBy("token:expired")!.id)]);
    expect(await claimToasts(OWNER, first.notices, clock.now)).toEqual([]);
  });

  it("the DTO fills names from ids at read time, re-checks buttons, and keeps only ids in the stored payload", async () => {
    const dto = (await listNotices(AGENT, { now: clock.now })).notices.find((n) => n.kind === "spending_stopped")!;
    expect(dto.textKey).toBe("notices.spending.workspace");
    expect(dto.payload.name).toBe("Anshu");
    expect(noticeBy("spending:workspace:all")!.payload).toEqual({ scope: "workspace", level: "all", byUserId: OWNER.userId });
    expect(tn("en", "notices.spending.workspace", { name: dto.payload.name as string })).toBe("Anshu stopped spending for this workspace. The owner can turn it back on in Settings > Spending limits.");
  });

  it("orders action needed, then heads-up, then for your information, newest first within each", () => {
    const at = (s: string) => new Date(s).toISOString();
    const list = [
      { id: "a", severity: "fyi", updatedAt: at("2026-10-29T06:00:00Z") },
      { id: "b", severity: "heads_up", updatedAt: at("2026-10-29T05:00:00Z") },
      { id: "c", severity: "action_needed", updatedAt: at("2026-10-29T04:00:00Z") },
      { id: "d", severity: "heads_up", updatedAt: at("2026-10-29T06:10:00Z") },
    ];
    expect(orderForStrip(list).map((n) => n.id)).toEqual(["c", "d", "b", "a"]);
  });

  it("a Phase 0 row the Eddy notice already covers is hidden (quality breaker on the same number)", async () => {
    fake.db.seed("notice", { id: "n_p0", tenantId: T, kind: "breaker_tripped", severity: "heads_up", dedupeKey: "spend-breaker:br_1", source: "spend", audienceMinRole: "owner", subjectType: "phone", subjectId: "ph_1", payload: { title: "+91 98xxx quality dropped" }, expiresAt: new Date(clock.now.getTime() + DAY) });
    expect(await kinds(OWNER)).toContain("breaker_tripped");
    await publishNotice({ tenantId: T, kind: "number_quality_dropped", severity: "heads_up", dedupeKey: "quality:ph_1:YELLOW", audience: { minRole: "admin" }, subjectType: "phone", subjectId: "ph_1", payload: { phoneId: "ph_1", rating: "YELLOW" } }, { now: clock.now });
    expect(await kinds(OWNER)).not.toContain("breaker_tripped");
    expect(await kinds(OWNER)).toContain("number_quality_dropped");
  });

  it("isNoticeUpdate accepts only seen, dismissed and mute set to true", () => {
    expect(isNoticeUpdate({ seen: true })).toEqual({ seen: true });
    expect(isNoticeUpdate({ dismissed: true, mute: true })).toEqual({ dismissed: true, mute: true });
    expect(isNoticeUpdate({})).toBeNull();
    expect(isNoticeUpdate({ seen: "yes" })).toBeNull();
    expect(isNoticeUpdate({ text: "hello" })).toBeNull();
  });
});

// =====================================================================================================================
// Producers
// =====================================================================================================================

describe("producer: templates (approved, rejected, paused)", () => {
  it("publishes one notice per template and status with the right buttons; a new status resolves the old one", async () => {
    fake.db.seed("template", { id: "tpl_a", tenantId: T, name: "diwali_offer", status: "approved", rejectionReason: null, updatedAt: ago(60_000) }, { id: "tpl_r", tenantId: T, name: "promo_x", status: "rejected", rejectionReason: CUSTOMER_TEXT[3], updatedAt: ago(50_000) }, { id: "tpl_p", tenantId: T, name: "old_one", status: "paused", updatedAt: ago(40_000) }, { id: "tpl_d", tenantId: T, name: "draft_one", status: "draft", updatedAt: ago(30_000) });
    const out = await templatesProducer.run(ctxFor(T));
    expect(out.published).toBe(3);
    expect(out.cursor).toEqual({ at: ago(30_000).toISOString(), id: "tpl_d" });
    expect(noticeBy("template:tpl_a:approved")).toMatchObject({ kind: "template_approved", severity: "heads_up", audienceMinRole: "admin", actions: [{ kind: "navigate", path: "/app/broadcasts/new", labelKey: "btn.send_it" }] });
    expect(noticeBy("template:tpl_r:rejected")).toMatchObject({ kind: "template_rejected", severity: "action_needed", actions: [{ kind: "open_eddy", ref: { kind: "notice", noticeId: SELF }, labelKey: "btn.fix_with_eddy" }, { kind: "navigate", path: "/app/templates", labelKey: "btn.review" }] });
    expect(noticeBy("template:tpl_p:paused")?.kind).toBe("template_paused");
    expect(JSON.stringify(notices())).not.toContain(CUSTOMER_TEXT[3]);

    // The rejected template is fixed and approved: the rejection notice resolves, an approval notice appears.
    const tpl = fake.db.rows("template").find((r) => r.id === "tpl_r")!;
    Object.assign(tpl, { status: "approved", updatedAt: ago(10_000) });
    const next = await templatesProducer.run(ctxFor(T, out.cursor));
    expect(next.published).toBe(1);
    expect(noticeBy("template:tpl_r:rejected")?.resolvedAt).toEqual(clock.now);
    expect(noticeBy("template:tpl_r:approved")?.resolvedAt).toBeNull();
    // Nothing new since the cursor: nothing happens.
    expect((await templatesProducer.run(ctxFor(T, next.cursor))).published).toBe(0);
  });

  it("maps statuses to kinds", () => {
    expect(templateKind("approved")).toBe("template_approved");
    expect(templateKind("rejected")).toBe("template_rejected");
    for (const s of ["paused", "disabled", "flagged"]) expect(templateKind(s)).toBe("template_paused");
    for (const s of ["draft", "pending"]) expect(templateKind(s)).toBeNull();
  });
});

describe("producer: number quality reads Phase 0 breakers, lists what the safety stop paused and pauses nothing (12.1a decision 15)", () => {
  function seedQuality() {
    fake.db.seed("phoneNumber", { id: "ph_1", tenantId: T, displayPhone: "+91 98100 00001", qualityRating: "YELLOW" }, { id: "ph_2", tenantId: T, displayPhone: "+91 98100 00002", qualityRating: "RED" });
    fake.db.seed(
      "spendBreaker",
      { id: "br_y", tenantId: T, kind: "wa_quality_yellow", scopeType: "phone", scopeId: "ph_1", state: "tripped", effect: "block_marketing" },
      { id: "br_r", tenantId: T, kind: "wa_quality_red", scopeType: "phone", scopeId: "ph_2", state: "tripped", effect: "block_automated" },
      { id: "br_old", tenantId: T, kind: "wa_quality_red", scopeType: "phone", scopeId: "ph_1", state: "cleared", effect: "block_automated" },
      { id: "br_other", tenantId: "t_other", kind: "wa_quality_red", scopeType: "phone", scopeId: "ph_9", state: "tripped", effect: "block_automated" },
    );
    fake.db.seed(
      "broadcast",
      { id: "b_1", tenantId: T, phoneNumberId: "ph_1", name: "Diwali sale", status: "paused", createdAt: ago(3 * DAY) },
      { id: "b_2", tenantId: T, phoneNumberId: "ph_1", name: "Paused by a person", status: "paused", createdAt: ago(2 * DAY) },
      { id: "b_3", tenantId: T, phoneNumberId: "ph_2", name: "Weekend offer", status: "paused", createdAt: ago(DAY) },
      { id: "b_4", tenantId: T, phoneNumberId: "ph_2", name: "New arrivals", status: "paused", createdAt: ago(DAY / 2) },
      { id: "b_5", tenantId: T, phoneNumberId: "ph_2", name: "Still sending", status: "sending", createdAt: ago(DAY / 3) },
    );
    fake.db.seed(
      "platformSetting",
      { key: "broadcast.pause_reason.b_1", value: { reason: "number_quality_yellow", at: ago(DAY).toISOString() } },
      { key: "broadcast.pause_reason.b_3", value: { reason: "number_quality", at: ago(DAY).toISOString() } },
      { key: "broadcast.pause_reason.b_4", value: { reason: "number_quality_yellow", at: ago(DAY).toISOString() } },
    );
  }

  it("medium is a heads-up, low needs action and lists the paused broadcasts; no broadcast, breaker or pause reason is written", async () => {
    seedMembers();
    seedQuality();
    fake.db.writes.length = 0;
    const out = await qualityProducer.run(ctxFor(T));
    expect(out.published).toBe(2);
    expect(fake.db.writes.filter((w) => !w.startsWith("notice."))).toEqual([]);
    expect(broadcastsProcess.pauseBroadcastsForNumber).not.toHaveBeenCalled();
    expect(noticeBy("quality:ph_1:YELLOW")).toMatchObject({ kind: "number_quality_dropped", severity: "heads_up", count: 1, subjectType: "phone", subjectId: "ph_1", payload: { phoneId: "ph_1", rating: "YELLOW", breakerId: "br_y", broadcastIds: "b_1" } });
    expect(noticeBy("quality:ph_2:RED")).toMatchObject({ severity: "action_needed", count: 2, payload: { broadcastIds: "b_3,b_4" }, actions: [{ kind: "navigate", path: "/app/broadcasts", labelKey: "btn.review" }] });

    const shown = (await listNotices(OWNER, { now: clock.now })).notices.find((n) => n.subjectId === "ph_2")!;
    expect(noticeText("en", shown)).toBe("Your number +91 98100 00002 dropped to Low quality. To protect it, a safety stop paused 2 marketing broadcasts: Weekend offer, New arrivals.");
    expect(noticeText("en", (await listNotices(OWNER, { now: clock.now })).notices.find((n) => n.subjectId === "ph_1")!)).toBe("Your number +91 98100 00001 dropped to Medium quality. Marketing broadcasts on it are paused until it improves.");
  });

  it("resolves when Phase 0 clears the breaker", async () => {
    seedQuality();
    await qualityProducer.run(ctxFor(T));
    fake.db.rows("spendBreaker").find((b) => b.id === "br_y")!.state = "cleared";
    const out = await qualityProducer.run(ctxFor(T));
    expect(out.resolved).toBe(1);
    expect(noticeBy("quality:ph_1:YELLOW")?.resolvedAt).toEqual(clock.now);
    expect(noticeBy("quality:ph_2:RED")?.resolvedAt).toBeNull();
  });
});

describe("producer: failed sends grouped by code", () => {
  function seedFailures() {
    fake.db.seed("spendControl", { tenantId: T, timezone: "Asia/Kolkata", freeze: "none", approverUserIds: [] });
    const msg = (id: string, over: Row) => ({ id, tenantId: T, direction: "outbound", status: "failed", body: CUSTOMER_TEXT[1], createdAt: ago(60 * 60_000), ...over });
    fake.db.seed(
      "message",
      msg("m1", { errorCode: "131047", sentByUserId: AGENT.userId, conversationId: "cv_1" }),
      msg("m2", { errorCode: "131026", sentByUserId: null, conversationId: "cv_2" }),
      msg("m3", { errorCode: "131026", sentByUserId: null, conversationId: "cv_3" }),
      msg("m4", { errorCode: "131049", sentByUserId: null, conversationId: "cv_4", origin: "broadcast" }),
      msg("m5", { errorCode: "131049", sentByUserId: null, conversationId: "cv_5", origin: "broadcast" }),
      msg("m6", { errorCode: "999999", sentByUserId: null, conversationId: "cv_6" }),
      msg("m7", { errorCode: "131026", sentByUserId: null, conversationId: "cv_7", createdAt: ago(5 * DAY) }),
      msg("m8", { errorCode: null, sentByUserId: null, conversationId: "cv_8", status: "delivered" }),
    );
    fake.db.seed("broadcastRecipient", { id: "r4", tenantId: T, broadcastId: "b_9", contactId: "c4", messageId: "m4" }, { id: "r5", tenantId: T, broadcastId: "b_9", contactId: "c5", messageId: "m5" });
  }

  it("a member's own sends go to that member, automatic ones to admins, a broadcast's to admins with its page", async () => {
    seedFailures();
    const out = await failuresProducer.run(ctxFor(T));
    expect(out.published).toBe(4);
    const own = noticeBy(`failures:2026-10-29:131047:u:${AGENT.userId}`)!;
    expect(own).toMatchObject({ audienceUserId: AGENT.userId, severity: "action_needed", count: 1, actions: [{ kind: "navigate", path: "/app/inbox?c=cv_1", labelKey: "btn.pick_template" }] });
    expect(noticeBy("failures:2026-10-29:131026")).toMatchObject({ audienceUserId: null, audienceMinRole: "admin", count: 2 });
    expect(noticeBy("failures:b_9:131049")).toMatchObject({ count: 2, subjectType: "broadcast", subjectId: "b_9", actions: [{ kind: "navigate", path: "/app/broadcasts/b_9", labelKey: "btn.open_broadcast" }] });
    expect(noticeBy("failures:2026-10-29:999999")?.actions).toEqual([{ kind: "open_eddy", ref: { kind: "notice", noticeId: SELF }, labelKey: "btn.explain" }]);
    for (const text of CUSTOMER_TEXT) expect(JSON.stringify(notices())).not.toContain(text);

    // A third failure later: the same notice, its count updated in place.
    fake.db.seed("message", { id: "m9", tenantId: T, direction: "outbound", status: "failed", errorCode: "131026", sentByUserId: null, conversationId: "cv_9", createdAt: ago(10_000) });
    await failuresProducer.run(ctxFor(T));
    expect(notices().filter((n) => String(n.dedupeKey).startsWith("failures:2026-10-29:131026"))).toHaveLength(1);
    expect(noticeBy("failures:2026-10-29:131026")?.count).toBe(3);
  });

  it("the texts explain 131047, 131026 and 131049 with the fix", () => {
    expect(tn("en", "notices.failed.131026", { count: 2 })).toBe("2 messages didn't go because the number isn't on WhatsApp.");
    expect(tn("en", "notices.failed.131049", { count: 2 })).toBe("Meta held back 2 marketing messages to protect engagement. Try again later.");
    expect(t("en", "btn.pick_template")).toBe("Pick a template");
  });
});

describe("producer: approvals waiting go only to people who can decide them", () => {
  it("a spend raise reaches the owner and named approvers; a lowering, optimizer proposals and client changes reach every admin", async () => {
    seedMembers();
    fake.db.seed("spendControl", { tenantId: T, freeze: "none", approverUserIds: [APPROVER.userId], timezone: "Asia/Kolkata" });
    fake.db.seed("spendApproval", { id: "sa_1", tenantId: T, status: "pending", direction: "raise", expiresAt: new Date(clock.now.getTime() + DAY) }, { id: "sa_2", tenantId: T, status: "pending", direction: "raise", expiresAt: ago(1) }, { id: "sa_3", tenantId: T, status: "approved", direction: "raise", expiresAt: new Date(clock.now.getTime() + DAY) });
    await approvalsProducer.run(ctxFor(T));
    expect(noticeBy(dedupe.approvals(OWNER.userId))).toMatchObject({ count: 1, audienceUserId: OWNER.userId, payload: { spend: 1, client: 0, optimizer: 0 }, actions: [{ kind: "navigate", path: "/app/settings/spending", labelKey: "btn.review" }] });
    expect(noticeBy(dedupe.approvals(APPROVER.userId))?.count).toBe(1);
    expect(noticeBy(dedupe.approvals(ADMIN.userId))).toBeUndefined();
    expect(noticeBy(dedupe.approvals(AGENT.userId))).toBeUndefined();

    fake.db.seed("optimizerProposal", { id: "op_1", tenantId: T, status: "proposed" });
    fake.db.seed("approvalRequest", { id: "ap_1", tenantId: T, status: "changes_requested", decidedAt: ago(DAY) }, { id: "ap_2", tenantId: T, status: "changes_requested", decidedAt: ago(10 * DAY) });
    await approvalsProducer.run(ctxFor(T));
    expect(noticeBy(dedupe.approvals(ADMIN.userId))).toMatchObject({ count: 2, payload: { spend: 0, client: 1, optimizer: 1 } });
    expect(noticeBy(dedupe.approvals(OWNER.userId))?.count).toBe(3);
    expect((await listNotices(ADMIN, { now: clock.now })).notices.map((n) => n.textKey)).toEqual(["notice.approvals"]);
    expect((await listNotices(APPROVER, { now: clock.now })).notices.map((n) => n.textKey)).toEqual(["notice.approvals"]);

    // Everything decided: every approvals notice resolves.
    fake.db.rows("spendApproval").forEach((a) => (a.status = "approved"));
    fake.db.rows("optimizerProposal").forEach((p) => (p.status = "applied"));
    fake.db.rows("approvalRequest").forEach((p) => (p.status = "approved"));
    const out = await approvalsProducer.run(ctxFor(T));
    expect(out.resolved).toBe(3);
    expect(fake.db.writes.some((w) => w.startsWith("spendApproval.") || w.startsWith("spendControl."))).toBe(false);
  });

  it("reviewPath points at the first kind waiting", () => {
    expect(reviewPath({ spend: 1, client: 1, optimizer: 1 })).toBe("/app/settings/spending");
    expect(reviewPath({ spend: 0, client: 0, optimizer: 1 })).toBe("/app/ads/optimizer");
    expect(reviewPath({ spend: 0, client: 2, optimizer: 0 })).toBe("/app/creative");
  });
});

describe("producers: token, AI limit, spending, activity digest and setup", () => {
  it("token expiring and expired, with [Reconnect]; resolves when the connection is fine again", async () => {
    tokenHealth.getWhatsAppTokenHealth.mockResolvedValueOnce({ state: "expiring", expiresAt: "2026-11-05T00:00:00.000Z", daysLeft: 7 });
    await tokenProducer.run(ctxFor(T));
    expect(noticeBy("token:expiring")).toMatchObject({ kind: "token_expiring", severity: "heads_up", payload: { state: "expiring", daysLeft: 7 }, actions: [{ kind: "navigate", path: "/app/settings/connect", labelKey: "btn.reconnect" }] });
    tokenHealth.getWhatsAppTokenHealth.mockResolvedValueOnce({ state: "rejected", expiresAt: null, daysLeft: null });
    await tokenProducer.run(ctxFor(T));
    expect(noticeBy("token:expiring")?.resolvedAt).toEqual(clock.now);
    expect(noticeBy("token:expired")).toMatchObject({ kind: "token_expired", severity: "action_needed" });
    tokenHealth.getWhatsAppTokenHealth.mockResolvedValueOnce({ state: "ok", expiresAt: null, daysLeft: null });
    expect((await tokenProducer.run(ctxFor(T))).resolved).toBe(1);
  });

  it("AI 80% and 100% use Phase 0's key and period; 100% resolves the 80%; a workspace without a SpendControl row is not read", async () => {
    expect(await aiProducer.run(ctxFor(T))).toEqual({});
    expect(bridge.aiHeadroom).not.toHaveBeenCalled();
    fake.db.seed("spendControl", { tenantId: T, freeze: "none", approverUserIds: [], timezone: "Asia/Kolkata" });
    bridge.aiHeadroom.mockResolvedValueOnce({ usedToday: 0, limitToday: null, usedMonth: 410, limitMonth: 500, leftToday: null, leftMonth: 90, todayResetsOn: "2026-10-30", monthResetsOn: "2026-11-01", timezone: "Asia/Kolkata" });
    await aiProducer.run(ctxFor(T));
    expect(noticeBy("spend-ai:t_acme:2026-10:80")).toMatchObject({ kind: "ai_limit_80", severity: "heads_up", audienceMinRole: "admin", payload: { period: "month", periodKey: "2026-10", level: 80, used: 410, limit: 500 } });
    bridge.aiHeadroom.mockResolvedValueOnce({ usedToday: 30, limitToday: 30, usedMonth: 500, limitMonth: 500, leftToday: 0, leftMonth: 0, todayResetsOn: "2026-10-30", monthResetsOn: "2026-11-01", timezone: "Asia/Kolkata" });
    await aiProducer.run(ctxFor(T));
    expect(noticeBy("spend-ai:t_acme:2026-10:80")?.resolvedAt).toEqual(clock.now);
    expect(noticeBy("spend-ai:t_acme:2026-10:100")?.kind).toBe("ai_limit_100");
    expect(noticeBy("spend-ai:t_acme:2026-10-29:100")?.payload).toMatchObject({ period: "day" });
    expect(aiLevel(79, 100)).toBeNull();
    expect(aiLevel(80, 100)).toBe(80);
    expect(aiLevel(100, 100)).toBe(100);
    expect(aiLevel(100, null)).toBeNull();
    expect(fake.db.writes.some((w) => w.startsWith("spendControl."))).toBe(false);
  });

  it("spending stopped names who stopped it (by id), for every member; the platform stop too; both resolve when lifted", async () => {
    fake.db.seed("spendControl", { tenantId: T, freeze: "all", frozenByKind: "user", frozenByUserId: OWNER.userId, approverUserIds: [], timezone: "Asia/Kolkata" });
    platform.readPlatformFreeze.mockResolvedValueOnce({ freeze: "all", reason: null, byUserId: "pa_1", at: null, version: 2 });
    await spendingProducer.run(ctxFor(T));
    expect(noticeBy("spending:workspace:all")).toMatchObject({ severity: "action_needed", audienceMinRole: "agent", payload: { scope: "workspace", level: "all", byKind: "user", byUserId: OWNER.userId } });
    expect(noticeBy("spending:platform:all")?.payload).toEqual({ scope: "platform", level: "all" });
    fake.db.rows("spendControl")[0].freeze = "none";
    expect((await spendingProducer.run(ctxFor(T))).resolved).toBe(2);
    expect(fake.db.writes.some((w) => w.startsWith("spendControl."))).toBe(false);
  });

  it("the automation digest counts today's AI replies, hand-overs, chatbot sessions and rule runs (fyi, admins)", async () => {
    fake.db.seed("spendControl", { tenantId: T, timezone: "Asia/Kolkata", freeze: "none", approverUserIds: [] });
    fake.db.seed("message", { id: "a1", tenantId: T, origin: "ai_reply", conversationId: "cv_1", createdAt: ago(60_000), body: CUSTOMER_TEXT[2] }, { id: "a2", tenantId: T, origin: "ai_reply", conversationId: "cv_1", createdAt: ago(50_000) }, { id: "a3", tenantId: T, origin: "ai_reply", conversationId: "cv_2", createdAt: ago(40_000) });
    fake.db.seed("conversation", { id: "cv_2", tenantId: T, tags: ["ai:stopped"], statusChangedAt: ago(30_000), status: "open" });
    fake.db.seed("chatbotSession", { id: "s1", tenantId: T, chatbotId: "bot_1", startedAt: ago(1000) });
    fake.db.seed("ruleExecution", { id: "e1", tenantId: T, ruleId: "r_1", createdAt: ago(1000) }, { id: "e2", tenantId: T, ruleId: "r_1", createdAt: ago(2 * DAY) });
    await activityProducer.run(ctxFor(T));
    const digest = noticeBy("digest:2026-10-29")!;
    expect(digest).toMatchObject({ kind: "automation_digest", severity: "fyi", audienceMinRole: "admin", payload: { day: "2026-10-29", ai: 2, handoff: 1, bots: 1, rules: 1 } });
    expect(tn("en", "notices.digest.ai", { ai: 2, handoff: 1 })).toBe("Today the AI agent replied to 2 chats and handed 1 to your team.");
    expect(JSON.stringify(digest)).not.toContain(CUSTOMER_TEXT[2]);
  });

  it("setup: the next step with [Do this with Eddy] and its page; resolves when the step changes", async () => {
    setup.getSetup.mockResolvedValueOnce({ steps: [{ id: "template", href: "/app/templates/new" }], summary: { nextStepId: "template" } });
    await setupProducer.run(ctxFor(T));
    expect(noticeBy("setup:template")).toMatchObject({ severity: "fyi", payload: { stepId: "template" }, actions: [{ kind: "open_eddy", ref: { kind: "notice", noticeId: SELF }, labelKey: "btn.do_with_eddy" }, { kind: "navigate", path: "/app/templates/new", labelKey: "btn.open" }] });
    setup.getSetup.mockResolvedValueOnce({ steps: [], summary: { nextStepId: null } });
    expect((await setupProducer.run(ctxFor(T))).resolved).toBe(1);
  });
});

// =====================================================================================================================
// The scan: eligible workspaces, demo and no-number skips, cursors, isolation
// =====================================================================================================================

describe("the notice scan", () => {
  it("scans only workspaces with Eddy on or proactive notices on (no setting row = defaults, on); never deleted ones", async () => {
    fake.db.seed("tenant", { id: "t_a", deletedAt: null }, { id: "t_b", deletedAt: null }, { id: "t_c", deletedAt: null }, { id: "t_d", deletedAt: ago(DAY) }, { id: "t_e", deletedAt: null });
    fake.db.seed("eddyWorkspaceSetting", { tenantId: "t_b", enabled: false, proactiveNotices: false }, { tenantId: "t_c", enabled: true, proactiveNotices: false }, { tenantId: "t_e", enabled: false, proactiveNotices: true });
    expect(await eligibleTenants("", 10)).toEqual(["t_a", "t_c", "t_e"]);
    expect(await eligibleTenants("t_a", 1)).toEqual(["t_c"]);
  });

  it("skips the demo workspace's token and quality scans, and number-based kinds when there is no number", async () => {
    const ran: string[] = [];
    const spy = (name: string, flags: Partial<NoticeProducer>): NoticeProducer => ({ name, kinds: [], ...flags, run: async () => (ran.push(name), {}) });
    const producers = [spy("token", { skipDemo: true }), spy("quality", { skipDemo: true, numberBased: true }), spy("failures", { numberBased: true }), spy("templates", {})];
    fake.db.seed("phoneNumber", { id: "ph_demo", tenantId: "t_demo", displayPhone: "+1" });
    const demo = await scanTenant("t_demo", clock.now, { producers });
    expect(demo.skipped).toEqual(["token", "quality"]);
    expect(ran).toEqual(["failures", "templates"]);
    ran.length = 0;
    const noNumber = await scanTenant("t_none", clock.now, { producers });
    expect(noNumber.skipped).toEqual(["quality", "failures"]);
    expect(ran).toEqual(["token", "templates"]);
    expect(PRODUCERS.find((p) => p.name === "token")?.skipDemo).toBe(true);
    expect(PRODUCERS.find((p) => p.name === "quality")).toMatchObject({ skipDemo: true, numberBased: true });
    expect(PRODUCERS.find((p) => p.name === "failures")?.numberBased).toBe(true);
    expect(PRODUCERS.map((p) => p.name).sort()).toEqual(["activity", "ai-limit", "approvals", "failures", "quality", "setup", "spending", "templates", "token"]);
  });

  it("saves each producer's cursor; one failing producer never stops the others", async () => {
    const spy = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const producers: NoticeProducer[] = [
      { name: "boom", kinds: [], run: async () => Promise.reject(new Error("db down for +919876543210")) },
      { name: "ok", kinds: [], run: async (ctx) => ({ cursor: { seen: (ctx.cursor as { seen?: number } | null)?.seen ? 2 : 1 } }) },
    ];
    const r = await scanTenant(T, clock.now, { producers });
    expect(r).toMatchObject({ ran: ["ok"], failed: ["boom"] });
    expect(fake.db.rows("noticeScanState")).toEqual([expect.objectContaining({ tenantId: T, scanner: "ok", cursor: { seen: 1 } })]);
    await scanTenant(T, clock.now, { producers });
    expect(fake.db.rows("noticeScanState")[0].cursor).toEqual({ seen: 2 });
    expect(JSON.stringify(spy.mock.calls)).not.toContain("919876543210");
    spy.mockRestore();
  });

  it("rotates through workspaces a batch at a time and wraps around", async () => {
    fake.db.seed("tenant", ...["t_1", "t_2", "t_3"].map((id) => ({ id, deletedAt: null })));
    const seen: string[] = [];
    const producers: NoticeProducer[] = [{ name: "rec", kinds: [], run: async (ctx) => (seen.push(ctx.tenantId), {}) }];
    await runNoticeScan({ now: clock.now, maxTenants: 2, producers, isDemo: async () => false });
    await runNoticeScan({ now: clock.now, maxTenants: 2, producers, isDemo: async () => false });
    await runNoticeScan({ now: clock.now, maxTenants: 2, producers, isDemo: async () => false });
    expect(seen).toEqual(["t_1", "t_2", "t_3", "t_1", "t_2", "t_3"]);
  });

  it("a full scan of a workspace stores no customer text anywhere in the notice store, and every button carries ids only", async () => {
    seedMembers();
    fake.db.seed("phoneNumber", { id: "ph_1", tenantId: T, displayPhone: "+91 98100 00001" });
    fake.db.seed("spendControl", { tenantId: T, timezone: "Asia/Kolkata", freeze: "all", frozenByKind: "user", frozenByUserId: OWNER.userId, approverUserIds: [] });
    fake.db.seed("contact", { id: "ct_1", tenantId: T, name: CUSTOMER_TEXT[0], phone: CUSTOMER_TEXT[4] });
    fake.db.seed("template", { id: "tpl_r", tenantId: T, name: "promo", status: "rejected", rejectionReason: CUSTOMER_TEXT[3], updatedAt: ago(1000) });
    fake.db.seed("message", { id: "m1", tenantId: T, direction: "outbound", status: "failed", errorCode: "131047", body: CUSTOMER_TEXT[1], sentByUserId: AGENT.userId, conversationId: "cv_1", createdAt: ago(1000) }, { id: "m2", tenantId: T, origin: "ai_reply", body: CUSTOMER_TEXT[2], conversationId: "cv_1", createdAt: ago(1000) });
    fake.db.seed("spendBreaker", { id: "br_r", tenantId: T, kind: "wa_quality_red", scopeType: "phone", scopeId: "ph_1", state: "tripped" });
    tokenHealth.getWhatsAppTokenHealth.mockResolvedValueOnce({ state: "expired", expiresAt: null, daysLeft: 0 });
    setup.getSetup.mockResolvedValueOnce({ steps: [{ id: "broadcast", href: "/app/broadcasts/new" }], summary: { nextStepId: "broadcast" } });
    const r = await scanTenant(T, clock.now);
    expect(r.failed).toEqual([]);
    expect(notices().length).toBeGreaterThanOrEqual(6);
    const stored = JSON.stringify([notices(), fake.db.rows("noticeScanState")]);
    for (const text of CUSTOMER_TEXT) expect(stored).not.toContain(text);
    for (const n of notices()) {
      for (const a of n.actions as { kind: string; path?: string; ref?: { noticeId?: string } }[]) {
        expect(["navigate", "open_eddy", "card"]).toContain(a.kind);
        if (a.kind === "navigate") expect(a.path).toMatch(/^\/app(\/|\?|$)/);
        if (a.kind === "open_eddy") expect(a.ref).toEqual({ kind: "notice", noticeId: SELF });
      }
    }
    // Read back, each notice button that opens Eddy points at that notice itself.
    for (const actor of [OWNER, AGENT]) {
      for (const n of (await listNotices(actor, { now: clock.now })).notices) {
        for (const a of n.actions) if (a.kind === "open_eddy") expect(a.ref).toEqual({ kind: "notice", noticeId: n.id });
      }
    }
  });
});

// =====================================================================================================================
// Routes
// =====================================================================================================================

describe("GET /api/notices, PATCH /api/notices/[id], POST automation_off", () => {
  const req = (url: string, init: RequestInit = {}) => new Request(`https://wa.edwyz.com${url}`, { headers: { origin: "https://wa.edwyz.com", "content-type": "application/json" }, ...init });

  beforeEach(async () => {
    seedMembers();
    await publishNotice({ tenantId: T, kind: "token_expired", severity: "action_needed", dedupeKey: "token:expired", audience: { minRole: "admin" }, actions: [{ kind: "navigate", path: "/app/settings/connect", labelKey: "btn.reconnect" }] }, { now: new Date() });
  });

  it("GET lists the member's notices, claims the toast once, and sends no-store", async () => {
    auth.getActor.mockResolvedValue(ADMIN);
    const res = await getNotices(req("/api/notices"));
    expect(res.status).toBe(200);
    expect(res.headers.get("cache-control")).toBe("no-store");
    const body = (await res.json()) as { notices: NoticeDTO[]; needsYou: number; toasts: string[] };
    expect(body.notices.map((n) => n.kind)).toEqual(["token_expired"]);
    expect(body.needsYou).toBe(1);
    expect(body.toasts).toEqual([body.notices[0].id]);
    expect(((await (await getNotices(req("/api/notices"))).json()) as { toasts: string[] }).toasts).toEqual([]);
    auth.getActor.mockResolvedValue(AGENT);
    expect(((await (await getNotices(req("/api/notices"))).json()) as { notices: unknown[] }).notices).toEqual([]);
  });

  it("GET ?view=activity lists automations; canManage only for admins and the owner", async () => {
    fake.db.seed("automationRule", { id: "r_1", tenantId: T, name: "Welcome", enabled: true });
    fake.db.seed("aiAgent", { id: "ag_1", tenantId: T, name: "Helper", enabled: false });
    auth.getActor.mockResolvedValue(AGENT);
    const body = (await (await getNotices(req("/api/notices?view=activity"))).json()) as { activity: { kind: string }[]; canManage: boolean };
    expect(body.activity.map((i) => i.kind)).toEqual(["ai_agent", "rule"]);
    expect(body.canManage).toBe(false);
  });

  it("PATCH sets the member's receipt; 404 for a notice they cannot see; 400 for anything but seen, dismissed or mute", async () => {
    const id = String(noticeBy("token:expired")!.id);
    auth.getActor.mockResolvedValue(ADMIN);
    const patch = (body: unknown, nid = id) => patchNoticeRoute(req(`/api/notices/${nid}`, { method: "PATCH", body: JSON.stringify(body) }), { params: Promise.resolve({ id: nid }) });
    expect((await patch({ dismissed: true })).status).toBe(200);
    expect(fake.db.rows("noticeReceipt")[0]).toMatchObject({ noticeId: id, userId: ADMIN.userId });
    expect((await patch({ text: "Ravi Kumar" })).status).toBe(400);
    expect((await patch({ seen: true }, "n_missing")).status).toBe(404);
    expect((await patch({ seen: true }, "bad id!")).status).toBe(404);
    auth.getActor.mockResolvedValue(AGENT);
    expect((await patch({ seen: true })).status).toBe(404);
  });

  it("POST automation_off: admins turn something off at once through the Settings services; members get 403; turning on is never done here", async () => {
    const post = (body: unknown) => postNotices(req("/api/notices", { method: "POST", body: JSON.stringify(body) }));
    auth.getActor.mockResolvedValue(AGENT);
    expect((await post({ op: "automation_off", kind: "rule", id: "r_1" })).status).toBe(403);
    expect(services.updateRule).not.toHaveBeenCalled();
    auth.getActor.mockResolvedValue(ADMIN);
    expect((await post({ op: "automation_off", kind: "rule", id: "r_1" })).status).toBe(200);
    expect(services.updateRule).toHaveBeenCalledWith(T, "r_1", { enabled: false });
    expect((await post({ op: "automation_off", kind: "chatbot", id: "bot_1" })).status).toBe(200);
    expect(services.unpublishChatbot).toHaveBeenCalledWith(T, "bot_1");
    expect((await post({ op: "automation_off", kind: "ai_agent", id: "ag_1" })).status).toBe(200);
    expect(services.updateAgent).toHaveBeenCalledWith(T, ADMIN.userId, "ag_1", { enabled: false });
    expect(services.audit).toHaveBeenCalledWith(expect.objectContaining({ action: "eddy.team_activity.off", target: "ag_1" }));
    expect((await post({ op: "automation_on", kind: "rule", id: "r_1" })).status).toBe(400);
    expect((await post({ op: "automation_off", kind: "webhook", id: "w_1" })).status).toBe(400);
  });

  it("team activity: one item per automation with its Settings page and 24-hour counts", async () => {
    fake.db.seed("chatbot", { id: "bot_1", tenantId: T, name: "Order bot", status: "published" }, { id: "bot_2", tenantId: T, name: "Old", status: "archived" });
    fake.db.seed("leadSequence", { id: "ls_1", tenantId: T, name: "Follow up", enabled: true });
    fake.db.seed("shopifyStore", { id: "sh_1", tenantId: T, shopDomain: "acme.myshopify.com" });
    fake.db.seed("chatbotSession", { id: "s1", tenantId: T, chatbotId: "bot_1", startedAt: ago(1000) });
    const items = await teamActivity(T, clock.now);
    expect(items.map((i) => [i.kind, i.id, i.enabled, i.last24h, i.settingsPath])).toEqual([
      ["chatbot", "bot_1", true, 1, "/app/automation/chatbots/bot_1"],
      ["lead_sequence", "ls_1", true, 0, "/app/leads/sequences"],
      ["cart_reminders", "sh_1", true, null, "/app/commerce"],
    ]);
    expect(settingsPathFor("rule", "r_1")).toBe("/app/automation/rules/r_1");
    // A team member sees neither the admin-only kinds (lead follow-ups, cart reminders) nor the workspace-wide counts.
    expect(activityForViewer(items, false).map((i) => [i.kind, i.id, i.last24h, i.waiting])).toEqual([["chatbot", "bot_1", null, 0]]);
    expect(activityForViewer(items, true)).toEqual(items);
  });
});

// =====================================================================================================================
// Retention (7.6, 8.3) and erasure (7.6, EDDY-16 acceptance 6 and 8)
// =====================================================================================================================

const CONFIG = { eddyHistoryDays: 90, actionRecordDays: 90, actionInvocationDays: 400, noticeDays: 30, usageLedgerDays: 400 } as never;

describe("Eddy retention", () => {
  it("deletes the rows older than each key, keeps the newer ones", async () => {
    fake.db.seed("eddyConversation", { id: "c_old", tenantId: T, userId: AGENT.userId, visibilityHash: "vh_a", lastMessageAt: ago(91 * DAY) }, { id: "c_new", tenantId: T, userId: AGENT.userId, visibilityHash: "vh_a", lastMessageAt: ago(89 * DAY) });
    fake.db.seed("eddyMessage", { id: "em_1", tenantId: T, conversationId: "c_old", seq: 0 }, { id: "em_2", tenantId: T, conversationId: "c_new", seq: 0 });
    fake.db.seed(
      "actionRecord",
      { id: "ar_old", tenantId: T, userId: AGENT.userId, status: "done", decidedAt: ago(91 * DAY), createdAt: ago(91 * DAY) },
      { id: "ar_exp", tenantId: T, userId: AGENT.userId, status: "expired", decidedAt: null, expiresAt: ago(91 * DAY), createdAt: ago(91 * DAY) },
      { id: "ar_new", tenantId: T, userId: AGENT.userId, status: "done", decidedAt: ago(10 * DAY), createdAt: ago(10 * DAY) },
      { id: "ar_run", tenantId: T, userId: AGENT.userId, status: "running", decidedAt: ago(200 * DAY), createdAt: ago(200 * DAY) },
    );
    fake.db.seed("actionInvocation", { id: "ai_old", tenantId: T, userId: AGENT.userId, createdAt: ago(401 * DAY) }, { id: "ai_new", tenantId: T, userId: AGENT.userId, createdAt: ago(399 * DAY) });
    fake.db.seed("eddyTurn", { id: "tu_old", tenantId: T, status: "done", startedAt: ago(401 * DAY) }, { id: "tu_new", tenantId: T, status: "done", startedAt: ago(30 * DAY) });
    fake.db.seed(
      "notice",
      { id: "n_res", tenantId: T, kind: "x", severity: "fyi", dedupeKey: "a", resolvedAt: ago(31 * DAY), expiresAt: ago(25 * DAY) },
      { id: "n_exp", tenantId: T, kind: "x", severity: "fyi", dedupeKey: "b", resolvedAt: null, expiresAt: ago(31 * DAY) },
      { id: "n_keep", tenantId: T, kind: "x", severity: "fyi", dedupeKey: "c", resolvedAt: ago(29 * DAY), expiresAt: ago(20 * DAY) },
    );
    fake.db.seed("noticeReceipt", { noticeId: "n_res", userId: AGENT.userId, tenantId: T }, { noticeId: "n_keep", userId: AGENT.userId, tenantId: T });
    const out = await runEddyRetention({ now: clock.now, config: CONFIG });
    expect(out).toMatchObject({ eddyConversations: 1, actionRecords: 2, actionInvocations: 1, eddyTurns: 1, notices: 2, mismatchedVisibility: 0 });
    expect(fake.db.rows("eddyConversation").map((r) => r.id)).toEqual(["c_new"]);
    expect(fake.db.rows("eddyMessage").map((r) => r.id)).toEqual(["em_2"]);
    expect(fake.db.rows("actionRecord").map((r) => r.id)).toEqual(["ar_new", "ar_run"]);
    expect(fake.db.rows("actionInvocation").map((r) => r.id)).toEqual(["ai_new"]);
    expect(fake.db.rows("eddyTurn").map((r) => r.id)).toEqual(["tu_new"]);
    expect(fake.db.rows("notice").map((r) => r.id)).toEqual(["n_keep"]);
    expect(fake.db.rows("noticeReceipt").map((r) => r.noticeId)).toEqual(["n_keep"]);
  });

  it("deletes conversations whose visibilityHash no longer matches their member (not one with a running turn, not a member who left)", async () => {
    fake.db.seed(
      "eddyConversation",
      { id: "c_match", tenantId: T, userId: AGENT.userId, visibilityHash: "vh_now", status: "active", lastMessageAt: ago(DAY) },
      { id: "c_stale", tenantId: T, userId: AGENT.userId, visibilityHash: "vh_before", status: "closed", lastMessageAt: ago(DAY) },
      { id: "c_busy", tenantId: T, userId: ADMIN.userId, visibilityHash: "vh_before", status: "active", lastMessageAt: ago(DAY) },
      { id: "c_left", tenantId: T, userId: "u_left", visibilityHash: "vh_before", status: "active", lastMessageAt: ago(DAY) },
      { id: "c_erased", tenantId: T, userId: AGENT.userId, visibilityHash: "vh_before", status: "erased", lastMessageAt: ago(DAY) },
    );
    fake.db.seed("eddyMessage", { id: "em_s", tenantId: T, conversationId: "c_stale", seq: 0 }, { id: "em_m", tenantId: T, conversationId: "c_match", seq: 0 });
    fake.db.seed("eddyTurn", { id: "tu_busy", tenantId: T, conversationId: "c_busy", status: "running", startedAt: ago(1000) });
    const hashFor = vi.fn(async (_t: string, userId: string) => (userId === "u_left" ? null : "vh_now"));
    const out = await runEddyRetention({ now: clock.now, config: CONFIG, visibilityHashFor: hashFor });
    expect(out.mismatchedVisibility).toBe(1);
    expect(fake.db.rows("eddyConversation").map((r) => r.id).sort()).toEqual(["c_busy", "c_erased", "c_left", "c_match"]);
    expect(fake.db.rows("eddyMessage").map((r) => r.id)).toEqual(["em_m"]);
    // Asked once per member.
    expect(hashFor.mock.calls.filter((c) => c[1] === AGENT.userId)).toHaveLength(1);
  });
});

describe("Eddy erasure", () => {
  function seedEddyRows() {
    fake.db.seed("contact", { id: "ct_keep", tenantId: T, name: "Asha" });
    fake.db.seed("eddyConversation", { id: "c_1", tenantId: T, userId: AGENT.userId, status: "active", visibilityHash: "v" }, { id: "c_2", tenantId: T, userId: AGENT.userId, status: "closed", visibilityHash: "v" }, { id: "c_3", tenantId: T, userId: ADMIN.userId, status: "active", visibilityHash: "v" });
    fake.db.seed(
      "eddyMessage",
      { id: "e1", tenantId: T, conversationId: "c_1", seq: 0, contactIds: [] },
      { id: "e2", tenantId: T, conversationId: "c_1", seq: 1, contactIds: ["ct_gone"] },
      { id: "e3", tenantId: T, conversationId: "c_1", seq: 2, contactIds: [] },
      { id: "e4", tenantId: T, conversationId: "c_2", seq: 0, contactIds: ["ct_keep"] },
      { id: "e5", tenantId: T, conversationId: "c_3", seq: 0, contactIds: [] },
    );
    fake.db.seed("eddyTurn", { id: "tu_1", tenantId: T, conversationId: "c_1", userId: AGENT.userId, status: "running", startedAt: ago(1000) });
    fake.db.seed("actionRecord", { id: "ar_1", tenantId: T, userId: AGENT.userId, status: "done", contactIds: ["ct_gone", "ct_keep"] }, { id: "ar_2", tenantId: T, userId: AGENT.userId, status: "done", contactIds: ["ct_keep"] });
    fake.db.seed("notice", { id: "n_c", tenantId: T, kind: "x", severity: "fyi", dedupeKey: "k1", subjectType: "contact", subjectId: "ct_gone", expiresAt: new Date(clock.now.getTime() + DAY) }, { id: "n_cv", tenantId: T, kind: "x", severity: "fyi", dedupeKey: "k2", subjectType: "conversation", subjectId: "cv_gone", expiresAt: new Date(clock.now.getTime() + DAY) }, { id: "n_other", tenantId: T, kind: "x", severity: "fyi", dedupeKey: "k3", subjectType: "contact", subjectId: "ct_keep", expiresAt: new Date(clock.now.getTime() + DAY) });
    fake.db.seed("noticeReceipt", { noticeId: "n_c", userId: AGENT.userId, tenantId: T });
  }

  it("eraseContactFromEddy deletes every message of a conversation mentioning the contact and marks it erased; its records and notices go", async () => {
    seedEddyRows();
    const out = await eraseContactFromEddy(T, "ct_gone", { conversationIds: ["cv_gone"], now: clock.now });
    expect(out).toEqual({ conversations: 1, messages: 3, actionRecords: 1, notices: 2 });
    expect(fake.db.rows("eddyConversation").find((c) => c.id === "c_1")).toMatchObject({ status: "erased", closedReason: "contact_erased" });
    expect(fake.db.rows("eddyConversation").find((c) => c.id === "c_2")?.status).toBe("closed");
    expect(fake.db.rows("eddyMessage").map((m) => m.id)).toEqual(["e4", "e5"]);
    expect(fake.db.rows("eddyTurn")[0]).toMatchObject({ status: "aborted", errorCode: "erased" });
    expect(fake.db.rows("actionRecord").map((a) => a.id)).toEqual(["ar_2"]);
    expect(fake.db.rows("notice").map((n) => n.id)).toEqual(["n_other"]);
    expect(fake.db.rows("noticeReceipt")).toEqual([]);
    // Idempotent.
    expect(await eraseContactFromEddy(T, "ct_gone", { now: clock.now })).toEqual({ conversations: 0, messages: 0, actionRecords: 0, notices: 0 });
  });

  it("the daily sweep erases contacts that no longer exist, notices about deleted chats, and forgets members who left", async () => {
    seedEddyRows();
    fake.db.seed("membership", { id: "m_a", ...AGENT });
    fake.db.seed("eddyUserPref", { tenantId: T, userId: ADMIN.userId, mutedNoticeKinds: ["x"] });
    const out = await runEddyErasureSweep({ now: clock.now });
    expect(out).toEqual({ contactsErased: 1, noticesDeleted: 1, membersForgotten: 1 });
    expect(fake.db.rows("eddyConversation").find((c) => c.id === "c_1")?.status).toBe("erased");
    // The admin has no membership row here: their conversation, messages and preferences are gone.
    expect(fake.db.rows("eddyConversation").some((c) => c.userId === ADMIN.userId)).toBe(false);
    expect(fake.db.rows("eddyMessage").some((m) => m.id === "e5")).toBe(false);
    expect(fake.db.rows("eddyUserPref")).toEqual([]);
    // The member who stays keeps their other conversation.
    expect(fake.db.rows("eddyConversation").find((c) => c.id === "c_2")).toBeTruthy();
  });

  it("eddyForgetUser removes the member's Eddy rows and keeps usage and audit rows without the person", async () => {
    fake.db.seed("eddyConversation", { id: "c_1", tenantId: T, userId: AGENT.userId, status: "active", visibilityHash: "v" }, { id: "c_x", tenantId: T, userId: ADMIN.userId, status: "active", visibilityHash: "v" });
    fake.db.seed("eddyMessage", { id: "e1", tenantId: T, conversationId: "c_1", seq: 0 }, { id: "ex", tenantId: T, conversationId: "c_x", seq: 0 });
    fake.db.seed("eddyTurn", { id: "tu_1", tenantId: T, conversationId: "c_1", userId: AGENT.userId, status: "running", startedAt: ago(1000) }, { id: "tu_2", tenantId: T, conversationId: null, userId: AGENT.userId, status: "done", startedAt: ago(DAY) });
    fake.db.seed("eddyUserPref", { tenantId: T, userId: AGENT.userId });
    fake.db.seed("notice", { id: "n_own", tenantId: T, kind: "failed_sends", severity: "heads_up", dedupeKey: "k", audienceUserId: AGENT.userId, expiresAt: new Date(clock.now.getTime() + DAY) }, { id: "n_ws", tenantId: T, kind: "x", severity: "fyi", dedupeKey: "k2", expiresAt: new Date(clock.now.getTime() + DAY) });
    fake.db.seed("noticeReceipt", { noticeId: "n_ws", userId: AGENT.userId, tenantId: T }, { noticeId: "n_ws", userId: ADMIN.userId, tenantId: T });
    fake.db.seed("actionRecord", { id: "ar_p", tenantId: T, userId: AGENT.userId, status: "pending" }, { id: "ar_d", tenantId: T, userId: AGENT.userId, status: "done" }, { id: "ar_u", tenantId: T, userId: AGENT.userId, status: "unknown" });
    fake.db.seed("actionInvocation", { id: "iv_1", tenantId: T, userId: AGENT.userId }, { id: "iv_2", tenantId: T, userId: ADMIN.userId });
    const out = await eddyForgetUser(T, AGENT.userId, { now: clock.now });
    expect(out).toMatchObject({ conversations: 1, messages: 1, prefs: 1, receipts: 1, notices: 1, cancelled: 1, actionRecords: 2, turns: 2, invocations: 1 });
    expect(fake.db.rows("eddyTurn").every((r) => r.userId === null)).toBe(true);
    expect(fake.db.rows("eddyTurn").find((r) => r.id === "tu_1")?.status).toBe("aborted");
    expect(fake.db.rows("actionInvocation").find((r) => r.id === "iv_1")?.userId).toBeNull();
    expect(fake.db.rows("actionInvocation").find((r) => r.id === "iv_2")?.userId).toBe(ADMIN.userId);
    expect(fake.db.rows("actionRecord").map((r) => r.id)).toEqual(["ar_u"]);
    expect(fake.db.rows("noticeReceipt")).toEqual([expect.objectContaining({ userId: ADMIN.userId })]);
    expect(fake.db.rows("eddyConversation").map((r) => r.id)).toEqual(["c_x"]);
    // Only the unknown record (left for the reconcile job) still names the member.
    const left = Object.entries(fake.db.tables).flatMap(([model, rows]) => rows.filter((r) => r.userId === AGENT.userId || r.audienceUserId === AGENT.userId).map((r) => `${model}:${String(r.id)}`));
    expect(left).toEqual(["actionRecord:ar_u"]);
    expect(await eddyForgetUserEverywhere(AGENT.userId, { now: clock.now })).toBe(1);
  });
});

// =====================================================================================================================
// UI: the strip and the menu views (light and dark, 360 px, design-system components, all three languages)
// =====================================================================================================================

const html = (node: ReactElement) => renderToStaticMarkup(node);
const textOf = (markup: string) => markup.replace(/<[^>]+>/g, "").replace(/&#x27;/g, "'").replace(/&quot;/g, '"').replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&amp;/g, "&");

const CSS = readFileSync(path.resolve(__dirname, "../src/app/globals.css"), "utf8");
function block(selector: string): string {
  const start = CSS.indexOf(selector);
  if (start < 0) throw new Error(`no ${selector} block in globals.css`);
  return CSS.slice(start, CSS.indexOf("\n}", start));
}
const defined = (b: string) => new Set([...b.matchAll(/^\s*--([a-z0-9-]+):/gm)].map((m) => m[1]));
const LIGHT = defined(block(":root {"));
const DARK = defined(block(':root[data-theme="dark"] {'));
const THEME_COLORS = new Map([...block("@theme inline {").matchAll(/--color-([a-z0-9-]+):\s*var\(--([a-z0-9-]+)\)/g)].map((m) => [m[1], m[2]]));
const PALETTE = /^(slate|gray|zinc|neutral|stone|red|orange|amber|yellow|lime|green|emerald|teal|cyan|sky|blue|indigo|violet|purple|fuchsia|pink|rose)-\d{2,3}$|^(white|black)$/;
const COLOR_UTILITY = /^(?:bg|text|border(?:-[trblxy])?|ring|fill|stroke|decoration|outline|divide|placeholder|from|to|via)-(.+?)(?:\/\d+)?$/;

/** Light and dark come only from tokens defined in both themes: no palette colours, hex or dark: variants. */
function themeProblems(markup: string): string[] {
  const problems: string[] = [];
  for (const m of markup.matchAll(/class="([^"]*)"/g)) {
    for (const raw of m[1].split(/\s+/).filter(Boolean)) {
      if (raw.includes("dark:")) problems.push(`dark variant ${raw}`);
      const cm = COLOR_UTILITY.exec(raw.replace(/^(?:[a-z0-9-]+:)+/, ""));
      if (!cm) continue;
      if (PALETTE.test(cm[1])) problems.push(`palette colour ${raw}`);
      if (/#[0-9a-f]{3,8}/i.test(cm[1])) problems.push(`raw hex ${raw}`);
      const token = THEME_COLORS.get(cm[1]);
      if (token && !(LIGHT.has(token) && DARK.has(token))) problems.push(`token --${token} missing in a theme (${raw})`);
    }
  }
  return problems;
}

/** Nothing wider than a 360 px phone (minus its 16 px gutters): no fixed width above 328 px, and text that can wrap. */
function phoneProblems(markup: string): string[] {
  const problems: string[] = [];
  for (const m of markup.matchAll(/\b(?:min-)?w-\[(\d+)px\]/g)) if (Number(m[1]) > 328) problems.push(m[0]);
  for (const m of markup.matchAll(/width:\s*(\d+)px/g)) if (Number(m[1]) > 328) problems.push(m[0]);
  return problems;
}

/** The same markup in a light and a dark page (theme comes only from the root's data-theme). */
function inThemes(node: ReactElement): { light: string; dark: string } {
  const light = html(h("div", { "data-theme": "light" }, node)).replace(/^<div data-theme="light">/, "");
  const dark = html(h("div", { "data-theme": "dark" }, node)).replace(/^<div data-theme="dark">/, "");
  return { light, dark };
}

const iso = (s: string) => new Date(s).toISOString();
function dto(over: Partial<NoticeDTO> = {}): NoticeDTO {
  return {
    id: "n_1",
    kind: "template_approved",
    severity: "heads_up",
    source: "eddy",
    textKey: "notice.template_approved",
    payload: { templateId: "tpl_1", name: "diwali_offer", count: 1 },
    actions: [{ kind: "navigate", path: "/app/broadcasts/new", labelKey: "btn.send_it" }],
    subjectType: "template",
    subjectId: "tpl_1",
    count: 1,
    createdAt: iso("2026-10-29T06:00:00Z"),
    updatedAt: iso("2026-10-29T06:00:00Z"),
    expiresAt: iso("2026-11-05T06:00:00Z"),
    resolvedAt: null,
    seenAt: null,
    dismissedAt: null,
    toastedAt: null,
    ...over,
  };
}

const STRIP = [
  dto({ id: "n_a", severity: "action_needed", kind: "token_expired", textKey: "notices.token_expired", payload: {}, actions: [{ kind: "navigate", path: "/app/settings/connect", labelKey: "btn.reconnect" }] }),
  dto({ id: "n_b", kind: "template_rejected", severity: "action_needed", textKey: "notices.template_rejected", actions: [{ kind: "open_eddy", ref: { kind: "notice", noticeId: "n_b" }, labelKey: "btn.fix_with_eddy" }, { kind: "navigate", path: "/app/templates", labelKey: "btn.review" }] }),
  dto({ id: "n_c" }),
  dto({ id: "n_d", severity: "fyi", kind: "automation_digest", textKey: "notices.digest.ai", payload: { ai: 34, handoff: 5 }, actions: [] }),
];

const noop = () => undefined;
const strip = (lang: EddyLang, over: Partial<Parameters<typeof NoticeListView>[0]> = {}) => h(NoticeListView, { notices: STRIP, lang, expanded: false, onToggle: noop, onAction: noop, onDismiss: noop, onMute: noop, ...over });

describe("the Needs you strip (NoticeList)", () => {
  it.each(EDDY_LANGS)("renders at most %s 3 notices, See all, buttons and dismiss, in light and dark, tokens only, phone width", (lang) => {
    const { light, dark } = inThemes(strip(lang));
    expect(light).toBe(dark);
    expect(themeProblems(light)).toEqual([]);
    expect(phoneProblems(light)).toEqual([]);
    expect((light.match(/data-notice-id=/g) ?? []).length).toBe(STRIP_LIMIT);
    expect(light).toContain(`lang="${lang === "hi" ? "hi" : lang === "hinglish" ? "hi-Latn" : "en"}"`);
    expect(light).toMatch(/aria-labelledby="[^"]+"/);
    expect(light).toMatch(/role="status" aria-live="polite"/);
    expect(light).toContain("data-notice-see-all");
    expect(light).toContain('aria-expanded="false"');
    expect(textOf(light)).toContain(tn(lang, "notices.strip.title"));
    expect(textOf(light)).toContain(t(lang, "btn.see_all"));
    expect(light).toContain(`aria-label="${tn(lang, "notices.dismiss.a11y")}"`);
    expect(textOf(light)).toContain(t(lang, "btn.dismiss"));
    // Design-system pieces: Badge (rounded-full chip), Button (rounded-full, min-h), tokens for the surface.
    expect(light).toContain("rounded-card border border-border bg-raised");
    expect(light).toMatch(/inline-flex items-center gap-1\.5 whitespace-nowrap rounded-full border/);
    expect(light).toContain("h-11 w-11");
    expect(light).toContain("pointer-coarse:min-h-11");
  });

  it("expanded shows every notice; nothing to show renders nothing", () => {
    expect((html(strip("en", { expanded: true })).match(/data-notice-id=/g) ?? []).length).toBe(4);
    expect(html(strip("en", { notices: [] }))).toBe("");
  });

  it("names render as escaped text, a backticked template name as code, and the severity chip reads plainly", () => {
    const markup = html(strip("en", { notices: [dto({ payload: { name: "<img src=x onerror=alert(1)>" } })] }));
    expect(markup).not.toContain("<img");
    expect(markup).toContain("&lt;img src=x onerror=alert(1)&gt;");
    expect(markup).toContain("<code");
    expect(textOf(markup)).toContain("Needs you");
    expect(textOf(markup)).toContain("Heads-up");
    expect(html(h(NoticeText, { text: "a `b` c `d" }))).toBe("<span>a </span><code class=\"rounded bg-surface-2 px-1 font-mono text-[0.92em]\">b</code><span> c </span><span>`d</span>");
  });

  it("buttons only navigate to /app paths or open Eddy with the notice's id; a card is built fresh from that id", () => {
    const n = dto({ id: "n_7" });
    expect(intentFor(n, { kind: "navigate", path: "/app/templates", labelKey: "btn.review" })).toEqual({ kind: "navigate", path: "/app/templates" });
    expect(intentFor(n, { kind: "navigate", path: "https://evil.example", labelKey: "btn.review" })).toBeNull();
    // A navigation renders as a real link to its /app page (9.4 scenario 9: "Resume is a link in v1").
    expect(html(strip("en", { expanded: true }))).toMatch(/<a href="\/app\/templates"[^>]*data-notice-action="navigate"/);
    expect(intentFor(n, { kind: "open_eddy", ref: { kind: "notice", noticeId: "other" }, labelKey: "btn.explain" })).toEqual({ kind: "open_eddy", ref: { kind: "notice", noticeId: "n_7" } });
    expect(intentFor(n, { kind: "card", action: "enable_automation", labelKey: "btn.open" })).toEqual({ kind: "open_eddy", ref: { kind: "notice", noticeId: "n_7" } });
    // The open event carries the reference and no text (events.ts checks the same shape on both sides).
    expect(checkDetail(EDDY_EVENTS.open, { ref: { kind: "notice", noticeId: "n_7" } })).toEqual({ ref: { kind: "notice", noticeId: "n_7" } });
  });

  it("parses the GET response strictly: unsafe buttons and unknown shapes are dropped", () => {
    const parsed = parseNoticesResponse({
      notices: [
        { ...dto({ id: "n_1" }), actions: [{ kind: "navigate", path: "javascript:alert(1)", labelKey: "btn.open" }, { kind: "navigate", path: "/app/inbox", labelKey: "btn.open" }] },
        { id: "bad id", kind: "x", textKey: "notices.generic" },
      ],
      needsYou: 3,
      toasts: ["n_1", "not valid!"],
    })!;
    expect(parsed.notices.map((n) => n.id)).toEqual(["n_1"]);
    expect(parsed.notices[0].actions).toEqual([{ kind: "navigate", path: "/app/inbox", labelKey: "btn.open" }]);
    expect(parsed.needsYou).toBe(3);
    expect(parsed.toasts).toEqual(["n_1"]);
    expect(parseNoticesResponse(null)).toBeNull();
    expect(parseNotice({ ...dto(), createdAt: "not a date" })).toBeNull();
  });

  it("noticeText fills the catalogue text in each language; Phase 0's own rows show their sentence", () => {
    expect(noticeText("en", dto())).toBe("Meta approved your template `diwali_offer`. Want to send it?");
    expect(noticeText("hi", dto({ textKey: "notices.token_expired", payload: {} }))).toBe(tn("hi", "notices.token_expired"));
    expect(noticeText("hinglish", dto({ textKey: "notices.digest.ai", payload: { ai: 34, handoff: 5 } }))).toBe("Aaj AI agent ne 34 chats ka jawab diya aur 5 chats aapki team ko saunpi.");
    expect(noticeText("en", dto({ source: "spend", textKey: "notices.spend_fallback", payload: { title: "Spending request waiting", body: "Approve or decline it." } }))).toBe("Spending request waiting. Approve or decline it.");
    expect(noticeText("en", dto({ textKey: "no.such.key" }))).toBe("Something needs a look.");
  });
});

describe("the notices store on the client (useNotices)", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    resetNoticesStore();
  });

  it("loads GET /api/notices, publishes the list and count, and shows one sticky toast per claimed notice", async () => {
    const warning = vi.spyOn(toast, "warning").mockImplementation(() => "toast-id");
    const fetchSpy = vi.fn(async (_url: string, _init?: RequestInit) => new Response(JSON.stringify({ notices: STRIP, needsYou: 3, toasts: ["n_a"] }), { status: 200 }));
    vi.stubGlobal("fetch", fetchSpy);
    const snap = await loadNotices();
    expect(fetchSpy.mock.calls[0][0]).toBe("/api/notices");
    expect(snap.notices.map((n) => n.id)).toEqual(["n_a", "n_b", "n_c", "n_d"]);
    expect(snap.needsYou).toBe(3);
    expect(warning).toHaveBeenCalledTimes(1);
    expect(warning.mock.calls[0][0]).toBe(tn("en", "notices.token_expired"));
    expect(warning.mock.calls[0][1]).toMatchObject({ key: "notice-n_a", duration: 0 });
    expect(showNoticeToasts(STRIP, ["n_c"], "en")).toBe(0);
  });

  it("a failed load keeps the last good list; dismiss leaves the list at once and comes back if the server refuses", async () => {
    resetNoticesStore({ notices: STRIP, needsYou: 3, loadedAt: 1 });
    vi.stubGlobal("fetch", vi.fn(async () => new Response("nope", { status: 500 })));
    expect((await loadNotices()).notices).toHaveLength(4);
    expect(readNoticesSnapshot().error).toBe(true);
    const patches: { url: string; body: string }[] = [];
    vi.stubGlobal("fetch", vi.fn(async (url: string, init?: RequestInit) => (patches.push({ url, body: String(init?.body) }), new Response("{}", { status: 200 }))));
    expect(await patchNotice("n_b", { dismissed: true })).toBe(true);
    expect(patches).toEqual([{ url: "/api/notices/n_b", body: '{"dismissed":true}' }]);
    expect(readNoticesSnapshot().notices.map((n) => n.id)).toEqual(["n_a", "n_c", "n_d"]);
    vi.stubGlobal("fetch", vi.fn(async () => new Response("{}", { status: 404 })));
    expect(await patchNotice("n_a", { mute: true })).toBe(false);
    expect(readNoticesSnapshot().notices.map((n) => n.id)).toEqual(["n_a", "n_c", "n_d"]);
    expect(await patchNotice("bad id!", { seen: true })).toBe(false);
  });
});

const ITEMS: ActivityItemDTO[] = [
  { kind: "ai_agent", id: "ag_1", name: "Support helper", enabled: true, last24h: 34, waiting: 5, settingsPath: "/app/automation/ai-agent" },
  { kind: "rule", id: "r_1", name: "Welcome", enabled: false, last24h: 0, waiting: 0, settingsPath: "/app/automation/rules/r_1" },
];
const activityView = (lang: EddyLang, over: Partial<Parameters<typeof TeamActivityView>[0]> = {}) =>
  h(TeamActivityView, { lang, state: "ready", items: ITEMS, canManage: true, eddyReady: true, onTurnOff: noop, onTurnOn: noop, onNavigate: noop, onRetry: noop, onClose: noop, ...over });

describe("Menu > Team activity", () => {
  it.each(EDDY_LANGS)("one card per automation with on/off, 24 hours, waiting and Settings (%s, light and dark, phone width)", (lang) => {
    const { light, dark } = inThemes(activityView(lang));
    expect(light).toBe(dark);
    expect(themeProblems(light)).toEqual([]);
    expect(phoneProblems(light)).toEqual([]);
    expect((light.match(/data-activity-kind=/g) ?? []).length).toBe(2);
    const text = textOf(light);
    expect(text).toContain(tn(lang, "notices.activity.title"));
    expect(text).toContain(tn(lang, "notices.activity.last24h", { count: 34 }));
    expect(text).toContain(tn(lang, "notices.activity.waiting", { count: 5 }));
    expect(text).toContain(tn(lang, "notices.activity.turn_off"));
    expect(text).toContain(tn(lang, "notices.activity.turn_on"));
    expect(light).toContain(`aria-label="${tn(lang, "notices.activity.settings.a11y", { name: "Welcome" })}"`);
    expect(light).toMatch(/role="status" aria-live="polite"/);
    expect(light).toContain("rounded-card border border-border bg-raised shadow-raised");
  });

  it("members see no switches; Turn on needs Eddy ready; loading and error states", () => {
    const member = textOf(html(activityView("en", { canManage: false })));
    expect(member).not.toContain("Turn off");
    expect(member).not.toContain("Turn on with Eddy");
    expect(member).toContain("Only admins and the owner can turn automations on or off.");
    expect(textOf(html(activityView("en", { eddyReady: false })))).not.toContain("Turn on with Eddy");
    expect(html(activityView("en", { state: "loading" }))).toContain('role="status"');
    expect(textOf(html(activityView("en", { state: "error" })))).toContain("Team activity couldn't be loaded.");
    expect(textOf(html(activityView("en", { items: [] })))).toContain("Nothing runs automatically yet.");
  });

  it("turning on asks Eddy by kind and id only, never with the automation's own text; the response is parsed strictly", () => {
    const q = turnOnQuery("en", { kind: "rule", id: "r_1" });
    expect(q).toBe("Turn on this automation: rule r_1");
    expect(q).not.toContain("Welcome");
    const parsed = parseActivity({ activity: [{ ...ITEMS[0], settingsPath: "https://evil.example" }, { kind: "webhook", id: "w" }], canManage: true })!;
    expect(parsed.items).toHaveLength(1);
    expect(parsed.items[0].settingsPath).toBe("/app/automation");
    expect(parsed.canManage).toBe(true);
  });
});

const STATUS: EddyStatusDTO = {
  state: "ready",
  readOnly: false,
  canEnable: false,
  ownerNames: ["Anshu"],
  allowance: { usedToday: 40, limitToday: null, usedMonth: 120, limitMonth: 500, resetsOn: null, memberUsedToday: 12, memberLimitToday: 40 },
  langPref: "auto",
  needsYou: 0,
  demo: false,
  whatsapp: "connected",
  phase: 1,
  firstUse: false,
  spendingStopped: false,
} as EddyStatusDTO;

describe("Menu > My usage and Language", () => {
  it.each(EDDY_LANGS)("My usage reads '12 credits used today' with a meter (%s, light and dark)", (lang) => {
    const { light, dark } = inThemes(h(UsageMeter, { lang, status: STATUS, onClose: noop }));
    expect(light).toBe(dark);
    expect(themeProblems(light)).toEqual([]);
    expect(phoneProblems(light)).toEqual([]);
    expect(textOf(light)).toContain(tn(lang, "notices.usage.today", { used: "12" }));
    expect(light).toContain('role="progressbar"');
    expect(light).toContain('aria-valuenow="12"');
    expect(light).toContain('aria-valuemax="40"');
  });

  it("usage figures, and the loading line before the status arrives", () => {
    expect(usageFigures("en", STATUS)).toMatchObject({ today: "12 credits used today", meterValue: "12 of 40", month: "This workspace has used 120 of 500 AI credits this month." });
    expect(usageFigures("en", null)).toBeNull();
    expect(textOf(html(h(UsageMeter, { lang: "en", status: null })))).toContain("Loading Eddy…");
  });

  it("Language is a labelled radio group; each language names itself in its own script", () => {
    const { light, dark } = inThemes(h(LanguagePicker, { lang: "en", value: "hi", onPick: noop, onClose: noop }));
    expect(light).toBe(dark);
    expect(themeProblems(light)).toEqual([]);
    expect(light).toContain("<fieldset");
    expect(light).toContain("<legend");
    expect((light.match(/type="radio"/g) ?? []).length).toBe(4);
    expect(light).toMatch(/checked="" value="hi"/);
    expect(light).toContain('<span lang="hi">हिंदी</span>');
    expect(light).toContain('<span lang="hi-Latn">Hinglish</span>');
    expect(optionLabel("hi", LANG_OPTIONS[0])).toBe("मेरे मैसेज जैसी");
  });
});

describe("these files: tokens only, no inner HTML, no Meta host, no user actor, mounted from the panel", () => {
  const FILES = ["NoticeList.tsx", "useNotices.ts", "TeamActivity.tsx", "UsageMeter.tsx", "LanguagePicker.tsx", "EddyPanel.tsx"].map((f) => `src/components/eddy/${f}`);
  it.each(FILES)("%s", (file) => {
    const src = readFileSync(path.resolve(__dirname, "..", file), "utf8");
    expect(src).not.toMatch(/\bdark:/);
    expect(src.match(/#[0-9a-fA-F]{3,8}\b/g) ?? []).toEqual([]);
    expect(src).not.toMatch(/\bz-(\d+|\[)/);
    expect(src).not.toContain("dangerouslySetInnerHTML");
    expect(src).not.toMatch(/facebook\.com|business\.facebook|meta\.com|fb\.me/i);
    expect(src).not.toMatch(/\btype\s*:\s*["']user["']/);
  });

  it("the panel menu opens Team activity, My usage and Language as views; the strip shows in every state; EddyRoot polls", () => {
    const panel = readFileSync(path.resolve(__dirname, "../src/components/eddy/EddyPanel.tsx"), "utf8");
    expect(panel).toContain('onClick={() => setView("team")}');
    expect(panel).toMatch(/view === "team" && \(\s*<TeamActivity/);
    expect(panel).toContain('view === "usage" && <UsageMeter');
    expect(panel).toContain('view === "language" && <LanguagePicker');
    expect(panel).toContain("<NoticeList lang={c.lang} onNavigate={c.navigate} />");
    const root = readFileSync(path.resolve(__dirname, "../src/components/eddy/EddyRoot.tsx"), "utf8");
    expect(root).toContain("useNoticesPoller(open);");
  });

  it("the notice copy never puts text from a notice into a member message: notice buttons hold catalogue label keys only", () => {
    for (const n of STRIP) for (const a of n.actions) expect(hasKey(a.labelKey), a.labelKey).toBe(true);
  });
});
