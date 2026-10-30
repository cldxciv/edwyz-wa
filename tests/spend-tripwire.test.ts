import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/crypto/tokens", () => ({ getAccessToken: vi.fn(async () => "SECRET-TOKEN-123") }));

import { graphFetch, graphFetchAs, graphUpload } from "@/lib/graph";
import { classify } from "@/lib/spend/classify";
import { SpendGuardBypassError } from "@/lib/spend/errors";
import { mintPermit, permitUses, runWithPermit } from "@/lib/spend/permit";
import { permitCovers, setTripwireAuditSink, tripwire, type TripwireAuditEvent, type TripwireVia } from "@/lib/spend/tripwire";
import type { AdsPermitData, CreatePermitData, LoweringPermitData, MetaCapPermitData, MsgPermitData, SpendPermit } from "@/lib/spend/types";

/** docs/SPEND-CONTROLS-SPEC.md 4.7 and 10.1 (spend-tripwire.test.ts). Both modes; enforce throws before any fetch. */

const T = "tenant_1";
const ACT = "act_777";
const PHONE = "106540352242922";
const tenant: TripwireVia = { via: "tenant", tenantId: T };
const token: TripwireVia = { via: "token" };
const times = () => ({ issuedAt: new Date(Date.now() - 1000), expiresAt: new Date(Date.now() + 10 * 60_000) });

const adsPermit = (objects: AdsPermitData["objects"], over: Partial<AdsPermitData> = {}): SpendPermit =>
  mintPermit({ type: "ads", kind: "raise_budget", correlationId: "sc_ads", tenantId: T, adAccountAssetId: "asset_1", accountExternalId: ACT, objects, paths: Object.keys(objects), maxUses: 3, ...times(), ...over });
const createPermit = (over: Partial<CreatePermitData> = {}): SpendPermit =>
  mintPermit({ type: "create", correlationId: "sc_create", tenantId: T, adAccountExternalId: ACT, objectCount: 3, paths: [`${ACT}/campaigns`, `${ACT}/adsets`, `${ACT}/adcreatives`, `${ACT}/ads`], maxUses: 5, ...times(), ...over });
const msgPermit = (over: Partial<MsgPermitData> = {}): SpendPermit =>
  mintPermit({ type: "msg", correlationId: "msg:m1", tenantId: T, phoneNumberId: PHONE, paths: [[PHONE, "messages"].join("/")], maxUses: 1, ...times(), ...over });
const capPermit = (over: Partial<MetaCapPermitData> = {}): SpendPermit =>
  mintPermit({ type: "meta_cap", kind: "write", correlationId: "sc_cap", tenantId: T, adAccountAssetId: "asset_1", accountExternalId: ACT, capMinor: 123_456n, priority: "P1_lower", paths: [ACT], maxUses: 1, ...times(), ...over });
const lowerPermit = (kind: LoweringPermitData["kind"], id = "238500002", over: Partial<LoweringPermitData> = {}): SpendPermit =>
  mintPermit({
    type: "lowering",
    kind,
    correlationId: "sc_low",
    tenantId: T,
    metaObjectIds: [id],
    paths: [id],
    maxUses: 3,
    ...(kind === "cut_budget" ? { maxBudgetMinor: 50_000n } : {}),
    ...(kind === "end_earlier" ? { endsAt: new Date("2026-11-01T00:00:00Z") } : {}),
    ...times(),
    ...over,
  });

let events: TripwireAuditEvent[];
let fetchMock: ReturnType<typeof vi.fn>;

