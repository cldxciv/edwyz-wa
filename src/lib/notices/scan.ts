/**
 * The notice scan (docs/EDDY-SPEC.md 6.7, EDDY-16): the `notices.scan` periodic task, every 120 s (src/worker/eddy.ts).
 *
 * - Workspaces: only those with Eddy switched on or with proactive notices on (EddyWorkspaceSetting.enabled or
 *   .proactiveNotices; a workspace with no setting row has the defaults, and proactive notices default to on). Deleted
 *   workspaces are skipped. At most MAX_TENANTS_PER_RUN workspaces are scanned per run, SCAN_CONCURRENCY at a time, and a
 *   run starts no new workspace after SCAN_BUDGET_MS; the next run carries on from a rotation cursor (the last workspace
 *   actually scanned), so the cost per run stays flat however many workspaces there are (12.2 risk 12) and a run never
 *   holds the worker pass, or the once-a-minute tick, for long.
 * - Due work only: before a batch is scanned, each producer's `due` pre-check finds, with a few indexed queries for the
 *   whole batch, the workspaces where it may have something to publish, and every workspace where one of its kinds is still
 *   open is added (it may resolve). A producer runs only there, and a workspace where nothing is due costs no query at all,
 *   so an idle workspace is nearly free however many there are; setup spaces out its own checks (producers/setup.ts). A
 *   pre-check that fails runs its producer everywhere.
 * - Producers are deterministic, read-only on everything but the notice store, and never call AI. Each keeps its own cursor
 *   in NoticeScanState (tenantId, scanner = the producer's name). They never edit webhooks/processor.ts and never write a
 *   Phase 0 table (they read SpendBreaker, SpendApproval, SpendControl and the AI counters).
 * - The demo workspace (6.14) skips the token and quality scans (it has no token by design), and a workspace with no
 *   WhatsApp number skips the number-based kinds (quality, failed sends).
 * - One producer failing never stops the others, or the other workspaces: errors are logged with ids only.
 */
import { prisma } from "@/lib/db";
import { isDemoWorkspace } from "@/lib/actions/spend-bridge";
import { describeError } from "@/lib/safe-error";
import type { NoticeKind } from "@/lib/eddy/contract";
import { publishNotice, resolveNotices, type PublishInput, type PublishResult, type ResolveFilter } from "./publish";
import { producer as templates } from "./producers/templates";
import { producer as quality } from "./producers/quality";
import { producer as failures } from "./producers/failures";
import { producer as approvals } from "./producers/approvals";
import { producer as token } from "./producers/token";
import { producer as aiLimit } from "./producers/ai-limit";
import { producer as spending } from "./producers/spending";
import { producer as activity } from "./producers/activity";
import { producer as setup } from "./producers/setup";

export const NOTICE_SCAN_EVERY_MS = 120_000;
/** Workspaces scanned per run; the rotation cursor carries on next run. */
export const MAX_TENANTS_PER_RUN = 100;
/** Workspaces scanned side by side (each one's producers still run in turn). Small: the pass shares the app's database pool. */
export const SCAN_CONCURRENCY = 4;
/** A run starts no new workspace after this long; the rotation cursor carries on from the last one scanned. */
export const SCAN_BUDGET_MS = 10_000;
/** The rotation cursor's NoticeScanState row (not a workspace). */
export const ROTATION_TENANT = "*";
export const ROTATION_SCANNER = "rotation";

export type Json = string | number | boolean | null | Json[] | { [key: string]: Json };

export type ProducerContext = {
  tenantId: string;
  now: Date;
  demo: boolean;
  hasNumber: boolean;
  /** This producer's cursor from NoticeScanState, or null on its first run in this workspace. */
  cursor: Json | null;
  /** publishNotice for this workspace. */
  publish: (n: Omit<PublishInput, "tenantId">) => Promise<PublishResult>;
  /** resolveNotices for this workspace. */
  resolve: (filter: ResolveFilter) => Promise<number>;
};

export type ProducerResult = { cursor?: Json | null; published?: number; resolved?: number };

export type NoticeProducer = {
  /** Also the NoticeScanState scanner name. */
  name: string;
  kinds: readonly NoticeKind[];
  /** Skipped in the demo workspace (token and quality, 6.14). */
  skipDemo?: boolean;
  /** Skipped when the workspace has no WhatsApp number. */
  numberBased?: boolean;
  /**
   * The workspaces among `tenantIds` where this producer may have something new to publish (a superset is fine, a miss is
   * not), from a few queries for the whole batch. The scan adds the workspaces with an open notice of its kinds (so they
   * can resolve), unless `dueIsComplete`. Without it, the producer runs in every workspace.
   */
  due?(tenantIds: readonly string[], now: Date): Promise<Iterable<string>>;
  /** `due` alone decides, open notices or not (setup re-checks a settled checklist on its own schedule). */
  dueIsComplete?: boolean;
  run(ctx: ProducerContext): Promise<ProducerResult>;
};

