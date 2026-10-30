import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { FakeSpendDb } from "./helpers/fake-spend-db";

const h = vi.hoisted(() => ({ db: null as unknown as FakeSpendDb }));

vi.mock("@/lib/db", async () => {
  const { createFakeSpendDb } = await import("./helpers/fake-spend-db");
  h.db = createFakeSpendDb();
  return { prisma: h.db.prisma };
});

import { decimalToMinor } from "@/lib/ads/insights-money";
import { readEddyConfig, EDDY_DEFAULTS, EDDY_EVENT_TYPES, memberDailyCreditCap, microUsdToCredits, type EddyEvent } from "@/lib/eddy/contract";
import { eddyRoundSubjectId, eddyScreenSubjectId } from "@/lib/eddy/model";
import { NeedsApprovalError, ShadowOnlyError, SpendBlockedError, SpendBusyError, SpendGuardBypassError } from "@/lib/spend/errors";
import { assistantSpendEnabled, legacyMaxDailyBudgetMinor, resetFlagWarningsForTests, spendCapMode, spendDryRun, spendEnforceMode, spendFlags, spendSim, spendTripwireMode } from "@/lib/spend/flags";
import { jsonSafe, parseLimitInput, periodDTO, spendErrorResponse } from "@/lib/spend/http";
import { actorColumns, appendOutcome, appendRequest, appendStandalone, ledgerRowsFor, listLedger, type LedgerDb } from "@/lib/spend/ledger";
import {
  currencyExponent,
  decimalToMinorBig,
  formatMinor,
  minLimit,
  minorToMajorString,
  parseMajorInput,
  parseMinorString,
  percentOf,
  serializeMinor,
  toMinor,
  toMoneyDTO,
  toMoneyDTOOrNull,
} from "@/lib/spend/money";
import {
  addDays,
  dateToDayKey,
  dayKey,
  dayKeyToDate,
  daysInMonth,
  eachDay,
  isValidTimeZone,
  monthKey,
  nextLocalMidnight,
  nextLocalMonthStart,
  nextMonthKey,
  periodKeys,
  resolveTimeZone,
  startOfLocalDay,
  startOfLocalMonth,
  weekdayOfDay,
  weekStartKey,
} from "@/lib/spend/periods";
import { currentPermit, isMintedPermit, mintPermit, permitStore, permitUses, runWithPermit, usePermit } from "@/lib/spend/permit";
import { PROBATION_CEILING_DEFAULTS, SPEND_QUEUES, type AdsPermitData, type LedgerRowInput, type SpendActor } from "@/lib/spend/types";

const ROOT = path.resolve(__dirname, "..");
const read = (rel: string) => readFileSync(path.join(ROOT, rel), "utf8");
const space = (s: string) => s.replace(/\s/g, " ");
/**
 * The tests that walk src read every source file. Under the full suite's parallel load that can pass vitest's 5 s default
 * although nothing is wrong, so they get a realistic budget. The checks themselves are unchanged.
 */
const SCAN_TIMEOUT = 30_000;