beforeEach(() => {
  events = [];
  setTripwireAuditSink((e) => void events.push(e));
  fetchMock = vi.fn(async () => new Response(JSON.stringify({ id: "1", messages: [{ id: "wamid.1" }], success: true }), { status: 200 }));
  vi.stubGlobal("fetch", fetchMock);
  vi.spyOn(console, "log").mockImplementation(() => undefined);
  vi.spyOn(console, "warn").mockImplementation(() => undefined);
  vi.spyOn(console, "error").mockImplementation(() => undefined);
});
afterEach(() => {
  setTripwireAuditSink(null);
  delete process.env.SPEND_TRIPWIRE;
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

const UNPERMITTED = [
  ["create a campaign", { method: "POST", path: `${ACT}/campaigns`, body: { name: "x", status: "PAUSED" } }, "act_{id}/campaigns"],
  ["turn an ad set on", { method: "POST", path: "238500002", body: { status: "ACTIVE" } }, "{id}"],
  ["write Meta's spending limit", { method: "POST", path: ACT, body: { spend_cap: "5000" } }, "act_{id}"],
  ["send a WhatsApp message", { method: "POST", path: `${PHONE}/messages`, body: { to: "919800000000", type: "text" } }, "{id}/messages"],
] as const;

describe("an unpermitted raising write (4.7)", () => {
  it.each(UNPERMITTED)("%s: enforce throws SpendGuardBypassError and audits it as blocked", (_name, call, pattern) => {
    let thrown: unknown;
    try {
      tripwire(call, tenant, { mode: "enforce", permit: undefined });
    } catch (e) {
      thrown = e;
    }
    expect(thrown).toBeInstanceOf(SpendGuardBypassError);
    expect(thrown).toMatchObject({ status: 500, code: "spend_bypass", reason: "no_permit" });
    expect(events).toEqual([{ action: "spend.tripwire.bypass", tenantId: T, target: pattern, meta: expect.objectContaining({ mode: "enforce", blocked: true, reason: "no_permit", via: "tenant" }) }]);
  });

  it.each(UNPERMITTED)("%s: report lets it through and audits the path pattern only", (_name, call, pattern) => {
    const outcome = tripwire(call, tenant, { mode: "report", permit: undefined });
    expect(outcome).toMatchObject({ action: "reported", reason: "no_permit" });
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ action: "spend.tripwire.bypass", target: pattern, meta: { blocked: false, mode: "report" } });
    const text = JSON.stringify(events);
    for (const leaked of ["238500002", "777", PHONE, "919800000000", "5000"]) expect(text).not.toContain(leaked);
  });

  it("report is the default mode (train 1 keeps today's behaviour)", () => {
    expect(tripwire(UNPERMITTED[1][1], tenant, { permit: undefined }).action).toBe("reported");
    process.env.SPEND_TRIPWIRE = "enforce";
    expect(() => tripwire(UNPERMITTED[1][1], tenant, { permit: undefined })).toThrow(SpendGuardBypassError);
  });

  it("not_spend requests pass untouched, without counting a permit use or auditing", () => {
    const p = msgPermit();
    expect(tripwire({ method: "GET", path: `${ACT}/insights` }, token, { mode: "enforce", permit: p })).toEqual({ action: "pass", class: "not_spend" });
    expect(tripwire({ method: "POST", path: `${PHONE}/media`, body: { messaging_product: "whatsapp" } }, tenant, { mode: "enforce", permit: undefined }).action).toBe("pass");
    expect(permitUses(p)).toBe(0);
    expect(events).toEqual([]);
  });
});

