import type { Prisma } from "@/generated/prisma/client";
import { getRateCard, type RateCardData } from "@/lib/admin/ratecard";
import { AUTOMATION_HOLD_TTL_MS, bulkGateStep, holdForBulk, releaseBulkHold } from "@/lib/broadcasts/cost";
import { receivableWhere, sendKindForCategory } from "@/lib/contacts/opt-out";
import { prisma } from "@/lib/db";
import type { JobHandler } from "@/lib/queue";
import { enqueue } from "@/lib/queue";
import { describeError } from "@/lib/safe-error";
import { filterToWhere, isEmptyFilter, parseFilter, prefilterWhere, usesAttributes } from "@/lib/segments/filter";
import { SpendBlockedError } from "@/lib/spend/errors";
import { formatMinor } from "@/lib/spend/money";
import { rateFor, recipientCountry } from "@/lib/spend/messaging/estimate";
import { normalizeCategory } from "@/lib/spend/messaging/origin";
import { notifySpend } from "@/lib/spend/notify";
import type { SpendActor } from "@/lib/spend/types";
import { clockToMinutes, localDateTime } from "../match";
import { parseDefinition, type Group, type RuleDefinition, type Trigger } from "./model";
import { fireRulesSafely, type StoredRule } from "./run";

export const SCHEDULE_QUEUE = "automation-scheduled";
/** How long after the waiting time a chat is still picked up, so a worker pause does not lose follow-ups. */
export const NO_RESPONSE_SLACK_MS = 2 * 3_600_000;
const NO_REPLY_EVER_WINDOW_MS = 30 * 86_400_000;
const CHAT_BATCH = 100;
const CHUNK = 50;
/** A scheduled run reaches at most this many contacts that the rule's conditions accept. */
export const MAX_AUDIENCE = 5000;
/** Contacts looked at per run, whether or not they match, so one run cannot walk an enormous workspace forever. */
export const MAX_SCAN = 200_000;
/** Rules read per page. Every enabled rule of the wanted trigger type is read, a page at a time; there is no overall cap. */
const RULE_PAGE = 500;
/** Chats one "customer has not replied" rule looks at per scan (oldest first), so one busy workspace cannot hold up the minute. */
export const MAX_CHATS_PER_RULE = 2000;

type Parsed = { rule: StoredRule; trigger: Trigger };
type ScanChat = { id: string; contactId: string; lastInboundAt: Date | null; lastMessageAt: Date };

/**
 * The enabled v2 rules of one trigger type. The type is filtered in SQL (a JSON path on trigger.type) and the rules are read in
 * id order a page at a time, so rules of other types never use up a page and none is skipped as the platform grows.
 */
async function loadTimedRules(type: Trigger["type"]): Promise<Parsed[]> {
  const out: Parsed[] = [];
  let cursor: string | undefined;
  for (;;) {
    const page = ((await prisma.automationRule.findMany({
      where: { enabled: true, version: 2, trigger: { path: ["type"], equals: type } },
      orderBy: { id: "asc" },
      take: RULE_PAGE,
      ...(cursor ? { cursor: { id: cursor }, skip: 1 } : {}),
    })) ?? []) as StoredRule[];
    for (const rule of page) {
      const parsed = parseDefinition({ trigger: rule.trigger, filters: rule.filters, actions: rule.actions });
      if (parsed.ok && parsed.value.trigger.type === type) out.push({ rule, trigger: parsed.value.trigger });
    }
    if (page.length < RULE_PAGE) return out;
    cursor = page[page.length - 1].id;
  }
}

/**
 * Runs "customer has not replied" rules for chats whose last message is ours and old enough. Only chats where we wrote last are
 * read (lastInboundAt before lastMessageAt, or no customer message at all), page by page, up to MAX_CHATS_PER_RULE per rule.
 * Returns how many chats were checked.
 */
