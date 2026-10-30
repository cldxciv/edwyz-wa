import { readFileSync } from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { BANNED_COPY_WORDS } from "@/lib/spend/copy";
import {
  decide,
  level2Share,
  policyReasonText,
  withinLevel1Step,
  withinPct,
  type PolicyHeadroom,
  type PolicyIntent,
  type PolicyMandate,
  type PolicyReason,
} from "@/lib/spend/policy";
import {
  ASSISTANT_KEYS,
  ASSISTANTS,
  assistantLabel,
  assistantMayDo,
  assistantsForPot,
  clampApprovalSharePct,
  clampRaiseStepPct,
  getAssistant,
  isAssistantKey,
  isLoweringOp,
  LEVEL_OPTIONS,
  levelLabel,
  MANDATE_DEFAULTS,
  NOT_ASSISTANTS,
  sanitizeAllowedOps,
} from "@/lib/spend/registry";
import type { AutonomyLevel, SpendActor } from "@/lib/spend/types";

/** docs/SPEND-CONTROLS-SPEC.md 7.1, 7.2 and 10.1 (spend-policy.test.ts): a test per matrix cell. */

const NOW = new Date("2026-10-28T10:00:00Z");
const optimizer: SpendActor = { type: "assistant", assistantKey: "ads_optimizer" };
const launcher: SpendActor = { type: "assistant", assistantKey: "ads_launcher" };
const planner: SpendActor = { type: "assistant", assistantKey: "broadcast_planner" };
const owner: SpendActor = { type: "user", userId: "u1", role: "owner" };

const mandate = (level: AutonomyLevel, over: Partial<PolicyMandate> = {}): PolicyMandate => ({
  enabled: true,
  level,
  allowedOps: ["pause", "archive", "cut_budget", "end_earlier", "raise_budget", "resume_ad", "resume_adset", "activate", "extend_end", "broadcast_start", "cancel_broadcast"],
  maxDailyMinor: null,
  maxMonthlyMinor: null,
  targetCostPerLeadMinor: 10_000n,
  raiseStepPct: 20,
  approvalSharePct: 25,
  shadowUntil: null,
  ...over,
});

const room = (over: Partial<PolicyHeadroom> = {}): PolicyHeadroom => ({
  freeze: { workspace: "none", platform: "none" },
  blockingBreaker: false,
  breakerOnScope: false,
  dailyLimitMinor: 500_000n,
  monthlyLimitMinor: 1_000_000n,
  dayLeftMinor: 500_000n,
  monthLeftMinor: 1_000_000n,
  metaLimitManaged: true,
  sandbox: false,
  targetCostPerLeadMinor: null,
  autoRaisesLast24hMinor: 0n,
  ...over,
});

const LOWER: PolicyIntent = { op: "pause" };
const raise = (to: bigint, dayStart = 10_000n): PolicyIntent => ({ op: "raise_budget", dayStartBudgetMinor: dayStart, toMinor: to });
const LAUNCH: PolicyIntent = { op: "activate", hasEndDate: true };
const small = { todayMinor: 17_500n, monthMinor: 70_000n };
const on = { assistantSpendEnabled: true };

afterEach(() => {
  delete process.env.ASSISTANT_SPEND_ENABLED;
});

