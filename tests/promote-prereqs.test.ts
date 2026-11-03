import { readFileSync } from "node:fs";
import path from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * docs/IG-PAGE-ADS-SPEC.md 3.1a, 3.2, 3.6, 8.3, 8.3a, 8.4 and PRM-07 acceptance 2, 7 and 8 (promote-prereqs): every readiness row
 * of every goal is ok, missing or unknown with exactly one fix; owners and admins get different fixes; the currency row, the
 * Instagram-to-Page row and the 8.3a states have copy in three languages; the pixel row's fix is in Edwyz; the V-P4, V-P11 and
 * V-P12 rows warn but never block; and the two-way check between every Opens Meta fix (prereqs.ts, review-reasons.ts and the
 * copy) and the meta-screens.ts allowlist. Also the routes: GET /api/promote/prereqs and POST
 * /api/promote/fix/instagram-identity (C8 once per Page, then discovery again). No network, no database.
 */
const h = vi.hoisted(() => ({
  getActor: vi.fn(),
  db: {
    metaConnection: { findMany: vi.fn(), findFirst: vi.fn() },
    metaAsset: { findMany: vi.fn(), findFirst: vi.fn(), updateMany: vi.fn() },
    spendControl: { findUnique: vi.fn() },
    spendAllowance: { findUnique: vi.fn() },
    phoneNumber: { count: vi.fn() },
    platformSetting: { findUnique: vi.fn() },
    membership: { findFirst: vi.fn() },
    user: { findUnique: vi.fn() },
    auditLog: { create: vi.fn() },
    $executeRaw: vi.fn(),
  },
  meta: { getPixel: vi.fn(), createPixel: vi.fn(), listPageBackedInstagram: vi.fn(), createPageBackedInstagram: vi.fn() },
}));
vi.mock("@/lib/auth", () => ({ getActor: (...a: unknown[]) => h.getActor(...a) }));
vi.mock("@/lib/db", () => ({ prisma: h.db }));
vi.mock("@/lib/promote/meta", () => ({ promoteMeta: h.meta }));

import { ensurePageBackedInstagram, INSTAGRAM_IDENTITY_COPY } from "@/lib/meta-connect/service";
import { META_SCREENS, metaScreenHref, metaScreensTagged } from "@/lib/meta-connect/meta-screens";
import { goalRow, GOALS } from "@/lib/promote/catalog/goals";
import { PROMOTE_COPY, promoteText, type PromoteCopyKey } from "@/lib/promote/copy";
import {
  checksFor,
  copyText,
  evaluatePrereqs,
  IG_STATES,
  PREREQ_OPENS_META,
  prereqsReady,
  WARNING_ONLY,
  type PrereqFacts,
  type PrereqFix,
  type PrereqRow,
} from "@/lib/promote/prereqs";
import { explainReviewFeedback, META_ERRORS, REVIEW_REASONS } from "@/lib/promote/review-reasons";
import { GOAL_KEYS, PROMOTE_LANGS, READINESS_CHECKS, type GoalKey, type MetaScreenKey, type PromoteLang } from "@/lib/promote/types";

const ROOT = path.resolve(__dirname, "..");

const OK: PrereqFacts = {
  role: "owner",
  ownerName: "Asha",
  facebookConnected: true,
  spendingAccount: { assetId: "acc", externalId: "act_123", name: "Shop ads", currency: "INR", accountStatus: 1, disableReason: 0, fundingPresent: true, customAudienceTos: true, userTosAccepted: true },
  adsLimit: { currency: "INR", dailyLimitMinor: 200_000n },
  page: { assetId: "pg", externalId: "111", name: "Shop", canAdvertise: true, leadgenTosAccepted: true, whatsappLinkState: "ok" },
  instagram: { assetId: "ig", externalId: "222", username: "shop", pageId: "111", pageBacked: false, profilePictureUrl: "https://cdn.example/ig.jpg", authorizedAdAccountIds: ["act_123"] },
  instagramPage: null,
  whatsappConnected: true,
  pixel: { state: "ok", pixel: { assetId: "ds", externalId: "999", name: "Pixel", lastFiredAt: "2026-10-30T10:00:00+0000" } },
  settings: { privacyUrl: "https://shop.example/privacy", shop: true },
  leadAccess: "ok",
};
const NOTHING: PrereqFacts = {
  ...OK,
  role: "admin",
  facebookConnected: false,
  spendingAccount: null,
  adsLimit: null,
  page: null,
  instagram: null,
  whatsappConnected: false,
  pixel: { state: "none" },
  settings: { privacyUrl: null, shop: false },
  leadAccess: "missing",
};
const with_ = (over: Partial<PrereqFacts>): PrereqFacts => ({ ...OK, ...over });
const rowOf = (rows: PrereqRow[], check: string) => rows.find((r) => r.check === check)!;
const every = { nearShop: true, customAudience: true, websiteAudience: true } as const;

