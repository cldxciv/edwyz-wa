/**
 * In-memory stand-in for the layers UNDER the AI gateway (src/lib/spend/exec/ai.ts, docs/SPEND-CONTROLS-SPEC.md 4.10), so
 * the tests of its callers (the AI agent, the AI test panel, reply suggestions, the chatbot's escalation check and
 * billing/limits reserveCredits) run the real gateway: the freeze check, the hold, every model round through
 * anthropicMessages() with the real URL and headers, and the settle that writes the usage.
 *
 * Each module is replaced at its boundary, and only for the AI pot; anything else goes to the real module:
 * - @/lib/spend/kill          spendState(): the freeze levels set with freeze()
 * - @/lib/spend/control       getControl(): the workspace time zone (Asia/Kolkata unless set)
 * - @/lib/spend/allowances    effectiveLimits(): the AI pot. Monthly is the plan's credits (ai-agent/credits
 *                             effectiveCreditLimit, so registerAiAgentSeams and AI_DEFAULT_MONTHLY_CREDITS keep working),
 *                             lowered by an owner limit set with ownerLimits(); daily is the owner's daily limit
 * - @/lib/spend/counters      reserveCounter (the conditional reservation: both periods fit or neither changes, with no
 *                             await between the check and the increment, so parallel callers serialize as on the
 *                             Postgres row lock), releaseCounter, adjustSpent, ensureCounterRows, readCounters
 * - @/lib/spend/reservations  createCallReservation, settleCallReservation, releaseCallReservation
 * - @/lib/spend/ledger        appendStandalone (rows kept in `ledger`)
 * - @/lib/spend/notify        notifySpend (notices kept in `notices`)
 * - @/lib/lifecycle/state     claimOnce, releaseClaim (optional: leave it real when the test drives claims through its own
 *                             prisma.platformSetting, as the usage alert tests do)
 * plus `spendCounter`, the Prisma delegate the gateway's seedAiCounters() reads and writes: put it on the test's own fake
 * prisma. Credits already used this month come from the test's prisma.usageLedger.aggregate, which seedAiCounters reads
 * when it creates the day's and month's counter rows (I12).
 *
 * Wiring, in a test file (vi.mock factories must be written out in the file itself):
 *
 *   import { fakeAi } from "./helpers/fake-ai-gateway";
 *   vi.mock("@/lib/spend/kill", async (orig) => (await import("./helpers/fake-ai-gateway")).fakeAiModule("kill", await orig()));
 *   ...one line each for control, allowances, counters, reservations, ledger, notify and lifecycle (see FakeAiModuleName)
 *   beforeEach(async () => { await fakeAi.reset(); });
 *
 * This file imports nothing from src at load time (vi.mock factories run before the test's imports), only types.
 */
import type { CounterKeys } from "@/lib/spend/counters";
import type { FreezeLevel, FreezeState, NotifyResult, SpendNotice } from "@/lib/spend/types";

type Big = bigint;
type CounterRow = { tenantId: string; pot: string; periodKind: "day" | "month"; periodKey: string; currency: string; spentMinor: Big; reservedMinor: Big };
type CallReservation = {
  id: string;
  tenantId: string;
  pot: string;
  currency: string;
  subjectId: string;
  amountMinor: Big;
  consumedMinor: Big;
  keys: CounterKeys;
  status: "held" | "settled" | "released" | "expired";
  expiresAt: Date;
};
type Actual = Record<string, unknown>;

const AI = "ai";
const rowKey = (tenantId: string, pot: string, kind: string, key: string) => `${tenantId}|${pot}|${kind}|${key}`;
const maxBig = (a: Big, b: Big) => (a > b ? a : b);
const stricter = (a: FreezeLevel, b: FreezeLevel): FreezeLevel => (a === "all" || b === "all" ? "all" : a === "assistants" || b === "assistants" ? "assistants" : "none");

