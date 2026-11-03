import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Promote settings and member preferences (docs/IG-PAGE-ADS-SPEC.md 3.2, 3.5, 5.4, D13, 11.1a decision 2, PRM-10): the
 * PlatformSetting rows promote:settings:<tenantId> and promote:member-prefs:<tenantId>:<userId>. The privacy link is https only,
 * the shop's PIN code has 6 digits, and malformed stored rows read as not set. PlatformSetting is an in-memory map.
 */
const rows = vi.hoisted(() => new Map<string, unknown>());

vi.mock("@/lib/db", () => ({
  prisma: {
    platformSetting: {
      findUnique: vi.fn(async ({ where }: { where: { key: string } }) => (rows.has(where.key) ? { key: where.key, value: structuredClone(rows.get(where.key)) } : null)),
      upsert: vi.fn(async ({ where, create, update }: { where: { key: string }; create: { value: unknown }; update: { value: unknown } }) => {
        rows.set(where.key, structuredClone(rows.has(where.key) ? update.value : create.value));
        return { key: where.key, value: rows.get(where.key) };
      }),
    },
  },
}));

import {
  applySettingsPatch,
  EMPTY_SETTINGS,
  getMemberPrefs,
  getPromoteSettings,
  memberPrefsKey,
  parsePromoteSettings,
  privacyUrlProblem,
  PROMOTE_SETTINGS_COPY,
  setMemberPrefs,
  setPromoteSettings,
  settingsKey,
} from "@/lib/promote/settings";

const T = "t1";

async function refusal(promise: Promise<unknown>): Promise<{ status: number; message: string }> {
  try {
    await promise;
  } catch (error) {
    return { status: (error as { status: number }).status, message: (error as Error).message };
  }
  throw new Error("expected a refusal");
}

beforeEach(() => rows.clear());