export async function scanNoResponse(now = new Date()): Promise<number> {
  let checked = 0;
  for (const { rule, trigger } of await loadTimedRules("no_customer_response")) {
    if (trigger.type !== "no_customer_response") continue;
    const { tenantId } = rule;
    const cutoff = new Date(now.getTime() - trigger.minutes * 60_000);
    // Keyset paging on (lastMessageAt, id) as read, not a row cursor: a follow-up sent to a chat moves its lastMessageAt, which
    // would make a cursor on that row skip the rest of the scan.
    let after: { at: Date; id: string } | null = null;
    for (let seen = 0; seen < MAX_CHATS_PER_RULE; ) {
      const chats: ScanChat[] = await prisma.conversation.findMany({
        where: {
          tenantId,
          status: { in: ["open", "pending"] },
          lastMessageAt: { lte: cutoff, gte: new Date(cutoff.getTime() - NO_RESPONSE_SLACK_MS) },
          ...(rule.phoneNumberId ? { phoneNumberId: rule.phoneNumberId } : {}),
          AND: [
            { OR: [{ lastInboundAt: null }, { lastInboundAt: { lt: prisma.conversation.fields.lastMessageAt } }] },
            ...(after ? [{ OR: [{ lastMessageAt: { gt: after.at } }, { lastMessageAt: after.at, id: { gt: after.id } }] }] : []),
          ],
        },
        orderBy: [{ lastMessageAt: "asc" }, { id: "asc" }],
        take: CHAT_BATCH,
        select: { id: true, contactId: true, lastInboundAt: true, lastMessageAt: true },
      });
      for (const chat of chats) {
        // Kept as a second guard: a customer message may arrive between the read and this check.
        if (chat.lastInboundAt && chat.lastInboundAt.getTime() >= chat.lastMessageAt.getTime()) continue;
        checked += 1;
        await fireRulesSafely(
          {
            type: "no_customer_response",
            tenantId,
            contactId: chat.contactId,
            conversationId: chat.id,
            at: now,
            ruleId: rule.id,
            dedupeSince: chat.lastInboundAt ?? new Date(now.getTime() - NO_REPLY_EVER_WINDOW_MS),
          },
          [rule],
        );
      }
      seen += chats.length;
      if (chats.length < CHAT_BATCH) break;
      const last: ScanChat = chats[chats.length - 1];
      after = { at: last.lastMessageAt, id: last.id };
    }
  }
  return checked;
}

const nextDay = (date: string) => new Date(Date.parse(`${date}T00:00:00Z`) + 86_400_000).toISOString().slice(0, 10);

/** The moment the clock last read the scheduled time, given that it is now `ahead` minutes past it. */
const momentOf = (now: Date, ahead: number) => now.getTime() - ((ahead * 60 + now.getUTCSeconds()) * 1000 + now.getUTCMilliseconds());

/**
 * The key of the run that is due now (one per day, or once), or null when nothing is due. When `since` is given (the time the
 * rule was created, switched on or last edited), a run is only due if its scheduled moment came after that, so saving a rule
 * at 15:00 for 09:00 waits for tomorrow instead of sending at once.
 */
export function dueRunKey(trigger: Trigger, now: Date, since?: Date): string | null {
  if (trigger.type !== "scheduled") return null;
  const at = clockToMinutes(trigger.time);
  if (at === null) return null;
  const local = localDateTime(now, trigger.timezone);
  const after = (ahead: number) => !since || momentOf(now, ahead) > since.getTime();
  if (trigger.repeat === "once") {
    const date = trigger.date ?? "";
    if (local.date === date && local.minutes >= at) return after(local.minutes - at) ? `once:${date}` : null;
    if (local.date === nextDay(date)) return after(local.minutes + 1440 - at) ? `once:${date}` : null;
    return null;
  }
  if (trigger.repeat === "weekly" && !trigger.days.includes(local.day)) return null;
  return local.minutes >= at && after(local.minutes - at) ? `day:${local.date}` : null;
}

const claimKey = (ruleId: string, runKey: string) => `automation-run:${ruleId}:${runKey}`;