function createFakeAiGateway() {
  const counters = new Map<string, CounterRow>();
  const reservations = new Map<string, CallReservation>();
  const claims = new Set<string>();
  const ledger: Record<string, unknown>[] = [];
  const notices: SpendNotice[] = [];
  let freeze: { workspace: FreezeLevel; platform: FreezeLevel } = { workspace: "none", platform: "none" };
  let owner: { daily: Big | null; monthly: Big | null } = { daily: null, monthly: null };
  let timezone = "Asia/Kolkata";
  let seq = 0;

  const ensureRow = (tenantId: string, pot: string, kind: "day" | "month", key: string, currency: string, spent: Big = 0n): { row: CounterRow; created: boolean } => {
    const k = rowKey(tenantId, pot, kind, key);
    const found = counters.get(k);
    if (found) return { row: found, created: false };
    const row: CounterRow = { tenantId, pot, periodKind: kind, periodKey: key, currency, spentMinor: spent, reservedMinor: 0n };
    counters.set(k, row);
    return { row, created: true };
  };
  const rowsOf = (tenantId: string, pot: string, keys: CounterKeys) => [counters.get(rowKey(tenantId, pot, "day", keys.day)), counters.get(rowKey(tenantId, pot, "month", keys.month))];
  const figures = (r: CounterRow | undefined) => {
    const spent = r?.spentMinor ?? 0n;
    const reserved = r?.reservedMinor ?? 0n;
    return { spent, reserved, used: spent + reserved };
  };
  /** Moves `release` out of reserved and `delta` into spent on both period rows (the settle statement). */
  const settleRows = (tenantId: string, pot: string, keys: CounterKeys, release: Big, delta: Big): number => {
    let n = 0;
    for (const r of rowsOf(tenantId, pot, keys)) {
      if (!r) continue;
      r.reservedMinor = maxBig(0n, r.reservedMinor - release);
      r.spentMinor = maxBig(0n, r.spentMinor + delta);
      n++;
    }
    return n;
  };
  const closeReservation = (id: string, status: "settled" | "released", actual: Big | null) => {
    const r = reservations.get(id)!;
    if (r.status !== "held") return { closed: false, releasedMinor: 0n, status: r.status };
    r.status = status;
    if (actual !== null) r.consumedMinor = actual;
    settleRows(r.tenantId, r.pot, r.keys, r.amountMinor, status === "settled" ? (actual ?? 0n) : 0n);
    return { closed: true, releasedMinor: r.amountMinor, status };
  };

  /** The Prisma delegate the gateway's seedAiCounters() uses (findMany with select, createMany with skipDuplicates). */
  const spendCounter = {
    async findMany(args: { where?: { tenantId?: string; pot?: string; OR?: { periodKind: string; periodKey: string }[] } } = {}) {
      const w = args.where ?? {};
      return [...counters.values()]
        .filter((r) => (w.tenantId === undefined || r.tenantId === w.tenantId) && (w.pot === undefined || r.pot === w.pot))
        .filter((r) => !w.OR || w.OR.some((o) => o.periodKind === r.periodKind && o.periodKey === r.periodKey))
        .map((r) => ({ ...r }));
    },
    async createMany(args: { data: { tenantId: string; pot: string; periodKind: "day" | "month"; periodKey: string; currency: string; spentMinor?: Big }[]; skipDuplicates?: boolean }) {
      let count = 0;
      for (const d of args.data) if (ensureRow(d.tenantId, d.pot, d.periodKind, d.periodKey, d.currency, d.spentMinor ?? 0n).created) count++;
      return { count };
    },
  };

  const modules = {
    kill: (actual: Actual) => ({
      ...actual,
      spendState: async (): Promise<FreezeState> => ({
        workspace: freeze.workspace,
        platform: freeze.platform,
        effective: stricter(freeze.workspace, freeze.platform),
        frozenAt: null,
        frozenByKind: null,
        frozenByUserId: null,
        reason: null,
      }),
    }),

    control: (actual: Actual) => ({
      ...actual,
      getControl: async (tenantId: string) => ({
        tenantId,
        freeze: freeze.workspace,
        frozenByKind: null,
        frozenByUserId: null,
        frozenReason: null,
        frozenAt: null,
        probation: "auto",
        probationReason: null,
        probationChangedByUserId: null,
        verifiedAt: null,
        spendingAdAccountAssetId: null,
        timezone,
        approverUserIds: [],
        approvalTtlHours: 12,
        targetCostPerLeadMinor: null,
        breakersMayPauseHumanCampaigns: false,
        digestEnabled: true,
        version: 1,
        updatedAt: null,
      }),
    }),

    // Only the fields the gateway reads (daily, monthly, planCapMonthly, rules.assistantRefusal) carry meaning here.
    allowances: (actual: Actual) => ({
      ...actual,
      effectiveLimits: async (tenantId: string, pot: string, ...rest: unknown[]) => {
        if (pot !== AI) return (actual.effectiveLimits as (...a: unknown[]) => unknown)(tenantId, pot, ...rest);
        const { effectiveCreditLimit } = await import("@/lib/ai-agent/credits");
        const plan = BigInt(await effectiveCreditLimit(tenantId));
        const monthly = owner.monthly === null ? plan : owner.monthly < plan ? owner.monthly : plan;
        return {
          pot: AI,
          currency: "CRD",
          daily: owner.daily,
          monthly,
          owner: { ...owner },
          planCapMonthly: plan,
          unknownCeiling: false,
          rules: { adsCanStart: true, humansChecked: { daily: true, monthly: true }, assistantRefusal: null, humanRefusal: null },
        };
      },
    }),

    counters: (actual: Actual) => {
      const real = <F>(name: string) => actual[name] as F;
      return {
        ...actual,
        ensureCounterRows: async (tenantId: string, pot: string, keys: CounterKeys, currency: string, ...rest: unknown[]) => {
          if (pot !== AI) return real<(...a: unknown[]) => Promise<void>>("ensureCounterRows")(tenantId, pot, keys, currency, ...rest);
          ensureRow(tenantId, pot, "day", keys.day, currency);
          ensureRow(tenantId, pot, "month", keys.month, currency);
        },
        reserveCounter: async (input: { tenantId: string; pot: string; amountMinor: Big; dayLimitMinor: Big | null; monthLimitMinor: Big | null; currency?: string; keys?: CounterKeys }, ...rest: unknown[]) => {
          if (input.pot !== AI || !input.keys) return real<(...a: unknown[]) => Promise<unknown>>("reserveCounter")(input, ...rest);
          if (input.amountMinor < 0n) throw new RangeError("A reservation cannot be negative.");
          const keys = input.keys;
          if (input.amountMinor === 0n) return { ok: true, keys, dayTotal: null, monthTotal: null };
          // No await from here to the increment: the check and the update are one step, like the conditional UPDATE.
          const d = ensureRow(input.tenantId, AI, "day", keys.day, input.currency ?? "CRD").row;
          const m = ensureRow(input.tenantId, AI, "month", keys.month, input.currency ?? "CRD").row;
          const fits = (r: CounterRow, limit: Big | null) => limit === null || r.spentMinor + r.reservedMinor + input.amountMinor <= limit;
          const dOk = fits(d, input.dayLimitMinor);
          const mOk = fits(m, input.monthLimitMinor);
          if (!dOk || !mOk) return { ok: false, keys, exhausted: !dOk && !mOk ? "both" : !dOk ? "day" : "month" };
          d.reservedMinor += input.amountMinor;
          m.reservedMinor += input.amountMinor;
          return { ok: true, keys, dayTotal: d.spentMinor + d.reservedMinor, monthTotal: m.spentMinor + m.reservedMinor };
        },
        releaseCounter: async (input: { tenantId: string; pot: string; keys: CounterKeys; amountMinor: Big }, ...rest: unknown[]) => {
          if (input.pot !== AI) return real<(...a: unknown[]) => Promise<number>>("releaseCounter")(input, ...rest);
          return settleRows(input.tenantId, AI, input.keys, input.amountMinor, 0n);
        },
        adjustSpent: async (input: { tenantId: string; pot: string; keys: CounterKeys; deltaMinor: Big }, ...rest: unknown[]) => {
          if (input.pot !== AI) return real<(...a: unknown[]) => Promise<number>>("adjustSpent")(input, ...rest);
          return settleRows(input.tenantId, AI, input.keys, 0n, input.deltaMinor);
        },
        readCounters: async (tenantId: string, pot: string, keys: CounterKeys, ...rest: unknown[]) => {
          if (pot !== AI) return real<(...a: unknown[]) => Promise<unknown>>("readCounters")(tenantId, pot, keys, ...rest);
          const [day, month] = rowsOf(tenantId, AI, keys);
          return { day: figures(day), month: figures(month) };
        },
      };
    },

    reservations: (actual: Actual) => {
      const real = <F>(name: string) => actual[name] as F;
      return {
        ...actual,
        createCallReservation: async (input: { tenantId: string; pot: string; currency: string; subjectId: string; amountMinor: Big; keys: CounterKeys; ttlMs: number; now?: Date }, ...rest: unknown[]) => {
          if (input.pot !== AI) return real<(...a: unknown[]) => Promise<unknown>>("createCallReservation")(input, ...rest);
          if (input.amountMinor <= 0n) throw new RangeError("A call reservation must be above zero.");
          // The partial unique index of 0009: one open hold per subject.
          if ([...reservations.values()].some((r) => r.status === "held" && r.tenantId === input.tenantId && r.subjectId === input.subjectId)) {
            throw Object.assign(new Error("Unique constraint failed on SpendReservation_open_subject_key"), { code: "P2002" });
          }
          const now = input.now ?? new Date();
          const row: CallReservation = {
            id: `fake_sr_${++seq}`,
            tenantId: input.tenantId,
            pot: AI,
            currency: input.currency,
            subjectId: input.subjectId,
            amountMinor: input.amountMinor,
            consumedMinor: 0n,
            keys: input.keys,
            status: "held",
            expiresAt: new Date(now.getTime() + input.ttlMs),
          };
          reservations.set(row.id, row);
          return { ...row, subjectType: "ai_call", dayKey: row.keys.day, monthKey: row.keys.month };
        },
        settleCallReservation: async (id: string, actualMinor: Big, ...rest: unknown[]) => {
          if (!reservations.has(id)) return real<(...a: unknown[]) => Promise<unknown>>("settleCallReservation")(id, actualMinor, ...rest);
          if (actualMinor < 0n) throw new RangeError("Actual usage cannot be negative.");
          return closeReservation(id, "settled", actualMinor);
        },
        releaseCallReservation: async (id: string, ...rest: unknown[]) => {
          if (!reservations.has(id)) return real<(...a: unknown[]) => Promise<unknown>>("releaseCallReservation")(id, ...rest);
          return closeReservation(id, "released", null);
        },
      };
    },

    ledger: (actual: Actual) => ({
      ...actual,
      appendStandalone: async (row: Record<string, unknown>) => {
        const record = { ...row, id: `fake_led_${++seq}`, seq: BigInt(seq) };
        ledger.push(record);
        return { record, created: true };
      },
    }),

    notify: (actual: Actual) => ({
      ...actual,
      notifySpend: async (notice: SpendNotice): Promise<NotifyResult> => {
        notices.push(notice);
        return { delivered: ["in_app"] as NotifyResult["delivered"], skipped: [], deduplicated: false };
      },
    }),

    lifecycle: (actual: Actual) => ({
      ...actual,
      claimOnce: async (key: string) => {
        if (claims.has(key)) return false;
        claims.add(key);
        return true;
      },
      releaseClaim: async (key: string) => {
        claims.delete(key);
      },
    }),
  };

  return {
    modules,
    spendCounter,
    ledger,
    notices,
    /** Forgets every counter, hold, claim, ledger row and notice, and the settings below. Also clears the gateway's own record of seeded counter rows. */
    async reset(): Promise<void> {
      counters.clear();
      reservations.clear();
      claims.clear();
      ledger.length = 0;
      notices.length = 0;
      freeze = { workspace: "none", platform: "none" };
      owner = { daily: null, monthly: null };
      timezone = "Asia/Kolkata";
      (await import("@/lib/spend/exec/ai")).resetAiCounterSeeds();
    },
    /** "Stop spending": the workspace's and the platform's freeze levels. */
    freeze(workspace: FreezeLevel, platform: FreezeLevel = "none"): void {
      freeze = { workspace, platform };
    },
    /** The owner's own AI limits in credits (null = not set); the monthly one never lifts the plan's credits. */
    ownerLimits(limits: { daily?: number | null; monthly?: number | null }): void {
      owner = { daily: limits.daily == null ? null : BigInt(limits.daily), monthly: limits.monthly == null ? null : BigInt(limits.monthly) };
    },
    setTimezone(zone: string): void {
      timezone = zone;
    },
    /** The AI counter of one period: spent, reserved and their sum (zeros when the row does not exist yet). */
    counter(tenantId: string, kind: "day" | "month") {
      const row = [...counters.values()].find((r) => r.tenantId === tenantId && r.pot === AI && r.periodKind === kind);
      return figures(row);
    },
    /** Holds (ai_call reservations) of a workspace still open. */
    openHolds(tenantId: string): number {
      return [...reservations.values()].filter((r) => r.tenantId === tenantId && r.status === "held").length;
    },
  };
}

export type FakeAiGateway = ReturnType<typeof createFakeAiGateway>;
export type FakeAiModuleName = keyof FakeAiGateway["modules"];

/** One fake per test file: vitest gives every test file its own module registry, so the mocks and the test share it. */
export const fakeAi: FakeAiGateway = createFakeAiGateway();

/** The replacement for one module under the gateway, built over the real module (`await orig()` in the vi.mock factory). */
export function fakeAiModule(name: FakeAiModuleName, actual: unknown): Record<string, unknown> {
  return fakeAi.modules[name]((actual ?? {}) as Actual);
}