// =====================================================================================================================
describe("money", () => {
  it("formats with the exponent and en-IN grouping", () => {
    expect(formatMinor(10_234_000n, "INR")).toBe("₹1,02,340");
    expect(formatMinor(10_234_050n, "INR")).toBe("₹1,02,340.50");
    expect(formatMinor(85_000, "INR")).toBe("₹850");
    expect(formatMinor("140000", "INR")).toBe("₹1,400");
    expect(formatMinor(5n, "INR")).toBe("₹0.05");
    expect(formatMinor(85_000n, "INR", { alwaysFraction: true })).toBe("₹850.00");
    expect(formatMinor(-85_000n, "INR")).toBe("-₹850");
  });

  it("formats JPY with no decimals and KWD with three", () => {
    expect(currencyExponent("JPY")).toBe(0);
    expect(formatMinor(1500n, "JPY")).toBe("¥1,500");
    expect(currencyExponent("KWD")).toBe(3);
    expect(space(formatMinor(1234n, "KWD"))).toBe("KWD 1.234");
    expect(space(formatMinor(1230n, "KWD"))).toBe("KWD 1.230");
    expect(space(formatMinor(5000n, "KWD"))).toBe("KWD 5");
    expect(formatMinor(123_456n, "USD")).toBe("$1,234.56");
  });

  it("counts AI in CRD credits with exponent 0", () => {
    expect(currencyExponent("CRD")).toBe(0);
    expect(formatMinor(140n, "CRD")).toBe("140 credits");
    expect(formatMinor(1n, "CRD")).toBe("1 credit");
    expect(formatMinor(150_000n, "CRD")).toBe("1,50,000 credits");
  });

  it("is exact for 10^15 minor units and beyond 2^53", () => {
    expect(formatMinor(10n ** 15n, "INR")).toBe("₹1,00,00,00,00,00,000");
    expect(formatMinor(10n ** 15n + 1n, "INR")).toBe("₹1,00,00,00,00,00,000.01");
    expect(formatMinor(9_007_199_254_740_993n, "INR")).toBe("₹9,00,71,99,25,47,409.93");
  });

  it("converts Meta decimals without clamping (3.1)", () => {
    expect(decimalToMinorBig("10000000000000", 2)).toBe(10n ** 15n);
    expect(decimalToMinor("10000000000", 2)).toBe(2_147_483_647); // the old helper clamps: the unsafe direction
    expect(decimalToMinorBig("10000000000", 2)).toBe(1_000_000_000_000n);
    expect(decimalToMinorBig("99999999999999999999.99", 2)).toBe(BigInt("9".repeat(22)));
    expect(decimalToMinorBig("12.345", 2)).toBe(1235n);
    expect(decimalToMinorBig("12.344", 2)).toBe(1234n);
    expect(decimalToMinorBig("1500", 0)).toBe(1500n);
    expect(decimalToMinorBig("1.2345", 3)).toBe(1235n);
    expect(decimalToMinorBig("", 2)).toBe(0n);
    expect(decimalToMinorBig(null, 2)).toBe(0n);
    expect(decimalToMinorBig(12.5, 2)).toBe(1250n);
    for (const bad of ["-1", "1e5", "abc", "1.2.3", " ", "1,000"]) expect(() => decimalToMinorBig(bad, 2), bad).toThrow(RangeError);
  });

  it("writes major-unit decimal strings for Meta's spend_cap (5.5)", () => {
    expect(minorToMajorString(2_000_000n, "INR")).toBe("20000.00");
    expect(minorToMajorString(20_000n, "JPY")).toBe("20000");
    expect(minorToMajorString(20_000n, "KWD")).toBe("20.000");
    expect(minorToMajorString(5n, "INR")).toBe("0.05");
  });

  it("parses what a person types without rounding it", () => {
    expect(parseMajorInput("2,000", "INR")).toBe(200_000n);
    expect(parseMajorInput("₹ 1,500.50", "INR")).toBe(150_050n);
    expect(parseMajorInput("JPY 1500", "JPY")).toBe(1500n);
    expect(parseMajorInput("", "INR")).toBeNull();
    expect(parseMajorInput(null, "INR")).toBeNull();
    expect(() => parseMajorInput("1.234", "INR")).toThrow(/at most 2 decimal places/);
    expect(() => parseMajorInput("1.5", "JPY")).toThrow(/whole amount/);
    expect(() => parseMajorInput("ten", "INR")).toThrow(RangeError);
  });

  it("normalises and serialises minor units strictly", () => {
    expect(toMinor(5)).toBe(5n);
    expect(toMinor("123")).toBe(123n);
    expect(() => toMinor(1.5)).toThrow(RangeError);
    expect(() => toMinor("1e3")).toThrow(RangeError);
    expect(() => toMinor(2 ** 60)).toThrow(RangeError);
    expect(serializeMinor(10n ** 15n)).toBe("1000000000000000");
    expect(parseMinorString("200000")).toBe(200_000n);
    expect(() => parseMinorString("-1")).toThrow(RangeError);
    expect(toMoneyDTO(85_000n, "INR")).toEqual({ minor: "85000", currency: "INR", formatted: "₹850" });
    expect(toMoneyDTOOrNull(null, "INR")).toBeNull();
    expect(minLimit(null, 5n)).toBe(5n);
    expect(minLimit(7n, 5n)).toBe(5n);
    expect(minLimit(null, undefined)).toBeNull();
    expect(percentOf(50n, 200n)).toBe(25);
    expect(percentOf(50n, null)).toBeNull();
    expect(periodDTO({ spent: 1n, committed: 2n, held: 0n, left: null }, "INR").left).toBeNull();
  });
});