describe("the level matrix (7.2): levels 0-2 x lowering / budget raise / launch", () => {
  const cells: [AutonomyLevel, string, PolicyIntent, string, PolicyReason][] = [
    [0, "lowering", LOWER, "needs_approval", "level_0"],
    [0, "budget raise", raise(11_000n), "needs_approval", "level_0"],
    [0, "launch", LAUNCH, "needs_approval", "level_0"],
    [1, "lowering", LOWER, "auto", "lowering"],
    [1, "budget raise within 20%", raise(11_000n), "auto", "level_1_step"],
    [1, "launch", LAUNCH, "needs_approval", "level_1_launch"],
    [2, "lowering", LOWER, "auto", "lowering"],
    [2, "budget raise within 25% of the month", raise(30_000n), "auto", "level_2"],
    [2, "launch that fits, with an end date, a target and a managed Meta limit", LAUNCH, "auto", "level_2"],
  ];
  it.each(cells)("Level %i, %s -> %s", (level, _name, intent, verdict, reason) => {
    const d = decide(optimizer.type === "assistant" && intent.op === "activate" ? launcher : optimizer, intent, small, mandate(level), room(), NOW, on);
    expect(d).toMatchObject({ verdict, reason, level });
  });

  it("Level 2 over 25% of the monthly limit needs approval; exactly 25% is automatic", () => {
    expect(decide(optimizer, raise(30_000n), { todayMinor: 1n, monthMinor: 250_000n }, mandate(2), room(), NOW, on)).toMatchObject({ verdict: "auto" });
    expect(decide(optimizer, raise(30_000n), { todayMinor: 1n, monthMinor: 250_001n }, mandate(2), room(), NOW, on)).toMatchObject({ verdict: "needs_approval", reason: "level_2_over_share" });
    expect(decide(launcher, LAUNCH, { todayMinor: 1n, monthMinor: 250_001n }, mandate(2), room(), NOW, on)).toMatchObject({ verdict: "needs_approval", reason: "level_2_over_share" });
  });

  it("Level 2 launch without a target cost per lead needs approval; the workspace target counts", () => {
    const noTarget = mandate(2, { targetCostPerLeadMinor: null });
    expect(decide(launcher, LAUNCH, small, noTarget, room(), NOW, on)).toMatchObject({ verdict: "needs_approval", reason: "no_target_cost" });
    expect(decide(launcher, LAUNCH, small, noTarget, room({ targetCostPerLeadMinor: 5_000n }), NOW, on)).toMatchObject({ verdict: "auto" });
  });

  it("Level 2 needs a monthly limit to measure the share against", () => {
    expect(decide(optimizer, raise(11_000n), small, mandate(2), room({ monthlyLimitMinor: null, monthLeftMinor: null }), NOW, on)).toMatchObject({ verdict: "refuse", reason: "no_monthly_limit" });
  });
});

describe("Level 1: +20% of the day-start budget, cumulative per account day", () => {
  it("+20% exactly is automatic and +20.01% needs approval", () => {
    expect(decide(optimizer, raise(12_000n), small, mandate(1), room(), NOW, on)).toMatchObject({ verdict: "auto", reason: "level_1_step" });
    expect(decide(optimizer, raise(12_001n), small, mandate(1), room(), NOW, on)).toMatchObject({ verdict: "needs_approval", reason: "level_1_over_step" });
    expect(withinLevel1Step(10_000n, 12_000n, 20)).toBe(true);
    expect(withinLevel1Step(10_000n, 12_001n, 20)).toBe(false);
  });

  it("a 10% raise then another 11% the same day is caught (measured from the budget at the start of the day)", () => {
    expect(decide(optimizer, raise(11_000n), small, mandate(1), room(), NOW, on).verdict).toBe("auto");
    // The second raise: 11,000 -> 12,100 is "only" 10% of the current budget, but 21% of the day-start 10,000.
    expect(decide(optimizer, raise(12_100n), small, mandate(1), room(), NOW, on)).toMatchObject({ verdict: "needs_approval", reason: "level_1_over_step" });
    expect(decide(optimizer, raise(12_210n), small, mandate(1), room(), NOW, on).verdict).toBe("needs_approval");
  });

  it("a lower owner step (raiseStepPct 10) is respected, and an unknown day-start budget needs approval", () => {
    expect(decide(optimizer, raise(11_001n), small, mandate(1, { raiseStepPct: 10 }), room(), NOW, on).verdict).toBe("needs_approval");
    expect(decide(optimizer, { op: "raise_budget", toMinor: 11_000n, dayStartBudgetMinor: null }, small, mandate(1), room(), NOW, on).verdict).toBe("needs_approval");
  });

  it("an open (non-blocking) breaker on the scope, or resuming what a safety stop paused, needs approval", () => {
    expect(decide(optimizer, raise(11_000n), small, mandate(1), room({ breakerOnScope: true }), NOW, on)).toMatchObject({ verdict: "needs_approval", reason: "level_1_breaker_open" });
    expect(decide(optimizer, { ...raise(11_000n), resumesBreakerPause: true }, small, mandate(1), room(), NOW, on)).toMatchObject({ verdict: "needs_approval", reason: "level_1_breaker_resume" });
    // Level 2 is not held back by a notify-only breaker.
    expect(decide(optimizer, raise(11_000n), small, mandate(2), room({ breakerOnScope: true }), NOW, on).verdict).toBe("auto");
  });
});

