/**
 * WhatsApp quality, template and account signals and their safety stops (docs/SPEND-CONTROLS-SPEC.md 6.3, WP-12).
 *
 * The quality poll (`spend.quality.poll`, every 30 min, tasks/quality.ts). Meta's phone_number_quality_update webhook no longer
 * carries a rating, so each connected number of a workspace that holds a sendable token (tenantIdsWithSendableToken: not the
 * demo workspace, not an expired token) is read with `GET <phoneNumberId>?fields=quality_rating,status`:
 * - the rating is stored on PhoneNumber.qualityRating (GREEN, YELLOW or RED), which also feeds the existing quality email
 *   (lifecycle/notices.ts) with fresh data;
 * - YELLOW (MEDIUM) opens `wa_quality_yellow` (scope phone, block_marketing): marketing broadcasts from the number pause with
 *   number_quality_yellow and MARKETING sends from automated, API and assistant origins are held by the send gate;
 * - RED (LOW) opens `wa_quality_red` (block_automated): every automated, API and assistant send from the number is held and its
 *   broadcasts pause with number_quality;
 * - GREEN twice in a row clears both (the stated auto-clear), and the owner is told;
 * - UNKNOWN, NA, a failed read, or a number Meta does not report as CONNECTED keeps the last known state: breakers neither open
 *   nor clear on missing data. A number Meta reports as disconnected, banned or deleted is stored so, and the gate then holds
 *   automated, API and assistant sends from it.
 * Once a day the poll also reads each WABA's billing currency (`GET <wabaId>?fields=currency`) for the Spending page note
 * ("Meta bills your WhatsApp account in USD...").
 *
 * Account events (account_update): RESTRICTED_BIZ_INITIATED_MESSAGING opens `wa_restricted` (WABA) until the restriction's
 * expiration; DISABLE opens `waba_disabled` (all automated outbound held); SCHEDULE_FOR_DISABLE opens
 * `waba_disable_scheduled` (block_marketing) with an urgent notice; REINSTATE clears both; ACCOUNT_VIOLATION only notifies.
 * Template quality: YELLOW or RED opens `template_quality` (scope template, notify_only) so assistants stop using it
 * (templateUsableByAssistant); GREEN clears it.
 *
 * Every trip and clear is ledgered by breakers/state.ts and notifies the owner once (dedupe `spend-breaker:<id>`).
 */
import { tenantIdsWithSendableToken } from "@/lib/admin/service";
import { pauseBroadcastsForNumber } from "@/lib/broadcasts/process";
import { prisma } from "@/lib/db";
import { graphFetch } from "@/lib/graph";
import { describeError } from "@/lib/safe-error";
import { clearBreaker, isOpen, listBreakers, openBreaker, type BreakerRow } from "../breakers/state";
import { notifySpend } from "../notify";
import type { BreakerEffect, SpendNoticeKind, SpendNoticeSeverity } from "../types";

export const QUALITY_POLL_MS = 30 * 60_000;
export const CURRENCY_POLL_MS = 24 * 3_600_000;
/** GREEN polls in a row that clear a quality breaker (6.3). */
export const GREEN_POLLS_TO_CLEAR = 2;
/** PhoneNumber.status values the poll reads (a number still in onboarding, "pending", is not polled). */
export const POLLED_STATUSES = ["connected", "disconnected", "banned"] as const;
export const WABA_CURRENCY_KEY = (tenantId: string) => `spend:waba-currency:${tenantId}`;

export type QualityRating = "GREEN" | "YELLOW" | "RED";

/** Meta's quality ratings, old and new names, as GREEN, YELLOW or RED. UNKNOWN, NA or anything else is null (no data). */
export function normalizeQualityRating(value: unknown): QualityRating | null {
  const v = typeof value === "string" ? value.trim().toUpperCase() : "";
  if (v === "GREEN" || v === "HIGH") return "GREEN";
  if (v === "YELLOW" || v === "MEDIUM") return "YELLOW";
  if (v === "RED" || v === "LOW") return "RED";
  return null;
}

/** Meta's number statuses that are stored on PhoneNumber.status (the gate holds automatic sends from the last three). */
const STORED_STATUS: Readonly<Record<string, string>> = { CONNECTED: "connected", DISCONNECTED: "disconnected", BANNED: "banned", DELETED: "deleted" };