describe("permits must match exactly", () => {
  const enforce = (call: Parameters<typeof tripwire>[0], permit: unknown, ctx: TripwireVia = tenant) => () => tripwire(call, ctx, { mode: "enforce", permit });

  it("a permit for another path throws", () => {
    const p = adsPermit({ "111": { status: "ACTIVE" } });
    expect(enforce({ method: "POST", path: "222", body: { status: "ACTIVE" } }, p)).toThrow(expect.objectContaining({ reason: "wrong_path" }));
    expect(tripwire({ method: "POST", path: "111", body: { status: "ACTIVE" } }, tenant, { mode: "enforce", permit: p })).toMatchObject({ action: "permitted" });
  });

  it("a permit used past maxUses throws", () => {
    const p = msgPermit();
    const send = { method: "POST", path: `${PHONE}/messages`, body: { to: "1" } };
    expect(tripwire(send, tenant, { mode: "enforce", permit: p }).action).toBe("permitted");
    expect(enforce(send, p)).toThrow(expect.objectContaining({ reason: "used_up" }));
  });

  it("a budget above the permit's max throws; at or below it passes", () => {
    const p = adsPermit({ "111": { maxDailyMinor: 100_000n } });
    expect(enforce({ method: "POST", path: "111", body: { daily_budget: 100_001 } }, p)).toThrow(expect.objectContaining({ reason: "budget_over_permit" }));
    expect(tripwire({ method: "POST", path: "111", body: { daily_budget: "100000" } }, tenant, { mode: "enforce", permit: p }).action).toBe("permitted");
    expect(enforce({ method: "POST", path: "111", body: { lifetime_budget: 5 } }, p)).toThrow(expect.objectContaining({ reason: "budget_over_permit" }));
    expect(enforce({ method: "POST", path: "111", body: { daily_budget: "12.5" } }, p)).toThrow(SpendGuardBypassError);
  });

  it("turning on needs status ACTIVE in the permit; a later end needs the permitted end; other spend fields are never covered", () => {
    const endsAt = new Date("2026-11-30T00:00:00Z");
    const p = adsPermit({ "111": { maxDailyMinor: 1n }, "112": { status: "ACTIVE", endsAt } }, { maxUses: 10 });
    expect(enforce({ method: "POST", path: "111", body: { status: "ACTIVE" } }, p)).toThrow(expect.objectContaining({ reason: "status_not_permitted" }));
    expect(tripwire({ method: "POST", path: "112", body: { status: "ACTIVE" } }, tenant, { mode: "enforce", permit: p }).action).toBe("permitted");
    expect(tripwire({ method: "POST", path: "112", body: { end_time: "2026-11-29T00:00:00Z" } }, tenant, { mode: "enforce", permit: p }).action).toBe("permitted");
    expect(enforce({ method: "POST", path: "112", body: { end_time: "2026-12-01T00:00:00Z" } }, p)).toThrow(expect.objectContaining({ reason: "end_over_permit" }));
    expect(enforce({ method: "POST", path: "112", body: { bid_amount: 5 } }, p)).toThrow(expect.objectContaining({ reason: "field_not_permitted" }));
    expect(enforce({ method: "POST", path: "112", body: { status: "ACTIVE", is_adset_budget_sharing_enabled: true } }, p)).toThrow(expect.objectContaining({ reason: "field_not_permitted" }));
  });

  it("a create without PAUSED throws; creatives need the permit but no status (erratum 12.1b)", () => {
    const p = createPermit();
    expect(enforce({ method: "POST", path: `${ACT}/campaigns`, body: { name: "x", status: "ACTIVE" } }, p)).toThrow(expect.objectContaining({ reason: "not_paused" }));
    expect(enforce({ method: "POST", path: `${ACT}/adsets`, body: { name: "x" } }, p)).toThrow(expect.objectContaining({ reason: "not_paused" }));
    expect(enforce({ method: "POST", path: `${ACT}/ads`, query: { status: "ACTIVE" }, body: { name: "x", status: "PAUSED" } }, p)).toThrow(expect.objectContaining({ reason: "not_paused" }));
    expect(tripwire({ method: "POST", path: `${ACT}/campaigns`, body: { name: "x", status: "PAUSED" } }, token, { mode: "enforce", permit: p }).action).toBe("permitted");
    expect(tripwire({ method: "POST", path: `${ACT}/adcreatives`, body: { name: "c", object_story_spec: {} } }, token, { mode: "enforce", permit: p }).action).toBe("permitted");
    // The permit half: a creative create with no permit is a bypass.
    expect(enforce({ method: "POST", path: `${ACT}/adcreatives`, body: { name: "c" } }, undefined)).toThrow(expect.objectContaining({ reason: "no_permit" }));
    // Another ad account's paths are not covered.
    expect(enforce({ method: "POST", path: "act_888/campaigns", body: { status: "PAUSED" } }, p)).toThrow(SpendGuardBypassError);
  });

  it("the tenant (graphFetch) and the ad account (graphFetchAs) must match", () => {
    expect(enforce({ method: "POST", path: `${PHONE}/messages`, body: { to: "1" } }, msgPermit(), { via: "tenant", tenantId: "other" })).toThrow(expect.objectContaining({ reason: "wrong_tenant" }));
    expect(enforce({ method: "POST", path: `${PHONE}/messages`, body: { to: "1" } }, msgPermit({ phoneNumberId: "999", paths: [`${PHONE}/messages`] }))).toThrow(expect.objectContaining({ reason: "wrong_object" }));
    const cap = capPermit({ paths: ["act_888"] });
    expect(enforce({ method: "POST", path: "act_888", body: { spend_cap: "1" } }, cap, token)).toThrow(expect.objectContaining({ reason: "wrong_account" }));
  });

  it("an expired permit, a forged object and the wrong kind of permit are refused", () => {
    const p = msgPermit();
    const later = new Date(Date.now() + 11 * 60_000);
    expect(() => tripwire({ method: "POST", path: `${PHONE}/messages`, body: { to: "1" } }, tenant, { mode: "enforce", permit: p, now: later })).toThrow(expect.objectContaining({ reason: "expired" }));
    const forged = { type: "msg", tenantId: T, phoneNumberId: PHONE, paths: [`${PHONE}/messages`], maxUses: 9, expiresAt: later, issuedAt: new Date() };
    expect(enforce({ method: "POST", path: `${PHONE}/messages`, body: { to: "1" } }, forged)).toThrow(expect.objectContaining({ reason: "not_minted" }));
    expect(enforce({ method: "POST", path: `${PHONE}/messages`, body: { to: "1" } }, createPermit())).toThrow(expect.objectContaining({ reason: "wrong_permit_type" }));
    expect(enforce({ method: "POST", path: "", body: { batch: "[]" } }, adsPermit({ "1": {} }))).toThrow(expect.objectContaining({ reason: "not_coverable" }));
  });

  it("Meta's spending limit: the value never above the permitted cap, removal only with a delete permit, never a reset", () => {
    expect(tripwire({ method: "POST", path: ACT, body: { spend_cap: "1234.56" } }, token, { mode: "enforce", permit: capPermit() }).action).toBe("permitted");
    expect(enforce({ method: "POST", path: ACT, body: { spend_cap: "123457" } }, capPermit(), token)).toThrow(expect.objectContaining({ reason: "cap_over_permit" }));
    expect(enforce({ method: "POST", path: ACT, body: { spend_cap: "lots" } }, capPermit(), token)).toThrow(expect.objectContaining({ reason: "cap_over_permit" }));
    expect(enforce({ method: "POST", path: ACT, body: { spend_cap_action: "reset" } }, capPermit({ kind: "delete" }), token)).toThrow(expect.objectContaining({ reason: "cap_action_not_permitted" }));
    expect(enforce({ method: "POST", path: ACT, body: { spend_cap_action: "delete" } }, capPermit(), token)).toThrow(expect.objectContaining({ reason: "cap_action_not_permitted" }));
    expect(tripwire({ method: "POST", path: ACT, body: { spend_cap_action: "delete" } }, token, { mode: "enforce", permit: capPermit({ kind: "delete", capMinor: undefined }) }).action).toBe("permitted");
  });

  it("a lowering permit covers stopping, and the cut or earlier end its kind names, but never a raise", () => {
    expect(tripwire({ method: "POST", path: "238500002", body: { daily_budget: 50_000 } }, token, { mode: "enforce", permit: lowerPermit("cut_budget") }).action).toBe("permitted");
    expect(tripwire({ method: "POST", path: "238500002", body: { end_time: "2026-11-01T00:00:00Z" } }, token, { mode: "enforce", permit: lowerPermit("end_earlier") }).action).toBe("permitted");
    expect(enforce({ method: "POST", path: "238500002", body: { daily_budget: 50_000 } }, lowerPermit("pause"), token)).toThrow(expect.objectContaining({ reason: "field_not_permitted" }));
    expect(enforce({ method: "POST", path: "238500002", body: { status: "ACTIVE" } }, lowerPermit("cut_budget"), token)).toThrow(expect.objectContaining({ reason: "status_not_permitted" }));
    expect(enforce({ method: "POST", path: "238500003", body: { daily_budget: 1 } }, lowerPermit("cut_budget"), token)).toThrow(SpendGuardBypassError);
  });

  it("a lowering permit is bounded by the value it was minted for: a higher budget or a later end is refused", () => {
    expect(tripwire({ method: "POST", path: "238500002", body: { daily_budget: 40_000 } }, token, { mode: "enforce", permit: lowerPermit("cut_budget") }).action).toBe("permitted");
    expect(enforce({ method: "POST", path: "238500002", body: { daily_budget: 99_999_999 } }, lowerPermit("cut_budget"), token)).toThrow(expect.objectContaining({ reason: "budget_over_permit" }));
    expect(enforce({ method: "POST", path: "238500002", body: { lifetime_budget: 50_001 } }, lowerPermit("cut_budget"), token)).toThrow(expect.objectContaining({ reason: "budget_over_permit" }));
    expect(enforce({ method: "POST", path: "238500002", body: { daily_budget: 1 } }, lowerPermit("cut_budget", "238500002", { maxBudgetMinor: undefined }), token)).toThrow(expect.objectContaining({ reason: "budget_over_permit" }));
    expect(tripwire({ method: "POST", path: "238500002", body: { end_time: "2026-10-30T00:00:00Z" } }, token, { mode: "enforce", permit: lowerPermit("end_earlier") }).action).toBe("permitted");
    expect(enforce({ method: "POST", path: "238500002", body: { end_time: "2099-01-01T00:00:00Z" } }, lowerPermit("end_earlier"), token)).toThrow(expect.objectContaining({ reason: "end_over_permit" }));
    expect(enforce({ method: "POST", path: "238500002", body: { end_time: "2026-10-30T00:00:00Z" } }, lowerPermit("end_earlier", "238500002", { endsAt: undefined }), token)).toThrow(expect.objectContaining({ reason: "end_over_permit" }));
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("permitCovers is pure: it never counts a use", () => {
    const p = msgPermit();
    const c = classify({ method: "POST", path: `${PHONE}/messages`, body: { to: "1" } });
    expect(permitCovers(c, p, tenant)).toEqual({ ok: true });
    expect(permitCovers(c, p, tenant)).toEqual({ ok: true });
    expect(permitUses(p)).toBe(0);
    expect(permitCovers(c, undefined, tenant)).toEqual({ ok: false, reason: "no_permit" });
  });
});

describe("lowering is never blocked (I2)", () => {
  it.each(["report", "enforce"] as const)("%s: a pause with no permit passes and is audited as unledgered", (mode) => {
    const outcome = tripwire({ method: "POST", path: "238500002", body: { status: "PAUSED" } }, token, { mode, permit: undefined });
    expect(outcome).toMatchObject({ action: "lowering_unledgered", reason: "no_permit" });
    expect(events).toEqual([{ action: "spend.tripwire.unledgered_lowering", tenantId: null, target: "{id}", meta: expect.objectContaining({ blocked: false, class: "ads_lowering", via: "token" }) }]);
  });

  it("a pause with a mismatching or used-up permit still passes", () => {
    expect(tripwire({ method: "POST", path: "999", body: { status: "ARCHIVED" } }, token, { mode: "enforce", permit: adsPermit({ "111": {} }) }).action).toBe("lowering_unledgered");
  });

  it("a pause inside a matching lowering permit counts the use and is not audited", () => {
    const p = lowerPermit("pause");
    expect(tripwire({ method: "POST", path: "238500002", body: { status: "PAUSED" } }, token, { mode: "enforce", permit: p }).action).toBe("permitted");
    expect(permitUses(p)).toBe(1);
    expect(events).toEqual([]);
  });

  it("an audit sink that fails never breaks the request", () => {
    setTripwireAuditSink(() => {
      throw new Error("db down");
    });
    expect(tripwire({ method: "POST", path: "1", body: { status: "PAUSED" } }, token, { mode: "enforce", permit: undefined }).action).toBe("lowering_unledgered");
    setTripwireAuditSink(async () => {
      throw new Error("db down");
    });
    expect(tripwire({ method: "POST", path: "1", body: { status: "ACTIVE" } }, token, { mode: "report", permit: undefined }).action).toBe("reported");
  });
});

describe("in the transport: run() checks before any network I/O", () => {
  it("enforce: an unpermitted raise throws before fetch (spy: 0 calls)", async () => {
    process.env.SPEND_TRIPWIRE = "enforce";
    await expect(graphFetchAs("page-token", { path: "238500002", method: "POST", body: { status: "ACTIVE" } })).rejects.toBeInstanceOf(SpendGuardBypassError);
    await expect(graphFetchAs("page-token", { path: `${ACT}/campaigns`, method: "POST", body: { status: "PAUSED" } })).rejects.toBeInstanceOf(SpendGuardBypassError);
    await expect(graphFetch({ tenantId: T, path: `${PHONE}/messages`, method: "POST", body: { to: "1" } })).rejects.toMatchObject({ code: "spend_bypass" });
    await expect(graphUpload({ tenantId: T, path: "238500002", fields: { status: "ACTIVE" }, file: { bytes: new Uint8Array([1]), filename: "a", mime: "image/png" } })).rejects.toBeInstanceOf(SpendGuardBypassError);
    expect(fetchMock).toHaveBeenCalledTimes(0);
  });

  it("enforce: the same calls go out inside a matching permit, counting one use per request even when retried", async () => {
    process.env.SPEND_TRIPWIRE = "enforce";
    const p = adsPermit({ "238500002": { status: "ACTIVE" } });
    fetchMock.mockResolvedValueOnce(new Response(JSON.stringify({ error: { message: "slow down", code: 4 } }), { status: 400 }));
    vi.stubGlobal("setTimeout", (fn: () => void) => {
      fn();
      return 0;
    });
    await runWithPermit(p, () => graphFetchAs("page-token", { path: "238500002", method: "POST", body: { status: "ACTIVE" } }));
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(permitUses(p)).toBe(1);
    const m = msgPermit();
    await runWithPermit(m, () => graphFetch({ tenantId: T, path: `${PHONE}/messages`, method: "POST", body: { to: "1" } }));
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });

  it("enforce: a pause with no permit still reaches Meta", async () => {
    process.env.SPEND_TRIPWIRE = "enforce";
    await graphFetchAs("page-token", { path: "238500002", method: "POST", body: { status: "PAUSED" } });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(events.map((e) => e.action)).toEqual(["spend.tripwire.unledgered_lowering"]);
  });

  it("report (default): an unpermitted raise still reaches Meta and is audited without the token", async () => {
    await graphFetchAs("page-token", { path: "238500002", method: "POST", body: { status: "ACTIVE" } });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(events).toHaveLength(1);
    expect(JSON.stringify(events)).not.toContain("page-token");
    // Reads and non-spend writes never touch the tripwire.
    await graphFetch({ tenantId: T, path: "1/subscribed_apps", method: "POST" });
    await graphFetchAs("page-token", { path: `${ACT}/insights`, query: { fields: "spend" } });
    expect(events).toHaveLength(1);
  });
});