describe("Level 2 anti-splitting (2.3.9; kept by 12.1a decision 6): the rolling 24 h sum of auto raises", () => {
  it("counts this assistant's auto-applied raises of the last 24 h toward the 25%", () => {
    expect(decide(optimizer, raise(11_000n), { todayMinor: 1n, monthMinor: 100_000n }, mandate(2), room({ autoRaisesLast24hMinor: 150_000n }), NOW, on).verdict).toBe("auto");
    expect(decide(optimizer, raise(11_000n), { todayMinor: 1n, monthMinor: 100_000n }, mandate(2), room({ autoRaisesLast24hMinor: 150_001n }), NOW, on)).toMatchObject({ verdict: "needs_approval", reason: "level_2_over_share" });
  });

  it("ten launches of 10% each cannot add the whole month without an approval", () => {
    let window = 0n;
    const verdicts: string[] = [];
    for (let i = 0; i < 10; i++) {
      const d = decide(launcher, LAUNCH, { todayMinor: 1n, monthMinor: 100_000n }, mandate(2), room({ autoRaisesLast24hMinor: window }), NOW, on);
      verdicts.push(d.verdict);
      if (d.verdict === "auto") window += 100_000n;
    }
    expect(verdicts.slice(0, 2)).toEqual(["auto", "auto"]);
    expect(verdicts.slice(2).every((v) => v === "needs_approval")).toBe(true);
    expect(window).toBe(200_000n);
  });

  it("the share is max(action, action + window), so a negative window never lowers it", () => {
    expect(level2Share(100n, 50n)).toBe(150n);
    expect(level2Share(100n, -500n)).toBe(100n);
    expect(withinPct(250n, 1000n, 25)).toBe(true);
    expect(withinPct(251n, 1000n, 25)).toBe(false);
    expect(withinPct(0n, 0n, 25)).toBe(true);
    expect(withinPct(1n, 0n, 25)).toBe(false);
  });
});

describe("missing or disabled mandates, and ops outside the mandate, are suggestions, not refusals (2.3.10)", () => {
  it("no mandate row: Level 0 suggestions only, for raises, launches and lowering", () => {
    for (const intent of [raise(11_000n), LAUNCH, LOWER]) {
      const d = decide(optimizer, intent, small, null, room(), NOW, on);
      expect(d).toMatchObject({ verdict: "needs_approval", reason: "suggestion_only", suggestion: true, level: 0 });
    }
  });

  it("a disabled mandate and an op not in allowedOps give a suggestion", () => {
    expect(decide(optimizer, raise(11_000n), small, mandate(2, { enabled: false }), room(), NOW, on)).toMatchObject({ verdict: "needs_approval", reason: "suggestion_only", level: 0 });
    expect(decide(optimizer, raise(11_000n), small, mandate(2, { allowedOps: ["pause"] }), room(), NOW, on)).toMatchObject({ verdict: "needs_approval", reason: "op_not_allowed" });
    expect(decide(optimizer, LOWER, small, mandate(2, { allowedOps: ["raise_budget"] }), room(), NOW, on)).toMatchObject({ verdict: "needs_approval", reason: "op_not_allowed" });
  });

  it("but something no approval could make valid is refused: it does not fit what is left", () => {
    const d = decide(optimizer, raise(11_000n), { todayMinor: 17_500n, monthMinor: 2_000_000n }, null, room(), NOW, on);
    expect(d).toMatchObject({ verdict: "refuse", reason: "over_monthly_limit", needsMinor: 2_000_000n, leftMinor: 1_000_000n, period: "month", suggestion: false });
    expect(decide(optimizer, raise(11_000n), { todayMinor: 600_000n, monthMinor: 1n }, mandate(2), room(), NOW, on)).toMatchObject({ verdict: "refuse", reason: "over_daily_limit", needsMinor: 600_000n, leftMinor: 500_000n });
  });

  it("the mandate's own ceilings refuse (min(mandate, allowance))", () => {
    const capped = mandate(2, { maxDailyMinor: 50_000n, maxMonthlyMinor: 300_000n });
    expect(decide(optimizer, raise(11_000n), { todayMinor: 20_000n, monthMinor: 1n }, capped, room({ assistantTodayMinor: 40_000n }), NOW, on)).toMatchObject({ verdict: "refuse", reason: "mandate_daily", leftMinor: 10_000n });
    expect(decide(optimizer, raise(11_000n), { todayMinor: 1n, monthMinor: 200_000n }, capped, room({ assistantMonthMinor: 150_000n }), NOW, on)).toMatchObject({ verdict: "refuse", reason: "mandate_monthly", leftMinor: 150_000n });
    expect(decide(optimizer, raise(11_000n), { todayMinor: 10_000n, monthMinor: 150_000n }, capped, room({ assistantTodayMinor: 40_000n, assistantMonthMinor: 150_000n }), NOW, on).verdict).toBe("auto");
  });
});

