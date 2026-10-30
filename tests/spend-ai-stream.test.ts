import { readFileSync } from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { matchesWhere, type FakeSpendDb, type RawCall, type Row } from "./helpers/fake-spend-db";
import type { FreezeLevel } from "@/lib/spend/types";

/**
 * Eddy's streaming entry point to the AI gateway (docs/EDDY-SPEC.md 5.1, 5.2, 5.10; Phase 0 requests E1, E2, E9; Eddy 12.1a
 * decision 13). The Anthropic SDK is mocked: no request ever leaves the test. Underneath, the real gateway (ai.ts), counters,
 * reservations, ledger and usage modules run over the in-memory spend database with the counter and reservation statements
 * emulated atomically, as in tests/spend-ai.test.ts.
 */

type Limits = { daily: bigint | null; monthly: bigint | null; plan: bigint };
type Script = {
  events?: Record<string, unknown>[];
  final?: Record<string, unknown>;
  /** Thrown after event `failAfter` (or, without it, after the last event). */
  failWith?: unknown;
  failAfter?: number;
  /** Thrown by client.beta.messages.stream() itself. */
  throwOnCreate?: unknown;
  /** The stream waits for this before its first event. */
  gate?: Promise<void>;
};

const sdk = vi.hoisted(() => {
  class APIUserAbortError extends Error {
    constructor() {
      super("Request was aborted.");
      this.name = "APIUserAbortError";
    }
  }
  const state = {
    constructed: [] as unknown[],
    calls: [] as { params: unknown; opts: { signal?: AbortSignal } | undefined }[],
    scripts: [] as Script[],
  };
  const clone = <T,>(v: T): T => JSON.parse(JSON.stringify(v)) as T;

  /** A stand-in for BetaMessageStream: streamEvent listeners, currentMessage, finalMessage(), and abort on the signal. */
  function makeStream(script: Script, signal: AbortSignal | undefined) {
    const listeners: ((event: unknown, snapshot: unknown) => void)[] = [];
    let current: Record<string, unknown> | undefined;
    const apply = (e: Record<string, unknown>) => {
      if (e.type === "message_start") current = clone(e.message as Record<string, unknown>);
      else if (!current) return;
      else if (e.type === "content_block_start") (current.content as unknown[]).push(clone(e.content_block));
      else if (e.type === "content_block_delta") {
        const block = (current.content as Record<string, unknown>[])[e.index as number];
        const delta = e.delta as Record<string, unknown>;
        if (delta.type === "text_delta") block.text = String(block.text ?? "") + String(delta.text);
        if (delta.type === "thinking_delta") block.thinking = String(block.thinking ?? "") + String(delta.thinking);
      } else if (e.type === "message_delta") {
        current.usage = { ...(current.usage as object), ...(e.usage as object) };
        current.stop_reason = (e.delta as Record<string, unknown>).stop_reason;
      }
    };
    const stream = {
      on(event: string, fn: (event: unknown, snapshot: unknown) => void) {
        if (event === "streamEvent") listeners.push(fn);
        return stream;
      },
      get currentMessage() {
        return current;
      },
      async finalMessage() {
        if (script.gate) await script.gate;
        const events = script.events ?? [];
        for (let i = 0; i < events.length; i++) {
          await Promise.resolve();
          if (signal?.aborted) throw new APIUserAbortError();
          apply(events[i]);
          for (const l of listeners) l(events[i], current);
          if (script.failWith !== undefined && script.failAfter === i) throw script.failWith;
        }
        await Promise.resolve();
        if (signal?.aborted) throw new APIUserAbortError();
        if (script.failWith !== undefined) throw script.failWith;
        return script.final ?? current;
      },
    };
    return stream;
  }
  return { APIUserAbortError, state, makeStream };
});

const h = vi.hoisted(() => ({
  db: null as unknown as FakeSpendDb,
  freeze: { workspace: "none", platform: "none" } as { workspace: FreezeLevel; platform: FreezeLevel },
  limits: { daily: null, monthly: 1000n, plan: 1000n } as Limits,
}));

vi.mock("@anthropic-ai/sdk", () => {
  class Anthropic {
    static APIUserAbortError = sdk.APIUserAbortError;
    beta: unknown;
    constructor(options: unknown) {
      sdk.state.constructed.push(options);
      this.beta = {
        messages: {
          stream: (params: unknown, opts?: { signal?: AbortSignal }) => {
            sdk.state.calls.push({ params, opts });
            const script = sdk.state.scripts.shift() ?? {};
            if (script.throwOnCreate !== undefined) throw script.throwOnCreate;
            return sdk.makeStream(script, opts?.signal);
          },
        },
      };
    }
  }
  return { default: Anthropic, Anthropic, APIUserAbortError: sdk.APIUserAbortError };
});
vi.mock("@/lib/db", async () => {
  const { createFakeSpendDb } = await import("./helpers/fake-spend-db");
  h.db = createFakeSpendDb();
  return { prisma: h.db.prisma };
});
vi.mock("@/lib/spend/kill", () => ({
  spendState: vi.fn(async () => ({ workspace: h.freeze.workspace, platform: h.freeze.platform, effective: "none", frozenAt: null, frozenByKind: null, frozenByUserId: null, reason: null })),
}));
vi.mock("@/lib/spend/allowances", () => ({
  effectiveLimits: vi.fn(async () => ({
    pot: "ai",
    currency: "CRD",
    daily: h.limits.daily,
    monthly: h.limits.monthly,
    planCapMonthly: h.limits.plan,
    unknownCeiling: false,
    rules: { adsCanStart: true, humansChecked: { daily: h.limits.daily !== null, monthly: true }, assistantRefusal: null, humanRefusal: null },
  })),
}));
vi.mock("@/lib/spend/notify", () => ({ notifySpend: vi.fn(async () => ({ delivered: ["in_app"], skipped: [], deduplicated: false })) }));
vi.mock("@/lib/lifecycle/state", () => {
  const claims = new Set<string>();
  return {
    claimOnce: vi.fn(async (key: string) => (claims.has(key) ? false : (claims.add(key), true))),
    releaseClaim: vi.fn(async (key: string) => void claims.delete(key)),
  };
});