// =====================================================================================================================
describe("periods", () => {
  const IST = "Asia/Kolkata";
  const NY = "America/New_York";
  const at = (iso: string) => new Date(iso);

  it("flips the Asia/Kolkata day, month and week at local midnight on 1 Nov", () => {
    expect(dayKey(at("2026-10-31T18:29:59.999Z"), IST)).toBe("2026-10-31");
    expect(dayKey(at("2026-10-31T18:30:00Z"), IST)).toBe("2026-11-01");
    expect(monthKey(at("2026-10-31T18:29:59Z"), IST)).toBe("2026-10");
    expect(monthKey(at("2026-10-31T18:30:00Z"), IST)).toBe("2026-11");
    // 1 Nov 2026 is a Sunday, so a new Sunday-to-Saturday week starts with the new month.
    expect(weekdayOfDay("2026-11-01")).toBe(0);
    expect(weekStartKey(at("2026-10-31T18:29:00Z"), IST)).toBe("2026-10-25");
    expect(weekStartKey(at("2026-10-31T18:30:00Z"), IST)).toBe("2026-11-01");
    expect(nextLocalMidnight(at("2026-10-31T10:00:00Z"), IST).toISOString()).toBe("2026-10-31T18:30:00.000Z");
    expect(nextLocalMonthStart(at("2026-10-15T10:00:00Z"), IST).toISOString()).toBe("2026-10-31T18:30:00.000Z");
    expect(startOfLocalMonth(at("2026-11-01T00:00:00Z"), IST).toISOString()).toBe("2026-10-31T18:30:00.000Z");
    expect(periodKeys(at("2026-10-28T09:00:00Z"), IST)).toEqual({ day: "2026-10-28", month: "2026-10", weekStart: "2026-10-25" });
    expect(weekdayOfDay("2026-10-01")).toBe(4); // Thursday (the 4.5 worked example)
  });

  it("handles the America/New_York DST change on 1 Nov 2026 (a 25-hour day)", () => {
    expect(dayKey(at("2026-11-01T03:59:59Z"), NY)).toBe("2026-10-31");
    expect(dayKey(at("2026-11-01T04:00:00Z"), NY)).toBe("2026-11-01");
    expect(startOfLocalDay("2026-11-01", NY).toISOString()).toBe("2026-11-01T04:00:00.000Z"); // EDT midnight
    expect(startOfLocalDay("2026-11-02", NY).toISOString()).toBe("2026-11-02T05:00:00.000Z"); // EST midnight
    expect(nextLocalMidnight(at("2026-11-01T05:30:00Z"), NY).toISOString()).toBe("2026-11-02T05:00:00.000Z"); // 01:30 EDT
    expect(nextLocalMidnight(at("2026-11-01T06:30:00Z"), NY).toISOString()).toBe("2026-11-02T05:00:00.000Z"); // 01:30 EST, the repeated hour
    expect(nextLocalMidnight(at("2026-11-01T03:00:00Z"), NY).toISOString()).toBe("2026-11-01T04:00:00.000Z"); // still 31 Oct locally
    const hours = (startOfLocalDay("2026-11-02", NY).getTime() - startOfLocalDay("2026-11-01", NY).getTime()) / 3_600_000;
    expect(hours).toBe(25);
    expect(monthKey(at("2026-11-01T03:59:59Z"), NY)).toBe("2026-10");
    expect(nextLocalMonthStart(at("2026-10-20T12:00:00Z"), NY).toISOString()).toBe("2026-11-01T04:00:00.000Z");
  });

  it("handles the spring-forward day (23 hours) and a zone that skips midnight", () => {
    const spring = (startOfLocalDay("2026-03-09", NY).getTime() - startOfLocalDay("2026-03-08", NY).getTime()) / 3_600_000;
    expect(spring).toBe(23);
    // Whatever the zone rules, the start of a day is the first instant whose local date is that day.
    for (const [zone, day] of [["America/Santiago", "2026-09-06"], ["America/Havana", "2026-03-08"], ["Asia/Kathmandu", "2026-11-01"], ["Pacific/Kiritimati", "2026-11-01"]] as const) {
      const start = startOfLocalDay(day, zone);
      expect(dayKey(start, zone), zone).toBe(day);
      expect(dayKey(new Date(start.getTime() - 60_000), zone), zone).toBe(addDays(day, -1));
    }
  });

  it("does calendar arithmetic on keys", () => {
    expect(addDays("2026-12-31", 1)).toBe("2027-01-01");
    expect(addDays("2026-03-01", -1)).toBe("2026-02-28");
    expect(daysInMonth("2026-02")).toBe(28);
    expect(daysInMonth("2028-02")).toBe(29);
    expect(nextMonthKey("2026-12")).toBe("2027-01");
    expect(eachDay("2026-10-29", "2026-11-02")).toEqual(["2026-10-29", "2026-10-30", "2026-10-31", "2026-11-01", "2026-11-02"]);
    expect(eachDay("2026-11-02", "2026-10-29")).toEqual([]);
    expect(dateToDayKey(dayKeyToDate("2026-11-01"))).toBe("2026-11-01");
    expect(dayKeyToDate("2026-11-01").toISOString()).toBe("2026-11-01T00:00:00.000Z");
    expect(() => addDays("2026-02-30", 1)).toThrow(RangeError);
  });

  it("validates zones and falls back to Asia/Kolkata", () => {
    expect(isValidTimeZone("America/New_York")).toBe(true);
    expect(isValidTimeZone("Mars/Base")).toBe(false);
    expect(resolveTimeZone(null)).toBe("Asia/Kolkata");
    expect(resolveTimeZone("Mars/Base")).toBe("Asia/Kolkata");
    expect(resolveTimeZone("Europe/London")).toBe("Europe/London");
  });
});