async function claimRun(ruleId: string, runKey: string, now: Date): Promise<boolean> {
  try {
    await prisma.platformSetting.create({ data: { key: claimKey(ruleId, runKey), value: { at: now.toISOString() } } });
    return true;
  } catch {
    return false;
  }
}

async function releaseClaim(ruleId: string, runKey: string) {
  await prisma.platformSetting.deleteMany({ where: { key: claimKey(ruleId, runKey) } }).catch(() => undefined);
}

/** The worker's actor on spend ledger rows about scheduled runs. */
const RUN_ACTOR: SpendActor = { type: "system", job: SCHEDULE_QUEUE };
/** A finished run keeps its hold a little longer, so its last messages still take their estimate from it when they are sent. */
export const RELEASE_DELAY_MS = 10 * 60_000;

/**
 * What one scheduled run could cost at worst (docs/SPEND-CONTROLS-SPEC.md 4.9): its template messages to the contacts it may
 * reach, at the conservative rates. The run reaches at most MAX_AUDIENCE contacts out of the narrowed walk, so the most expensive
 * MAX_AUDIENCE of them are counted. Free-form actions (text, material) only go to open chats and reserve one by one when sent.
 * Null when nothing can be priced.
 */
export async function scheduledRunEstimate(tenantId: string, def: RuleDefinition, card: RateCardData | null, now = new Date()): Promise<bigint | null> {
  if (!card) return null;
  const templateIds = def.actions.flatMap((a) => (a.type === "send_template" ? [a.templateId] : []));
  if (templateIds.length === 0) return 0n;
  const templates = await prisma.template.findMany({ where: { tenantId, id: { in: [...new Set(templateIds)] } }, select: { id: true, category: true } });
  const categoryOf = new Map(templates.map((t) => [t.id, normalizeCategory(t.category)]));
  // An unknown (deleted) template sends nothing; the run's notes say so.
  const categories = templateIds.flatMap((id) => (categoryOf.has(id) ? [categoryOf.get(id)!] : []));
  if (categories.length === 0) return 0n;
  const contacts = await prisma.contact.findMany({
    where: { AND: [{ tenantId, ...(await scheduledOptOutWhere(tenantId, def)) }, await audienceWhere(tenantId, def, now)] },
    select: { phone: true, bsuid: true },
    take: MAX_SCAN,
  });
  const byCountry = new Map<string | null, number>();
  for (const c of contacts) {
    const country = recipientCountry(c);
    byCountry.set(country, (byCountry.get(country) ?? 0) + 1);
  }
  const perContact = [...byCountry.entries()]
    .map(([country, n]) => {
      let cost = 0n;
      for (const category of categories) {
        const quote = rateFor(card, country, category);
        if (!quote) return null;
        cost += quote.minor;
      }
      return { n, cost };
    })
    .filter((x): x is { n: number; cost: bigint } => x !== null)
    .sort((a, b) => (a.cost > b.cost ? -1 : a.cost < b.cost ? 1 : 0));
  let left = MAX_AUDIENCE;
  let total = 0n;
  for (const { n, cost } of perContact) {
    const take = Math.min(left, n);
    total += cost * BigInt(take);
    left -= take;
    if (left <= 0) break;
  }
  return total;
}

type RunHold = { action: "start"; reservationId: string | null } | { action: "refused"; message: string } | { action: "retry" };

/** The refusal in words for a rule (4.13 spend.broadcast speaks of a broadcast; a scheduled run is not one). */
function runRefusal(error: SpendBlockedError): string {
  const { cost, left, period } = error.params;
  if (error.code !== "spend.broadcast" || !cost || !left) return error.message;
  const when = period === "day" ? "today" : "this month";
  return `This run could cost about ${formatMinor(cost.minor, cost.currency)}, but only ${formatMinor(left.minor, left.currency)} is left in your WhatsApp limit ${when}. Narrow the rule with a tag or segment, or raise the limit.`;
}