import { eddyRoundSubjectId, eddyScreenSubjectId, type EddyRequest, type EddyUsage, type GatewayCtx, type StreamEvent } from "@/lib/eddy/model";
import { DEFAULT_AI_PRICES, aiPrices, iterationTokens, parsePriceOverride, priceFor, priceUsage, resetAiPricesCache, usageEntries, type UsageLike } from "@/lib/spend/exec/ai-pricing";
import { AI_STREAM_TTL_MS, resetAiCounterSeeds } from "@/lib/spend/exec/ai";
import {
  abortedUsage,
  ANTHROPIC_MAX_RETRIES,
  ANTHROPIC_TIMEOUT_MS,
  anthropicStream,
  anthropicStreamPort,
  createTurnMeter,
  estimateStreamedOutputTokens,
  resetAnthropicClient,
  type TurnMeter,
} from "@/lib/spend/exec/ai-stream";

// =====================================================================================================================
// The fake database (as in tests/spend-ai.test.ts)
// =====================================================================================================================

const max = (a: bigint, b: bigint) => (a > b ? a : b);

function emulateSql(db: FakeSpendDb): void {
  db.onRaw((call: RawCall) => {
    const rows = db.rows("spendCounter");
    const find = (t: unknown, pot: unknown, kind: string, key: unknown) => rows.find((r) => r.tenantId === t && r.pot === pot && r.periodKind === kind && r.periodKey === key);
    if (call.sql.includes("spend.counter.reserve")) {
      const [t, pot, day, month, c, dl, ml] = call.values as [string, string, string, string, bigint, bigint | null, bigint | null];
      const d = find(t, pot, "day", day);
      const m = find(t, pot, "month", month);
      const fits = (r: Row | undefined, lim: bigint | null) => !!r && (lim === null || (r.spentMinor as bigint) + (r.reservedMinor as bigint) + c <= lim);
      const dOk = fits(d, dl);
      const mOk = fits(m, ml);
      if (dOk && mOk) {
        d!.reservedMinor = (d!.reservedMinor as bigint) + c;
        m!.reservedMinor = (m!.reservedMinor as bigint) + c;
      }
      const total = (r: Row | undefined) => (r ? String((r.spentMinor as bigint) + (r.reservedMinor as bigint)) : null);
      return [{ d: dOk ? 1 : 0, m: mOk ? 1 : 0, dayTotal: dOk ? total(d) : null, monthTotal: mOk ? total(m) : null }];
    }
    if (call.sql.includes("spend.counter.settle")) {
      const [t, pot, day, month, rel, delta] = call.values as [string, string, string, string, bigint, bigint];
      for (const r of [find(t, pot, "day", day), find(t, pot, "month", month)]) {
        if (!r) continue;
        r.reservedMinor = max(0n, (r.reservedMinor as bigint) - rel);
        r.spentMinor = max(0n, (r.spentMinor as bigint) + delta);
      }
      return 2;
    }
    if (call.sql.includes("spend.reservation.close")) {
      const [id, status, now, actual] = call.values as [string, string, Date, bigint | null];
      const r = db.rows("spendReservation").find((x) => x.id === id);
      if (!r || r.status !== "held") return [];
      r.status = status === "released" && (r.consumedMinor as bigint) > 0n ? "settled" : status;
      r.closedAt = now;
      if (actual !== null) r.consumedMinor = actual;
      return [{ ...r, amountMinor: String(r.amountMinor), consumedMinor: String(r.consumedMinor) }];
    }
    return undefined;
  });
}

let usageIds = 0;
function patchUsageLedger(db: FakeSpendDb): void {
  const ul = (db.prisma as Record<string, unknown>).usageLedger as Record<string, unknown> & { __patched?: boolean };
  if (ul.__patched) return;
  const create = ul.create as (args: { data: Row }) => Promise<Row>;
  ul.create = async ({ data }: { data: Row }) => create({ data: { id: `ul_${++usageIds}`, createdAt: new Date(), ...data } });
  ul.aggregate = async ({ where }: { where?: Row }) => {
    const rows = db.rows("usageLedger").filter((r) => matchesWhere(r, where));
    return { _sum: { amount: rows.length ? rows.reduce((n, r) => n + Number(r.amount), 0) : null } };
  };
  ul.__patched = true;
}