describe("every 3.2 row for each goal: ok, missing or unknown, with exactly one fix", () => {
  it.each(GOAL_KEYS.map((g) => [g] as const))("%s", (goal) => {
    for (const facts of [OK, NOTHING, with_({ role: "admin" })]) {
      for (const placements of ["auto", "instagram", "facebook"] as const) {
        const rows = evaluatePrereqs(facts, { goal, placements, ...every });
        expect(rows.map((r) => r.check)).toEqual(checksFor({ goal, placements, ...every }).checks);
        for (const r of rows) {
          expect(["ok", "missing", "unknown"], r.check).toContain(r.status);
          expect(r.fix, r.check).toBeTruthy();
          expect(["opens_meta", "reconnect", "in_app", "settings", "ask_owner"], r.check).toContain(r.fix.kind);
          expect(r.fix.label.length, r.check).toBeGreaterThan(2);
          expect(r.fix.label, r.check).not.toMatch(/\{\w+\}/);
          expect(r.label, r.check).toBe(promoteText(`readiness.${r.check}` as PromoteCopyKey));
          expect(r.blocks).toBe(r.status === "missing" && !r.warningOnly);
        }
      }
    }
    // With everything in place nothing blocks; only the unverified Instagram messages row stays a warning.
    const ok = evaluatePrereqs(OK, { goal, ...every });
    expect(ok.filter((r) => r.status !== "ok").map((r) => r.check).filter((c) => c !== "instagram_messages_access")).toEqual([]);
    expect(prereqsReady(ok)).toBe(true);
    expect(prereqsReady(evaluatePrereqs(NOTHING, { goal }))).toBe(false);
  });

  it("each goal shows its catalog prerequisites; Instagram rows follow the placements; extras follow the draft", () => {
    for (const g of GOALS) for (const c of g.prerequisites) expect(checksFor({ goal: g.key }).checks).toContain(c);
    expect(checksFor({ goal: "engagement", placements: "facebook" }).checks).not.toContain("instagram_identity");
    expect(checksFor({ goal: "engagement" }).checks).toContain("instagram_identity");
    expect(checksFor({ goal: "engagement" }).instagramRequired).toBe(false);
    expect(checksFor({ goal: "engagement", placements: "instagram" }).instagramRequired).toBe(true);
    expect(checksFor({ goal: "instagram_dms", placements: "facebook" }).checks).toContain("instagram_identity");
    expect(checksFor({ goal: "lead_form" }).checks).toEqual(expect.arrayContaining(["leadgen_tos", "privacy_link", "lead_access"]));
    expect(checksFor({ goal: "website_sales" }).checks).toContain("pixel");
    expect(checksFor({ goal: "engagement", nearShop: true, customAudience: true }).checks).toEqual(expect.arrayContaining(["shop_location", "custom_audience_tos"]));
    // Every readiness check is reachable from some goal and options.
    const reachable = new Set(GOAL_KEYS.flatMap((goal) => checksFor({ goal, ...every }).checks));
    expect([...READINESS_CHECKS].filter((c) => !reachable.has(c))).toEqual([]);
  });
});

describe("owner and admin fixes differ", () => {
  it("the owner goes to Spending limits; an admin asks the owner by name", () => {
    const bad = { spendingAccount: null, adsLimit: { currency: "USD", dailyLimitMinor: null } };
    const owner = evaluatePrereqs(with_({ ...bad, role: "owner" }), { goal: "engagement" });
    const admin = evaluatePrereqs(with_({ ...bad, role: "admin" }), { goal: "engagement" });
    for (const check of ["spending_account", "daily_limit"]) {
      expect(rowOf(owner, check).fix).toMatchObject({ kind: "settings", key: "spending_limits", href: "/app/settings/spending" });
      expect(rowOf(admin, check).fix.kind).toBe("ask_owner");
      expect(rowOf(admin, check).fix.label).toContain("Asha");
    }
    expect(rowOf(owner, "spending_account").fix.label).toBe(promoteText("readiness.choose_account"));
    expect(rowOf(admin, "spending_account").fix.label).toBe(promoteText("readiness.ask_owner_account", { owner: "Asha" }));
    expect(rowOf(owner, "daily_limit").detail).toBe("Set a daily ads limit in Settings > Spending limits before starting ads.");
    const currencyOwner = evaluatePrereqs(with_({ role: "owner", adsLimit: { currency: "USD", dailyLimitMinor: 100n } }), { goal: "engagement" });
    const currencyAdmin = evaluatePrereqs(with_({ role: "admin", adsLimit: { currency: "USD", dailyLimitMinor: 100n } }), { goal: "engagement" });
    expect(rowOf(currencyOwner, "currency_match").fix.kind).toBe("settings");
    expect(rowOf(currencyAdmin, "currency_match").fix).toMatchObject({ kind: "ask_owner", label: promoteText("readiness.ask_owner", { owner: "Asha" }) });
  });
});