// =====================================================================================================================
describe("ledger (9.1)", () => {
  const db = () => h.db.prisma as unknown as LedgerDb & { $transaction: <T>(fn: (tx: LedgerDb) => Promise<T>) => Promise<T> };
  const owner: SpendActor = { type: "user", userId: "u_owner", role: "owner" };
  const row = (over: Partial<LedgerRowInput> = {}): LedgerRowInput => ({
    tenantId: "t1",
    pot: "ads",
    action: "ads.adset.budget_raise",
    actor: owner,
    reason: "Raised the daily budget",
    currency: "INR",
    amountMinor: 100_000n,
    forecastTodayMinor: 175_000n,
    ...over,
  });
  const silent = { log: () => undefined, retryDelayMs: 0 };

  beforeEach(() => h.db.reset());

  it("writes a requested row and exactly one outcome with the same correlationId", async () => {
    const req = await db().$transaction((tx) => appendRequest(tx, row({ before: { dailyBudgetMinor: 80_000n }, after: { dailyBudgetMinor: 100_000n }, undo: { action: "set_adset_budget", metaAdSetId: "m1", dailyBudgetMinor: 80_000n } })));
    expect(req.created).toBe(true);
    expect(req.record).toMatchObject({ phase: "requested", actorType: "user", actorId: "u_owner", tenantId: "t1", amountMinor: 100_000n });
    expect(req.record.correlationId).toMatch(/^sc_/);
    expect(req.record.before).toEqual({ dailyBudgetMinor: "80000" });
    expect(req.record.undo).toEqual({ action: "set_adset_budget", metaAdSetId: "m1", dailyBudgetMinor: "80000" });

    const out = await appendOutcome(req.record.correlationId, { ...row(), phase: "applied" }, silent);
    expect(out?.created).toBe(true);
    const again = await appendOutcome(req.record.correlationId, { ...row(), phase: "failed" }, silent);
    expect(again?.created).toBe(false);
    expect(again?.record.phase).toBe("applied");

    const rows = await ledgerRowsFor("t1", req.record.correlationId);
    expect(rows.map((r) => r.phase)).toEqual(["requested", "applied"]);
    expect(rows[0].seq < rows[1].seq).toBe(true);
  });

  it("allows one reconciled row only after an unconfirmed outcome", async () => {
    const a = await db().$transaction((tx) => appendRequest(tx, row()));
    await appendOutcome(a.record.correlationId, { ...row(), phase: "unconfirmed" }, silent);
    expect((await appendOutcome(a.record.correlationId, { ...row(), phase: "reconciled" }, silent))?.created).toBe(true);
    expect((await appendOutcome(a.record.correlationId, { ...row(), phase: "reconciled" }, silent))?.created).toBe(false);
    expect((await ledgerRowsFor("t1", a.record.correlationId)).map((r) => r.phase)).toEqual(["requested", "unconfirmed", "reconciled"]);

    const b = await db().$transaction((tx) => appendRequest(tx, row()));
    await appendOutcome(b.record.correlationId, { ...row(), phase: "applied" }, silent);
    expect((await appendOutcome(b.record.correlationId, { ...row(), phase: "reconciled" }, silent))?.created).toBe(false);
    expect((await ledgerRowsFor("t1", b.record.correlationId)).map((r) => r.phase)).toEqual(["requested", "applied"]);
  });

  it("makes retries harmless through the (tenant, key, phase) idempotency key", async () => {
    const key = "activate:c1:2026-10-28T09:00:00.000Z";
    const first = await db().$transaction((tx) => appendRequest(tx, row({ idempotencyKey: key })));
    const second = await db().$transaction((tx) => appendRequest(tx, row({ idempotencyKey: key, reason: "retry" })));
    expect(second.created).toBe(false);
    expect(second.record.correlationId).toBe(first.record.correlationId);
    const other = await db().$transaction((tx) => appendRequest(tx, row({ idempotencyKey: key, tenantId: "t2" })));
    expect(other.created).toBe(true);
    await appendOutcome(first.record.correlationId, { ...row(), phase: "applied", idempotencyKey: key }, silent);
    expect((await appendOutcome(first.record.correlationId, { ...row(), phase: "applied", idempotencyKey: key }, silent))?.created).toBe(false);
    expect(h.db.rows("spendLedger")).toHaveLength(3);
    // The fake enforces the partial unique index of 0009, like Postgres.
    await expect(h.db.model("spendLedger").create({ data: { ...h.db.rows("spendLedger")[0], id: undefined, seq: undefined } })).rejects.toMatchObject({ code: "P2002" });
  });

  it("writes standalone refused, shadow, info and external reconciled rows with their own correlationId", async () => {
    const refused = await appendStandalone({ ...row({ observe: true, reasonCodes: ["spend.monthly_limit"] }), phase: "refused" }, silent);
    expect(refused?.record).toMatchObject({ phase: "refused", observe: true, reasonCodes: ["spend.monthly_limit"] });
    expect(await ledgerRowsFor("t1", refused!.record.correlationId)).toHaveLength(1);
    const external = await appendStandalone(
      { ...row({ action: "ads.external_change", actor: { type: "external", source: "meta_ads_manager" }, reason: "The daily budget was changed in Meta Ads Manager" }), phase: "reconciled" },
      silent,
    );
    expect(external?.record).toMatchObject({ actorType: "external", actorId: "meta_ads_manager", phase: "reconciled" });
    for (const phase of ["shadow", "info"] as const) expect((await appendStandalone({ ...row(), phase }, silent))?.record.phase).toBe(phase);
    const ids = new Set(h.db.rows("spendLedger").map((r) => r.correlationId));
    expect(ids.size).toBe(4);
  });

  it("keeps a refusal even though the refusing transaction rolls back", async () => {
    await expect(
      db().$transaction(async (tx) => {
        await appendRequest(tx, row());
        await appendStandalone({ ...row(), phase: "refused" }, silent); // outside the transaction, on purpose
        throw new SpendBlockedError("spend.daily_limit");
      }),
    ).rejects.toBeInstanceOf(SpendBlockedError);
    expect(h.db.rows("spendLedger").map((r) => r.phase)).toEqual(["refused"]);
  });

  it("appendRequest is strict: a failed insert throws and rolls the transaction back", async () => {
    h.db.failNext("spendLedger", "create", new Error("disk full"));
    await expect(db().$transaction((tx) => appendRequest(tx, row()))).rejects.toThrow("disk full");
    await expect(db().$transaction((tx) => appendRequest(tx, row({ reason: "  " })))).rejects.toThrow(RangeError);
    expect(h.db.rows("spendLedger")).toEqual([]);
    expect(h.db.transactions.map((t) => t.status)).toEqual(["rolled_back", "rolled_back"]);
  });

  it("appendOutcome never throws: it retries once, then logs and returns null", async () => {
    const req = await db().$transaction((tx) => appendRequest(tx, row()));
    h.db.failNext("spendLedger", "create", new Error("blip"));
    expect((await appendOutcome(req.record.correlationId, { ...row(), phase: "applied" }, silent))?.created).toBe(true);

    const other = await db().$transaction((tx) => appendRequest(tx, row()));
    const log = vi.fn();
    h.db.failNext("spendLedger", "create", new Error("down"), 2);
    await expect(appendOutcome(other.record.correlationId, { ...row(), phase: "failed" }, { log, retryDelayMs: 0 })).resolves.toBeNull();
    expect(log).toHaveBeenCalledTimes(1);
    expect(log.mock.calls[0][0]).toContain(other.record.correlationId);
    await expect(appendOutcome("sc_x", { ...row({ reason: "" }), phase: "applied" }, { log, retryDelayMs: 0 })).resolves.toBeNull();
    await expect(appendStandalone({ ...row(), phase: "info" }, { db: { spendLedger: null } as unknown as LedgerDb, log, retryDelayMs: 0 })).resolves.toBeNull();
  });

  it("records who acted: via_eddy on a member, assistantKey and approvalId on an assistant", async () => {
    const eddy = await db().$transaction((tx) => appendRequest(tx, row({ actor: { type: "user", userId: "u1", role: "admin", reasonCodes: ["via_eddy"] } })));
    expect(eddy.record.reasonCodes).toEqual(["via_eddy"]);
    const assistant = await db().$transaction((tx) => appendRequest(tx, row({ actor: { type: "assistant", assistantKey: "ads_optimizer", approvalId: "ap_9" }, autonomyLevel: 1 })));
    expect(assistant.record).toMatchObject({ actorType: "assistant", actorId: null, assistantKey: "ads_optimizer", approvalId: "ap_9", autonomyLevel: 1 });
    expect(actorColumns({ type: "api", keyId: "k1", userId: "u" })).toMatchObject({ actorType: "api", actorId: "k1" });
    expect(actorColumns({ type: "breaker", kind: "daily_limit" })).toMatchObject({ actorType: "breaker", actorId: "daily_limit" });
    expect(actorColumns({ type: "platform_admin", userId: "pa" })).toMatchObject({ actorType: "platform_admin", actorId: "pa" });
    expect(actorColumns({ type: "system", job: "tenant-state" })).toMatchObject({ actorType: "system", actorId: "tenant-state" });
  });

  it("pages by seq, at most 100 rows, per workspace and pot", async () => {
    for (let i = 0; i < 120; i++) await appendStandalone({ ...row({ pot: i % 2 ? "ads" : "messaging" }), phase: "info" }, silent);
    await appendStandalone({ ...row({ tenantId: "t2" }), phase: "info" }, silent);
    const first = await listLedger("t1", { limit: 500 });
    expect(first.rows).toHaveLength(100);
    expect(first.rows[0].seq > first.rows[99].seq).toBe(true);
    const second = await listLedger("t1", { limit: 500, cursor: first.nextCursor });
    expect(second.rows).toHaveLength(20);
    expect(second.nextCursor).toBeNull();
    expect(new Set([...first.rows, ...second.rows].map((r) => r.id)).size).toBe(120);
    expect((await listLedger("t1", { pot: "ads", limit: 100 })).rows.every((r) => r.pot === "ads")).toBe(true);
    expect((await listLedger("t1", { order: "asc", limit: 2 })).rows.map((r) => r.seq)).toEqual([1n, 2n]);
    expect((await listLedger("t1", {})).rows).toHaveLength(50);
    expect((await listLedger("t2", {})).rows).toHaveLength(1);
    await expect(listLedger("t1", { cursor: "1; drop" })).rejects.toThrow(RangeError);
  });

  it("cannot be changed afterwards (the fake models the 0009 trigger)", async () => {
    await appendStandalone({ ...row(), phase: "info" }, silent);
    await expect(h.db.model("spendLedger").updateMany({ where: { tenantId: "t1" }, data: { reason: "x" } })).rejects.toMatchObject({ sqlState: "42501" });
    await expect(h.db.model("spendLedger").deleteMany({ where: { tenantId: "t1" } })).rejects.toMatchObject({ sqlState: "42501" });
  });

  it("is the only writer of the ledger in src (bypass rule B6 starts here)", { timeout: SCAN_TIMEOUT }, () => {
    const offenders: string[] = [];
    const walk = (dir: string) => {
      for (const entry of readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) {
          if (entry.name !== "generated") walk(full);
        } else if (/\.tsx?$/.test(entry.name)) {
          const rel = path.relative(ROOT, full).split(path.sep).join("/");
          if (rel === "src/lib/spend/ledger.ts" || rel === "src/lib/lifecycle/erase-workspace.ts") continue;
          if (/spendLedger\.(create|createMany|update|updateMany|upsert|delete|deleteMany)\b/.test(readFileSync(full, "utf8"))) offenders.push(rel);
        }
      }
    };
    walk(path.join(ROOT, "src"));
    expect(offenders).toEqual([]);
  });
});

