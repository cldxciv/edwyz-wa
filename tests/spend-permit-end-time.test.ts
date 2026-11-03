import fc from "fast-check";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * docs/IG-PAGE-ADS-SPEC.md 6.1 rule 17 and request P0-11 (spend-permit-end-time.test.ts): an end-date write is bounded by its
 * permit in both directions, at the ads client and again at the transport tripwire.
 * - extend_end (reserveAds, an AdsPermit): no end_time later than objects[id].endsAt.
 * - end_earlier (recordLowering, a lowering permit): no end_time later than the end it was minted for, so a "lowering" can
 *   never extend spending.
 * Only the book's database check (assertPermitValid) and fetch (Meta) are stand-ins; the client, transport, tripwire and
 * permits are real. Nothing reaches the network.
 */

const book = vi.hoisted(() => ({ assertPermitValid: vi.fn(async () => undefined) }));
vi.mock("@/lib/db", () => ({ prisma: {} }));
vi.mock("@/lib/spend/book", async () => {
  const { runWithPermit } = await import("@/lib/spend/permit");
  return {
    assertPermitValid: book.assertPermitValid,
    runUnderPermit: <T>(permit: Parameters<typeof runWithPermit>[0], fn: () => Promise<T>) => runWithPermit(permit, fn),
  };
});

import { adsClient } from "@/lib/ads/client";
import { graphFetchAs } from "@/lib/graph";
import { SpendGuardBypassError } from "@/lib/spend/errors";
import { mintPermit, permitUses, runWithPermit } from "@/lib/spend/permit";
import { setTripwireAuditSink, tripwire, type TripwireAuditEvent } from "@/lib/spend/tripwire";
import type { AdsGuard, AdsPermit, AdsPermitObject, LoweringPermit, LoweringPermitData } from "@/lib/spend/types";

const T = "tenant_1";
const ACT = "act_777";
const ADSET = "238500002";
const OTHER = "238500009";
const DAY = 86_400_000;
/** The end each permit was minted for: 30 Nov 2026, 23:59 in Kolkata. */
const END = new Date("2026-11-30T18:29:00Z");
const guard: AdsGuard = { tenantId: T, adAccountAssetId: "asset_1", actor: { type: "user", userId: "u_admin", role: "admin" }, sandbox: false };
const times = () => ({ issuedAt: new Date(Date.now() - 1000), expiresAt: new Date(Date.now() + 10 * 60_000) });
const token = { via: "token" } as const;

const extendEnd = (objects: Record<string, AdsPermitObject> = { [ADSET]: { endsAt: END } }): AdsPermit =>
  mintPermit({ type: "ads", kind: "extend_end", correlationId: "sc_extend", tenantId: T, adAccountAssetId: "asset_1", accountExternalId: ACT, objects, paths: Object.keys(objects), maxUses: 5, ...times() });
const lowering = (kind: LoweringPermitData["kind"] = "end_earlier", over: Partial<LoweringPermitData> = {}): LoweringPermit =>
  mintPermit({ type: "lowering", kind, correlationId: "sc_earlier", tenantId: T, metaObjectIds: [ADSET], paths: [ADSET], maxUses: 5, ...(kind === "end_earlier" ? { endsAt: END } : {}), ...times(), ...over });

const client = () => adsClient("TOKEN", ACT, guard, { env: {} });
const at = (ms: number) => new Date(END.getTime() + ms);
/** One POST <adset> through the tripwire alone, in enforce mode. */
const throughTripwire = (body: Record<string, unknown>, permit: unknown) => () => tripwire({ method: "POST", path: ADSET, body }, token, { mode: "enforce", permit });

let events: TripwireAuditEvent[];
let fetchSpy: ReturnType<typeof vi.fn>;
const sentBodies = () => fetchSpy.mock.calls.map(([, init]) => JSON.parse(String((init as RequestInit).body)) as Record<string, unknown>);

