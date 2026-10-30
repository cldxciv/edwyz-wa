/**
 * The notice scan (docs/EDDY-SPEC.md 6.7, EDDY-16): the `notices.scan` periodic task, every 120 s (src/worker/eddy.ts).
 *
 * - Workspaces: only those with Eddy switched on or with proactive notices on (EddyWorkspaceSetting.enabled or
 *   .proactiveNotices; a workspace with no setting row has the defaults, and proactive notices default to on). Deleted
 *   workspaces are skipped. At most MAX_TENANTS_PER_RUN workspaces are scanned per run; the next run carries on from a
 *   rotation cursor, so the cost per run stays flat however many workspaces there are (12.2 risk 12).
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

// ===== One workspace =====

export type TenantScanResult = { tenantId: string; ran: string[]; skipped: string[]; failed: string[]; published: number; resolved: number };

export type ScanDeps = { producers?: readonly NoticeProducer[]; isDemo?: (tenantId: string) => Promise<boolean> };

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
    if ((p.skipDemo && demo) || (p.numberBased && !hasNumber)) {
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

/** The `notices.scan` task: the next workspaces in rotation, each scanned in turn. Never throws. */
export async function runNoticeScan(opts: { now?: Date; maxTenants?: number } & ScanDeps = {}): Promise<ScanRunResult> {
  const now = opts.now ?? new Date();
  const max = opts.maxTenants ?? MAX_TENANTS_PER_RUN;
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
    for (const tenantId of tenants) {
      const r = await scanTenant(tenantId, now, opts);
      out.tenants++;
      out.published += r.published;
      out.resolved += r.resolved;
      out.failed += r.failed.length;
    }
    await writeCursor(ROTATION_TENANT, ROTATION_SCANNER, { after: nextAfter }, now);
  } catch (error) {
    console.error(`[notices] scan failed: ${describeError(error)}`);
  }
  return out;
}