describe("shadow (learning period, 7.5)", () => {
  const learning = (level: AutonomyLevel, over: Partial<PolicyMandate> = {}) => mandate(level, { shadowUntil: new Date(NOW.getTime() + 86_400_000), ...over });

  it("every action is shadow while learning, with what the configured level would have done", () => {
    expect(decide(launcher, LAUNCH, small, learning(2), room(), NOW, on)).toMatchObject({ verdict: "shadow", reason: "learning", level: 0, would: "auto", suggestion: true });
    expect(decide(optimizer, LOWER, small, learning(1), room(), NOW, on)).toMatchObject({ verdict: "shadow", would: "auto" });
    expect(decide(optimizer, raise(13_000n), small, learning(1), room(), NOW, on)).toMatchObject({ verdict: "shadow", would: "needs_approval", wouldReason: "level_1_over_step" });
    // The 10.5 exit check counts "would exceed allowance" verdicts.
    expect(decide(optimizer, raise(11_000n), { todayMinor: 1n, monthMinor: 5_000_000n }, learning(2), room(), NOW, on)).toMatchObject({ verdict: "shadow", would: "refuse", wouldReason: "over_monthly_limit" });
  });

  it("ends when shadowUntil passes", () => {
    const ended = mandate(2, { shadowUntil: new Date(NOW.getTime() - 1) });
    expect(decide(launcher, LAUNCH, small, ended, room(), NOW, on).verdict).toBe("auto");
  });

  it("a person approving the suggestion during shadow acts as actor user: not shadowed, only the limits apply", () => {
    const d = decide(owner, LAUNCH, small, learning(2), room(), NOW, on);
    expect(d).toMatchObject({ verdict: "auto", reason: "not_assistant" });
  });
});

