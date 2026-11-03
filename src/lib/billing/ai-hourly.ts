/**
 * The workspace's AI replies per hour (owner decision 3), read where the AI agent admits a reply (src/lib/ai-agent/index.ts) and
 * shown on the AI agent screen. The rules are in ./ai-allowance.ts; this file finds the plan that applies:
 *
 * - during a trial: the trial plan's own value (Plan with code "trial"), else 60. This holds even when the subscription row
 *   already names a plan, because a checkout that was opened but never paid writes its plan there;
 * - a paid plan (active, payment grace, or complimentary with a plan): its own value, else its code or name default, else the
 *   platform fallback (AI_MAX_REPLIES_PER_HOUR, passed in by the caller);
 * - otherwise (no plan, complimentary without a plan, a plan that has ended): 60.
 * When the plan cannot be read at all the fallback applies. A lookup is kept for a minute per workspace, so the AI agent pays no
 * extra query per reply; a plan change shows within that minute.
 *
 * It also raises the one notice per hour when the cap is reached (noteHourlyCapHit): kind ai_limit_100 with period "hour", one
 * dedupe key per UTC hour, so however many messages the cap holds back in that hour the admins get one notice. The AI limit
 * producer (src/lib/notices/producers/ai-limit.ts) resolves it once the hour after it is over.
 */
import { prisma } from "@/lib/db";
import { act } from "@/lib/notices/kinds";
import { publishNotice, resolveNotices } from "@/lib/notices/publish";
import { describeError } from "@/lib/safe-error";
import { BASE_AI_REPLIES_PER_HOUR, featureRepliesPerHour, planRepliesPerHour } from "./ai-allowance";
import { getBillingStatus } from "./status";

export type HourlyAllowanceSource = "plan" | "plan_default" | "trial" | "no_plan" | "fallback";
export type HourlyAllowance = { limit: number; source: HourlyAllowanceSource; planName: string | null };

const TTL_MS = 60_000;
const MAX_CACHED = 5000;
type Lookup = { limit: number | null; source: Exclude<HourlyAllowanceSource, "fallback">; planName: string | null };
const cache = new Map<string, { at: number; lookup: Lookup }>();

/** Test hook: forget the cached lookups. */
export function resetAiHourlyCache(): void {
  cache.clear();
  noted.clear();
}

const PLAN_SELECT = { code: true, name: true, features: true } as const;

/** The states in which the subscription's plan is paid for (or given), so its allowance applies. */
const PAID_STATES: ReadonlySet<string> = new Set(["active", "past_due_grace", "exempt"]);

/** What the workspace's plan says, or null when it cannot be told (the fallback applies then). `limit` null: the plan has no value. */
async function lookup(tenantId: string): Promise<Lookup | null> {
  const status = await getBillingStatus(tenantId);
  if (!status || typeof status !== "object") return null;
  // The trial rule comes first: a checkout that was started but never paid already writes its plan on the subscription row
  // (startSubscription), and a trial must not get that plan's allowance without paying for it.
  if (status.state === "trialing") {
    const trial = await prisma.plan.findUnique({ where: { code: "trial" }, select: PLAN_SELECT });
    return { limit: featureRepliesPerHour(trial?.features) ?? BASE_AI_REPLIES_PER_HOUR, source: "trial", planName: trial?.name ?? null };
  }
  if (status.planId && PAID_STATES.has(status.state)) {
    const plan = await prisma.plan.findUnique({ where: { id: status.planId }, select: PLAN_SELECT });
    if (!plan) return null;
    const value = planRepliesPerHour(plan);
    return value ? { limit: value.value, source: value.from, planName: plan.name ?? null } : { limit: null, source: "plan", planName: plan.name ?? null };
  }
  return { limit: BASE_AI_REPLIES_PER_HOUR, source: "no_plan", planName: null };
}

/**
 * The AI replies per hour for this workspace. `fallback` is AI_MAX_REPLIES_PER_HOUR as the AI agent reads it, used only when no plan
 * value can be found. Never throws.
 */
export async function aiRepliesPerHour(tenantId: string, opts: { fallback: number; now?: number }): Promise<HourlyAllowance> {
  const now = opts.now ?? Date.now();
  let found: Lookup | null = null;
  const hit = cache.get(tenantId);
  if (hit && now - hit.at < TTL_MS) {
    found = hit.lookup;
  } else {
    try {
      found = await lookup(tenantId);
    } catch (error) {
      console.warn(`[billing] AI replies per hour could not be read, the platform value applies: ${describeError(error)}`);
      found = null;
    }
    // Only an answer is kept: after a failed read the next reply tries again.
    if (found) {
      if (cache.size >= MAX_CACHED) cache.clear();
      cache.set(tenantId, { at: now, lookup: found });
    }
  }
  if (!found || found.limit === null) return { limit: opts.fallback, source: "fallback", planName: found?.planName ?? null };
  return { limit: found.limit, source: found.source, planName: found.planName };
}

// ===== The notice =====

/** "2026-10-31T14": the UTC hour, the period key of the hourly notice. */
export function hourKey(at: Date): string {
  return at.toISOString().slice(0, 13);
}

export const AI_HOUR_NOTICE_PREFIX = "ai-hour:";
export const aiHourNoticeKey = (at: Date) => `${AI_HOUR_NOTICE_PREFIX}${hourKey(at)}`;
/** The hourly notice stays up for the hour it was raised in and the one after, then the AI limit producer resolves it. */
export const AI_HOUR_NOTICE_TTL_MS = 2 * 60 * 60_000;
/** The keys the AI limit producer keeps open: this hour's and the last hour's. */
export const openAiHourKeys = (now: Date): string[] => [aiHourNoticeKey(now), aiHourNoticeKey(new Date(now.getTime() - 60 * 60_000))];

/** Per workspace, the hour a notice was already raised for in this process, so a busy hour costs one write. */
const noted = new Map<string, string>();

/**
 * Raises the one "AI replies reached this hour's limit" notice for this hour (admins, with Go to billing), and resolves an
 * earlier hour's, so at most one is open. Never throws: the AI agent's own work goes on whatever happens here.
 */
export async function noteHourlyCapHit(tenantId: string, input: { used: number; limit: number; now?: Date }): Promise<void> {
  const now = input.now ?? new Date();
  const hour = hourKey(now);
  if (noted.get(tenantId) === hour) return;
  try {
    const key = aiHourNoticeKey(now);
    const result = await publishNotice(
      {
        tenantId,
        kind: "ai_limit_100",
        severity: "action_needed",
        dedupeKey: key,
        audience: { minRole: "admin" },
        payload: { period: "hour", periodKey: hour, level: 100, used: input.used, limit: input.limit },
        actions: [act.go("/app/billing#plans", "btn.go_to_billing")],
        ttlMs: AI_HOUR_NOTICE_TTL_MS,
      },
      { now },
    );
    if (result.outcome === "failed") return;
    if (noted.size >= MAX_CACHED) noted.clear();
    noted.set(tenantId, hour);
    await resolveNotices(tenantId, { kinds: ["ai_limit_100"], prefix: AI_HOUR_NOTICE_PREFIX, except: [key] }, { now });
  } catch (error) {
    console.warn(`[billing] the hourly AI notice could not be raised: ${describeError(error)}`);
  }
}
