/**
 * Wall (a) in the worker (docs/SPEND-CONTROLS-SPEC.md 5, 4.16, 4.17). Runs in the daemon, and through /api/internal/tick
 * when the daemon is down.
 *
 * Queues:
 * - spend.metacap.replan: a limit changed, META_CAP_TOO_LOW, consent, a deferred write came due, or the 60-second read-back
 *   of an ambiguous write. Re-reads and re-plans the account (or every managed account of the workspace).
 * - spend.metacap.p0: a stop could not pause everything (failed or unreachable objects): Meta's limit is set to stop the
 *   account now (emergency class).
 * - spend.metacap.offboard: one of the 5.8 choices for an account leaving Edwyz's management.
 * Periodic: spend.metacap.pass every 5 minutes reads every managed account that is due (15 minutes with open commitments or
 * spend this month, 6 hours otherwise) and writes what the plan says.
 */
import type { JobHandler } from "@/lib/queue";
import type { PeriodicTask } from "@/worker/registry";
import { isOffboardChoice, OFFBOARD_TRIGGERS, offboardAccount, type OffboardTrigger } from "../metacap/offboard";
import { METACAP_PASS_MS, p0Stop, replanTenant, runMetacapPass } from "../metacap/sync";
import { SPEND_QUEUES, type MetacapOffboardJob, type MetacapP0Job, type MetacapReplanJob, type SpendActor } from "../types";

const str = (v: unknown): string | null => (typeof v === "string" && v.length > 0 && v.length <= 200 ? v : null);

function actorOf(v: unknown): SpendActor {
  if (v && typeof v === "object") {
    const a = v as Record<string, unknown>;
    if (a.type === "user" && str(a.userId) && (a.role === "owner" || a.role === "admin" || a.role === "agent")) return { type: "user", userId: a.userId as string, role: a.role };
    if (a.type === "platform_admin" && str(a.userId)) return { type: "platform_admin", userId: a.userId as string };
    if (a.type === "system" && str(a.job)) return { type: "system", job: a.job as string };
    if (a.type === "breaker" && str(a.kind)) return { type: "breaker", kind: a.kind as string };
  }
  return { type: "system", job: "metacap.offboard" };
}

export const handleReplan: JobHandler = async (payload) => {
  const p = (payload ?? {}) as Partial<MetacapReplanJob>;
  const tenantId = str(p.tenantId);
  if (!tenantId) return;
  await replanTenant(tenantId, str(p.adAccountAssetId) ?? undefined);
};

export const handleP0: JobHandler = async (payload) => {
  const p = (payload ?? {}) as Partial<MetacapP0Job>;
  const tenantId = str(p.tenantId);
  const assetId = str(p.adAccountAssetId);
  if (!tenantId || !assetId) return;
  await p0Stop(tenantId, assetId, str(p.reason) ?? "stop");
};

export const handleOffboard: JobHandler = async (payload) => {
  const p = (payload ?? {}) as Partial<MetacapOffboardJob>;
  const tenantId = str(p.tenantId);
  const assetId = str(p.adAccountAssetId);
  if (!tenantId || !assetId) return;
  const trigger = (OFFBOARD_TRIGGERS as readonly string[]).includes(String(p.trigger)) ? (p.trigger as OffboardTrigger) : "turn_off";
  await offboardAccount(tenantId, assetId, isOffboardChoice(p.choice) ? p.choice : "keep", trigger, actorOf(p.actor), { reason: str(p.reason) ?? undefined });
};

export const queues: Record<string, JobHandler> = {
  [SPEND_QUEUES.metacapReplan]: handleReplan,
  [SPEND_QUEUES.metacapP0]: handleP0,
  [SPEND_QUEUES.metacapOffboard]: handleOffboard,
};

export const periodic: PeriodicTask[] = [{ name: "spend.metacap.pass", everyMs: METACAP_PASS_MS, run: () => runMetacapPass() }];