beforeEach(() => {
  events = [];
  setTripwireAuditSink((e) => void events.push(e));
  fetchSpy = vi.fn(async () => new Response(JSON.stringify({ success: true }), { status: 200 }));
  vi.stubGlobal("fetch", fetchSpy);
  vi.spyOn(console, "log").mockImplementation(() => undefined);
  vi.spyOn(console, "warn").mockImplementation(() => undefined);
  vi.spyOn(console, "error").mockImplementation(() => undefined);
  book.assertPermitValid.mockClear();
  process.env.SPEND_TRIPWIRE = "enforce";
});
afterEach(() => {
  setTripwireAuditSink(null);
  delete process.env.SPEND_TRIPWIRE;
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("extend_end: an AdsPermit refuses an end later than objects[id].endsAt", () => {
  it("at the client: a later end is refused before the book is read or Meta is called", async () => {
    const permit = extendEnd();
    await expect(client().setEndTime(ADSET, at(1000), permit)).rejects.toMatchObject({ reason: "end_over_permit" });
    await expect(client().setEndTime(ADSET, at(1), permit)).rejects.toBeInstanceOf(SpendGuardBypassError);
    await expect(client().setEndTime(ADSET, at(60 * DAY), permit)).rejects.toMatchObject({ reason: "end_over_permit" });
    expect(book.assertPermitValid).not.toHaveBeenCalled();
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(permitUses(permit)).toBe(0);
  });

  it("at the client: the reserved end, or an earlier one, goes out inside the permit after the book's check", async () => {
    const permit = extendEnd();
    await client().setEndTime(ADSET, END, permit);
    await client().setEndTime(ADSET, at(-3 * DAY), permit);
    expect(book.assertPermitValid).toHaveBeenCalledTimes(2);
    expect(book.assertPermitValid).toHaveBeenCalledWith(permit, ADSET);
    expect(sentBodies()).toEqual([{ end_time: END.toISOString() }, { end_time: at(-3 * DAY).toISOString() }]);
    expect(permitUses(permit)).toBe(2);
    expect(events).toEqual([]);
  });

  it("at the client: an object the permit has no end for, or does not name, is refused", async () => {
    await expect(client().setEndTime(ADSET, at(-DAY), extendEnd({ [ADSET]: { maxDailyMinor: 10_000n } }))).rejects.toMatchObject({ reason: "end_over_permit" });
    await expect(client().setEndTime(OTHER, at(-DAY), extendEnd())).rejects.toMatchObject({ reason: "end_over_permit" });
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("at the tripwire: skipping the client, a later end_time or stop_time in any form is still refused with zero fetches", async () => {
    for (const body of [
      { end_time: at(1000).toISOString() },
      { end_time: Math.floor(at(DAY).getTime() / 1000) },
      { end_time: String(Math.floor(at(DAY).getTime() / 1000)) },
      { end_time: "2026-12-01T00:00:00+0530" },
      { stop_time: at(DAY).toISOString() },
      { end_time: "soon" },
      { end_time: END.toISOString(), stop_time: at(DAY).toISOString() },
    ]) {
      const permit = extendEnd();
      await expect(runWithPermit(permit, () => graphFetchAs("page-token", { method: "POST", path: ADSET, body })), JSON.stringify(body)).rejects.toBeInstanceOf(SpendGuardBypassError);
      expect(permitUses(permit)).toBe(0);
    }
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(events.every((e) => e.meta.blocked && e.target === "{id}")).toBe(true);
    expect(events.map((e) => e.meta.reason)).toEqual(Array(7).fill("end_over_permit"));
  });

  it("at the tripwire: the reserved end passes, another object's end does not", () => {
    expect(throughTripwire({ end_time: END.toISOString() }, extendEnd())()).toMatchObject({ action: "permitted" });
    expect(throughTripwire({ stop_time: Math.floor(END.getTime() / 1000) }, extendEnd())()).toMatchObject({ action: "permitted" });
    const two = extendEnd({ [ADSET]: { endsAt: END }, [OTHER]: { endsAt: at(10 * DAY) } });
    expect(throughTripwire({ end_time: at(5 * DAY).toISOString() }, two)).toThrow(expect.objectContaining({ reason: "end_over_permit" }));
  });

  it("property: at the tripwire, an end passes exactly when it is not after the permitted end", () => {
    fc.assert(
      fc.property(fc.integer({ min: -90 * 86_400, max: 90 * 86_400 }), fc.constantFrom("iso", "epoch", "stop_time"), (seconds, form) => {
        const when = at(seconds * 1000);
        const body = form === "iso" ? { end_time: when.toISOString() } : form === "epoch" ? { end_time: when.getTime() / 1000 } : { stop_time: when.toISOString() };
        const run = throughTripwire(body, extendEnd());
        if (seconds <= 0) return run().action === "permitted";
        try {
          run();
          return false;
        } catch (e) {
          return e instanceof SpendGuardBypassError && (e as { reason?: string }).reason === "end_over_permit";
        }
      }),
      { numRuns: 200 },
    );
  });
});

describe("end_earlier: a lowering permit refuses any end later than the one it was minted for", () => {
  it("at the client: a later end is refused before any call; the book is never asked (lowering is never blocked)", async () => {
    const permit = lowering();
    await expect(client().setEndTime(ADSET, at(1), permit)).rejects.toMatchObject({ reason: "end_over_permit" });
    await expect(client().setEndTime(ADSET, at(DAY), permit)).rejects.toMatchObject({ reason: "end_over_permit" });
    expect(fetchSpy).not.toHaveBeenCalled();
    await client().setEndTime(ADSET, END, permit);
    await client().setEndTime(ADSET, at(-2 * DAY), permit);
    expect(sentBodies()).toEqual([{ end_time: END.toISOString() }, { end_time: at(-2 * DAY).toISOString() }]);
    expect(book.assertPermitValid).not.toHaveBeenCalled();
  });

  it("at the client: another kind of lowering permit, or another object, covers no end date", async () => {
    await expect(client().setEndTime(ADSET, at(-DAY), lowering("pause"))).rejects.toMatchObject({ reason: "end_wrong_lowering_permit" });
    await expect(client().setEndTime(ADSET, at(-DAY), lowering("cut_budget", { maxBudgetMinor: 1n }))).rejects.toMatchObject({ reason: "end_wrong_lowering_permit" });
    await expect(client().setEndTime(OTHER, at(-DAY), lowering())).rejects.toMatchObject({ reason: "end_wrong_lowering_permit" });
    await expect(client().setEndTime(ADSET, at(-DAY), lowering("end_earlier", { endsAt: undefined }))).rejects.toMatchObject({ reason: "end_over_permit" });
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("at the tripwire: skipping the client, any later end_time or stop_time is refused with zero fetches", async () => {
    for (const body of [{ end_time: at(1000).toISOString() }, { end_time: Math.floor(at(DAY).getTime() / 1000) }, { stop_time: at(DAY).toISOString() }, { end_time: "2099-01-01T00:00:00Z" }, { end_time: "later" }]) {
      const permit = lowering();
      await expect(runWithPermit(permit, () => graphFetchAs("page-token", { method: "POST", path: ADSET, body })), JSON.stringify(body)).rejects.toBeInstanceOf(SpendGuardBypassError);
      expect(permitUses(permit)).toBe(0);
    }
    expect(fetchSpy).not.toHaveBeenCalled();
    // A lowering permit with no end refuses every end_time.
    expect(throughTripwire({ end_time: at(-DAY).toISOString() }, lowering("end_earlier", { endsAt: undefined }))).toThrow(expect.objectContaining({ reason: "end_over_permit" }));
    // A pause permit covers no end_time at all.
    expect(throughTripwire({ end_time: at(-DAY).toISOString() }, lowering("pause"))).toThrow(expect.objectContaining({ reason: "field_not_permitted" }));
  });

  it("property: at the tripwire, any later end is refused and any end up to the permitted one passes", () => {
    fc.assert(
      fc.property(fc.integer({ min: -90 * 86_400, max: 90 * 86_400 }), fc.constantFrom("iso", "epoch", "stop_time"), (seconds, form) => {
        const when = at(seconds * 1000);
        const body = form === "iso" ? { end_time: when.toISOString() } : form === "epoch" ? { end_time: String(when.getTime() / 1000) } : { stop_time: when.toISOString() };
        const run = throughTripwire(body, lowering());
        if (seconds <= 0) return run().action === "permitted";
        try {
          run();
          return false;
        } catch (e) {
          return e instanceof SpendGuardBypassError && (e as { reason?: string }).reason === "end_over_permit";
        }
      }),
      { numRuns: 200 },
    );
  });
});