describe("the critic rows and the 8.3a states, in three languages", () => {
  it.each(PROMOTE_LANGS.map((l) => [l] as const))("currency mismatch, Instagram on another Page, and each 8.3a state (%s)", (lang) => {
    const text = (k: PromoteCopyKey, vars: Record<string, string> = {}) => promoteText(k, vars, lang);
    // Currency: the ads limits use another currency than the ad account.
    const currency = rowOf(evaluatePrereqs(with_({ adsLimit: { currency: "USD", dailyLimitMinor: 100n } }), { goal: "engagement", lang }), "currency_match");
    expect(currency).toMatchObject({ status: "missing", blocks: true, label: text("readiness.currency_match") });
    expect(rowOf(evaluatePrereqs(with_({ adsLimit: { currency: "inr", dailyLimitMinor: 1n } }), { goal: "engagement", lang }), "currency_match").status).toBe("ok");
    expect(rowOf(evaluatePrereqs(with_({ adsLimit: null }), { goal: "engagement", lang }), "currency_match").status).toBe("unknown");

    // Instagram connected to another Page: [Use {Page B}].
    const link = rowOf(
      evaluatePrereqs(with_({ instagram: { ...OK.instagram!, pageId: "999" }, instagramPage: { assetId: "pgB", name: "Shop Two" } }), { goal: "profile_visits", lang }),
      "instagram_page_link",
    );
    expect(link).toMatchObject({ status: "missing", igState: "other_page", detail: text("ig.state.other_page", { username: "shop", page: "Shop Two" }) });
    expect(link.fix).toEqual({ kind: "in_app", key: "use_page", label: text("ig.fix.use_page", { page: "Shop Two" }) });

    const state = (facts: Partial<PrereqFacts>, goal: GoalKey = "engagement") => rowOf(evaluatePrereqs(with_(facts), { goal, placements: "instagram", lang }), "instagram_identity");
    const none = state({ instagram: null });
    expect(none).toMatchObject({ status: "missing", igState: "no_account", detail: text("ig.state.no_account") });
    expect(none.fix).toEqual({ kind: "in_app", key: "create_instagram_identity", label: text("ig.fix.page_backed") });
    expect(none.more.map((m) => m.kind === "opens_meta" ? m.key : m.key)).toEqual(["link_instagram_to_page", "facebook_only"]);
    expect(state({ instagram: null, saysHasInstagram: true })).toMatchObject({ igState: "personal", detail: text("ig.state.personal"), fix: { kind: "reconnect" } });
    expect(state({ instagram: { ...OK.instagram!, pageBacked: true } })).toMatchObject({ status: "ok", igState: "ads_only", detail: text("ig.state.ads_only"), fix: { kind: "opens_meta", key: "link_instagram_to_page" } });
    expect(state({ instagram: { ...OK.instagram!, pageBacked: true } }, "instagram_dms").status).toBe("missing");
    expect(state({ instagram: { ...OK.instagram!, profilePictureUrl: null } })).toMatchObject({ igState: "no_picture", detail: text("ig.state.no_picture"), warningOnly: true, blocks: false });
    expect(state({ instagram: { ...OK.instagram!, restricted: true } })).toMatchObject({ igState: "restricted", detail: text("ig.state.restricted", { username: "shop" }), fix: { kind: "opens_meta", key: "account_quality" } });
    expect(state({ facebookConnected: false })).toMatchObject({ igState: "token_lost", detail: text("ig.state.token_lost", { username: "shop" }), fix: { kind: "reconnect" } });
    const notUsable = rowOf(evaluatePrereqs(with_({ instagram: { ...OK.instagram!, authorizedAdAccountIds: [] } }), { goal: "instagram_dms", lang }), "instagram_ad_account");
    expect(notUsable).toMatchObject({ status: "unknown", igState: "not_usable", warningOnly: true, blocks: false, detail: text("ig.state.not_usable", { username: "shop" }) });
    expect(notUsable.fix).toEqual({ kind: "reconnect", key: "connect_facebook", label: text("ig.fix.connect_both") });

    // Every 8.3a key exists in the three languages with the same placeholders, and no row leaves one unfilled.
    for (const k of Object.keys(PROMOTE_COPY.en).filter((k) => k.startsWith("ig.state."))) expect(PROMOTE_COPY[lang][k as PromoteCopyKey].length, k).toBeGreaterThan(5);
    for (const r of [currency, link, none, notUsable]) expect(`${r.label} ${r.detail ?? ""} ${r.fix.label}`).not.toMatch(/\{\w+\}/);
  });

  it("every Instagram row offers [Run on Facebook only] when the goal can run there, and none blocks a Facebook-only ad", () => {
    const rows = evaluatePrereqs(with_({ instagram: null }), { goal: "engagement" });
    for (const c of ["instagram_identity", "instagram_page_link", "instagram_ad_account"]) {
      expect(rowOf(rows, c).more.some((m) => m.kind === "in_app" && m.key === "facebook_only"), c).toBe(true);
      expect(rowOf(rows, c).blocks, c).toBe(false); // automatic placements: a warning, not a block
    }
    expect(evaluatePrereqs(with_({ instagram: null }), { goal: "engagement", placements: "facebook" }).some((r) => r.check.startsWith("instagram"))).toBe(false);
    expect(rowOf(evaluatePrereqs(with_({ instagram: null }), { goal: "engagement", placements: "instagram" }), "instagram_identity").blocks).toBe(true);
    expect(IG_STATES).toHaveLength(9);
  });

  it("V-P4, V-P11 and V-P12 rows are unknown warnings, never blocks", () => {
    expect([...WARNING_ONLY].sort()).toEqual(["instagram_ad_account", "instagram_messages_access", "whatsapp_page_link"]);
    const rows = evaluatePrereqs(with_({ page: { ...OK.page!, whatsappLinkState: null }, instagram: { ...OK.instagram!, authorizedAdAccountIds: null } }), { goal: "any_chat" });
    const wa = rowOf(rows, "whatsapp_page_link");
    expect(wa).toMatchObject({ status: "unknown", warningOnly: true, blocks: false, detail: promoteText("readiness.whatsapp_page_link.hint") });
    expect(wa.fix).toMatchObject({ kind: "opens_meta", key: "link_whatsapp_to_page" });
    expect(rowOf(evaluatePrereqs(with_({ page: { ...OK.page!, whatsappLinkState: "missing" } }), { goal: "whatsapp_chats" }), "whatsapp_page_link")).toMatchObject({ status: "missing", blocks: false });
    const dm = rowOf(evaluatePrereqs(OK, { goal: "instagram_dms" }), "instagram_messages_access");
    expect(dm).toMatchObject({ status: "unknown", warningOnly: true, blocks: false });
    expect(dm.fix.kind).toBe("in_app");
  });

  it("the ADVERTISE row offers the in-app reconnect first and page_advertise_task second", () => {
    const row = rowOf(evaluatePrereqs(with_({ page: { ...OK.page!, canAdvertise: false } }), { goal: "engagement" }), "page_advertise");
    expect(row).toMatchObject({ status: "missing", blocks: true });
    expect(row.fix).toEqual({ kind: "reconnect", key: "connect_facebook", label: promoteText("readiness.page_advertise.fix") });
    expect(row.more).toEqual([{ kind: "opens_meta", key: "page_advertise_task", label: promoteText("readiness.page_advertise.meta"), href: metaScreenHref("page_advertise_task", { pageId: "111" }) }]);
    expect(row.more[0].kind === "opens_meta" && row.more[0].href).toContain("111");
  });

  it("the pixel row: [Create a pixel] in Edwyz, the 7-day warning, and never Events Manager", () => {
    const pixel = (p: PrereqFacts["pixel"]) => rowOf(evaluatePrereqs(with_({ pixel: p }), { goal: "website_sales" }), "pixel");
    expect(pixel({ state: "none" })).toMatchObject({ status: "missing", fix: { kind: "in_app", key: "create_pixel", label: promoteText("readiness.pixel_create") }, detail: promoteText("readiness.pixel_install") });
    expect(pixel({ state: "stale", pixel: { assetId: "d", externalId: "9", name: null, lastFiredAt: null } })).toMatchObject({
      status: "missing",
      detail: "Your pixel hasn't seen a visit in 7 days. Check it's installed on your website.",
      fix: { kind: "in_app", key: "pixel_install_code", label: promoteText("readiness.copy_code") },
    });
    expect(pixel({ state: "unknown", pixel: { assetId: "d", externalId: "9", name: null } }).status).toBe("unknown");
    expect(pixel(OK.pixel).status).toBe("ok");
    expect(JSON.stringify(evaluatePrereqs(with_({ pixel: { state: "none" } }), { goal: "website_sales" }))).not.toContain("events_manager");
  });

  it("account health: a payment problem opens the payment screen, a restriction Account Quality, a business review verification", () => {
    const active = (s: number | null, reason: number | null = 0) => rowOf(evaluatePrereqs(with_({ spendingAccount: { ...OK.spendingAccount!, accountStatus: s, disableReason: reason } }), { goal: "engagement" }), "account_active");
    expect(active(3).fix).toMatchObject({ kind: "opens_meta", key: "payment_method" });
    expect(active(2, 1)).toMatchObject({ status: "missing", detail: promoteText("error.account_restricted", { account: "Shop ads" }), fix: { kind: "opens_meta", key: "account_quality" } });
    expect(active(2, 6).fix).toMatchObject({ kind: "opens_meta", key: "business_verification" });
    expect(active(null).status).toBe("unknown");
    expect(rowOf(evaluatePrereqs(with_({ spendingAccount: { ...OK.spendingAccount!, fundingPresent: false } }), { goal: "engagement" }), "payment_method")).toMatchObject({ status: "missing", fix: { key: "payment_method" } });
    const cat = rowOf(evaluatePrereqs(with_({ spendingAccount: { ...OK.spendingAccount!, userTosAccepted: false } }), { goal: "engagement", customAudience: true }), "custom_audience_tos");
    expect(cat).toMatchObject({ status: "missing", fix: { kind: "opens_meta", key: "custom_audience_tos", href: "https://business.facebook.com/ads/manage/customaudiences/tos/?act=123" } });
    const lead = rowOf(evaluatePrereqs(with_({ page: { ...OK.page!, leadgenTosAccepted: false } }), { goal: "lead_form" }), "leadgen_tos");
    expect(lead.fix).toMatchObject({ kind: "opens_meta", key: "leadgen_tos", href: "https://www.facebook.com/ads/leadgen/tos?page_id=111" });
    expect(lead.more).toEqual([{ kind: "in_app", key: "recheck_leadgen_terms", label: promoteText("readiness.leadgen_tos.done") }]);
  });

  it("copyText reads Eddy's catalogue for the keys Eddy owns, in each language", () => {
    for (const lang of PROMOTE_LANGS as readonly PromoteLang[]) {
      expect(copyText("btn.connect_whatsapp", {}, lang)).not.toBe("btn.connect_whatsapp");
      expect(copyText("meta.screen.payment_method", {}, lang)).not.toBe("meta.screen.payment_method");
    }
  });
});