export function storedNumberStatus(value: unknown): string | null {
  return typeof value === "string" ? (STORED_STATUS[value.trim().toUpperCase()] ?? null) : null;
}

// ===== Notices =====

type Notice = { kind: SpendNoticeKind; severity: SpendNoticeSeverity; title: string; body: string; dedupeKey: string; link?: string; subjectType?: string; subjectId?: string };

async function tell(tenantId: string, n: Notice): Promise<void> {
  await notifySpend({ tenantId, audience: "owner", link: n.link ?? "/app/settings/spending", ...n });
}

/** Notifies once per trip and records when (6: claimOnce('spend-breaker:<id>')). Never throws. */
async function tellTrip(row: BreakerRow, n: Omit<Notice, "dedupeKey" | "kind">, now: Date): Promise<void> {
  await tell(row.tenantId, { ...n, kind: "breaker_tripped", dedupeKey: `spend-breaker:${row.id}` });
  try {
    await prisma.spendBreaker.updateMany({ where: { id: row.id, notifiedAt: null }, data: { notifiedAt: now } });
  } catch (error) {
    console.error("[spend] could not record that a safety stop was announced:", describeError(error));
  }
}

async function tellClear(row: BreakerRow, n: Omit<Notice, "dedupeKey" | "kind" | "severity">): Promise<void> {
  await tell(row.tenantId, { ...n, kind: "breaker_cleared", severity: "fyi", dedupeKey: `spend-breaker-clear:${row.id}` });
}

// ===== Number quality =====

export type PhoneRef = { id: string; tenantId: string; displayPhone: string; phoneNumberId?: string | null };

const QUALITY_KINDS = ["wa_quality_yellow", "wa_quality_red"] as const;

const greenPollsOf = (row: BreakerRow): number => {
  const d = row.details && typeof row.details === "object" ? (row.details as { greenPolls?: unknown }) : {};
  return typeof d.greenPolls === "number" && Number.isFinite(d.greenPolls) ? d.greenPolls : 0;
};

async function setGreenPolls(row: BreakerRow, greenPolls: number): Promise<void> {
  const details = { ...(row.details && typeof row.details === "object" ? (row.details as Record<string, unknown>) : {}), greenPolls };
  await prisma.spendBreaker.updateMany({ where: { id: row.id, state: "tripped" }, data: { details } });
}

export type QualityOutcome = { opened: string[]; cleared: string[]; kept: boolean };

/**
 * Applies one quality reading of a number to its breakers (6.3). A null rating (UNKNOWN, NA, a failed read) changes nothing.
 * YELLOW and RED open their breaker (idempotent) and reset the GREEN streak; GREEN counts toward the two that clear them.
 */
export async function applyQualityReading(phone: PhoneRef, rating: QualityRating | null, now: Date = new Date()): Promise<QualityOutcome> {
  const out: QualityOutcome = { opened: [], cleared: [], kept: rating === null };
  if (rating === null) return out;
  const open = (await listBreakers(phone.tenantId, { kinds: [...QUALITY_KINDS], now })).filter((r) => r.scopeType === "phone" && r.scopeId === phone.id);

  if (rating === "GREEN") {
    for (const row of open) {
      const greens = greenPollsOf(row) + 1;
      if (greens < GREEN_POLLS_TO_CLEAR) {
        await setGreenPolls(row, greens);
        continue;
      }
      const cleared = await clearBreaker({ id: row.id }, { now, reason: `${phone.displayPhone}'s quality rating was high for ${GREEN_POLLS_TO_CLEAR} checks in a row.` });
      if (!cleared.cleared) continue;
      out.cleared.push(row.kind);
      await tellClear(row, {
        title: `${phone.displayPhone}'s quality is back to high`,
        body: "Automatic messages from this number go out again. Broadcasts that paused stay paused: resume them when you're ready.",
        link: "/app/broadcasts",
        subjectType: "phone",
        subjectId: phone.id,
      });
    }
    return out;
  }

  // A drop breaks any GREEN streak.
  for (const row of open) if (greenPollsOf(row) > 0) await setGreenPolls(row, 0);
  const red = rating === "RED";
  const kind = red ? "wa_quality_red" : "wa_quality_yellow";
  const effect: BreakerEffect = red ? "block_automated" : "block_marketing";
  const reason = red
    ? `WhatsApp rated ${phone.displayPhone}'s quality as low. Broadcasts and automatic messages from it are paused until it recovers.`
    : `WhatsApp rated ${phone.displayPhone}'s quality as medium. Marketing broadcasts and automatic marketing messages from it are paused until it recovers.`;
  const { breaker, created } = await openBreaker({ tenantId: phone.tenantId, kind, scopeType: "phone", scopeId: phone.id, effect, reason, details: { rating, greenPolls: 0 } }, { now });
  if (!created) return out;
  out.opened.push(kind);
  await pauseBroadcastsForNumber(phone.tenantId, phone.id, red ? "number_quality" : "number_quality_yellow");
  await tellTrip(
    breaker,
    {
      severity: red ? "action_needed" : "heads_up",
      title: red ? `${phone.displayPhone}'s quality dropped to low` : `${phone.displayPhone}'s quality dropped to medium`,
      body: red
        ? "Broadcasts and automatic messages from this number are paused so the rating does not get worse. Messages your team types still go out. Check what people are reporting in WhatsApp Manager; we resume automatic messages after two good checks in a row."
        : "Marketing broadcasts from this number are paused and automatic marketing messages wait. Replies and order updates still go out. We resume them after two good checks in a row.",
      link: "/app/broadcasts",
      subjectType: "phone",
      subjectId: phone.id,
    },
    now,
  );
  return out;
}