// =====================================================================================================================
// Fixtures
// =====================================================================================================================

const T = "t1";
const NOW = new Date("2026-10-15T06:00:00Z");
const MODEL = "claude-sonnet-5-5";
const PARAMS = { model: MODEL, max_tokens: 8000, messages: [{ role: "user", content: "How many chats are open?" }] } as unknown as EddyRequest;

type UsageIn = Record<string, unknown>;
const message = (usage: UsageIn, opts: { model?: string; text?: string } = {}) => ({
  id: "msg_1",
  type: "message",
  role: "assistant",
  model: opts.model ?? MODEL,
  content: [{ type: "text", text: opts.text ?? "Three chats are open." }],
  stop_reason: "end_turn",
  stop_sequence: null,
  usage: { input_tokens: 0, output_tokens: 0, cache_read_input_tokens: 0, cache_creation_input_tokens: 0, ...usage },
});

/** The raw events of a message as the API streams them, ending in the final message. */
function scriptFor(final: ReturnType<typeof message>, extra: Partial<Script> = {}): Script {
  const text = String(final.content[0].text);
  const half = Math.ceil(text.length / 2);
  return {
    events: [
      { type: "message_start", message: { ...final, content: [], stop_reason: null, usage: { ...final.usage, output_tokens: 1 } } },
      { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } },
      { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: text.slice(0, half) } },
      { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: text.slice(half) } },
      { type: "content_block_stop", index: 0 },
      { type: "message_delta", delta: { stop_reason: "end_turn", stop_sequence: null }, usage: { output_tokens: final.usage.output_tokens } },
      { type: "message_stop" },
    ],
    final,
    ...extra,
  };
}

let meter: TurnMeter;
const gctx = (over: Partial<GatewayCtx> & Record<string, unknown> = {}): GatewayCtx => ({
  tenantId: T,
  feature: "eddy",
  requestedBy: { userId: "u1", role: "admin" },
  credits: 20,
  ref: { type: "eddy_turn", id: "turn_1" },
  subjectId: "turn_1:0",
  settle: (u: EddyUsage) => meter.settle(u),
  ...over,
});
const run = (ctx: GatewayCtx = gctx(), opts: { signal?: AbortSignal; onEvent?: (e: StreamEvent) => void } = {}) =>
  anthropicStream(ctx, PARAMS, { signal: opts.signal ?? new AbortController().signal, onEvent: opts.onEvent ?? (() => undefined) });

const counter = (kind: "day" | "month") => {
  const r = h.db.rows("spendCounter").find((x) => x.tenantId === T && x.pot === "ai" && x.periodKind === kind);
  return { spent: (r?.spentMinor as bigint | undefined) ?? 0n, reserved: (r?.reservedMinor as bigint | undefined) ?? 0n };
};
const reservations = () => h.db.rows("spendReservation");
const usageRows = () => h.db.rows("usageLedger");
const deferred = () => {
  let open!: () => void;
  const promise = new Promise<void>((r) => (open = r));
  return { promise, open };
};
/** Waits (on real event-loop turns, without moving the faked clock as vi.waitFor would) until `ready()` holds. */
async function until(ready: () => boolean): Promise<void> {
  for (let i = 0; i < 200 && !ready(); i++) await new Promise((r) => setImmediate(r));
  expect(ready()).toBe(true);
}

beforeEach(() => {
  h.db.reset();
  emulateSql(h.db);
  patchUsageLedger(h.db);
  h.freeze = { workspace: "none", platform: "none" };
  h.limits = { daily: null, monthly: 1000n, plan: 1000n };
  sdk.state.constructed.length = 0;
  sdk.state.calls.length = 0;
  sdk.state.scripts.length = 0;
  resetAnthropicClient();
  resetAiCounterSeeds();
  resetAiPricesCache();
  meter = createTurnMeter({ model: MODEL, prefixTokens: 16_000 });
  vi.stubEnv("ANTHROPIC_API_KEY", "test-key");
  vi.stubEnv("SPEND_ENFORCE", "enforce");
  vi.stubEnv("EDDY_PRICES", "");
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(NOW);
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllEnvs();
});