describe("two-way check: Opens Meta fixes and the meta-screens.ts allowlist (3.2)", () => {
  /** Every Opens Meta key the checklist can produce, over many combinations of facts. */
  function prereqKeys(): Set<MetaScreenKey> {
    const keys = new Set<MetaScreenKey>();
    const variants: Partial<PrereqFacts>[] = [
      {},
      NOTHING,
      { spendingAccount: { ...OK.spendingAccount!, accountStatus: 3 } },
      { spendingAccount: { ...OK.spendingAccount!, accountStatus: 2, disableReason: 6 } },
      { spendingAccount: { ...OK.spendingAccount!, accountStatus: 2, disableReason: 1 } },
      { instagram: null },
      { instagram: { ...OK.instagram!, restricted: true } },
      { instagram: { ...OK.instagram!, pageBacked: true } },
      { page: { ...OK.page!, canAdvertise: false } },
    ];
    for (const v of variants)
      for (const goal of GOAL_KEYS)
        for (const r of evaluatePrereqs(with_(v), { goal, placements: "instagram", ...every }))
          for (const f of [r.fix, ...r.more] as PrereqFix[]) if (f.kind === "opens_meta") keys.add(f.key);
    return keys;
  }

  function reviewKeys(): Set<MetaScreenKey> {
    const keys = new Set<MetaScreenKey>();
    for (const row of Object.values(META_ERRORS)) for (const f of row.fixes) if (f.kind === "opens_meta") keys.add(f.key);
    for (const r of explainReviewFeedback({ global: Object.fromEntries(Object.keys(REVIEW_REASONS).map((k) => [k, "x"])) })) keys.add(r.opensMeta);
    return keys;
  }

  /** Copy keys that name a screen (opens_meta.<key> or meta_screen.<key>), apart from the button's label and sentence. */
  function copyKeys(): string[] {
    return Object.keys(PROMOTE_COPY.en)
      .map((k) => /^(?:opens_meta|meta_screen)\.(.+)$/.exec(k)?.[1])
      .filter((k): k is string => !!k && k !== "label" && k !== "sentence");
  }

  it("every Opens Meta fix in prereqs.ts, review-reasons.ts and the copy is a key in meta-screens.ts", () => {
    const allowed = Object.keys(META_SCREENS);
    for (const k of prereqKeys()) expect(allowed, `prereqs: ${k}`).toContain(k);
    for (const k of reviewKeys()) expect(allowed, `review-reasons: ${k}`).toContain(k);
    for (const k of copyKeys()) expect(allowed, `copy: ${k}`).toContain(k);
    for (const k of PREREQ_OPENS_META) expect(allowed).toContain(k);
    // The source's literal keys are the declared set, so PREREQ_OPENS_META can't drift from the code.
    const src = readFileSync(path.join(ROOT, "src/lib/promote/prereqs.ts"), "utf8");
    const literal = new Set([...src.matchAll(/opensMeta\("([a-z_]+)"\)/g)].map((m) => m[1]));
    expect([...literal].sort()).toEqual([...PREREQ_OPENS_META].sort());
    expect([...prereqKeys()].sort()).toEqual([...PREREQ_OPENS_META].sort());
  });

  it("every entry tagged promote is used by at least one of them", () => {
    const used = new Set<string>([...prereqKeys(), ...reviewKeys(), ...copyKeys()]);
    expect(metaScreensTagged("promote").filter((k) => !used.has(k))).toEqual([]);
    expect(metaScreensTagged("promote")).toHaveLength(10);
  });

  it("every Opens Meta fix carries the server-resolved address of its screen", () => {
    for (const goal of GOAL_KEYS)
      for (const r of evaluatePrereqs(with_({ spendingAccount: { ...OK.spendingAccount!, fundingPresent: false } }), { goal, ...every }))
        for (const f of [r.fix, ...r.more])
          if (f.kind === "opens_meta") {
            expect(f.href, `${goal} ${r.check}`).toBe(metaScreenHref(f.key, { pageId: "111", act: "123" }));
            expect(f.label).toBe(copyText(META_SCREENS[f.key].labelKey));
          }
  });
});

