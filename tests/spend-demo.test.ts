import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { FakeSpendDb } from "./helpers/fake-spend-db";

/*
 * The demo workspace (docs/SPEND-CONTROLS-SPEC.md 8.4): scripts/seed-demo.mjs marks its Meta assets meta.demo = true with a
 * placeholder token. isDemoAsset() keeps every Meta call away from them: no metacap read or write, no offboarding write, no
 * fast or structure sync. This file fails if any of those paths reaches the Graph transport or even asks for a token.
 */

const h = vi.hoisted(() => ({ db: null as unknown as FakeSpendDb, fetch: vi.fn(), access: vi.fn() }));

vi.mock("@/lib/db", async () => {
  const { createFakeSpendDb } = await import("./helpers/fake-spend-db");
  h.db = createFakeSpendDb();
  return { prisma: h.db.prisma };
});
vi.mock("@/lib/tenant-state", () => ({ tenantMayRunBackground: async () => true }));
vi.mock("@/lib/queue", () => ({ enqueue: async () => ({}) }));
vi.mock("@/lib/meta-connect", () => ({ getAssetAccess: (...a: unknown[]) => h.access(...a) }));

import { reserveAds, resetBookForTests, setMetaCapPreRead } from "@/lib/spend/book";
import { getMetaLimitDTO, turnOnMetaLimit } from "@/lib/spend/metacap/consent";
import { offboardAccount, offboardTenant } from "@/lib/spend/metacap/offboard";
import { ensureFreshRead, p0Stop, runMetacapPass, syncMetaCap } from "@/lib/spend/metacap/sync";
import { runFastSync, syncTenantFast } from "@/lib/spend/sync/fast-insights";
import { runStructureSync, syncStructure } from "@/lib/spend/sync/structure";

const NOW = new Date("2026-10-28T06:30:00Z");
const T = "t_demo";
const ENV = { SPEND_CAP_MODE: "enforce", SPEND_ENFORCE: "enforce" } as Record<string, string>;
const io = { env: ENV, notify: async () => undefined };

function seedDemo() {
  h.db.seed("tenant", [{ id: T, name: "Demo", slug: "demo", status: "active", deletedAt: null }]);
  h.db.seed("metaAsset", [{ id: "demo_acc", tenantId: T, connectionId: "demo_mc", type: "ad_account", externalId: "act_demo", name: "Demo ads", status: "active", meta: { currency: "INR", timezone: "Asia/Kolkata", demo: true }, sandbox: false }]);
  h.db.seed("spendControl", [{ tenantId: T, probation: "lifted", spendingAdAccountAssetId: "demo_acc", timezone: "Asia/Kolkata" }]);
  h.db.seed("spendAllowance", [{ id: "sa_demo", tenantId: T, pot: "ads", currency: "INR", dailyLimitMinor: 200_000n, monthlyLimitMinor: 2_000_000n }]);
  h.db.seed("adCampaign", [{ id: "dc1", tenantId: T, adAccountAssetId: "demo_acc", metaCampaignId: "m_demo", name: "Sample campaign", template: "lead_generation", objective: "OUTCOME_LEADS", status: "active", dailyBudgetMinor: 50_000, currency: "INR", origin: "human", endsAt: null, lifetimeBudgetMinor: null, sandbox: false, updatedAt: NOW }]);
  h.db.seed("adSet", [{ id: "dc1s", tenantId: T, campaignId: "dc1", metaAdSetId: "m_demo_s", name: "Sample set", status: "active", targeting: {}, dailyBudgetMinor: 50_000 }]);
  h.db.seed("spendCommitment", [{ id: "dcm", tenantId: T, adAccountAssetId: "demo_acc", campaignId: "dc1", adSetId: "dc1s", metaObjectId: "m_demo_s", objectLevel: "adset", origin: "human", currency: "INR", timezone: "Asia/Kolkata", dailyBudgetMinor: 50_000n, status: "live" }]);
  // Even a managed-looking row (seeded or left over) is never read or written.
  h.db.seed("metaSpendLimit", [
    { adAccountAssetId: "demo_acc", tenantId: T, accountExternalId: "act_demo", mode: "managed", unitMode: "major_write", semantics: "cumulative", managedCapMinor: 2_000_000n, lastReadCapMinor: 2_000_000n, lastReadAmountSpentMinor: 0n, lastReadAt: new Date(NOW.getTime() - 86_400_000), lastWriteAt: new Date(NOW.getTime() - 2 * 86_400_000), pendingTargetMinor: 1n, deferredUntil: new Date(NOW.getTime() - 1), currency: "INR", monthKey: "2026-10", monthStartAmountSpentMinor: 0n, customerCapAtConsentMinor: 5_000_000n },
  ]);
}

beforeEach(() => {
  h.db.reset();
  h.fetch.mockReset();
  h.fetch.mockRejectedValue(new Error("no Graph call may be made for a demo asset"));
  h.access.mockReset();
  h.access.mockRejectedValue(new Error("no token may be asked for a demo asset"));
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(NOW);
  vi.stubGlobal("fetch", h.fetch);
  process.env.SPEND_CAP_MODE = "enforce";
  resetBookForTests();
});

afterEach(() => {
  expect(h.fetch).not.toHaveBeenCalled();
  expect(h.access).not.toHaveBeenCalled();
  vi.useRealTimers();
  vi.unstubAllGlobals();
  delete process.env.SPEND_CAP_MODE;
});

describe("no Graph call for an asset with meta.demo = true (8.4)", () => {
  it("metacap: the fresh read, a sync, a P0 stop and the scheduled pass", async () => {
    seedDemo();
    await ensureFreshRead(T, "demo_acc", 0, io);
    expect(await syncMetaCap(T, "demo_acc", io)).toMatchObject({ status: "skipped", reason: "demo" });
    expect(await p0Stop(T, "demo_acc", "kill", io)).toMatchObject({ status: "skipped", reason: "demo" });
    await runMetacapPass(io);
  });

  it("offboarding (remove, restore, the whole workspace) and the card", async () => {
    seedDemo();
    expect((await offboardAccount(T, "demo_acc", "remove", "turn_off", { type: "system", job: "test" }, io)).applied).toBe("not_needed");
    h.db.rows("metaSpendLimit")[0].mode = "managed";
    await offboardTenant(T, "erase", io);
    expect(await getMetaLimitDTO(T, "owner", io)).toMatchObject({ state: "demo", text: "Demo account: Meta's limit isn't used." });
  });

  it("consent is refused before any read", async () => {
    seedDemo();
    await expect(turnOnMetaLimit(T, { userId: "u", role: "owner" }, { agreed: true, textVersion: "meta-cap-v1" }, io)).rejects.toMatchObject({ code: "spend.demo" });
  });

  it("the fast sync and the structure sync", async () => {
    seedDemo();
    expect((await syncTenantFast(T, io)).accounts[0].status).toBe("demo");
    expect((await syncStructure(T, "demo_acc", io)).reason).toBe("demo");
    await runFastSync(io);
    await runStructureSync(io);
  });

  it("the Spend Book's pre-read before reserveAds (the raise itself is refused with spend.demo)", async () => {
    seedDemo();
    setMetaCapPreRead(undefined);
    await expect(reserveAds(T, { kind: "raise_budget", adSetId: "dc1s", metaAdSetId: "m_demo_s", toMinor: 60_000n }, { type: "user", userId: "u", role: "owner" }, { idempotencyKey: "d1", reason: "Test", env: ENV })).rejects.toMatchObject({ code: "spend.demo" });
  });
});
