/**
 * The spend controls' NotifyPort (docs/SPEND-CONTROLS-SPEC.md 7.4, 9.3; WP-15). Every notice tries, in order:
 *
 * 1. WhatsApp from the platform notifier (platform-sender.ts), when the person has a verified channel, the template is
 *    approved and active, the notifier number is not RED or restricted, and TIER_250 has room. Only notices that need a
 *    person go there: approval requests (spend_approval_v1, with the one-tap link and a signed Decline), alerts about
 *    something that was paused (spend_alert_v1) and the daily summary (spend_daily_v1). Heads-ups and notes stay in the app.
 * 2. Email: switched OFF (12.1a decision 2, no SMTP). Reported as skipped; no copy may say "we emailed you".
 * 3. In-app, always: one Notice row per (tenantId, dedupeKey), written through publishNotice() (Eddy request E6), source
 *    'spend', carrying Phase 0's own English title and body for the strip.
 *
 * A notice whose dedupeKey is already open is a no-op on every channel, so a retried notice never sends twice. Never throws:
 * a notice that cannot be delivered is reported as skipped, and the money decision it is about stands.
 */
import type { Prisma } from "@/generated/prisma/client";
import { prisma } from "@/lib/db";
import { publishNotice, type NoticeDb as PublishDb } from "@/lib/notices/publish";
import { describeError } from "@/lib/safe-error";
import { newApprovalToken } from "../approval-token";
import type { SpendDb } from "../control";
import { appendStandalone, type LedgerDb } from "../ledger";
import { formatMinor } from "../money";
import { assistantLabel } from "../registry";
import type { NotifyChannelKind, NotifyPort, NotifyResult, SpendNotice, SpendNoticeAudience } from "../types";
import { eraseOwnerChannels, noteSent, recipientsFor, replyPayload, type Recipient } from "./owner-channel";
import { sendNotifierTemplate, senderReadiness, type NotifyPurpose, type SendOutcome, type TemplateSend } from "./platform-sender";
import type { TemplateKey } from "./templates";

type Env = Record<string, string | undefined>;

/** How long an in-app spend notice stays before it expires on its own. */
export const SPEND_NOTICE_TTL_MS = 30 * 24 * 3_600_000;

/** The lowest role that sees a notice for each audience. Platform-admin alerts are not workspace notices. */
const MIN_ROLE: Record<SpendNoticeAudience, "owner" | "admin" | "agent" | null> = {
  owner: "owner",
  approvers: "admin",
  admins: "admin",
  members: "agent",
  platform_admins: null,
};

type NoticeDb = Pick<SpendDb, "notice" | "noticeReceipt">;

export type InAppOptions = { db?: NoticeDb; now?: Date; log?: (message: string) => void };
export type InAppResult = { delivered: boolean; deduplicated: boolean; reason?: string };

/** The ids and codes publishNotice keeps, plus Phase 0's own sentences for the strip (kinds.ts lets 'spend' rows carry them). */
function payloadOf(notice: SpendNotice): Prisma.InputJsonValue {
  return {
    title: notice.title,
    body: notice.body,
    ...(notice.link ? { link: notice.link } : {}),
    ...(notice.approvalId ? { approvalId: notice.approvalId } : {}),
    ...(notice.correlationId ? { correlationId: notice.correlationId } : {}),
    ...(notice.params ? { params: notice.params } : {}),
  };
}

/**
 * Stores the notice in-app. deduplicated: true when a notice with the same dedupeKey is already open (from Phase 0 or an Eddy
 * producer). A key whose notice resolved or expired starts again as a new occurrence (publishNotice).
 */