// =====================================================================================================================
// Routes
// =====================================================================================================================

const ORIGIN = "https://wa.edwyz.com";
const T = "tenant_1";
type Row = { id: string; type: string; externalId: string; name: string | null; meta: unknown; connectionId?: string; status?: string };
const ASSETS: Row[] = [
  { id: "pg", type: "page", externalId: "111", name: "Shop", meta: { canAdvertise: true, leadgenTosAccepted: false, whatsappLinkState: "ok" }, connectionId: "conn1", status: "active" },
  { id: "ig", type: "instagram", externalId: "222", name: "shop", meta: { pageId: "111", username: "shop", profilePictureUrl: "https://cdn.example/ig.jpg", authorizedAdAccountIds: ["act_123"] } },
  { id: "acc", type: "ad_account", externalId: "act_123", name: "Shop ads", meta: { currency: "INR", accountStatus: 1, fundingPresent: true } },
];

beforeEach(() => {
  process.env.SITE_URL = ORIGIN;
  process.env.PROMOTE_ENABLED = "on";
  delete process.env.SPEND_DRY_RUN;
  h.getActor.mockReset().mockResolvedValue({ userId: "u1", tenantId: T, role: "admin" });
  h.db.metaConnection.findMany.mockReset().mockResolvedValue([{ status: "active", tokenExpiresAt: null }]);
  h.db.metaConnection.findFirst.mockReset().mockResolvedValue(null);
  h.db.metaAsset.findMany.mockReset().mockImplementation(async (a: { where: { type?: unknown } }) => {
    const types = (a.where.type as { in?: string[] } | string | undefined) ?? undefined;
    const want = typeof types === "string" ? [types] : (types?.in ?? null);
    return ASSETS.filter((r) => !want || want.includes(r.type));
  });
  h.db.metaAsset.findFirst.mockReset().mockImplementation(async (a: { where: { id?: string; type?: string } }) => ASSETS.find((r) => r.id === a.where.id && (!a.where.type || r.type === a.where.type)) ?? null);
  h.db.metaAsset.updateMany.mockReset().mockResolvedValue({ count: 1 });
  h.db.spendControl.findUnique.mockReset().mockResolvedValue({ spendingAdAccountAssetId: "acc" });
  h.db.spendAllowance.findUnique.mockReset().mockResolvedValue({ currency: "INR", dailyLimitMinor: 200_000n });
  h.db.phoneNumber.count.mockReset().mockResolvedValue(1);
  h.db.platformSetting.findUnique.mockReset().mockResolvedValue({ value: { privacyUrl: "https://shop.example/privacy" } });
  h.db.membership.findFirst.mockReset().mockResolvedValue({ user: { name: "Asha" } });
  h.db.auditLog.create.mockReset().mockResolvedValue({});
  h.db.$executeRaw.mockReset().mockResolvedValue(1);
  for (const fn of Object.values(h.meta)) fn.mockReset();
});