// =====================================================================================================================
describe("permits (rule B8)", () => {
  const data = (over: Partial<AdsPermitData> = {}): AdsPermitData => ({
    type: "ads",
    kind: "raise_budget",
    correlationId: "sc_1",
    tenantId: "t1",
    adAccountAssetId: "as1",
    accountExternalId: "act_1",
    objects: { m1: { maxDailyMinor: 100_000n } },
    paths: ["m1"],
    maxUses: 2,
    issuedAt: new Date(Date.now() - 1000),
    expiresAt: new Date(Date.now() + 10 * 60_000),
    ...over,
  });

  it("exist only through mintPermit: a look-alike object is refused", async () => {
    const permit = mintPermit(data());
    expect(isMintedPermit(permit)).toBe(true);
    const fake = { ...permit };
    expect(isMintedPermit(fake)).toBe(false);
    expect(usePermit(fake)).toEqual({ ok: false, reason: "not_minted" });
    expect(() => runWithPermit(fake as typeof permit, () => 1)).toThrow(SpendGuardBypassError);
    expect(isMintedPermit(JSON.parse(JSON.stringify({ a: 1 })))).toBe(false);
  });

  it("are frozen copies: changing the input or the permit changes nothing", () => {
    const input = data();
    const permit = mintPermit(input);
    (input.objects.m1 as { maxDailyMinor?: bigint }).maxDailyMinor = 10n ** 9n;
    input.paths = ["act_1/campaigns"];
    input.expiresAt.setTime(Date.now() + 10 ** 9);
    expect(permit.objects.m1.maxDailyMinor).toBe(100_000n);
    expect(permit.paths).toEqual(["m1"]);
    expect(permit.expiresAt.getTime()).toBeLessThan(Date.now() + 11 * 60_000);
    expect(Object.isFrozen(permit)).toBe(true);
    expect(() => {
      (permit as { maxUses: number }).maxUses = 99;
    }).toThrow(TypeError);
  });

  it("count uses and expire", () => {
    const permit = mintPermit(data({ maxUses: 2 }));
    expect(usePermit(permit)).toEqual({ ok: true, remaining: 1 });
    expect(usePermit(permit)).toEqual({ ok: true, remaining: 0 });
    expect(usePermit(permit)).toEqual({ ok: false, reason: "used_up" });
    expect(permitUses(permit)).toBe(2);
    const later = mintPermit(data());
    expect(usePermit(later, new Date(Date.now() + 11 * 60_000))).toEqual({ ok: false, reason: "expired" });
  });

  it("refuse to mint anything incomplete", () => {
    expect(() => mintPermit(data({ paths: [] }))).toThrow(SpendGuardBypassError);
    expect(() => mintPermit(data({ maxUses: 0 }))).toThrow(SpendGuardBypassError);
    expect(() => mintPermit(data({ tenantId: "" }))).toThrow(SpendGuardBypassError);
    expect(() => mintPermit(data({ objects: {} }))).toThrow(SpendGuardBypassError);
    expect(() => mintPermit(data({ expiresAt: new Date(Date.now() - 5000) }))).toThrow(SpendGuardBypassError);
    expect(() => mintPermit({ type: "lowering", kind: "pause", correlationId: "c", tenantId: "t", metaObjectIds: [], paths: ["x"], maxUses: 1, issuedAt: new Date(), expiresAt: new Date(Date.now() + 1000) })).toThrow(SpendGuardBypassError);
  });

  it("run inside the async permit store", async () => {
    const permit = mintPermit({ type: "msg", correlationId: "c", tenantId: "t1", phoneNumberId: "pn1", paths: ["pn1/messages"], maxUses: 1, issuedAt: new Date(), expiresAt: new Date(Date.now() + 120_000) });
    expect(currentPermit()).toBeUndefined();
    const seen = await runWithPermit(permit, async () => {
      await new Promise((r) => setTimeout(r, 1));
      return currentPermit();
    });
    expect(seen).toBe(permit);
    expect(permitStore.getStore()).toBeUndefined();
  });

  it("are never cast into existence (`as Permit` appears nowhere in src/lib/spend)", () => {
    for (const file of readdirSync(path.join(ROOT, "src/lib/spend"))) {
      if (!file.endsWith(".ts")) continue;
      expect(read(`src/lib/spend/${file}`), file).not.toMatch(/\bas\s+\w*Permit\b(?!Data)/);
    }
  });
});

