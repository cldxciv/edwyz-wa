/**
 * Kill switches (docs/SPEND-CONTROLS-SPEC.md 4.11, 6.5, 8.1, 8.3).
 *
 * Two levels, per workspace (SpendControl.freeze) and platform-wide (PlatformSetting 'spend:platform'):
 * - `assistants` refuses every assistant intent, pauses assistant-launched campaigns and holds assistant sends;
 * - `all` refuses every raise, pauses every platform campaign, holds automated and API outbound, stops automatic AI, and
 *   supersedes pending approvals.
 *
 * Who may toggle: a workspace stop is a lowering, so the owner, an admin, a platform admin or a breaker may turn it on.
 * Turning it back on (or down from `all` to `assistants`) is owner only; a platform admin can override both ways. The
 * platform switch is platform admin only, with the typed confirmation, a reason and a step-up within the last 5 minutes.
 *
 * Reads: every raise path calls spendState({fresh: true}); the send gate and the AI gateway may use the cached read, which
 * is never more than 5 s old. A toggle in this process clears the cache at once.
 *
 * Propagation: a stop enqueues `spend.stop` (SPEND_QUEUES.stop) for the worker, after an optional inline pass (20 s budget)
 * that the ads call sites provide. Turning spending back on never restarts anything by itself (decision 2.3.13).
 */
import { prisma } from "@/lib/db";
import { enqueue as enqueueJob } from "@/lib/queue";
import { HttpError } from "@/lib/tenancy";
import { applyLedgered, getControl, PLATFORM_LEDGER_TENANT, requireReason, type SpendControlState, type SpendDb } from "./control";
import type { SpendCopyCode } from "./copy";
import { appendStandalone, type LedgerDb } from "./ledger";
import { SPEND_QUEUES, type FreezeLevel, type FreezeState, type FrozenByKind, type SpendActor, type SpendStopJob, type StopResultDTO } from "./types";

export const PLATFORM_FREEZE_KEY = "spend:platform";
/** The send gate and the AI gateway read the freeze through a cache no older than this (4.11). */
export const SPEND_STATE_CACHE_MS = 5_000;
/** A workspace toggle pauses inline for at most this long, then leaves the rest to the worker (4.11). */
export const STOP_INLINE_BUDGET_MS = 20_000;
/** Typed confirmations of the platform switch (8.3). */
export const PLATFORM_STOP_CONFIRM = "STOP SPENDING";
export const PLATFORM_RESUME_CONFIRM = "START SPENDING";
/** The platform switch needs a TOTP step-up no older than this (4.11). */
export const PLATFORM_STEP_UP_MAX_AGE_MS = 5 * 60_000;

const LEVELS: readonly FreezeLevel[] = ["none", "assistants", "all"];
const RANK: Record<FreezeLevel, number> = { none: 0, assistants: 1, all: 2 };

export function isFreezeLevel(value: unknown): value is FreezeLevel {
  return typeof value === "string" && (LEVELS as readonly string[]).includes(value);
}

/** The stricter of two levels. */
export function stricterFreeze(a: FreezeLevel, b: FreezeLevel): FreezeLevel {
  return RANK[a] >= RANK[b] ? a : b;
}

// ===== Platform switch state =====

export type PlatformFreeze = { freeze: FreezeLevel; reason: string | null; byUserId: string | null; at: Date | null; version: number };

export function parsePlatformFreeze(value: unknown): PlatformFreeze {
  const v = (value && typeof value === "object" ? value : {}) as Record<string, unknown>;
  const at = typeof v.at === "string" ? new Date(v.at) : null;
  return {
    freeze: isFreezeLevel(v.freeze) ? v.freeze : "none",
    reason: typeof v.reason === "string" ? v.reason : null,
    byUserId: typeof v.byUserId === "string" ? v.byUserId : null,
    at: at && !Number.isNaN(at.getTime()) ? at : null,
    version: Number.isInteger(v.version) ? (v.version as number) : 0,
  };
}

export async function readPlatformFreeze(db: SpendDb = prisma): Promise<PlatformFreeze> {
  const row = (await db.platformSetting.findUnique({ where: { key: PLATFORM_FREEZE_KEY } })) as { value?: unknown } | null;
  return parsePlatformFreeze(row?.value);
}