/** The JSON merges written into MetaAsset.meta: [patch, times, tenantId, connectionId, type, externalId]. */
const merges = () =>
  h.db.$executeRaw.mock.calls
    .filter((c) => Array.isArray(c[0]) && (c[0] as string[]).join("?").includes('UPDATE "MetaAsset"'))
    .map((c) => ({ values: JSON.parse(c[1] as string), times: JSON.parse(c[2] as string), tenantId: c[3], connectionId: c[4], type: c[5], externalId: c[6] }));
/** The Page-backed identities stored as Instagram assets (discovery.ts storePageBackedIdentity). */
const inserts = () =>
  h.db.$executeRaw.mock.calls
    .filter((c) => Array.isArray(c[0]) && (c[0] as string[]).join("?").includes('INSERT INTO "MetaAsset"'))
    .map((c) => ({ sql: (c[0] as string[]).join("?"), params: c.slice(1) as unknown[] }));

describe("GET /api/promote/prereqs", () => {
  const get = (query: string, headers: Record<string, string> = {}) => new Request(`${ORIGIN}/api/promote/prereqs${query}`, { headers });

  it("answers an admin with the goal's rows from the stored discovery blocks, and whether Start may go ahead", async () => {
    const { GET } = await import("@/app/api/promote/prereqs/route");
    const res = await GET(get("?goal=lead_form"), undefined);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { goal: string; rows: PrereqRow[]; ready: boolean; identity: { pageAssetId: string; igAssetId: string } };
    expect(body.goal).toBe("lead_form");
    expect(body.rows.map((r) => r.check)).toEqual(checksFor({ goal: "lead_form" }).checks);
    expect(rowOf(body.rows, "leadgen_tos")).toMatchObject({ status: "missing", blocks: true, fix: { kind: "opens_meta", href: "https://www.facebook.com/ads/leadgen/tos?page_id=111" } });
    expect(rowOf(body.rows, "privacy_link").status).toBe("ok");
    expect(rowOf(body.rows, "spending_account").status).toBe("ok");
    expect(body.ready).toBe(false);
    expect(body.identity).toEqual({ pageAssetId: "pg", igAssetId: "ig" });
    expect(h.db.metaAsset.findMany.mock.calls[0][0].where).toMatchObject({ tenantId: T, status: "active" });
  });

  it("reads the pixel (C7) only for a goal that needs it", async () => {
    const { GET } = await import("@/app/api/promote/prereqs/route");
    await GET(get("?goal=whatsapp_chats"), undefined);
    expect(h.meta.getPixel).not.toHaveBeenCalled();
    ASSETS.push({ id: "ds", type: "dataset", externalId: "999", name: "Pixel", meta: { adAccountId: "act_123" } });
    try {
      h.meta.getPixel.mockResolvedValue({ id: "999", name: "Pixel", lastFiredAt: new Date(Date.now() - 86_400_000).toISOString(), unavailable: false });
      const body = (await (await GET(get("?goal=website_sales"), undefined)).json()) as { rows: PrereqRow[] };
      expect(rowOf(body.rows, "pixel").status).toBe("ok");
      expect(h.meta.getPixel).toHaveBeenCalledWith({ tenantId: T, adAccountAssetId: "acc" }, "999");
    } finally {
      ASSETS.pop();
    }
  });

  it("is admin only, refuses cross-site requests, checks the goal, and is hidden while PROMOTE_ENABLED is off", async () => {
    const { GET } = await import("@/app/api/promote/prereqs/route");
    h.getActor.mockResolvedValueOnce({ userId: "u2", tenantId: T, role: "agent" });
    expect((await GET(get("?goal=engagement"), undefined)).status).toBe(403);
    expect((await GET(get("?goal=engagement", { origin: "https://evil.example" }), undefined)).status).toBe(403);
    expect((await GET(get("?goal=engagement", { "sec-fetch-site": "cross-site" }), undefined)).status).toBe(403);
    expect((await GET(get("?goal=nope"), undefined)).status).toBe(400);
    expect((await GET(get("?goal=engagement&placements=tiktok"), undefined)).status).toBe(400);
    expect((await GET(get("?goal=engagement&pageAssetId=unknown"), undefined)).status).toBe(404);
    process.env.PROMOTE_ENABLED = "off";
    expect((await GET(get("?goal=engagement"), undefined)).status).toBe(404);
  });
});