export const PRODUCERS: readonly NoticeProducer[] = [templates, quality, failures, approvals, token, aiLimit, spending, activity, setup];

// ===== Cursors =====

export async function readCursors(tenantId: string): Promise<Map<string, Json>> {
  const rows = (await prisma.noticeScanState.findMany({ where: { tenantId }, select: { scanner: true, cursor: true } })) as { scanner: string; cursor: Json }[];
  return new Map(rows.map((r) => [r.scanner, r.cursor]));
}

export async function writeCursor(tenantId: string, scanner: string, cursor: Json, now: Date): Promise<void> {
  await prisma.noticeScanState.upsert({
    where: { tenantId_scanner: { tenantId, scanner } },
    create: { tenantId, scanner, cursor: cursor as never, updatedAt: now },
    update: { cursor: cursor as never, updatedAt: now },
  });
}

// ===== Which workspaces =====

/** The next workspaces to scan after `after` (by id), skipping deleted ones and those with Eddy and proactive notices off. */
export async function eligibleTenants(after: string, limit: number): Promise<string[]> {
  const out: string[] = [];
  let cursor = after;
  for (let page = 0; page < 5 && out.length < limit; page++) {
    const tenants = (await prisma.tenant.findMany({ where: { deletedAt: null, id: { gt: cursor } }, orderBy: { id: "asc" }, take: limit, select: { id: true } })) as { id: string }[];
    if (tenants.length === 0) break;
    cursor = tenants[tenants.length - 1].id;
    const settings = (await prisma.eddyWorkspaceSetting.findMany({ where: { tenantId: { in: tenants.map((t) => t.id) } }, select: { tenantId: true, enabled: true, proactiveNotices: true } })) as { tenantId: string; enabled: boolean; proactiveNotices: boolean }[];
    const byTenant = new Map(settings.map((s) => [s.tenantId, s]));
    for (const t of tenants) {
      const s = byTenant.get(t.id);
      if (!s || s.enabled || s.proactiveNotices) out.push(t.id);
      if (out.length >= limit) break;
    }
    if (tenants.length < limit) break;
  }
  return out;
}

/** Per producer, the workspaces of a batch where it runs (null: all of them): its `due` pre-check plus its open kinds. */
export type DueMap = ReadonlyMap<string, ReadonlySet<string> | null>;

/** The due work of a batch (see the header): one query for the open notices, then each producer's pre-check in turn. Never throws. */
export async function dueWorkspaces(tenantIds: readonly string[], producers: readonly NoticeProducer[], now: Date): Promise<DueMap> {
  const out = new Map<string, ReadonlySet<string> | null>(producers.map((p) => [p.name, null]));
  if (tenantIds.length === 0 || !producers.some((p) => p.due)) return out;
  let open: { tenantId: string; kind: string }[];
  try {
    const rows = await prisma.notice.groupBy({ by: ["tenantId", "kind"], where: { tenantId: { in: [...tenantIds] }, resolvedAt: null } });
    open = rows;
  } catch (error) {
    console.error(`[notices] open notices could not be read: ${describeError(error)}`);
    return out;
  }
  for (const p of producers) {
    if (!p.due) continue;
    try {
      const due = new Set(await p.due(tenantIds, now));
      if (!p.dueIsComplete) for (const n of open) if ((p.kinds as readonly string[]).includes(n.kind)) due.add(n.tenantId);
      out.set(p.name, due);
    } catch (error) {
      console.error(`[notices] pre-check ${p.name} failed, so it runs everywhere: ${describeError(error)}`);
    }
  }
  return out;
}

/** Whether any producer has work in this workspace. */
export const anyDue = (due: DueMap, tenantId: string): boolean => [...due.values()].some((set) => set === null || set.has(tenantId));

// ===== One workspace =====

export type TenantScanResult = { tenantId: string; ran: string[]; skipped: string[]; failed: string[]; published: number; resolved: number };

export type ScanDeps = {
  producers?: readonly NoticeProducer[];
  isDemo?: (tenantId: string) => Promise<boolean>;
  /** From dueWorkspaces: a producer runs only in the workspaces listed for it. Without it, every producer runs. */
  due?: DueMap;
};