// =====================================================================================================================
describe("rollout flags (4.14)", () => {
  it("default to observe, report, off and false", () => {
    expect(spendEnforceMode({})).toBe("observe");
    expect(spendTripwireMode({})).toBe("report");
    expect(spendCapMode({})).toBe("off");
    expect(assistantSpendEnabled({})).toBe(false);
    expect(spendDryRun({})).toBe(false);
    expect(spendSim({})).toBe(false);
    expect(spendFlags({})).toEqual({ enforce: "observe", tripwire: "report", capMode: "off", assistantSpendEnabled: false, dryRun: false, sim: false, legacyMaxDailyBudgetMinor: null });
  });

  it("read the documented values and ignore anything else", () => {
    expect(spendEnforceMode({ SPEND_ENFORCE: "enforce" })).toBe("enforce");
    expect(spendEnforceMode({ SPEND_ENFORCE: "yes" })).toBe("observe");
    expect(spendTripwireMode({ SPEND_TRIPWIRE: " ENFORCE " })).toBe("enforce");
    expect(spendCapMode({ SPEND_CAP_MODE: "observe" })).toBe("observe");
    expect(spendCapMode({ SPEND_CAP_MODE: "enforce" })).toBe("enforce");
    expect(spendCapMode({ SPEND_CAP_MODE: "on" })).toBe("off");
    expect(assistantSpendEnabled({ ASSISTANT_SPEND_ENABLED: "true" })).toBe(true);
    expect(assistantSpendEnabled({ ASSISTANT_SPEND_ENABLED: "1" })).toBe(false);
    expect(spendDryRun({ SPEND_DRY_RUN: "1" })).toBe(true);
    expect(spendSim({ SPEND_SIM: "1" })).toBe(true);
  });

  it("never dry-run in production", () => {
    expect(spendDryRun({ SPEND_DRY_RUN: "1", NODE_ENV: "production" })).toBe(false);
  });

  it("read the deprecated MAX_DAILY_BUDGET_MINOR once with a warning", () => {
    resetFlagWarningsForTests();
    const warn = vi.fn();
    expect(legacyMaxDailyBudgetMinor({ MAX_DAILY_BUDGET_MINOR: "100000" }, warn)).toBe(100_000n);
    expect(legacyMaxDailyBudgetMinor({ MAX_DAILY_BUDGET_MINOR: "100000" }, warn)).toBe(100_000n);
    expect(warn).toHaveBeenCalledTimes(1);
    expect(legacyMaxDailyBudgetMinor({ MAX_DAILY_BUDGET_MINOR: "abc" }, warn)).toBeNull();
    expect(legacyMaxDailyBudgetMinor({ MAX_DAILY_BUDGET_MINOR: "0" }, warn)).toBeNull();
  });
});