describe("Run Instagram ads using your Page (C8, PRM-07 acceptance 7)", () => {
  const actor = { userId: "u1", tenantId: T, role: "admin" as const };

  it("creates the ads-only identity once per Page, stores it on the Page, then refreshes discovery", async () => {
    const meta = { listPageBackedInstagram: vi.fn(async () => []), createPageBackedInstagram: vi.fn(async () => ({ id: "pbig1" })) };
    const refresh = vi.fn(async () => ({ counts: {} }));
    const r = await ensurePageBackedInstagram(actor, "pg", { meta, refresh });
    expect(r).toEqual({ instagramId: "pbig1", created: true, refreshed: true });
    expect(meta.createPageBackedInstagram).toHaveBeenCalledTimes(1);
    expect(meta.createPageBackedInstagram).toHaveBeenCalledWith({ tenantId: T, pageAssetId: "pg" });
    // Only the new keys (the id, and when it was made) and their time are merged into the Page's stored meta.
    const [saved] = merges();
    expect(saved).toMatchObject({ values: { pageBackedIgId: "pbig1" }, tenantId: T, connectionId: "conn1", type: "page", externalId: "111" });
    expect(Object.keys(saved.values).sort()).toEqual(["pageBackedCreatedAt", "pageBackedIgId"]);
    expect(Date.parse(saved.values.pageBackedCreatedAt)).toBeGreaterThan(Date.now() - 60_000);
    expect(Object.keys(saved.times)).toEqual(["pageBacked"]);
    expect(refresh).toHaveBeenCalledWith(actor, "conn1");
    expect(h.db.$executeRaw.mock.invocationCallOrder[0]).toBeLessThan(refresh.mock.invocationCallOrder[0]);
    expect(h.db.metaAsset.updateMany).not.toHaveBeenCalled();
    expect(h.db.auditLog.create.mock.calls[0][0].data.action).toBe("promote.instagram_identity_created");
  });

  it("stores the identity as a Page-backed Instagram asset at once, before the refresh, so readiness finds it even if the refresh's C3 never reaches the Page", async () => {
    const meta = { listPageBackedInstagram: vi.fn(async () => []), createPageBackedInstagram: vi.fn(async () => ({ id: "pbig1" })) };
    // A refresh that ran out of time before this Page's C3 (or whose C3 does not list the new id yet).
    const refresh = vi.fn(async () => ({ counts: {} }));
    await ensurePageBackedInstagram(actor, "pg", { meta, refresh });
    expect(inserts()).toHaveLength(1);
    const [{ sql, params }] = inserts();
    for (const part of [`p."status" = 'active'`, `c."status" <> 'revoked'`, `p."type" = 'page'`, `p."tokenEnc"`, "'instagram'", 'ON CONFLICT ("tenantId", "type", "externalId")']) expect(sql).toContain(part);
    expect(params).toEqual(expect.arrayContaining(["pbig1", "pg", T, "111", "Shop"]));
    const created = JSON.parse(params.find((v) => typeof v === "string" && v.includes('"checkedAt"')) as string);
    expect(created).toMatchObject({ pageId: "111", pageBacked: true, username: null, profilePictureUrl: null });
    // An existing row keeps the rest of its meta (C6's answer): only these keys are merged in.
    expect(JSON.parse(params.find((v) => typeof v === "string" && v.startsWith('{"pageId"') && !v.includes('"checkedAt"')) as string)).toEqual({ pageId: "111", pageBacked: true });
    const insertOrder = h.db.$executeRaw.mock.invocationCallOrder[h.db.$executeRaw.mock.calls.findIndex((c) => (c[0] as string[]).join("?").includes('INSERT INTO "MetaAsset"'))];
    expect(insertOrder).toBeLessThan(refresh.mock.invocationCallOrder[0]);

    // A reused identity (listed by C3) is stored too, under its username, without a "made at" time.
    h.db.$executeRaw.mockClear();
    const listed = { listPageBackedInstagram: vi.fn(async () => [{ id: "pbig9", username: "shop_ads" }]), createPageBackedInstagram: vi.fn(async () => ({ id: "new" })) };
    await ensurePageBackedInstagram(actor, "pg", { meta: listed, refresh });
    expect(merges().map((m) => m.values)).toEqual([{ pageBackedIgId: "pbig9" }]);
    expect(inserts()[0].params).toEqual(expect.arrayContaining(["pbig9", "shop_ads"]));
    // Dry run: nothing is stored.
    h.db.$executeRaw.mockClear();
    await ensurePageBackedInstagram(actor, "pg", { meta, refresh, dryRun: true });
    expect(h.db.$executeRaw).not.toHaveBeenCalled();
  });

  it("reuses a stored or listed identity instead of creating a second one, and shares one request between two taps", async () => {
    const meta = { listPageBackedInstagram: vi.fn(async () => [{ id: "pbig9", username: null }]), createPageBackedInstagram: vi.fn(async () => ({ id: "new" })) };
    const refresh = vi.fn(async () => ({}));
    const [a, b] = await Promise.all([ensurePageBackedInstagram(actor, "pg", { meta, refresh }), ensurePageBackedInstagram(actor, "pg", { meta, refresh })]);
    expect(a).toEqual({ instagramId: "pbig9", created: false, refreshed: true });
    expect(b).toBe(a);
    expect(meta.listPageBackedInstagram).toHaveBeenCalledTimes(1);
    expect(meta.createPageBackedInstagram).not.toHaveBeenCalled();
    const stored = ASSETS[0];
    ASSETS[0] = { ...stored, meta: { ...(stored.meta as object), pageBackedIgId: "pbig7" } };
    try {
      expect((await ensurePageBackedInstagram(actor, "pg", { meta, refresh })).instagramId).toBe("pbig7");
      expect(meta.listPageBackedInstagram).toHaveBeenCalledTimes(1);
    } finally {
      ASSETS[0] = stored;
    }
  });

  it("refuses a Page this login can't advertise for, and an unknown Page, before calling Meta; a failed refresh still keeps the id", async () => {
    const meta = { listPageBackedInstagram: vi.fn(async () => []), createPageBackedInstagram: vi.fn(async () => ({ id: "pbig1" })) };
    const stored = ASSETS[0];
    ASSETS[0] = { ...stored, meta: { canAdvertise: false } };
    try {
      await expect(ensurePageBackedInstagram(actor, "pg", { meta, refresh: vi.fn() })).rejects.toMatchObject({ status: 409, message: INSTAGRAM_IDENTITY_COPY.noAdvertise });
    } finally {
      ASSETS[0] = stored;
    }
    await expect(ensurePageBackedInstagram(actor, "nope", { meta, refresh: vi.fn() })).rejects.toMatchObject({ status: 404 });
    expect(meta.createPageBackedInstagram).not.toHaveBeenCalled();
    const r = await ensurePageBackedInstagram(actor, "pg", { meta, refresh: vi.fn(async () => Promise.reject(new Error("expired"))) });
    expect(r).toEqual({ instagramId: "pbig1", created: true, refreshed: false });
    expect(merges().map((m) => m.values)).toEqual([{ pageBackedIgId: "pbig1", pageBackedCreatedAt: expect.any(String) }]);
    expect(inserts()).toHaveLength(1);
  });

  it("POST /api/promote/fix/instagram-identity: admin only, same origin, C8 once, then the refresh", async () => {
    const { POST } = await import("@/app/api/promote/fix/instagram-identity/route");
    const post = (body: unknown, origin = ORIGIN) => new Request(`${ORIGIN}/api/promote/fix/instagram-identity`, { method: "POST", headers: { origin, "content-type": "application/json" }, body: JSON.stringify(body) });
    h.meta.listPageBackedInstagram.mockResolvedValue([]);
    h.meta.createPageBackedInstagram.mockResolvedValue({ id: "pbig1" });
    const res = await POST(post({ pageAssetId: "pg" }), undefined);
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ instagramId: "pbig1", created: true });
    expect(h.meta.createPageBackedInstagram).toHaveBeenCalledTimes(1);
    // The refresh looked up the Page's own connection (it isn't there in this fake, so the answer says refreshed: false).
    expect(h.db.metaConnection.findFirst).toHaveBeenCalledWith({ where: { id: "conn1", tenantId: T } });
    expect((await POST(post({ pageAssetId: "pg" }, "https://evil.example"), undefined)).status).toBe(403);
    h.getActor.mockResolvedValueOnce({ userId: "u2", tenantId: T, role: "agent" });
    expect((await POST(post({ pageAssetId: "pg" }), undefined)).status).toBe(403);
    expect((await POST(post([1]), undefined)).status).toBe(400);
    process.env.PROMOTE_ENABLED = "off";
    expect((await POST(post({ pageAssetId: "pg" }), undefined)).status).toBe(404);
    expect(h.meta.createPageBackedInstagram).toHaveBeenCalledTimes(1);
  });
});

describe("the catalog rows the checklist relies on", () => {
  it("every goal row has its copy and the readiness label of each of its checks", () => {
    for (const g of GOAL_KEYS) for (const c of goalRow(g).prerequisites) expect(PROMOTE_COPY.en[`readiness.${c}` as PromoteCopyKey], c).toBeTruthy();
  });
});