export async function deliverInApp(notice: SpendNotice, opts: InAppOptions = {}): Promise<InAppResult> {
  const minRole = MIN_ROLE[notice.audience];
  if (!minRole) return { delivered: false, deduplicated: false, reason: "not_a_workspace_notice" };
  if (!notice.tenantId || !notice.dedupeKey) return { delivered: false, deduplicated: false, reason: "invalid_notice" };
  const db = (opts.db ?? prisma) as NoticeDb;
  const now = opts.now ?? new Date();
  const log = opts.log ?? console.error;
  try {
    const existing = (await db.notice.findFirst({ where: { tenantId: notice.tenantId, dedupeKey: notice.dedupeKey }, select: { id: true, resolvedAt: true, expiresAt: true } })) as
      | { id: string; resolvedAt?: Date | null; expiresAt?: Date | null }
      | null;
    const open = existing && !(existing.resolvedAt instanceof Date) && !(existing.expiresAt instanceof Date && existing.expiresAt.getTime() <= now.getTime());
    if (open) return { delivered: true, deduplicated: true };
    const published = await publishNotice(
      {
        tenantId: notice.tenantId,
        kind: notice.kind,
        severity: notice.severity,
        dedupeKey: notice.dedupeKey,
        audience: { minRole },
        subjectType: notice.subjectType ?? null,
        subjectId: notice.subjectId ?? null,
        payload: { approvalId: notice.approvalId, correlationId: notice.correlationId },
        source: "spend",
        ttlMs: SPEND_NOTICE_TTL_MS,
      },
      { db: db as unknown as PublishDb, now },
    );
    if (published.outcome === "foreign") return { delivered: true, deduplicated: true };
    if (published.outcome === "failed") {
      if (existing) return { delivered: false, deduplicated: false, reason: "store_failed" };
      // A key or subject publishNotice refuses (a caller's own format): store it the way Phase 0 always has.
      await db.notice.create({
        data: {
          tenantId: notice.tenantId,
          kind: notice.kind,
          severity: notice.severity,
          audienceMinRole: minRole,
          dedupeKey: notice.dedupeKey,
          subjectType: notice.subjectType ?? null,
          subjectId: notice.subjectId ?? null,
          source: "spend",
          payload: payloadOf(notice),
          expiresAt: new Date(now.getTime() + SPEND_NOTICE_TTL_MS),
        },
      });
      return { delivered: true, deduplicated: false };
    }
    // publishNotice keeps ids and codes only; Phase 0's rows also carry their English sentences for the strip.
    await db.notice.updateMany({ where: { tenantId: notice.tenantId, dedupeKey: notice.dedupeKey, source: "spend" }, data: { payload: payloadOf(notice) } });
    return { delivered: true, deduplicated: false };
  } catch (error) {
    // A concurrent writer won the unique (tenantId, dedupeKey): that is the same notice.
    if ((error as { code?: unknown })?.code === "P2002") return { delivered: true, deduplicated: true };
    log(`[spend] notice ${notice.kind} not stored: ${describeError(error)}`);
    return { delivered: false, deduplicated: false, reason: "store_failed" };
  }
}

// =====================================================================================================================
// What goes to WhatsApp, and with which values
// =====================================================================================================================

/** Kinds that may become a spend_alert_v1, when the notice needs someone (action_needed) and says what was paused. */
const ALERT_KINDS = new Set<SpendNotice["kind"]>(["breaker_tripped", "limit_reached", "spending_stopped", "ai_limit_100", "meta_limit"]);

const lowerFirst = (s: string) => (/^[A-Z][a-z]/.test(s) && !/^(AI|WhatsApp|Meta|Edwyz)\b/.test(s) ? s.charAt(0).toLowerCase() + s.slice(1) : s);
const trimEnd = (s: string) => s.trim().replace(/[.\s]+$/, "");

/**
 * {{2}} (what was paused) and {{3}} (why) of spend_alert_v1, from the notice's params or its title; null when the notice
 * is not about something that was paused (then it stays in the app). Pure.
 */