describe("freezes and breakers (step 1)", () => {
  it("a workspace stop refuses raises and launches but never lowering", () => {
    const frozen = room({ freeze: { workspace: "all", platform: "none" } });
    expect(decide(optimizer, raise(11_000n), small, mandate(2), frozen, NOW, on)).toMatchObject({ verdict: "refuse", reason: "frozen" });
    expect(decide(launcher, LAUNCH, small, mandate(2), frozen, NOW, on)).toMatchObject({ verdict: "refuse", reason: "frozen" });
    expect(decide(optimizer, LOWER, small, mandate(2), frozen, NOW, on)).toMatchObject({ verdict: "auto", reason: "lowering" });
    expect(decide(owner, raise(11_000n), small, null, frozen, NOW, on)).toMatchObject({ verdict: "refuse", reason: "frozen" });
  });

  it("stopping assistants refuses assistants' raises only; the platform stop refuses everyone's", () => {
    const assistantsOff = room({ freeze: { workspace: "assistants", platform: "none" } });
    expect(decide(optimizer, raise(11_000n), small, mandate(2), assistantsOff, NOW, on)).toMatchObject({ verdict: "refuse", reason: "assistants_frozen" });
    expect(decide(owner, raise(11_000n), small, null, assistantsOff, NOW, on).verdict).toBe("auto");
    expect(decide(optimizer, raise(11_000n), small, mandate(2), room({ freeze: { workspace: "none", platform: "assistants" } }), NOW, on).reason).toBe("assistants_frozen");
    const platform = room({ freeze: { workspace: "none", platform: "all" } });
    expect(decide(optimizer, raise(11_000n), small, mandate(2), platform, NOW, on)).toMatchObject({ verdict: "refuse", reason: "platform_frozen" });
    expect(decide(owner, LAUNCH, small, null, platform, NOW, on)).toMatchObject({ verdict: "refuse", reason: "platform_frozen" });
  });

  it("a blocking breaker refuses raises (even during learning) and lets lowering through", () => {
    const blocked = room({ blockingBreaker: true });
    expect(decide(optimizer, raise(11_000n), small, mandate(2), blocked, NOW, on)).toMatchObject({ verdict: "refuse", reason: "breaker" });
    expect(decide(optimizer, raise(11_000n), small, mandate(2, { shadowUntil: new Date(NOW.getTime() + 1000) }), blocked, NOW, on).verdict).toBe("refuse");
    expect(decide(optimizer, LOWER, small, mandate(2), blocked, NOW, on).verdict).toBe("auto");
  });

  it("breakers and kill switches: lowering always automatic; only the daily_limit auto-resume raises", () => {
    const daily: SpendActor = { type: "breaker", kind: "daily_limit" };
    const pacing: SpendActor = { type: "breaker", kind: "pacing" };
    expect(decide(pacing, LOWER, small, null, room({ freeze: { workspace: "all", platform: "all" } }), NOW, on)).toMatchObject({ verdict: "auto", reason: "breaker_lowering" });
    expect(decide(daily, { op: "resume_adset" }, small, null, room(), NOW, on)).toMatchObject({ verdict: "auto", reason: "breaker_resume" });
    expect(decide(pacing, { op: "resume_adset" }, small, null, room(), NOW, on)).toMatchObject({ verdict: "refuse", reason: "breaker_no_raise" });
    expect(decide(daily, raise(11_000n), small, null, room(), NOW, on)).toMatchObject({ verdict: "refuse", reason: "breaker_no_raise" });
    expect(decide(daily, { op: "resume_adset" }, small, null, room({ freeze: { workspace: "all", platform: "none" } }), NOW, on)).toMatchObject({ verdict: "refuse", reason: "frozen" });
    const kill: SpendActor = { type: "system", job: "spend.stop" };
    expect(decide(kill, LOWER, small, null, room({ freeze: { workspace: "all", platform: "none" } }), NOW, on).verdict).toBe("auto");
  });
});