// ===== Reading the freeze =====

type WorkspaceFreeze = Pick<SpendControlState, "freeze" | "frozenAt" | "frozenByKind" | "frozenByUserId" | "frozenReason">;
type Cached<T> = { at: number; value: T };

const workspaceCache = new Map<string, Cached<WorkspaceFreeze>>();
let platformCache: Cached<PlatformFreeze> | null = null;

/** Clears the cached reads (one workspace, or everything). */
export function invalidateSpendState(tenantId?: string): void {
  if (tenantId === undefined) {
    workspaceCache.clear();
    platformCache = null;
  } else if (tenantId === PLATFORM_LEDGER_TENANT) platformCache = null;
  else workspaceCache.delete(tenantId);
}

/** Test hook. */
export function resetSpendStateCache(): void {
  invalidateSpendState();
}

/** Combines the two levels; the stricter one's who and when are shown. */
export function composeFreeze(ws: WorkspaceFreeze, pf: PlatformFreeze): FreezeState {
  const useWorkspace = ws.freeze !== "none" && RANK[ws.freeze] >= RANK[pf.freeze];
  const usePlatform = !useWorkspace && pf.freeze !== "none";
  return {
    workspace: ws.freeze,
    platform: pf.freeze,
    effective: stricterFreeze(ws.freeze, pf.freeze),
    frozenAt: useWorkspace ? ws.frozenAt : usePlatform ? pf.at : null,
    frozenByKind: useWorkspace ? ws.frozenByKind : usePlatform ? "platform_admin" : null,
    frozenByUserId: useWorkspace ? ws.frozenByUserId : usePlatform ? pf.byUserId : null,
    reason: useWorkspace ? ws.frozenReason : usePlatform ? pf.reason : null,
  };
}

export type SpendStateOptions = {
  /** Read both levels from the database now. Every raise path passes true. */
  fresh?: boolean;
  db?: SpendDb;
  /** Clock for the cache (tests). */
  now?: number;
};

/** The workspace and platform freeze. Without `fresh`, the answer is at most 5 s old. */
export async function spendState(tenantId: string, opts: SpendStateOptions = {}): Promise<FreezeState> {
  const now = opts.now ?? Date.now();
  const db = opts.db ?? prisma;
  const fresh = opts.fresh === true;
  let pf = !fresh && platformCache && now - platformCache.at < SPEND_STATE_CACHE_MS ? platformCache.value : null;
  if (!pf) {
    pf = await readPlatformFreeze(db);
    platformCache = { at: now, value: pf };
  }
  const hit = workspaceCache.get(tenantId);
  let ws = !fresh && hit && now - hit.at < SPEND_STATE_CACHE_MS ? hit.value : null;
  if (!ws) {
    const c = await getControl(tenantId, { db, prune: false });
    ws = { freeze: c.freeze, frozenAt: c.frozenAt, frozenByKind: c.frozenByKind, frozenByUserId: c.frozenByUserId, frozenReason: c.frozenReason };
    if (workspaceCache.size > 5_000) for (const [k, v] of workspaceCache) if (now - v.at >= SPEND_STATE_CACHE_MS) workspaceCache.delete(k);
    workspaceCache.set(tenantId, { at: now, value: ws });
  }
  return composeFreeze(ws, pf);
}

/**
 * The refusal a freeze gives a RAISE by this actor, or null. `all` (platform first) refuses everyone; `assistants` refuses
 * assistant actors only. Lowering is never refused by a freeze and must not call this.
 */
export function freezeRefusal(state: FreezeState, actor: SpendActor): SpendCopyCode | null {
  if (state.platform === "all") return "spend.platform_frozen";
  if (state.workspace === "all") return "spend.frozen";
  if (actor.type === "assistant") {
    if (state.platform === "assistants") return "spend.platform_frozen";
    if (state.workspace === "assistants") return "spend.frozen";
  }
  return null;
}

// ===== Toggling =====