/** Holds a scheduled run's estimate before its first chunk (4.9); a run that does not fit is refused at start. */
async function holdRun(rule: StoredRule, def: RuleDefinition, runKey: string, now: Date): Promise<RunHold> {
  try {
    const hold = await bulkGateStep(
      "a scheduled run",
      async () => {
        const card = await getRateCard();
        const estimateMinor = await scheduledRunEstimate(rule.tenantId, def, card, now);
        if (!card || estimateMinor === null || estimateMinor <= 0n) return null;
        return holdForBulk({
          tenantId: rule.tenantId,
          subject: { type: "automation_run", id: `${rule.id}:${runKey}` },
          estimateMinor,
          currency: card.currency,
          ttlMs: AUTOMATION_HOLD_TTL_MS,
          actor: RUN_ACTOR,
          reason: `Scheduled rule "${rule.name}".`,
          refusal: "batch",
          now,
        });
      },
      null,
    );
    return { action: "start", reservationId: hold?.reservationId ?? null };
  } catch (error) {
    if (error instanceof SpendBlockedError) return { action: "refused", message: runRefusal(error) };
    console.error("[automation] could not set aside a scheduled run's cost:", describeError(error));
    return { action: "retry" };
  }
}

/**
 * Starts scheduled rules that are due. Each run is claimed once; a run that sends templates first holds its estimate against
 * the WhatsApp limit (refused at start, with a note on the rule and a notice to the owner, when it does not fit). Then its
 * audience is worked through in small chunks on the job queue.
 */
export async function scanScheduled(now = new Date()): Promise<number> {
  let started = 0;
  for (const { rule, trigger } of await loadTimedRules("scheduled")) {
    const runKey = dueRunKey(trigger, now, rule.updatedAt);
    if (!runKey || !(await claimRun(rule.id, runKey, now))) continue;
    const parsed = parseDefinition({ trigger: rule.trigger, filters: rule.filters, actions: rule.actions });
    const hold: RunHold = parsed.ok ? await holdRun(rule, parsed.value, runKey, now) : { action: "start", reservationId: null };
    if (hold.action === "retry") {
      await releaseClaim(rule.id, runKey);
      continue;
    }
    if (hold.action === "refused") {
      // The claim stays: this run is skipped, not retried every minute. The next scheduled time tries again.
      await logRun(rule.tenantId, rule.id, "skipped", `Did not run: ${hold.message}`);
      await notifySpend({
        tenantId: rule.tenantId,
        kind: "limit_reached",
        severity: "action_needed",
        audience: "owner",
        dedupeKey: `automation-run-refused:${rule.id}:${runKey}`,
        title: `Scheduled rule "${rule.name}" did not run`,
        body: `${hold.message} It runs again at its next scheduled time.`,
        link: "/app/automation",
        subjectType: "automation_rule",
        subjectId: rule.id,
      });
      continue;
    }
    try {
      await enqueue(
        SCHEDULE_QUEUE,
        { tenantId: rule.tenantId, ruleId: rule.id, startedAt: now.toISOString(), cursor: null, processed: 0, fired: 0, ...(hold.reservationId ? { reservationId: hold.reservationId } : {}) },
        { maxAttempts: 3 },
      );
      started += 1;
    } catch (error) {
      await releaseClaim(rule.id, runKey);
      await releaseBulkHold(hold.reservationId, "The scheduled run could not start, so what was set aside for it went back to your WhatsApp limit.", RUN_ACTOR);
      console.error("[automation] could not start a scheduled run:", describeError(error));
    }
  }
  return started;
}

type ChunkPayload = { tenantId: string; ruleId: string; startedAt: string; cursor: string | null; processed: number; fired?: number; reservationId?: string };
type ReleasePayload = { tenantId: string; releaseReservationId: string };

const isRelease = (p: unknown): p is ReleasePayload => {
  const r = p as Partial<ReleasePayload> | null;
  return Boolean(r && typeof r.tenantId === "string" && typeof r.releaseReservationId === "string" && r.releaseReservationId);
};