export function alertSlots(notice: Pick<SpendNotice, "kind" | "title" | "params">): { what: string; because: string } | null {
  const p = notice.params ?? {};
  if (typeof p.paused === "string" && typeof p.because === "string" && p.paused.trim() && p.because.trim()) return { what: trimEnd(p.paused), because: trimEnd(p.because) };
  const title = trimEnd(notice.title ?? "");
  const paused = /^(.+?) was paused(:\s*|\s+because\s+|\s+for\s+)(.+)$/i.exec(title);
  if (paused) {
    const why = paused[3].trim();
    return { what: paused[1].trim(), because: paused[2].trim().toLowerCase() === "for" ? `it was ${why}` : lowerFirst(why) };
  }
  const usedUp = /^(today's|this month's) (ads|AI|WhatsApp) limit is (nearly )?used up$/i.exec(title);
  if (usedUp && !usedUp[3]) {
    const pot = usedUp[2].toLowerCase();
    return { what: pot === "ai" ? "AI use" : pot === "ads" ? "Spending on ads" : "Automatic WhatsApp messages", because: lowerFirst(title) };
  }
  return null;
}

type Plan = { key: TemplateKey; purpose: NotifyPurpose };

/** Which template a notice becomes on WhatsApp, or the reason it stays in the app. Pure. */
export function whatsappPlan(notice: SpendNotice): Plan | { skip: string } {
  if (notice.audience === "platform_admins") return { skip: "not_a_workspace_notice" };
  if (notice.kind === "digest") return slotsOf(notice) ? { key: "digest", purpose: "digest" } : { skip: "no_digest_values" };
  if (notice.kind === "approval_waiting") return notice.severity === "action_needed" && notice.approvalId ? { key: "approval", purpose: "approval" } : { skip: "in_app_only" };
  if (notice.severity === "action_needed" && ALERT_KINDS.has(notice.kind) && alertSlots(notice)) return { key: "alert", purpose: "alert" };
  return { skip: "in_app_only" };
}

/** The nine digest values, from params s1..s9 (digest.ts writes them). */
function slotsOf(notice: SpendNotice): string[] | null {
  const p = notice.params ?? {};
  const out: string[] = [];
  for (let i = 1; i <= 9; i++) {
    const v = p[`s${i}`];
    if (v === undefined || v === null || String(v).trim() === "") return null;
    out.push(String(v));
  }
  return out;
}

const workspaceName = async (db: SpendDb, tenantId: string) => ((await db.tenant.findUnique({ where: { id: tenantId }, select: { name: true } })) as { name?: string } | null)?.name ?? "your workspace";