// ===== The poll =====

/** One Graph GET; injectable for tests (the real one goes through the transport, which never treats a read as spend). */
export type GraphRead = (tenantId: string, path: string, fields: string) => Promise<Record<string, unknown>>;

const graphRead: GraphRead = (tenantId, path, fields) => graphFetch<Record<string, unknown>>({ tenantId, path, query: { fields } });

export type PollResult = { polled: number; failed: number; skipped: number; opened: number; cleared: number; currencies: number };

type PolledPhone = { id: string; tenantId: string; phoneNumberId: string; displayPhone: string; status: string; qualityRating: string | null; wabaRefId: string; waba: { wabaId: string } | null };

const PAGE = 500;

/** The 30-minute quality poll (see the module comment). Safe to run again; a number's failure never stops the others. */
export async function pollQuality(opts: { now?: Date; read?: GraphRead } = {}): Promise<PollResult> {
  const now = opts.now ?? new Date();
  const read = opts.read ?? graphRead;
  const result: PollResult = { polled: 0, failed: 0, skipped: 0, opened: 0, cleared: 0, currencies: 0 };
  const wabas = new Map<string, { tenantId: string; wabaId: string }>();
  let after: string | undefined;
  for (let page = 0; page < 40; page++) {
    const phones = (await prisma.phoneNumber.findMany({
      where: { status: { in: [...POLLED_STATUSES] }, ...(after ? { id: { gt: after } } : {}) },
      select: { id: true, tenantId: true, phoneNumberId: true, displayPhone: true, status: true, qualityRating: true, wabaRefId: true, waba: { select: { wabaId: true } } },
      orderBy: { id: "asc" },
      take: PAGE,
    })) as PolledPhone[];
    if (phones.length === 0) break;
    const sendable = await tenantIdsWithSendableToken([...new Set(phones.map((p) => p.tenantId))]);
    for (const phone of phones) {
      if (!sendable.has(phone.tenantId)) {
        result.skipped++;
        continue;
      }
      if (phone.waba?.wabaId) wabas.set(phone.wabaRefId, { tenantId: phone.tenantId, wabaId: phone.waba.wabaId });
      let reading: Record<string, unknown>;
      try {
        reading = await read(phone.tenantId, phone.phoneNumberId, "quality_rating,status");
      } catch (error) {
        // A failed read keeps the last known state (6.3).
        result.failed++;
        console.warn(`[spend] quality poll could not read a number: ${describeError(error)}`);
        continue;
      }
      result.polled++;
      try {
        const rating = normalizeQualityRating(reading.quality_rating);
        const status = storedNumberStatus(reading.status);
        const data: Record<string, string> = {};
        if (rating && rating !== phone.qualityRating) data.qualityRating = rating;
        if (status && status !== phone.status) data.status = status;
        if (Object.keys(data).length) await prisma.phoneNumber.updateMany({ where: { id: phone.id, tenantId: phone.tenantId }, data });
        // Not CONNECTED (or no status): keep every breaker as it is. The stored status makes the gate hold automatic sends.
        if (status !== "connected") continue;
        const out = await applyQualityReading(phone, rating, now);
        result.opened += out.opened.length;
        result.cleared += out.cleared.length;
      } catch (error) {
        result.failed++;
        console.error(`[spend] quality poll could not apply a reading: ${describeError(error)}`);
      }
    }
    if (phones.length < PAGE) break;
    after = phones[phones.length - 1].id;
  }
  result.currencies = await pollWabaCurrencies([...wabas.entries()].map(([id, w]) => ({ id, ...w })), { now, read });
  return result;
}