const RUN_DONE = "The scheduled run finished, so what it did not use went back to your WhatsApp limit.";

/** A finished run gives back what it did not use, a little later (RELEASE_DELAY_MS), so its last queued messages still use it. */
async function finishRun(payload: ChunkPayload): Promise<void> {
  if (!payload.reservationId) return;
  try {
    await enqueue(SCHEDULE_QUEUE, { tenantId: payload.tenantId, releaseReservationId: payload.reservationId }, { runAt: new Date(Date.now() + RELEASE_DELAY_MS), maxAttempts: 3 });
  } catch {
    await releaseBulkHold(payload.reservationId, RUN_DONE, RUN_ACTOR);
  }
}


const isChunk = (p: unknown): p is ChunkPayload => {
  const c = p as Partial<ChunkPayload> | null;
  return Boolean(c && typeof c.tenantId === "string" && typeof c.ruleId === "string" && typeof c.startedAt === "string" && typeof c.processed === "number" && (c.cursor === null || typeof c.cursor === "string"));
};

const tagVariants = (tag: string) => [...new Set([tag, tag.toLowerCase(), tag.toUpperCase(), tag.charAt(0).toUpperCase() + tag.slice(1).toLowerCase()])];

/**
 * The opt-out part of a scheduled run's audience (lib/contacts/opt-out.ts). A rule that sends a marketing template leaves opted-out
 * contacts out, as a marketing broadcast does. Any other rule walks them too: a utility template, like an appointment reminder,
 * still reaches them, and tags or assignments are not messages. A category that cannot be read counts as marketing.
 */
export async function scheduledOptOutWhere(tenantId: string, def: RuleDefinition): Promise<Prisma.ContactWhereInput> {
  const ids = [...new Set(def.actions.flatMap((a) => (a.type === "send_template" ? [a.templateId] : [])))];
  if (ids.length === 0) return receivableWhere("utility");
  try {
    const rows = await prisma.template.findMany({ where: { tenantId, id: { in: ids } }, select: { category: true } });
    return receivableWhere(rows.some((r) => sendKindForCategory(r.category) === "marketing") ? "marketing" : "utility");
  } catch {
    return receivableWhere("marketing");
  }
}

/**
 * SQL that narrows the contacts a scheduled rule walks, from the conditions every contact must meet (top-level "all of"):
 * tags and segments. The rule's full conditions are still checked per contact, so this only avoids loading people who cannot match.
 */
export async function audienceWhere(tenantId: string, def: RuleDefinition, now = new Date()): Promise<Prisma.ContactWhereInput> {
  const root: Group = def.filters.root;
  const parts: Prisma.ContactWhereInput[] = [];
  if (root.op === "and") {
    for (const item of root.items) {
      if (item.type === "tag" && item.has && item.tag.trim()) {
        const variants = tagVariants(item.tag.trim());
        parts.push({ OR: [{ tags: { hasSome: variants } }, { conversations: { some: { tags: { hasSome: variants } } } }] });
      }
      if (item.type === "segment" && item.member) {
        const segment = await prisma.segment.findFirst({ where: { id: item.segmentId, tenantId }, select: { filter: true } });
        try {
          const filter = parseFilter(segment?.filter);
          if (segment && !isEmptyFilter(filter)) parts.push(usesAttributes(filter) ? prefilterWhere(filter, now) : filterToWhere(filter, now));
        } catch {
          // An unreadable segment matches nobody, which the per-contact check enforces.
        }
      }
    }
  }
  return parts.length ? { AND: parts } : {};
}

async function logRun(tenantId: string, ruleId: string, outcome: "skipped" | "failed", detail: string) {
  try {
    await prisma.ruleExecution.create({ data: { tenantId, ruleId, outcome, detail: detail.slice(0, 480) } });
  } catch {
    console.error("[automation] could not write a scheduled run note");
  }
}