/** "29 Oct, 21:05" in the zone. */
function stamp(at: Date, timeZone: string): string {
  try {
    const parts = new Intl.DateTimeFormat("en-IN", { timeZone, day: "numeric", month: "short", hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).formatToParts(at);
    const get = (t: string) => parts.find((p) => p.type === t)?.value ?? "";
    return `${get("day")} ${get("month")}, ${get("hour")}:${get("minute")}`;
  } catch {
    return at.toISOString().slice(0, 16).replace("T", " ");
  }
}

type ApprovalFacts = { params: string[]; urlSuffix: string; approvalId: string };

/**
 * The spend_approval_v1 values, and the one-tap link. The link's token exists only as a hash, so the notifier issues the
 * link: it stores the hash of a fresh token on the pending request (one token per request, shared by its recipients).
 * Null when the request is no longer pending.
 */
async function approvalFacts(db: SpendDb, notice: SpendNotice, now: Date): Promise<ApprovalFacts | null> {
  const row = (await db.spendApproval.findFirst({ where: { id: notice.approvalId!, tenantId: notice.tenantId } })) as Record<string, unknown> | null;
  if (!row || row.status !== "pending" || !(row.expiresAt instanceof Date) || row.expiresAt.getTime() <= now.getTime()) return null;
  const { token, tokenHash } = newApprovalToken();
  const { count } = await db.spendApproval.updateMany({ where: { id: String(row.id), tenantId: notice.tenantId, status: "pending" }, data: { tokenHash } });
  if (count !== 1) return null;
  const control = (await db.spendControl.findUnique({ where: { tenantId: notice.tenantId }, select: { timezone: true } })) as { timezone?: string } | null;
  const month = row.forecastMonthMinor === null || row.forecastMonthMinor === undefined ? null : BigInt(row.forecastMonthMinor as bigint);
  const summary = trimEnd(String(row.summary ?? "make a change"));
  const reason = trimEnd(String(row.reason ?? "").replace(/^why:\s*/i, "")) || "no reason was given";
  return {
    approvalId: String(row.id),
    urlSuffix: token,
    params: [
      assistantLabel(String(row.assistantKey ?? "")),
      lowerFirst(summary),
      await workspaceName(db, notice.tenantId),
      month !== null ? formatMinor(month, typeof row.currency === "string" ? row.currency : "INR") : "an amount we can't estimate yet",
      reason,
      stamp(row.expiresAt as Date, control?.timezone ?? "Asia/Kolkata"),
    ],
  };
}

export type PlatformNotifierDeps = {
  db?: SpendDb;
  env?: Env;
  clock?: () => Date;
  /** The one sender (tests replace it). */
  send?: (input: TemplateSend) => Promise<SendOutcome>;
};

type WhatsAppResult = { delivered: boolean; reason: string | null; sent: number };

async function deliverWhatsApp(notice: SpendNotice, deps: Required<Pick<PlatformNotifierDeps, "env" | "clock">> & PlatformNotifierDeps): Promise<WhatsAppResult> {
  const plan = whatsappPlan(notice);
  if ("skip" in plan) return { delivered: false, reason: plan.skip, sent: 0 };
  const db = (deps.db ?? prisma) as unknown as SpendDb;
  const now = deps.clock();
  const recipients = await recipientsFor(notice.tenantId, plan.key === "approval" ? "approvers" : notice.audience, db);
  if (!recipients.length) return { delivered: false, reason: "no_verified_channel", sent: 0 };
  const ready = await senderReadiness(plan.key, { db, now: now.getTime() });
  if (!ready.ok) return { delivered: false, reason: ready.reason, sent: 0 };

  let base: { params: string[]; urlSuffix?: string; perRecipient?: (r: Recipient) => Record<string, string> | null };
  if (plan.key === "approval") {
    const facts = await approvalFacts(db, notice, now);
    if (!facts) return { delivered: false, reason: "not_pending", sent: 0 };
    base = {
      params: facts.params,
      urlSuffix: facts.urlSuffix,
      perRecipient: (r) => {
        const payload = replyPayload("spdec", facts.approvalId, r.waId, deps.env);
        return payload ? { Decline: payload } : null;
      },
    };
  } else if (plan.key === "alert") {
    const slots = alertSlots(notice)!;
    base = { params: [await workspaceName(db, notice.tenantId), slots.what, slots.because] };
  } else {
    base = { params: slotsOf(notice)! };
  }

  const send = deps.send ?? ((input: TemplateSend) => sendNotifierTemplate(input, { db, now }));
  const sentTo: string[] = [];
  let lastReason: string | null = null;
  for (const r of recipients) {
    const payloads = base.perRecipient ? base.perRecipient(r) : undefined;
    if (base.perRecipient && !payloads) {
      lastReason = "no_secret";
      continue;
    }
    const out = await send({ key: plan.key, purpose: plan.purpose, subjectTenantId: notice.tenantId, phoneE164: r.phoneE164, values: { params: base.params, ...(base.urlSuffix ? { urlSuffix: base.urlSuffix } : {}), ...(payloads ? { payloads } : {}) } });
    if (out.sent) sentTo.push(r.channelId);
    else lastReason = out.reason;
  }
  if (sentTo.length) {
    await noteSent(sentTo, now, db);
    await appendStandalone(
      {
        tenantId: notice.tenantId,
        pot: "none",
        action: plan.key === "digest" ? "notify.digest" : plan.key === "approval" ? "notify.approval" : "notify.alert",
        phase: "info",
        actor: { type: "system", job: "spend.notify" },
        reason: sentTo.length === 1 ? "Sent on WhatsApp to 1 person." : `Sent on WhatsApp to ${sentTo.length} people.`,
        reasonCodes: ["whatsapp", notice.kind],
        approvalId: notice.approvalId ?? null,
        targetType: "notice",
        targetId: notice.dedupeKey.slice(0, 190),
        idempotencyKey: `notify:${notice.dedupeKey}`.slice(0, 200),
      },
      { db: db as unknown as LedgerDb },
    ).catch((error) => console.error(`[spend] notify ledger row not written: ${describeError(error)}`));
  }
  return { delivered: sentTo.length > 0, reason: sentTo.length ? null : lastReason, sent: sentTo.length };
}

/** WhatsApp, then email (off), then in-app always (7.4). */
export function createPlatformNotifier(deps: PlatformNotifierDeps = {}): NotifyPort {
  const env = deps.env ?? process.env;
  const clock = deps.clock ?? (() => new Date());
  return {
    async notify(notice: SpendNotice): Promise<NotifyResult> {
      const inApp = await deliverInApp(notice, { db: deps.db as NoticeDb | undefined, now: clock() });
      const skipped: NotifyResult["skipped"] = [];
      const delivered: NotifyChannelKind[] = [];
      if (inApp.deduplicated) {
        skipped.push({ channel: "whatsapp", reason: "already_sent" }, { channel: "email", reason: "email_off" });
        return { delivered: inApp.delivered ? ["in_app"] : [], skipped, deduplicated: true };
      }
      let wa: WhatsAppResult;
      try {
        wa = await deliverWhatsApp(notice, { ...deps, env, clock });
      } catch (error) {
        console.error(`[spend] WhatsApp notice ${notice.kind} not sent: ${describeError(error)}`);
        wa = { delivered: false, reason: "failed", sent: 0 };
      }
      if (wa.delivered) delivered.push("whatsapp");
      else skipped.push({ channel: "whatsapp", reason: wa.reason ?? "not_sent" });
      skipped.push({ channel: "email", reason: "email_off" });
      if (inApp.delivered) delivered.push("in_app");
      else skipped.push({ channel: "in_app", reason: inApp.reason ?? "not_delivered" });
      return { delivered, skipped, deduplicated: false };
    },
    async eraseOwnerData(tenantId: string): Promise<void> {
      await eraseOwnerChannels(tenantId, { db: deps.db });
    },
  };
}

/** In-app delivery only, with WhatsApp and email reported as skipped (tests, and a fallback if the platform sender is off). */
export function createInAppNotifier(opts: InAppOptions = {}): NotifyPort {
  return {
    async notify(notice: SpendNotice): Promise<NotifyResult> {
      const inApp = await deliverInApp(notice, opts);
      const skipped: NotifyResult["skipped"] = [
        { channel: "whatsapp", reason: "not_set_up" },
        { channel: "email", reason: "email_off" },
      ];
      if (!inApp.delivered) skipped.push({ channel: "in_app", reason: inApp.reason ?? "not_delivered" });
      return { delivered: inApp.delivered ? ["in_app"] : [], skipped, deduplicated: inApp.deduplicated };
    },
    async eraseOwnerData(): Promise<void> {
      // Holds nothing in the notifier workspace.
    },
  };
}

let current: NotifyPort = createPlatformNotifier();

/** The notifier the spend controls use. */
export function spendNotifier(): NotifyPort {
  return current;
}

/** Replaces the notifier (a test, or a stricter one). Returns the previous one. */
export function setSpendNotifier(port: NotifyPort): NotifyPort {
  const previous = current;
  current = port;
  return previous;
}

/** Sends one notice through the current notifier. Never throws. */
export async function notifySpend(notice: SpendNotice): Promise<NotifyResult> {
  try {
    return await current.notify(notice);
  } catch (error) {
    console.error(`[spend] notice ${notice.kind} failed: ${describeError(error)}`);
    return { delivered: [], skipped: [{ channel: "in_app", reason: "failed" }], deduplicated: false };
  }
}

/** Erasure duty (3.5): the notifier workspace's contacts and messages about this workspace. Never throws. */
export async function eraseOwnerData(tenantId: string): Promise<void> {
  try {
    await current.eraseOwnerData(tenantId);
  } catch (error) {
    console.error(`[spend] owner data erasure failed: ${describeError(error)}`);
  }
}