export type WabaCurrencies = { wabas: Record<string, { currency: string | null; at: string }> };

/** The stored WABA billing currencies of a workspace (for the Spending page note). */
export async function readWabaCurrencies(tenantId: string): Promise<WabaCurrencies> {
  try {
    const row = await prisma.platformSetting.findUnique({ where: { key: WABA_CURRENCY_KEY(tenantId) } });
    const v = row?.value as WabaCurrencies | null | undefined;
    return v && typeof v === "object" && v.wabas && typeof v.wabas === "object" ? v : { wabas: {} };
  } catch {
    return { wabas: {} };
  }
}

/** Reads each WABA's billing currency once a day. Returns how many were read. Never throws. */
export async function pollWabaCurrencies(wabas: { id: string; tenantId: string; wabaId: string }[], opts: { now?: Date; read?: GraphRead } = {}): Promise<number> {
  const now = opts.now ?? new Date();
  const read = opts.read ?? graphRead;
  const byTenant = new Map<string, typeof wabas>();
  for (const w of wabas) byTenant.set(w.tenantId, [...(byTenant.get(w.tenantId) ?? []), w]);
  let count = 0;
  for (const [tenantId, list] of byTenant) {
    try {
      const stored = await readWabaCurrencies(tenantId);
      let changed = false;
      for (const w of list) {
        const last = stored.wabas[w.id];
        if (last && now.getTime() - Date.parse(last.at) < CURRENCY_POLL_MS) continue;
        try {
          const res = await read(tenantId, w.wabaId, "currency");
          const currency = typeof res.currency === "string" && /^[A-Z]{3}$/i.test(res.currency) ? res.currency.toUpperCase() : null;
          stored.wabas[w.id] = { currency, at: now.toISOString() };
          changed = true;
          count++;
        } catch (error) {
          console.warn(`[spend] could not read a WhatsApp account's billing currency: ${describeError(error)}`);
        }
      }
      if (changed) {
        const value = stored as unknown as object;
        await prisma.platformSetting.upsert({ where: { key: WABA_CURRENCY_KEY(tenantId) }, create: { key: WABA_CURRENCY_KEY(tenantId), value }, update: { value } });
      }
    } catch (error) {
      console.error(`[spend] could not store WhatsApp billing currencies: ${describeError(error)}`);
    }
  }
  return count;
}

// ===== Account events (account_update) =====

export type WabaRef = { id: string; tenantId: string; wabaId?: string | null };

type Rec = Record<string, unknown>;
const rec = (v: unknown): Rec => (v && typeof v === "object" && !Array.isArray(v) ? (v as Rec) : {});
const text = (v: unknown): string => (typeof v === "string" ? v.trim() : typeof v === "number" ? String(v) : "");

/** A Meta date: unix seconds, milliseconds or an ISO string. */
export function metaDate(value: unknown): Date | null {
  if (value === null || value === undefined || value === "") return null;
  const n = typeof value === "number" ? value : /^\d+$/.test(String(value)) ? Number(value) : NaN;
  if (Number.isFinite(n) && n > 0) return new Date(n < 1e12 ? n * 1000 : n);
  const d = new Date(String(value));
  return Number.isNaN(d.getTime()) ? null : d;
}

/** The ban states of a DISABLED_UPDATE (Meta sends one string or a list). */
function banStates(value: Rec): string[] {
  const info = rec(value.ban_info);
  const raw = info.waba_ban_state ?? value.ban_state ?? value.decision;
  return (Array.isArray(raw) ? raw : [raw]).map((s) => text(s).toUpperCase()).filter(Boolean);
}