describe("Meta's limit, end dates and the rollout flag", () => {
  it("on an account whose Meta limit is not managed every assistant raise or launch needs approval, at any level", () => {
    const unmanaged = room({ metaLimitManaged: false });
    for (const level of [1, 2] as AutonomyLevel[]) {
      expect(decide(optimizer, raise(11_000n), small, mandate(level), unmanaged, NOW, on)).toMatchObject({ verdict: "needs_approval", reason: "meta_limit_not_managed" });
      expect(decide(launcher, LAUNCH, small, mandate(level), unmanaged, NOW, on).verdict).toBe("needs_approval");
    }
    // Lowering is unaffected, a test ad account is exempt, and the WhatsApp pot has no Meta limit.
    expect(decide(optimizer, LOWER, small, mandate(2), unmanaged, NOW, on).verdict).toBe("auto");
    expect(decide(optimizer, raise(11_000n), small, mandate(2), room({ metaLimitManaged: false, sandbox: true }), NOW, on).verdict).toBe("auto");
    expect(decide(planner, { op: "broadcast_start" }, small, mandate(2), unmanaged, NOW, on).verdict).toBe("auto");
  });

  it("a Level 2 launch without an end date or lifetime budget is refused; at Levels 0 and 1 it is only a suggestion", () => {
    const noEnd: PolicyIntent = { op: "activate", hasEndDate: false };
    expect(decide(launcher, noEnd, small, mandate(2), room(), NOW, on)).toMatchObject({ verdict: "refuse", reason: "end_date_required" });
    expect(decide(launcher, noEnd, small, mandate(2), room({ metaLimitManaged: false }), NOW, on).reason).toBe("end_date_required");
    expect(decide(launcher, noEnd, small, mandate(1), room(), NOW, on).verdict).toBe("needs_approval");
    expect(decide(launcher, noEnd, small, mandate(0), room(), NOW, on).verdict).toBe("needs_approval");
    // Broadcasts have no end date.
    expect(decide(planner, { op: "broadcast_start" }, small, mandate(2), room(), NOW, on).verdict).toBe("auto");
  });

  it("a sandbox-only mandate acts on its own only on a test ad account", () => {
    expect(decide(optimizer, raise(11_000n), small, mandate(2, { sandboxOnly: true }), room(), NOW, on)).toMatchObject({ verdict: "needs_approval", reason: "sandbox_only" });
    expect(decide(optimizer, raise(11_000n), small, mandate(2, { sandboxOnly: true }), room({ sandbox: true }), NOW, on).verdict).toBe("auto");
  });

  it("ASSISTANT_SPEND_ENABLED=false (the default) treats every level as 0", () => {
    expect(decide(launcher, LAUNCH, small, mandate(2), room(), NOW, { assistantSpendEnabled: false })).toMatchObject({ verdict: "needs_approval", reason: "level_0", level: 0 });
    expect(decide(launcher, LAUNCH, small, mandate(2), room(), NOW)).toMatchObject({ verdict: "needs_approval", level: 0 });
    process.env.ASSISTANT_SPEND_ENABLED = "true";
    expect(decide(launcher, LAUNCH, small, mandate(2), room(), NOW)).toMatchObject({ verdict: "auto", level: 2 });
  });

  it("refuses an unknown assistant key, and Eddy is not an assistant", () => {
    expect(decide({ type: "assistant", assistantKey: "eddy" }, LOWER, small, mandate(2), room(), NOW, on)).toMatchObject({ verdict: "refuse", reason: "unknown_assistant", suggestion: false });
    expect(decide({ type: "assistant", assistantKey: "made_up" }, raise(11_000n), small, mandate(2), room(), NOW, on).verdict).toBe("refuse");
  });
});

describe("reason copy", () => {
  const reasons: PolicyReason[] = [
    "lowering", "frozen", "assistants_frozen", "platform_frozen", "breaker", "learning", "unknown_assistant", "suggestion_only", "op_not_allowed",
    "over_daily_limit", "over_monthly_limit", "mandate_daily", "mandate_monthly", "no_monthly_limit", "end_date_required", "meta_limit_not_managed",
    "sandbox_only", "level_0", "level_1_step", "level_1_over_step", "level_1_breaker_open", "level_1_breaker_resume", "level_1_launch", "level_2",
    "level_2_over_share", "no_target_cost", "breaker_lowering", "breaker_resume", "breaker_no_raise", "not_assistant",
  ];
  it.each(reasons)("%s has a plain sentence without jargon", (reason) => {
    const text = policyReasonText(reason);
    expect(text).toMatch(/^[A-Z].*\.$/);
    for (const banned of BANNED_COPY_WORDS) expect(text.toLowerCase()).not.toContain(banned);
  });
});