export type StopInline = (job: SpendStopJob, budgetMs: number) => Promise<{ paused: number; total: number; failed: number }>;

export type FreezeOptions = {
  db?: SpendDb;
  now?: Date;
  /** Pauses inline (the ads call sites provide it); the rest is left to the spend.stop job. */
  inline?: StopInline;
  /** Defaults to the app job queue. */
  enqueue?: (queue: string, payload: unknown) => Promise<unknown>;
};

export type FreezeResult = StopResultDTO & { changed: boolean; correlationId: string | null; supersededApprovalIds: string[] };

const OWNER_ONLY_RESUME = "Only the owner can turn spending back on.";
const ADMIN_OR_OWNER_STOP = "Only the owner or an admin can stop spending.";

function frozenByKindOf(actor: SpendActor): FrozenByKind | null {
  if (actor.type === "user") return actor.role === "owner" ? "owner" : actor.role === "admin" ? "admin" : null;
  if (actor.type === "platform_admin") return "platform_admin";
  if (actor.type === "breaker") return "breaker";
  return null;
}

const userIdOf = (actor: SpendActor): string | null => (actor.type === "user" || actor.type === "platform_admin" ? actor.userId : null);

/** Who may move a workspace from `current` to `next` (4.11, 8.1). Throws the 403 to show. */
export function assertMayToggleWorkspace(current: FreezeLevel, next: FreezeLevel, actor: SpendActor): void {
  if (current === next) return;
  const tightening = RANK[next] > RANK[current];
  if (actor.type === "platform_admin") return;
  if (actor.type === "user") {
    if (actor.role === "owner") return;
    if (actor.role === "admin") {
      if (tightening) return;
      throw new HttpError(403, OWNER_ONLY_RESUME);
    }
    throw new HttpError(403, ADMIN_OR_OWNER_STOP);
  }
  if (actor.type === "breaker" && tightening) return;
  throw new HttpError(403, tightening ? ADMIN_OR_OWNER_STOP : OWNER_ONLY_RESUME);
}

const SUPERSEDE_REASON = "Spending was stopped, so this request was withdrawn.";

/** Marks pending approvals superseded (freeze `all`, 7.3) and ledgers each one. Returns the ids it changed. */
async function supersedePending(tx: SpendDb, tenantId: string | null, actor: SpendActor, now: Date): Promise<string[]> {
  const pending = ((await tx.spendApproval.findMany({
    where: { ...(tenantId ? { tenantId } : {}), status: "pending" },
    select: { id: true, tenantId: true, pot: true },
    take: 5_000,
  })) ?? []) as { id: string; tenantId: string; pot: string }[];
  const done: string[] = [];
  for (const a of pending) {
    const { count } = await tx.spendApproval.updateMany({
      where: { id: a.id, status: "pending" },
      data: { status: "superseded", decidedVia: "system", decidedAt: now, failureReason: SUPERSEDE_REASON },
    });
    if (count !== 1) continue;
    done.push(a.id);
    await appendStandalone(
      {
        tenantId: a.tenantId,
        pot: (["ads", "messaging", "ai"].includes(a.pot) ? a.pot : "none") as "ads" | "messaging" | "ai" | "none",
        action: "approval.supersede",
        phase: "info",
        actor,
        reason: SUPERSEDE_REASON,
        approvalId: a.id,
        targetType: "approval",
        targetId: a.id,
        idempotencyKey: `approval:${a.id}:supersede`,
      },
      { tx: tx as unknown as LedgerDb },
    );
  }
  return done;
}

function stopText(level: FreezeLevel, previous: FreezeLevel, inline: { paused: number; total: number; failed: number } | null): string {
  if (level === previous) return level === "none" ? "Spending is on." : level === "all" ? "Spending is already stopped." : "Assistants are already stopped.";
  if (RANK[level] < RANK[previous]) {
    return level === "none"
      ? "Spending is back on. Anything that was paused stays paused until you resume it."
      : "Spending is back on for your team. Assistants stay stopped.";
  }
  if (!inline) {
    return level === "all" ? "Spending is stopped. Running ads will be paused within a minute." : "Assistants are stopped. Their running ads will be paused within a minute.";
  }
  if (inline.total === 0) return level === "all" ? "Spending is stopped. No ads were running." : "Assistants are stopped. None of their ads were running.";
  if (inline.paused >= inline.total) return `Paused ${inline.paused} of ${inline.total} ${inline.total === 1 ? "campaign" : "campaigns"}.`;
  return `Paused ${inline.paused} of ${inline.total}; the rest will follow within a minute.`;
}