// =====================================================================================================================
describe("the SDK client and the stream (Eddy 5.2)", () => {
  it("builds one client per process with maxRetries 2 and a 60 s timeout, and streams the request as given", async () => {
    sdk.state.scripts.push(scriptFor(message({ input_tokens: 10, output_tokens: 5 })), scriptFor(message({ input_tokens: 10, output_tokens: 5 })));
    const ac = new AbortController();
    const events: string[] = [];
    const final = await run(gctx(), { signal: ac.signal, onEvent: (e) => events.push(e.type) });
    await run(gctx({ subjectId: "turn_1:1" }));
    expect(sdk.state.constructed).toEqual([{ maxRetries: 2, timeout: 60_000 }]);
    expect([ANTHROPIC_MAX_RETRIES, ANTHROPIC_TIMEOUT_MS]).toEqual([2, 60_000]);
    expect(sdk.state.calls[0].params).toBe(PARAMS);
    expect(sdk.state.calls[0].opts?.signal).toBe(ac.signal);
    expect(events).toEqual(["message_start", "content_block_start", "content_block_delta", "content_block_delta", "content_block_stop", "message_delta", "message_stop"]);
    expect(final).toMatchObject({ id: "msg_1", model: MODEL, stop_reason: "end_turn", content: [{ type: "text", text: "Three chats are open." }] });
  });

  it("a failing event handler never breaks the stream", async () => {
    sdk.state.scripts.push(scriptFor(message({ input_tokens: 10, output_tokens: 5 })));
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    await expect(
      run(gctx(), {
        onEvent: () => {
          throw new Error("UI went away");
        },
      }),
    ).resolves.toMatchObject({ id: "msg_1" });
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("stream event handler failed"));
    warn.mockRestore();
  });

  it("the production port is bound to the gateway", async () => {
    sdk.state.scripts.push(scriptFor(message({ input_tokens: 10, output_tokens: 5 })));
    await expect(anthropicStreamPort.stream(PARAMS, gctx(), { signal: new AbortController().signal, onEvent: () => undefined })).resolves.toMatchObject({ id: "msg_1" });
    expect(sdk.state.calls).toHaveLength(1);
  });

  it("this file is the only runtime importer of the SDK; Eddy's port imports its types only", () => {
    const stream = readFileSync(path.join(process.cwd(), "src/lib/spend/exec/ai-stream.ts"), "utf8");
    const port = readFileSync(path.join(process.cwd(), "src/lib/eddy/model.ts"), "utf8");
    expect(stream).toMatch(/^import Anthropic from "@anthropic-ai\/sdk";$/m);
    expect(port).not.toMatch(/^import (?!type )[^;]*"@anthropic-ai\/sdk/m);
  });
});

// =====================================================================================================================
describe("hold, stream, settle through the shared gateway (E1)", () => {
  it("holds the call's credits with a 3-minute ai_call reservation named by the round, then settles what the turn meter says", async () => {
    const gate = deferred();
    sdk.state.scripts.push(scriptFor(message({ input_tokens: 2_000, output_tokens: 400, cache_read_input_tokens: 16_000 }), { gate: gate.promise }));
    const pending = run();
    await until(() => sdk.state.calls.length === 1);
    expect(reservations()).toEqual([expect.objectContaining({ subjectType: "ai_call", subjectId: "turn_1:0", amountMinor: 20n, status: "held", pot: "ai", currency: "CRD" })]);
    expect((reservations()[0].expiresAt as Date).getTime() - NOW.getTime()).toBe(AI_STREAM_TTL_MS);
    expect(AI_STREAM_TTL_MS).toBe(180_000);
    expect(counter("month")).toMatchObject({ reserved: 20n, spent: 0n });
    gate.open();
    await pending;

    // 2,000 x 2 + 400 x 10 + 16,000 x 0.2 = 11,200 micro-USD: 2 credits.
    expect(meter.creditsCharged).toBe(2);
    expect(counter("month")).toMatchObject({ reserved: 0n, spent: 2n });
    expect(reservations()[0]).toMatchObject({ status: "settled", consumedMinor: 2n });
    expect(usageRows()).toEqual([expect.objectContaining({ tenantId: T, meter: "ai_credits", amount: 2, refType: "eddy_turn", refId: "turn_1", inputTokens: 2_000, outputTokens: 400, model: MODEL })]);
  });

  it("feature eddy keeps working under every stop (a person asked; 2.3.11, E7)", async () => {
    for (const freeze of [
      { workspace: "all", platform: "none" },
      { workspace: "none", platform: "all" },
      { workspace: "assistants", platform: "assistants" },
    ] as { workspace: FreezeLevel; platform: FreezeLevel }[]) {
      h.freeze = freeze;
      sdk.state.scripts.push(scriptFor(message({ input_tokens: 10, output_tokens: 5 })));
      await expect(run(gctx({ subjectId: `turn_${freeze.workspace}:0` }))).resolves.toMatchObject({ id: "msg_1" });
    }
  });

  it("a used-up AI limit is 402 ai_quota with the copy, before any stream", async () => {
    h.limits = { daily: null, monthly: 19n, plan: 19n };
    await expect(run()).rejects.toMatchObject({
      status: 402,
      code: "ai_quota",
      message: "This month's AI limit is used up. AI replies and suggestions are off until 1 Nov. Your team can still reply.",
    });
    expect(sdk.state.calls).toEqual([]);
    expect(reservations()).toEqual([]);
  });

  it("without an API key it says AI is not configured and builds no client", async () => {
    vi.stubEnv("ANTHROPIC_API_KEY", "");
    await expect(run()).rejects.toMatchObject({ status: 503, message: "AI is not configured." });
    expect(sdk.state.constructed).toEqual([]);
    expect(reservations()).toEqual([]);
  });
});