// =====================================================================================================================
describe("spend HTTP helpers", () => {
  it("answer a refusal with the copy, the code and JSON-safe parameters", async () => {
    const res = spendErrorResponse(new SpendBlockedError("spend.daily_limit", { left: { minor: 85_000n, currency: "INR" }, needs: { minor: 140_000n, currency: "INR" } }));
    expect(res.status).toBe(409);
    const body = await res.json();
    expect(body.code).toBe("spend.daily_limit");
    expect(body.error).toContain("Left today: ₹850.");
    expect(body.params.left).toEqual({ minor: "85000", currency: "INR" });
  });

  it("map busy, approval, shadow, bypass and other errors", async () => {
    const busy = spendErrorResponse(new SpendBusyError());
    expect([busy.status, busy.headers.get("Retry-After"), (await busy.json()).error]).toEqual([503, "2", "Busy checking your limits. Try again in a moment."]);
    const approval = spendErrorResponse(new NeedsApprovalError("ap_1", new Date("2026-10-28T21:00:00Z")));
    expect([approval.status, await approval.json()]).toEqual([202, expect.objectContaining({ code: "spend.needs_approval", approvalId: "ap_1", expiresAt: "2026-10-28T21:00:00.000Z" })]);
    expect(spendErrorResponse(new ShadowOnlyError("sh_1")).status).toBe(202);
    const bypass = spendErrorResponse(new SpendGuardBypassError("no_permit"));
    expect([bypass.status, (await bypass.json()).code]).toEqual([500, "spend_bypass"]);
    expect(spendErrorResponse(new SpendBlockedError("spend.only_owner_raise")).status).toBe(403);
    expect(spendErrorResponse(new SpendBlockedError("ai_quota")).status).toBe(402);
    const spy = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const other = spendErrorResponse(new Error("secret detail"));
    expect([other.status, await other.json()]).toEqual([500, { error: "Something went wrong." }]);
    spy.mockRestore();
  });

  it("read limits as minor units, with null for Not set", () => {
    expect(parseLimitInput(undefined)).toBeUndefined();
    expect(parseLimitInput(null)).toBeNull();
    expect(parseLimitInput("")).toBeNull();
    expect(parseLimitInput("200000")).toBe(200_000n);
    expect(parseLimitInput(5000)).toBe(5000n);
    for (const bad of ["0", "-5", "1.5", "abc", 1.5, {}, true]) expect(() => parseLimitInput(bad, "daily limit"), String(bad)).toThrow(/daily limit/);
  });

  it("make bigint and dates JSON-safe", () => {
    expect(jsonSafe({ a: 1n, b: [2n, { c: new Date("2026-01-01T00:00:00Z") }], d: undefined })).toEqual({ a: "1", b: ["2", { c: "2026-01-01T00:00:00.000Z" }] });
  });
});