describe("promote:settings:<tenantId>", () => {
  it("reads empty settings when none are saved, and stores under the workspace's key", async () => {
    expect(await getPromoteSettings(T)).toEqual({ privacyUrl: null, shop: null, welcome: { en: null, hi: null, hinglish: null }, preferredGoal: null });
    expect(settingsKey(T)).toBe("promote:settings:t1");
    await setPromoteSettings(T, { privacyUrl: "https://fakeshop.example/privacy" });
    expect([...rows.keys()]).toEqual(["promote:settings:t1"]);
  });

  it("refuses an http privacy URL and keeps the saved one; an https one is saved and null clears it", async () => {
    await setPromoteSettings(T, { privacyUrl: "https://fakeshop.example/privacy" });
    expect(await refusal(setPromoteSettings(T, { privacyUrl: "http://fakeshop.example/privacy" }))).toEqual({ status: 400, message: "The link must start with https://" });
    expect((await getPromoteSettings(T)).privacyUrl).toBe("https://fakeshop.example/privacy");
    for (const bad of ["fakeshop.example/privacy", "ftp://fakeshop.example/p", "https://user:pw@fakeshop.example/p", "https://localhost/p", `https://fakeshop.example/${"p".repeat(2_000)}`]) {
      expect(await refusal(setPromoteSettings(T, { privacyUrl: bad })), bad).toMatchObject({ status: 400 });
    }
    expect((await setPromoteSettings(T, { privacyUrl: "  https://FakeShop.example/Privacy  " })).privacyUrl).toBe("https://fakeshop.example/Privacy");
    expect((await setPromoteSettings(T, { privacyUrl: null })).privacyUrl).toBeNull();
  });

  it("explains a missing privacy link with the help text Meta needs", () => {
    expect(privacyUrlProblem(undefined)).toBe("Meta needs a link to your privacy policy. Edwyz can't host one for you.");
    expect(privacyUrlProblem("  ")).toBe(PROMOTE_SETTINGS_COPY.privacyMissing);
    expect(privacyUrlProblem("http://fakeshop.example")).toBe(PROMOTE_SETTINGS_COPY.privacyHttps);
    expect(privacyUrlProblem("https://fakeshop.example/privacy")).toBeNull();
  });

  it("the shop pincode must be 6 digits; a map point must be on the map; a pincode or a map point is needed", async () => {
    for (const pincode of ["41100", "4110011", "011001", "41100a", "PIN411"]) {
      expect(await refusal(setPromoteSettings(T, { shop: { pincode } })), pincode).toEqual({ status: 400, message: "Enter a 6-digit PIN code." });
    }
    expect((await setPromoteSettings(T, { shop: { pincode: "411 001", label: "Main shop" } })).shop).toEqual({ lat: null, lng: null, label: "Main shop", pincode: "411001" });
    expect((await setPromoteSettings(T, { shop: { pincode: 560001 } })).shop?.pincode).toBe("560001");
    expect((await setPromoteSettings(T, { shop: { lat: 18.52, lng: 73.86 } })).shop).toEqual({ lat: 18.52, lng: 73.86, label: null, pincode: null });
    expect(await refusal(setPromoteSettings(T, { shop: { lat: 91, lng: 73 } }))).toEqual({ status: 400, message: PROMOTE_SETTINGS_COPY.coordinates });
    expect(await refusal(setPromoteSettings(T, { shop: { lat: 18.5 } }))).toEqual({ status: 400, message: PROMOTE_SETTINGS_COPY.coordinates });
    expect(await refusal(setPromoteSettings(T, { shop: { label: "Shop" } }))).toEqual({ status: 400, message: PROMOTE_SETTINGS_COPY.shopEmpty });
    expect(await refusal(setPromoteSettings(T, { shop: { pincode: "411001", label: "x".repeat(101) } }))).toEqual({ status: 400, message: PROMOTE_SETTINGS_COPY.shopLabel });
    expect((await setPromoteSettings(T, { shop: null })).shop).toBeNull();
  });

  it("saves welcome messages per language and the preferred goal; keys left out keep their saved value", async () => {
    await setPromoteSettings(T, { privacyUrl: "https://fakeshop.example/privacy", welcome: { en: "Hi! How can we help?", hinglish: "Namaste! Kaise madad karein?" }, preferredGoal: "lead_form" });
    const after = await setPromoteSettings(T, { welcome: { hi: "नमस्ते!" } });
    expect(after).toEqual({
      privacyUrl: "https://fakeshop.example/privacy",
      shop: null,
      welcome: { en: "Hi! How can we help?", hi: "नमस्ते!", hinglish: "Namaste! Kaise madad karein?" },
      preferredGoal: "lead_form",
    });
    expect(await refusal(setPromoteSettings(T, { welcome: { en: "x".repeat(1_001) } }))).toEqual({ status: 400, message: PROMOTE_SETTINGS_COPY.welcome });
    expect(await refusal(setPromoteSettings(T, { preferredGoal: "go_viral" }))).toEqual({ status: 400, message: PROMOTE_SETTINGS_COPY.goal });
    expect(await refusal(setPromoteSettings(T, "privacy"))).toEqual({ status: 400, message: PROMOTE_SETTINGS_COPY.notObject });
    expect((await setPromoteSettings(T, { preferredGoal: null })).preferredGoal).toBeNull();
  });

  it("reads a malformed stored row as not set, field by field", () => {
    expect(parsePromoteSettings(null)).toEqual(EMPTY_SETTINGS);
    expect(parsePromoteSettings({ privacyUrl: "http://x.example", shop: { pincode: "12" }, welcome: { en: 5, hi: "ok" }, preferredGoal: "nope" })).toEqual({
      privacyUrl: null,
      shop: null,
      welcome: { en: null, hi: "ok", hinglish: null },
      preferredGoal: null,
    });
    expect(applySettingsPatch(EMPTY_SETTINGS, {})).toEqual(EMPTY_SETTINGS);
  });
});

describe("promote:member-prefs:<tenantId>:<userId>", () => {
  it("member prefs round-trip, per member, defaulting to off", async () => {
    expect(await getMemberPrefs(T, "u1")).toEqual({ showAllOptions: false });
    expect(await setMemberPrefs(T, "u1", { showAllOptions: true })).toEqual({ showAllOptions: true });
    expect(await getMemberPrefs(T, "u1")).toEqual({ showAllOptions: true });
    expect(await getMemberPrefs(T, "u2")).toEqual({ showAllOptions: false });
    expect(rows.get(memberPrefsKey(T, "u1"))).toEqual({ showAllOptions: true });
    expect(memberPrefsKey(T, "u1")).toBe("promote:member-prefs:t1:u1");
    expect(await setMemberPrefs(T, "u1", {})).toEqual({ showAllOptions: true });
    expect(await setMemberPrefs(T, "u1", { showAllOptions: false })).toEqual({ showAllOptions: false });
    expect(await refusal(setMemberPrefs(T, "u1", { showAllOptions: "yes" }))).toEqual({ status: 400, message: PROMOTE_SETTINGS_COPY.showAllOptions });
  });
});