/** Runs every producer for one workspace and saves their cursors. Never throws. */
export async function scanTenant(tenantId: string, now: Date = new Date(), deps: ScanDeps = {}): Promise<TenantScanResult> {
  const result: TenantScanResult = { tenantId, ran: [], skipped: [], failed: [], published: 0, resolved: 0 };
  let demo = false;
  let hasNumber = false;
  let cursors = new Map<string, Json>();
  try {
    [demo, hasNumber, cursors] = await Promise.all([
      (deps.isDemo ?? isDemoWorkspace)(tenantId).catch(() => false),
      prisma.phoneNumber.count({ where: { tenantId } }).then((n: number) => n > 0),
      readCursors(tenantId),
    ]);
  } catch (error) {
    console.error(`[notices] scan of ${tenantId} could not start: ${describeError(error)}`);
    result.failed.push("*");
    return result;
  }
  for (const p of deps.producers ?? PRODUCERS) {
    const due = deps.due?.get(p.name);
    if ((p.skipDemo && demo) || (p.numberBased && !hasNumber) || (due && !due.has(tenantId))) {
      result.skipped.push(p.name);
      continue;
    }
    try {
      const out = await p.run({
        tenantId,
        now,
        demo,
        hasNumber,
        cursor: cursors.get(p.name) ?? null,
        publish: (n) => publishNotice({ ...n, tenantId }, { now }),
        resolve: (filter) => resolveNotices(tenantId, filter, { now }),
      });
      if (out.cursor !== undefined && out.cursor !== null) await writeCursor(tenantId, p.name, out.cursor, now);
      result.ran.push(p.name);
      result.published += out.published ?? 0;
      result.resolved += out.resolved ?? 0;
    } catch (error) {
      result.failed.push(p.name);
      console.error(`[notices] producer ${p.name} failed for ${tenantId}: ${describeError(error)}`);
    }
  }
  return result;
}

// ===== The periodic task =====

export type ScanRunResult = { tenants: number; published: number; resolved: number; failed: number };

/** The `notices.scan` task: the next workspaces in rotation, a few at a time, until the batch or the time budget runs out. Never throws. */
export async function runNoticeScan(opts: { now?: Date; maxTenants?: number; concurrency?: number; budgetMs?: number } & ScanDeps = {}): Promise<ScanRunResult> {
  const now = opts.now ?? new Date();
  const max = opts.maxTenants ?? MAX_TENANTS_PER_RUN;
  const concurrency = Math.max(1, opts.concurrency ?? SCAN_CONCURRENCY);
  const budget = opts.budgetMs ?? SCAN_BUDGET_MS;
  const started = Date.now();
  const out: ScanRunResult = { tenants: 0, published: 0, resolved: 0, failed: 0 };
  try {
    const rotation = (await readCursors(ROTATION_TENANT)).get(ROTATION_SCANNER);
    const after = rotation && typeof rotation === "object" && !Array.isArray(rotation) && typeof rotation.after === "string" ? rotation.after : "";
    const first = await eligibleTenants(after, max);
    let tenants = first;
    let nextAfter = first.length ? first[first.length - 1] : "";
    if (first.length < max) {
      // The end of the list: carry on from the first workspace in the same run, up to the one this rotation started after.
      const rest = after ? (await eligibleTenants("", max - first.length)).filter((id) => id <= after && !first.includes(id)) : [];
      tenants = [...first, ...rest];
      nextAfter = rest.length ? rest[rest.length - 1] : "";
    }
    // Only the workspaces with due work are scanned; the rest of the batch costs nothing this run.
    const due = await dueWorkspaces(tenants, opts.producers ?? PRODUCERS, now);
    tenants = tenants.filter((tenantId) => anyDue(due, tenantId));
    const deps: ScanDeps = { ...opts, due };
    for (let i = 0; i < tenants.length; i += concurrency) {
      if (i > 0 && Date.now() - started > budget) {
        // Out of time: the next run starts after the last workspace scanned, so none is skipped.
        nextAfter = tenants[i - 1];
        break;
      }
      for (const r of await Promise.all(tenants.slice(i, i + concurrency).map((tenantId) => scanTenant(tenantId, now, deps)))) {
        out.tenants++;
        out.published += r.published;
        out.resolved += r.resolved;
        out.failed += r.failed.length;
      }
    }
    await writeCursor(ROTATION_TENANT, ROTATION_SCANNER, { after: nextAfter }, now);
  } catch (error) {
    console.error(`[notices] scan failed: ${describeError(error)}`);
  }
  return out;
}