async function runInline(inline: StopInline | undefined, job: SpendStopJob): Promise<{ paused: number; total: number; failed: number } | null> {
  if (!inline) return null;
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const timeout = new Promise<null>((resolve) => {
      timer = setTimeout(() => resolve(null), STOP_INLINE_BUDGET_MS);
    });
    return await Promise.race([inline(job, STOP_INLINE_BUDGET_MS), timeout]);
  } catch (error) {
    console.error("[spend] inline stop failed; the spend.stop job will finish it:", error instanceof Error ? error.message : "unknown");
    return null;
  } finally {
    if (timer) clearTimeout(timer);
  }
}

async function enqueueStop(opts: FreezeOptions, job: SpendStopJob): Promise<void> {
  try {
    await (opts.enqueue ?? enqueueJob)(SPEND_QUEUES.stop, job);
  } catch (error) {
    // The once-a-minute kill sweep still finds what the freeze covers.
    console.error("[spend] could not enqueue spend.stop:", error instanceof Error ? error.message : "unknown");
  }
}

function result(level: FreezeLevel, previous: FreezeLevel, inline: { paused: number; total: number; failed: number } | null, extra: Omit<FreezeResult, keyof StopResultDTO>): FreezeResult {
  return {
    level,
    paused: inline?.paused ?? 0,
    total: inline?.total ?? 0,
    pending: inline ? Math.max(0, inline.total - inline.paused) : 0,
    failed: inline?.failed ?? 0,
    text: stopText(level, previous, inline),
    ...extra,
  };
}

/** Stops or resumes spending for one workspace (Settings > Spending limits, Eddy's stop_spending, the admin panel). */
export async function setWorkspaceFreeze(tenantId: string, level: FreezeLevel, actor: SpendActor, reason?: string | null, opts: FreezeOptions = {}): Promise<FreezeResult> {
  if (!isFreezeLevel(level)) throw new HttpError(400, "Choose to stop assistants, stop all spending, or turn spending back on.");
  const now = opts.now ?? new Date();
  const why = requireReason(reason, level === "none" ? "Turned spending back on." : level === "all" ? "Stopped all spending." : "Stopped assistants.");
  let previous = "none" as FreezeLevel;
  let superseded = [] as string[];
  try {
    const { correlationId } = await applyLedgered(opts.db, async (tx) => {
      const control = await getControl(tenantId, { db: tx, prune: false });
      previous = control.freeze;
      if (previous === level) return { result: null, row: null };
      assertMayToggleWorkspace(previous, level, actor);
      const on = level !== "none";
      await tx.spendControl.update({
        where: { tenantId },
        data: on
          ? { freeze: level, frozenByKind: frozenByKindOf(actor), frozenByUserId: userIdOf(actor), frozenReason: why, frozenAt: now, version: { increment: 1 } }
          : { freeze: "none", frozenByKind: null, frozenByUserId: null, frozenReason: null, frozenAt: null, version: { increment: 1 } },
      });
      if (level === "all") superseded = await supersedePending(tx, tenantId, actor, now);
      return {
        result: null,
        row: {
          tenantId,
          pot: "none",
          action: "kill.workspace",
          actor,
          reason: why,
          reasonCodes: [`freeze_${level}`],
          targetType: "workspace",
          targetId: tenantId,
          before: { freeze: previous },
          after: { freeze: level, supersededApprovals: superseded.length },
          undo: { action: "set_freeze", level: previous },
        },
      };
    });
    invalidateSpendState(tenantId);
    if (previous === level) return result(level, previous, null, { changed: false, correlationId: null, supersededApprovalIds: [] });
    let inline: { paused: number; total: number; failed: number } | null = null;
    if (RANK[level] > RANK[previous]) {
      const job: SpendStopJob = { tenantId, level: level as Exclude<FreezeLevel, "none">, origin: level === "assistants" ? "assistant" : "all", reason: why, actor, correlationId: correlationId ?? undefined };
      inline = await runInline(opts.inline, job);
      await enqueueStop(opts, job);
    }
    return result(level, previous, inline, { changed: true, correlationId, supersededApprovalIds: superseded });
  } catch (error) {
    if (error instanceof HttpError && error.status === 403) {
      await appendStandalone(
        { tenantId, pot: "none", action: "kill.workspace", phase: "refused", actor, reason: error.message, reasonCodes: ["not_allowed"], before: { freeze: previous }, after: { freeze: level } },
        { db: opts.db as LedgerDb | undefined },
      );
    }
    throw error;
  }
}