const fmtDate = (d: Date): string => new Intl.DateTimeFormat("en-IN", { day: "numeric", month: "short", hour: "numeric", minute: "2-digit", timeZone: "Asia/Kolkata" }).format(d);

export type AccountOutcome = { handled: string | null };

async function clearKinds(waba: WabaRef, kinds: string[], reason: string, now: Date): Promise<BreakerRow[]> {
  const cleared: BreakerRow[] = [];
  for (const kind of kinds) {
    const out = await clearBreaker({ tenantId: waba.tenantId, kind, scopeType: "waba", scopeId: waba.id }, { now, reason });
    if (out.cleared && out.breaker) cleared.push(out.breaker);
  }
  return cleared;
}

/** account_update events (6.3). Returns what was done, for the webhook's notes. Throws only on a database failure. */
export async function applyAccountUpdate(waba: WabaRef, value: Rec, now: Date = new Date()): Promise<AccountOutcome> {
  const event = text(value.event).toUpperCase();

  if (event === "ACCOUNT_RESTRICTION") {
    const items = (Array.isArray(value.restriction_info) ? value.restriction_info : [value.restriction_info]).map(rec);
    const biz = items.find((r) => text(r.restriction_type).toUpperCase() === "RESTRICTED_BIZ_INITIATED_MESSAGING");
    if (!biz) {
      // The business-initiated restriction is no longer listed: it was lifted.
      const cleared = await clearKinds(waba, ["wa_restricted"], "Meta lifted the restriction on messages to people who have not written first.", now);
      for (const row of cleared) await tellClear(row, { title: "Your WhatsApp account's restriction was lifted", body: "Template messages to people who have not written to you recently go out again." });
      return { handled: cleared.length ? "restriction_lifted" : null };
    }
    const until = metaDate(biz.expiration);
    const { breaker, created } = await openBreaker(
      {
        tenantId: waba.tenantId,
        kind: "wa_restricted",
        scopeType: "waba",
        scopeId: waba.id,
        effect: "block_automated",
        reason: `Meta restricted messages to people who have not written to you in the last 24 hours${until ? ` until ${fmtDate(until)}` : ""}.`,
        details: { restrictionType: "RESTRICTED_BIZ_INITIATED_MESSAGING", expiration: until?.toISOString() ?? null },
        autoClearAt: until,
      },
      { now },
    );
    if (created) {
      await tellTrip(
        breaker,
        {
          severity: "action_needed",
          title: "Meta restricted your WhatsApp account",
          body: `Template messages to people who have not written to you in the last 24 hours wait${until ? ` until ${fmtDate(until)}` : " until Meta lifts the restriction"}. Replies inside open chats still go out. Check WhatsApp Manager for the reason.`,
        },
        now,
      );
    }
    return { handled: "restricted" };
  }

  if (event === "DISABLED_UPDATE") {
    const states = banStates(value);
    if (states.includes("REINSTATE")) {
      const cleared = await clearKinds(waba, ["waba_disabled", "waba_disable_scheduled"], "Meta reinstated the WhatsApp account.", now);
      for (const row of cleared) await tellClear(row, { title: "Your WhatsApp account was reinstated", body: "Automatic messages go out again. Paused broadcasts stay paused: resume them when you're ready." });
      return { handled: "reinstated" };
    }
    if (states.includes("DISABLE")) {
      const { breaker, created } = await openBreaker(
        { tenantId: waba.tenantId, kind: "waba_disabled", scopeType: "waba", scopeId: waba.id, effect: "block_automated", reason: "Meta disabled this WhatsApp account. Automatic messages are held." },
        { now },
      );
      if (created) {
        await tellTrip(
          breaker,
          {
            severity: "action_needed",
            title: "Meta disabled your WhatsApp account",
            body: "Broadcasts, automations and other automatic messages are held. Check WhatsApp Manager for the reason and how to appeal. We start them again when Meta reinstates the account.",
          },
          now,
        );
      }
      return { handled: "disabled" };
    }
    if (states.includes("SCHEDULE_FOR_DISABLE")) {
      const when = metaDate(rec(value.ban_info).waba_ban_date);
      const { breaker, created } = await openBreaker(
        {
          tenantId: waba.tenantId,
          kind: "waba_disable_scheduled",
          scopeType: "waba",
          scopeId: waba.id,
          effect: "block_marketing",
          reason: `Meta plans to disable this WhatsApp account${when ? ` on ${fmtDate(when)}` : ""}. Marketing messages are paused.`,
          details: { banDate: when?.toISOString() ?? null },
        },
        { now },
      );
      if (created) {
        await tellTrip(
          breaker,
          {
            severity: "action_needed",
            title: "Urgent: Meta plans to disable your WhatsApp account",
            body: `Meta says it will disable this account${when ? ` on ${fmtDate(when)}` : " soon"}. Marketing messages are paused now so it does not get worse. Open WhatsApp Manager today to see the reason and fix it.`,
          },
          now,
        );
      }
      return { handled: "disable_scheduled" };
    }
    return { handled: null };
  }

  if (event === "ACCOUNT_VIOLATION") {
    const type = text(rec(value.violation_info).violation_type || value.violation_type)
      .replace(/[^\w ]/g, "")
      .slice(0, 64);
    await tell(waba.tenantId, {
      kind: "breaker_tripped",
      severity: "heads_up",
      title: "Meta reported a policy issue on your WhatsApp account",
      body: `${type ? `Meta's reason: ${type.replace(/_/g, " ").toLowerCase()}. ` : ""}Nothing was paused. Check WhatsApp Manager for details, so it does not lead to a restriction.`,
      dedupeKey: `wa-violation:${waba.id}:${type || "unknown"}:${now.toISOString().slice(0, 10)}`,
    });
    return { handled: "violation" };
  }

  return { handled: null };
}