// =====================================================================================================================
describe("shared contracts", () => {
  it("names the spend queues", () => {
    expect(SPEND_QUEUES).toEqual({
      stop: "spend.stop",
      metacapReplan: "spend.metacap.replan",
      metacapP0: "spend.metacap.p0",
      metacapOffboard: "spend.metacap.offboard",
      breakersRun: "spend.breakers.run",
    });
  });

  it("mirrors the probation rows seeded by 0009", () => {
    const sql = read("prisma/migrations/0009_spend_controls/migration.sql");
    expect(PROBATION_CEILING_DEFAULTS.ads).toEqual({ currency: "INR", dailyMinor: 200_000n, monthlyMinor: 2_000_000n });
    expect(PROBATION_CEILING_DEFAULTS.messaging).toEqual({ currency: "INR", dailyMinor: 50_000n, monthlyMinor: 500_000n });
    expect(PROBATION_CEILING_DEFAULTS.ai).toEqual({ currency: "CRD", dailyMinor: null, monthlyMinor: 500n });
    expect(sql).toContain("'ads','INR',200000,2000000");
    expect(sql).toContain("'messaging','INR',50000,500000");
    expect(sql).toContain("'ai','CRD',NULL,500");
  });

  it("gives Eddy the owner's defaults: off, v1, Sonnet 5.5 at low effort, 40/10 credits a member-day, 30 a turn, 40 turns at once", () => {
    const cfg = readEddyConfig({});
    expect(cfg).toEqual({
      enabled: false,
      phase: 1,
      model: "claude-sonnet-5-5",
      effort: "low",
      maxTokens: 8000,
      maxCreditsPerUserDay: 40,
      maxCreditsPerUnverifiedUserDay: 10,
      maxCreditsPerTurn: 30,
      maxConcurrentTurns: 40,
      microUsdPerCredit: 10_000,
      tailCacheTtl: "5m",
      fallbacks: true,
    });
    expect(EDDY_DEFAULTS.enabled).toBe(false);
    expect(readEddyConfig({ EDDY_ENABLED: "1" }).enabled).toBe(false);
    expect(readEddyConfig({ EDDY_ENABLED: "true", EDDY_PHASE: "2", EDDY_MODEL: "claude-opus-5-5", EDDY_EFFORT: "medium" })).toMatchObject({ enabled: true, phase: 2, model: "claude-opus-5-5", effort: "medium" });
    expect(readEddyConfig({ EDDY_MODEL: "gpt-x", EDDY_EFFORT: "turbo", EDDY_MAX_TOKENS: "10", EDDY_MAX_CREDITS_PER_TURN: "-1" })).toMatchObject({ model: "claude-sonnet-5-5", effort: "low", maxTokens: 2000, maxCreditsPerTurn: 30 });
    expect(memberDailyCreditCap(cfg, true)).toBe(40);
    expect(memberDailyCreditCap(cfg, false)).toBe(10);
    expect(microUsdToCredits(10_000)).toBe(1);
    expect(microUsdToCredits(10_001)).toBe(2);
    expect(microUsdToCredits(0)).toBe(0);
    expect(microUsdToCredits(25_000n, 10_000)).toBe(3);
  });

  it("lists every SSE event type of 5.12", () => {
    const sample: Record<EddyEvent["type"], true> = { turn: true, status: true, delta: true, message: true, reset: true, card: true, done_action: true, refused_action: true, intent: true, end: true, error: true };
    expect([...EDDY_EVENT_TYPES].sort()).toEqual(Object.keys(sample).sort());
  });

  it("gives every model round and screen its own reservation subject (E9)", () => {
    expect(eddyRoundSubjectId("turn_1", 0)).toBe("turn_1:0");
    expect(eddyScreenSubjectId("turn_1", 2)).toBe("turn_1:screen:2");
    expect(() => eddyRoundSubjectId("bad id", 1)).toThrow(RangeError);
    expect(() => eddyRoundSubjectId("t", -1)).toThrow(RangeError);
  });

  it("keeps the contract files free of prisma, fetch and runtime SDK imports", () => {
    const pure = [
      "src/lib/spend/types.ts",
      "src/lib/spend/money.ts",
      "src/lib/spend/periods.ts",
      "src/lib/spend/copy.ts",
      "src/lib/spend/flags.ts",
      "src/lib/spend/permit.ts",
      "src/lib/actions/types.ts",
      "src/lib/eddy/contract.ts",
      "src/lib/eddy/model.ts",
    ];
    for (const file of pure) {
      const source = read(file);
      expect(source, file).not.toMatch(/from "@\/lib\/db"|@prisma\/|generated\/prisma|\bfetch\(/);
    }
    for (const file of ["src/lib/spend/types.ts", "src/lib/actions/types.ts"]) {
      for (const line of read(file).split("\n").filter((l) => /^import\b/.test(l))) expect(line, file).toMatch(/^import type\b/);
    }
  });

  it("imports @anthropic-ai/sdk only as types outside the AI gateway (rule B2b)", { timeout: SCAN_TIMEOUT }, () => {
    const hits: string[] = [];
    const walk = (dir: string) => {
      for (const entry of readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) {
          if (entry.name !== "generated") walk(full);
          continue;
        }
        if (!/\.tsx?$/.test(entry.name)) continue;
        const rel = path.relative(ROOT, full).split(path.sep).join("/");
        if (rel === "src/lib/spend/exec/ai-stream.ts") continue;
        for (const line of readFileSync(full, "utf8").split("\n")) {
          if (/["']@anthropic-ai\/sdk/.test(line) && !/^\s*import type\b/.test(line)) hits.push(`${rel}: ${line.trim()}`);
        }
      }
    };
    walk(path.join(ROOT, "src"));
    expect(hits).toEqual([]);
  });

  it("pins the SDK exactly and fast-check for the property tests", () => {
    const pkg = JSON.parse(read("package.json"));
    expect(pkg.dependencies["@anthropic-ai/sdk"]).toBe("1.3.0");
    expect(pkg.devDependencies["fast-check"]).toMatch(/^\d+\.\d+\.\d+$/);
    expect(pkg.scripts["test:db"]).toBe("vitest run --project db");
    expect(pkg.scripts["eval:eddy"]).toContain("evals/eddy/run.ts");
    expect(pkg.scripts["eval:eddy"]).toMatch(/^esbuild /);
  });
});