// =====================================================================================================================
describe("the actor is built inside the gateway (E9, rule B14)", () => {
  it("records the member who asked, from requestedBy", async () => {
    h.limits = { daily: null, monthly: 0n, plan: 0n };
    await expect(run(gctx({ requestedBy: { userId: "u_priya", role: "agent" } }))).rejects.toMatchObject({ code: "ai_quota" });
    const row = h.db.rows("spendLedger").find((r) => r.action === "ai.blocked")!;
    expect(row).toMatchObject({ actorType: "user", actorId: "u_priya", targetType: "ai_feature", targetId: "eddy" });
  });

  it("ignores any actor smuggled into the context: an assistant actor would be stopped by 'Stop assistants', the member is not", async () => {
    h.freeze = { workspace: "assistants", platform: "none" };
    sdk.state.scripts.push(scriptFor(message({ input_tokens: 10, output_tokens: 5 })));
    await expect(run(gctx({ actor: { type: "assistant", assistantKey: "ads_optimizer" } }))).resolves.toMatchObject({ id: "msg_1" });
  });

  it.each([
    ["no member", { requestedBy: undefined }],
    ["an empty user id", { requestedBy: { userId: "", role: "admin" } }],
    ["an unknown role", { requestedBy: { userId: "u1", role: "superuser" } }],
  ])("refuses a call with %s, before any hold", async (_label, over) => {
    await expect(run(gctx(over as Partial<GatewayCtx>))).rejects.toThrow(RangeError);
    expect(reservations()).toEqual([]);
    expect(sdk.state.calls).toEqual([]);
  });

  it("no Eddy file builds a user actor; the gateway does", () => {
    const source = readFileSync(path.join(process.cwd(), "src/lib/spend/exec/ai-stream.ts"), "utf8");
    expect(source).toMatch(/return \{ type: "user", userId: requestedBy\.userId, role: requestedBy\.role as SpendRole \};/);
    expect(source).toMatch(/reserveAi\(\{ tenantId: ctx\.tenantId, feature: "eddy", actor,/);
  });
});

// =====================================================================================================================
describe("one open hold per round and per screen (E9)", () => {
  it("two rounds and a screen of one turn hold at the same time without colliding; reusing an open subject is refused", async () => {
    const gate = deferred();
    for (let i = 0; i < 3; i++) sdk.state.scripts.push(scriptFor(message({ input_tokens: 1_000, output_tokens: 100 }), { gate: gate.promise }));
    const subjects = [eddyRoundSubjectId("turn_1", 0), eddyRoundSubjectId("turn_1", 1), eddyScreenSubjectId("turn_1", 0)];
    expect(subjects).toEqual(["turn_1:0", "turn_1:1", "turn_1:screen:0"]);
    const pending = subjects.map((s, i) => run(gctx({ subjectId: s, credits: 5 + i })));
    await until(() => sdk.state.calls.length === 3);
    expect(reservations().filter((r) => r.status === "held").map((r) => r.subjectId).sort()).toEqual(["turn_1:0", "turn_1:1", "turn_1:screen:0"]);
    expect(counter("month").reserved).toBe(18n);

    await expect(run(gctx({ subjectId: "turn_1:0", credits: 7 }))).rejects.toMatchObject({ code: "P2002" });
    expect(counter("month").reserved).toBe(18n);
    expect(sdk.state.calls).toHaveLength(3);

    gate.open();
    await Promise.all(pending);
    expect(reservations().every((r) => r.status === "settled")).toBe(true);
    expect(counter("month").reserved).toBe(0n);
  });

  it.each(["turn_1", "turn_1:x", "turn 1:0", "turn_1:screen:", ":0", "turn_1:0:1", "a".repeat(65) + ":0"])("refuses the subject %j", async (subjectId) => {
    await expect(run(gctx({ subjectId }))).rejects.toThrow(RangeError);
    expect(reservations()).toEqual([]);
  });

  it("refuses a call that is not Eddy's, has no turn reference or no settle function", async () => {
    await expect(run(gctx({ feature: "creative" as "eddy" }))).rejects.toThrow(RangeError);
    await expect(run(gctx({ ref: { type: "inbox_suggest" as "eddy_turn", id: "x" } }))).rejects.toThrow(RangeError);
    await expect(run(gctx({ settle: undefined as unknown as GatewayCtx["settle"] }))).rejects.toThrow(RangeError);
    await expect(run(gctx({ credits: -1 }))).rejects.toThrow(RangeError);
    expect(reservations()).toEqual([]);
  });
});

// =====================================================================================================================
describe("settlement (Eddy 5.10, 12.1a decision 13)", () => {
  it("prices usage.iterations at each model's own prices (a server-side fallback)", async () => {
    const usage = {
      input_tokens: 2_000,
      output_tokens: 1_500,
      cache_read_input_tokens: 16_000,
      iterations: [
        { type: "message", model: "claude-sonnet-5-5", input_tokens: 1_000, output_tokens: 500, cache_read_input_tokens: 16_000 },
        { type: "message", model: "claude-opus-5", input_tokens: 1_000, output_tokens: 1_000 },
      ],
    };
    sdk.state.scripts.push(scriptFor(message(usage)));
    await run();
    // Sonnet 5.5: 1,000 x 2 + 500 x 10 + 16,000 x 0.2 = 10,200. Opus 5 (fallback): 1,000 x 5 + 1,000 x 25 = 30,000.
    expect(meter.workspaceMicroUsd).toBe(40_200);
    expect(meter.creditsCharged).toBe(5);
    expect(counter("month").spent).toBe(5n);
    // Priced from the top-level figures alone it would have been 3 credits: iterations are not optional.
    const topLevel = priceUsage({ input_tokens: 2_000, output_tokens: 1_500, cache_read_input_tokens: 16_000 }, MODEL);
    expect(Math.ceil(topLevel.workspaceMicroUsd / 10_000)).toBe(3);
  });

  it("charges the shared 1-hour prefix write at the cache-read price and returns the difference as platformMicroUsd", async () => {
    const usage = { input_tokens: 500, output_tokens: 300, cache_creation_input_tokens: 16_000, cache_creation: { ephemeral_5m_input_tokens: 0, ephemeral_1h_input_tokens: 16_000 } };
    sdk.state.scripts.push(scriptFor(message(usage)));
    await run();
    // Workspace: 500 x 2 + 300 x 10 + 16,000 x 0.2 = 7,200 (1 credit). Platform: 16,000 x (4.00 - 0.20) = 60,800.
    expect(meter.workspaceMicroUsd).toBe(7_200);
    expect(meter.platformMicroUsd).toBe(60_800);
    expect(meter.creditsCharged).toBe(1);
    expect(counter("month").spent).toBe(1n);
    // Without the platform's share the member would have paid 68,000 micro-USD, 7 credits.
    expect(priceUsage(usage, MODEL).workspaceMicroUsd).toBe(68_000);
  });

  it("with a 1-hour tail only the part of the 1-hour writes that is the prefix goes to the platform", () => {
    const m = createTurnMeter({ model: MODEL, prefixTokens: 16_000, tailCacheTtl: "1h" });
    const credits = m.settle({ input_tokens: 500, output_tokens: 300, cache_read_input_tokens: 10_000, cache_creation: { ephemeral_1h_input_tokens: 9_000 } });
    // Prefix share min(9,000, 16,000 - 10,000) = 6,000 at 3.80: 22,800. Workspace 1,000 + 3,000 + 2,000 + 36,000 - 22,800 = 19,200.
    expect(m.platformMicroUsd).toBe(22_800);
    expect(m.workspaceMicroUsd).toBe(19_200);
    expect(credits).toBe(2);
    // An unknown prefix size gives the platform nothing with a 1-hour tail.
    const unknown = createTurnMeter({ model: MODEL, prefixTokens: null, tailCacheTtl: "1h" });
    unknown.settle({ input_tokens: 0, output_tokens: 0, cache_creation: { ephemeral_1h_input_tokens: 9_000 } });
    expect(unknown.platformMicroUsd).toBe(0);
  });

  it("rounds once per turn, not per call", async () => {
    for (let i = 0; i < 3; i++) sdk.state.scripts.push(scriptFor(message({ input_tokens: 2_000, output_tokens: 0 })));
    const charged: number[] = [];
    for (let i = 0; i < 3; i++) {
      await run(gctx({ subjectId: `turn_1:${i}`, settle: (u: EddyUsage) => (charged.push(meter.settle(u)), charged[charged.length - 1]) }));
    }
    // Each round costs 4,000 micro-USD: 0.4, 0.8, 1.2 credits so far.
    expect(charged).toEqual([1, 0, 1]);
    expect(meter.creditsCharged).toBe(2);
    expect(counter("month")).toMatchObject({ spent: 2n, reserved: 0n });
    expect(usageRows().map((r) => r.amount)).toEqual([1, 1]);
  });

  it("the optional Haiku screen is charged inside the same turn at Haiku's prices", async () => {
    sdk.state.scripts.push(scriptFor(message({ input_tokens: 20_000, output_tokens: 2_000 }, { model: "claude-haiku-5-5" })));
    await run(gctx({ subjectId: "turn_1:screen:0", settle: meter.settleFor("claude-haiku-5-5") }));
    // 20,000 x 0.10 + 2,000 x 0.50 = 3,000 micro-USD.
    expect(meter.workspaceMicroUsd).toBe(3_000);
    expect(usageRows()).toEqual([expect.objectContaining({ amount: 1, model: "claude-haiku-5-5", refType: "eddy_turn" })]);
  });

  it("a call that cannot be priced fails closed: the whole hold is charged and ops is told", async () => {
    sdk.state.scripts.push(scriptFor(message({ input_tokens: 10, output_tokens: 5 }, { model: "claude-mystery-1" })));
    const error = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const unknown = createTurnMeter({ model: "claude-mystery-1", prefixTokens: null });
    await run(gctx({ settle: unknown.settle }));
    expect(counter("month")).toMatchObject({ spent: 20n, reserved: 0n });
    expect(usageRows()).toEqual([expect.objectContaining({ amount: 20, model: "claude-mystery-1" })]);
    expect(error).toHaveBeenCalledWith(expect.stringContaining("eddy.unpriced_model"));
    // A settle function that returns nonsense is treated the same way.
    sdk.state.scripts.push(scriptFor(message({ input_tokens: 10, output_tokens: 5 })));
    await run(gctx({ subjectId: "turn_1:1", credits: 4, settle: () => Number.NaN }));
    expect(counter("month").spent).toBe(24n);
    error.mockRestore();
  });
});

// =====================================================================================================================
describe("aborts and failures", () => {
  it("an abort after the stream started settles what it reported: the input tokens plus an estimate of the output so far", async () => {
    const ac = new AbortController();
    const text = "नमस्ते दुनिया"; // 37 bytes of UTF-8
    const final = message({ input_tokens: 3_000, output_tokens: 900 }, { text: text + " and much more that never arrives" });
    const script = scriptFor(final);
    script.events![2] = { type: "content_block_delta", index: 0, delta: { type: "text_delta", text } };
    sdk.state.scripts.push(script);
    const error = await run(gctx(), {
      signal: ac.signal,
      onEvent: (e) => {
        if (e.type === "content_block_delta") ac.abort();
      },
    }).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(sdk.APIUserAbortError);
    // 3,000 x 2 + ceil(37 / 3) = 13 output tokens x 10 = 6,130 micro-USD: 1 credit.
    expect(meter.workspaceMicroUsd).toBe(6_130);
    expect(counter("month")).toMatchObject({ spent: 1n, reserved: 0n });
    expect(reservations()[0]).toMatchObject({ status: "settled", consumedMinor: 1n });
    expect(usageRows()).toEqual([expect.objectContaining({ amount: 1, inputTokens: 3_000, outputTokens: 13, refType: "eddy_turn" })]);
  });

  it("an abort before the stream started gives the whole hold back", async () => {
    const ac = new AbortController();
    ac.abort();
    sdk.state.scripts.push(scriptFor(message({ input_tokens: 3_000, output_tokens: 900 })));
    await expect(run(gctx(), { signal: ac.signal })).rejects.toBeInstanceOf(sdk.APIUserAbortError);
    expect(counter("month")).toMatchObject({ spent: 0n, reserved: 0n });
    expect(reservations()[0]).toMatchObject({ status: "released" });
    expect(usageRows()).toEqual([]);
  });

  it("a failed stream gives the hold back and rethrows the SDK's own error, unchanged", async () => {
    class RateLimitError extends Error {
      status = 429;
    }
    const before = new RateLimitError("rate limited");
    sdk.state.scripts.push({ failWith: before });
    expect(await run().catch((e: unknown) => e)).toBe(before);
    const midway = new RateLimitError("overloaded mid-stream");
    sdk.state.scripts.push(scriptFor(message({ input_tokens: 3_000, output_tokens: 900 }), { failWith: midway, failAfter: 2 }));
    expect(await run(gctx({ subjectId: "turn_1:1" })).catch((e: unknown) => e)).toBe(midway);
    const create = new RateLimitError("could not start");
    sdk.state.scripts.push({ throwOnCreate: create });
    expect(await run(gctx({ subjectId: "turn_1:2" })).catch((e: unknown) => e)).toBe(create);
    expect(counter("month")).toMatchObject({ spent: 0n, reserved: 0n });
    expect(reservations().map((r) => r.status)).toEqual(["released", "released", "released"]);
    expect(usageRows()).toEqual([]);
  });

  it("estimates streamed output conservatively, never below what the stream reported", () => {
    expect(estimateStreamedOutputTokens(null)).toBe(0);
    expect(estimateStreamedOutputTokens({ content: [], usage: { output_tokens: 42 } } as never)).toBe(42);
    expect(estimateStreamedOutputTokens({ content: [{ type: "text", text: "abcdefghi" }], usage: { output_tokens: 1 } } as never)).toBe(3);
    // 30 bytes of thinking notes plus the 9 bytes of '{"q":"y"}': 39 bytes, 13 tokens.
    expect(estimateStreamedOutputTokens({ content: [{ type: "thinking", thinking: "x".repeat(30) }, { type: "tool_use", input: { q: "y" } }], usage: { output_tokens: 1 } } as never)).toBe(13);
    expect(abortedUsage({ content: [{ type: "text", text: "abcdef" }], usage: { input_tokens: 7, output_tokens: 1 } } as never)).toMatchObject({ input_tokens: 7, output_tokens: 2 });
  });
});

// =====================================================================================================================
describe("the price table (Eddy 5.1, EDDY_PRICES)", () => {
  it("covers Opus, Sonnet and Haiku 5.5 and the fallback models, with 5-minute and 1-hour cache writes", () => {
    expect(DEFAULT_AI_PRICES).toEqual({
      "claude-opus-5-5": { input: 4, output: 20, cacheRead: 0.2, cacheWrite5m: 5, cacheWrite1h: 8 },
      "claude-sonnet-5-5": { input: 2, output: 10, cacheRead: 0.2, cacheWrite5m: 2.5, cacheWrite1h: 4 },
      "claude-haiku-5-5": { input: 0.1, output: 0.5, cacheRead: 0.01, cacheWrite5m: 0.125, cacheWrite1h: 0.2 },
      "claude-opus-5": { input: 5, output: 25, cacheRead: 0.5, cacheWrite5m: 6.25, cacheWrite1h: 10 },
      "claude-opus-4-8": { input: 5, output: 25, cacheRead: 0.5, cacheWrite5m: 6.25, cacheWrite1h: 10 },
      "claude-sonnet-5": { input: 2, output: 10, cacheRead: 0.2, cacheWrite5m: 2.5, cacheWrite1h: 4 },
    });
    expect(Object.isFrozen(DEFAULT_AI_PRICES)).toBe(true);
  });

  it("EDDY_PRICES overrides or adds models; a bad override is ignored whole, with a warning", () => {
    const sonnet = { input: 2, output: 10, cacheRead: 0.1, cacheWrite5m: 2.5, cacheWrite1h: 4 };
    const ok = parsePriceOverride(JSON.stringify({ "claude-sonnet-5-5": sonnet, "claude-new-6": { ...sonnet, input: 3 } }));
    expect(ok.problem).toBeNull();
    expect(ok.prices["claude-sonnet-5-5"].cacheRead).toBe(0.1);
    expect(ok.prices["claude-new-6"].input).toBe(3);
    expect(ok.prices["claude-opus-5-5"]).toEqual(DEFAULT_AI_PRICES["claude-opus-5-5"]);
    for (const [raw, problem] of [
      ["{not json", "EDDY_PRICES is not valid JSON"],
      ["[1]", "EDDY_PRICES must be an object of models"],
      [JSON.stringify({ "gpt-9": sonnet }), "EDDY_PRICES has an invalid model id: gpt-9"],
      [JSON.stringify({ "claude-sonnet-5-5": { ...sonnet, cacheWrite1h: undefined } }), "EDDY_PRICES.claude-sonnet-5-5.cacheWrite1h must be a price from 0 to 1000"],
      [JSON.stringify({ "claude-sonnet-5-5": { ...sonnet, output: -1 } }), "EDDY_PRICES.claude-sonnet-5-5.output must be a price from 0 to 1000"],
      [JSON.stringify({ "claude-sonnet-5-5": sonnet, "claude-x-1": { ...sonnet, input: 5000 } }), "EDDY_PRICES.claude-x-1.input must be a price from 0 to 1000"],
    ] as const) {
      const out = parsePriceOverride(raw);
      expect(out.problem).toBe(problem);
      expect(out.prices).toBe(DEFAULT_AI_PRICES);
    }
    const warn = vi.fn();
    expect(aiPrices({ EDDY_PRICES: "{not json" }, warn)).toBe(DEFAULT_AI_PRICES);
    expect(aiPrices({ EDDY_PRICES: "{not json" }, warn)).toBe(DEFAULT_AI_PRICES);
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn.mock.calls[0][0]).toContain("using the built-in prices");
  });

  it("the live table follows EDDY_PRICES, so settlement uses the override", async () => {
    vi.stubEnv("EDDY_PRICES", JSON.stringify({ "claude-sonnet-5-5": { input: 20, output: 100, cacheRead: 2, cacheWrite5m: 25, cacheWrite1h: 40 } }));
    sdk.state.scripts.push(scriptFor(message({ input_tokens: 1_000, output_tokens: 100 })));
    await run();
    // 1,000 x 20 + 100 x 100 = 30,000 micro-USD: 3 credits (10x the list price).
    expect(meter.creditsCharged).toBe(3);
  });

  it("a model missing from the table is unpriced, never free", () => {
    expect(priceFor("claude-mystery-1", DEFAULT_AI_PRICES)).toBeNull();
    expect(priceFor("constructor", DEFAULT_AI_PRICES)).toBeNull();
    expect(priceFor(null, DEFAULT_AI_PRICES)).toBeNull();
    const out = priceUsage({ input_tokens: 10, iterations: [{ model: MODEL, input_tokens: 5 }, { model: "claude-mystery-1", input_tokens: 5 }] }, MODEL, { prices: DEFAULT_AI_PRICES });
    expect(out).toMatchObject({ priced: false, unpricedModels: ["claude-mystery-1"], platformMicroUsd: 0 });
    expect(Number.isNaN(out.workspaceMicroUsd)).toBe(true);
  });

  it("reads usage.iterations first, the top-level usage otherwise, and prices undivided cache writes at the dearer rate", () => {
    const u: UsageLike = { input_tokens: 9, iterations: [{ input_tokens: 4 }, { model: "claude-opus-5", input_tokens: 5 }] };
    expect(usageEntries(u, MODEL).map((e) => [e.model, e.input])).toEqual([
      [MODEL, 4],
      ["claude-opus-5", 5],
    ]);
    expect(usageEntries({ input_tokens: 9 }, MODEL).map((e) => e.input)).toEqual([9]);
    expect(usageEntries(null, MODEL)).toEqual([]);
    expect(iterationTokens({ cache_creation_input_tokens: 100, cache_creation: { ephemeral_5m_input_tokens: 30 } }, MODEL)).toMatchObject({ write5m: 30, write1h: 0, writeUnknown: 70 });
    // 100 undivided write tokens at the 1-hour price (4.00), never the cheaper 5-minute one.
    expect(priceUsage({ cache_creation_input_tokens: 100 }, MODEL, { prices: DEFAULT_AI_PRICES }).totalMicroUsd).toBe(400);
  });
});