describe("assistant registry (7.1)", () => {
  it("lists the four assistants with their UI labels and pots", () => {
    expect(ASSISTANTS.map((a) => [a.key, a.label, [...a.pots], a.phase])).toEqual([
      ["ads_optimizer", "Ad assistant", ["ads"], "live"],
      ["ads_launcher", "Campaign assistant", ["ads"], "planned"],
      ["broadcast_planner", "Broadcast assistant", ["messaging"], "planned"],
      ["lead_followup", "Follow-up assistant", ["messaging", "ai"], "planned"],
    ]);
    expect(ASSISTANT_KEYS).toEqual(["ads_optimizer", "ads_launcher", "broadcast_planner", "lead_followup"]);
    expect(Object.isFrozen(ASSISTANTS)).toBe(true);
  });

  it("Eddy and the AI reply bot are not assistants (4.15)", () => {
    for (const key of ["eddy", "ai_reply", "ai_agent"]) {
      expect(isAssistantKey(key)).toBe(false);
      expect(getAssistant(key)).toBeNull();
      expect(NOT_ASSISTANTS[key]).toBeTruthy();
    }
    expect(assistantLabel("eddy")).toBe("Assistant");
  });

  it("narrows ops to what each assistant may ever do", () => {
    expect(assistantMayDo("ads_optimizer", "raise_budget")).toBe(true);
    expect(assistantMayDo("ads_optimizer", "broadcast_start")).toBe(false);
    expect(sanitizeAllowedOps("ads_optimizer", ["broadcast_start", "raise_budget", "pause", "nonsense"])).toEqual(["pause", "raise_budget"]);
    expect(sanitizeAllowedOps("eddy", ["pause"])).toEqual([]);
    expect(assistantsForPot("messaging").map((a) => a.key)).toEqual(["broadcast_planner", "lead_followup"]);
    expect(isLoweringOp("cut_budget")).toBe(true);
    expect(isLoweringOp("raise_budget")).toBe(false);
  });

  it("levels have plain labels; the defaults are Level 0, 20% and 25%, and the owner may only lower them", () => {
    expect(LEVEL_OPTIONS.map((o) => o.label)).toEqual(["Suggest", "Guarded", "Autopilot"]);
    expect(levelLabel(2)).toBe("Autopilot");
    expect(levelLabel(9)).toBe("Suggest");
    expect(MANDATE_DEFAULTS).toMatchObject({ level: 0, raiseStepPct: 20, approvalSharePct: 25, shadowDays: 14 });
    expect(clampRaiseStepPct(35)).toBe(20);
    expect(clampRaiseStepPct(-3)).toBe(0);
    expect(clampApprovalSharePct(0)).toBe(1);
    expect(clampApprovalSharePct(40)).toBe(25);
    expect(clampApprovalSharePct(Number.NaN)).toBe(25);
    const copy = [...ASSISTANTS.flatMap((a) => [a.label, a.description]), ...LEVEL_OPTIONS.flatMap((o) => [o.label, o.description])].join(" ").toLowerCase();
    for (const banned of BANNED_COPY_WORDS) expect(copy).not.toContain(banned);
  });
});

describe("purity (WP-01 acceptance 1)", () => {
  it("policy.ts and registry.ts import neither prisma nor fetch, directly or through their imports", () => {
    const seen = new Set<string>();
    const visit = (rel: string) => {
      if (seen.has(rel)) return;
      seen.add(rel);
      const text = readFileSync(path.join(process.cwd(), "src", rel), "utf8");
      for (const m of text.matchAll(/^import\s[^;]*?from\s+["']([^"']+)["']/gm)) expect(m[1], rel).not.toMatch(/^@\/lib\/db$|^@prisma\/|generated\/prisma|^node:(http|https|net)$/);
      expect(text, rel).not.toMatch(/(?<![\w.])fetch\s*\(/);
      for (const m of text.matchAll(/^import\s+(?!type\b)[^;]*?from\s+["']([^"']+)["']/gm)) {
        const spec = m[1];
        if (spec.startsWith("./")) visit(path.posix.join(path.posix.dirname(rel), spec.slice(2)) + ".ts");
        else if (spec.startsWith("@/")) visit(spec.slice(2) + ".ts");
      }
    };
    visit("lib/spend/policy.ts");
    visit("lib/spend/registry.ts");
    expect([...seen]).toEqual(expect.arrayContaining(["lib/spend/flags.ts", "lib/spend/registry.ts"]));
  });
});