// ===== Template quality =====

/**
 * message_template_quality_update (6.3). YELLOW or RED: assistants stop using the template (a `template_quality` breaker the
 * assistant layer reads, notify_only, so no other sender is affected) and the owner gets a notice; RED broadcasts are paused by
 * the webhook itself. GREEN clears it.
 */
export async function applyTemplateQuality(tenantId: string, template: { id: string; name?: string | null } | null, score: string, now: Date = new Date()): Promise<void> {
  if (!template) return;
  const s = score.toUpperCase();
  const name = template.name ? `"${template.name}"` : "a template";
  if (s === "GREEN") {
    await clearBreaker({ tenantId, kind: "template_quality", scopeType: "template", scopeId: template.id }, { now, reason: `Meta rated ${name}'s quality as high again.` });
    return;
  }
  if (s !== "YELLOW" && s !== "RED") return;
  const { breaker, created } = await openBreaker(
    {
      tenantId,
      kind: "template_quality",
      scopeType: "template",
      scopeId: template.id,
      effect: "notify_only",
      reason: `Meta rated template ${name}'s quality as ${s === "RED" ? "low" : "medium"}, so assistants stop using it.`,
      details: { score: s },
    },
    { now },
  );
  if (created) {
    await tellTrip(
      breaker,
      {
        severity: s === "RED" ? "action_needed" : "heads_up",
        title: `Template ${name}'s quality dropped to ${s === "RED" ? "low" : "medium"}`,
        body:
          s === "RED"
            ? "Broadcasts using it are paused before Meta turns it off, and assistants stop using it. Send the same people another approved template, or review its wording."
            : "Assistants stop using it for now. Broadcasts and other messages still go out; if it drops to low, broadcasts using it pause. Review its wording or use another template for marketing.",
        link: "/app/templates",
        subjectType: "template",
        subjectId: template.id,
      },
      now,
    );
  }
}

/**
 * Whether an assistant may use a template (6.3): approved, and not flagged or rated down by Meta. The assistant layer calls
 * this before proposing a send; people and other senders are not limited by it.
 */
export async function templateUsableByAssistant(tenantId: string, templateId: string, now: Date = new Date()): Promise<boolean> {
  const template = await prisma.template.findFirst({ where: { id: templateId, tenantId }, select: { status: true } });
  if (!template || template.status !== "approved") return false;
  const open = await listBreakers(tenantId, { kinds: ["template_quality"], now });
  return !open.some((r) => r.scopeType === "template" && r.scopeId === templateId && isOpen(r, now));
}