/**
 * The platform-wide switch (/admin/spending). Platform admin only, with the typed confirmation ("STOP SPENDING" to stop,
 * "START SPENDING" to turn it back on), a reason and a step-up no older than 5 minutes.
 */
export async function setPlatformFreeze(
  level: FreezeLevel,
  actor: SpendActor,
  reason: string,
  opts: FreezeOptions & { confirm: string; stepUpAt: Date | null },
): Promise<FreezeResult> {
  if (actor.type !== "platform_admin") throw new HttpError(403, "Only Edwyz support can stop spending for every workspace.");
  if (!isFreezeLevel(level)) throw new HttpError(400, "Choose to stop assistants everywhere, stop all spending everywhere, or turn spending back on.");
  const why = requireReason(reason);
  const now = opts.now ?? new Date();
  if (!opts.stepUpAt || now.getTime() - opts.stepUpAt.getTime() > PLATFORM_STEP_UP_MAX_AGE_MS || opts.stepUpAt.getTime() > now.getTime() + 60_000) {
    throw new HttpError(403, "Confirm it's you again with your authenticator code, then try within 5 minutes.");
  }
  let previous = "none" as FreezeLevel;
  let superseded = [] as string[];
  const { correlationId } = await applyLedgered(opts.db, async (tx) => {
    const current = await readPlatformFreeze(tx);
    previous = current.freeze;
    if (previous === level) return { result: null, row: null };
    const expected = RANK[level] > RANK[previous] ? PLATFORM_STOP_CONFIRM : PLATFORM_RESUME_CONFIRM;
    if ((opts.confirm ?? "").trim() !== expected) throw new HttpError(400, `Type ${expected} to confirm.`);
    const value = { freeze: level, reason: level === "none" ? null : why, byUserId: actor.userId, at: now.toISOString(), version: current.version + 1 };
    await tx.platformSetting.upsert({ where: { key: PLATFORM_FREEZE_KEY }, create: { key: PLATFORM_FREEZE_KEY, value }, update: { value } });
    if (level === "all") superseded = await supersedePending(tx, null, actor, now);
    return {
      result: null,
      row: {
        tenantId: PLATFORM_LEDGER_TENANT,
        pot: "none",
        action: "kill.platform",
        actor,
        reason: why,
        reasonCodes: [`freeze_${level}`],
        targetType: "platform",
        targetId: PLATFORM_LEDGER_TENANT,
        before: { freeze: previous, version: current.version },
        after: { freeze: level, version: value.version, supersededApprovals: superseded.length },
        undo: { action: "set_platform_freeze", level: previous },
      },
    };
  });
  invalidateSpendState(PLATFORM_LEDGER_TENANT);
  if (previous === level) return result(level, previous, null, { changed: false, correlationId: null, supersededApprovalIds: [] });
  let inline: { paused: number; total: number; failed: number } | null = null;
  if (RANK[level] > RANK[previous]) {
    const job: SpendStopJob = { tenantId: "*", level: level as Exclude<FreezeLevel, "none">, origin: level === "assistants" ? "assistant" : "all", reason: why, actor, correlationId: correlationId ?? undefined };
    inline = await runInline(opts.inline, job);
    await enqueueStop(opts, job);
  }
  return result(level, previous, inline, { changed: true, correlationId, supersededApprovalIds: superseded });
}