async function runChunk(payload: ChunkPayload): Promise<void> {
  const { tenantId, ruleId } = payload;
  const startedAt = new Date(payload.startedAt);
  if (Number.isNaN(startedAt.getTime())) return;
  const rule = (await prisma.automationRule.findFirst({ where: { id: ruleId, tenantId, enabled: true, version: 2 } })) as StoredRule | null;
  if (!rule) return void (await finishRun(payload));
  const parsed = parseDefinition({ trigger: rule.trigger, filters: rule.filters, actions: rule.actions });
  if (!parsed.ok) return void (await finishRun(payload));

  const contacts = await prisma.contact.findMany({
    where: { AND: [{ tenantId, ...(await scheduledOptOutWhere(tenantId, parsed.value)) }, await audienceWhere(tenantId, parsed.value)] },
    orderBy: { id: "asc" },
    take: CHUNK,
    ...(payload.cursor ? { cursor: { id: payload.cursor }, skip: 1 } : {}),
    select: { id: true },
  });
  let fired = payload.fired ?? 0;
  for (const contact of contacts) {
    const chat = await prisma.conversation.findFirst({ where: { tenantId, contactId: contact.id }, orderBy: { lastMessageAt: "desc" }, select: { id: true } });
    const result = await fireRulesSafely(
      { type: "scheduled", tenantId, contactId: contact.id, conversationId: chat?.id ?? null, at: new Date(), ruleId, dedupeSince: startedAt, ...(payload.reservationId ? { reservationId: payload.reservationId } : {}) },
      [rule],
    );
    fired += result.fired;
  }
  const processed = payload.processed + contacts.length;
  if (contacts.length < CHUNK) return void (await finishRun(payload));
  if (fired >= MAX_AUDIENCE) {
    await logRun(tenantId, ruleId, "skipped", `Stopped after reaching ${MAX_AUDIENCE.toLocaleString("en")} contacts, the most one scheduled run sends to. Narrow the rule with a tag or segment to reach the rest.`);
    return void (await finishRun(payload));
  }
  if (processed >= MAX_SCAN) {
    await logRun(tenantId, ruleId, "skipped", `Stopped after checking ${MAX_SCAN.toLocaleString("en")} contacts. Narrow the rule with a tag or segment so it reaches the rest.`);
    return void (await finishRun(payload));
  }
  await enqueue(SCHEDULE_QUEUE, { ...payload, cursor: contacts[contacts.length - 1].id, processed, fired }, { maxAttempts: 3 });
}

export const scheduledJobHandler: JobHandler = async (payload, ctx) => {
  if (isRelease(payload)) return void (await releaseBulkHold(payload.releaseReservationId, RUN_DONE, RUN_ACTOR));
  if (!isChunk(payload)) return;
  try {
    await runChunk(payload);
  } catch (error) {
    if (ctx?.isLastAttempt) {
      await logRun(payload.tenantId, payload.ruleId, "failed", "A scheduled run stopped part-way because of an error and will not be retried. It runs again at the next scheduled time.");
      await releaseBulkHold(payload.reservationId, "A scheduled run stopped part-way, so what it did not use went back to your WhatsApp limit.", RUN_ACTOR);
    }
    throw error;
  }
};

/** Daily cleanup: run logs are kept for 90 days, and old schedule claims go with them. */
export async function purgeOld(now = new Date()): Promise<number> {
  const executions = await prisma.ruleExecution.deleteMany({ where: { createdAt: { lt: new Date(now.getTime() - 90 * 86_400_000) } } });
  await prisma.platformSetting.deleteMany({ where: { key: { startsWith: "automation-run:" }, updatedAt: { lt: new Date(now.getTime() - 3 * 86_400_000) } } });
  await prisma.platformSetting.deleteMany({ where: { key: { startsWith: "automation-lease:" }, updatedAt: { lt: new Date(now.getTime() - 86_400_000) } } });
  return executions.count;
}
