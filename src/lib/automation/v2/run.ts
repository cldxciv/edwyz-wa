import { prisma } from "@/lib/db";
import { describeError } from "@/lib/safe-error";
import { tenantMayRunBackground } from "@/lib/tenant-state";
import { runAction, ACTION_LABEL, type ActionEnv, type ActionResult, type EnvContact, type EnvConversation } from "./actions";
import { filtersMatch, segmentIds, type RuleContext } from "./evaluate";
import { byPriority, parseDefinition, type Action, type RuleDefinition, type TriggerType } from "./model";
import { remainingTriggers } from "./metering";
import { segmentMembership } from "./segments";
import { getAutomationSettings, type RunMode } from "./settings";

/** An agent who replied in the chat this recently counts as handling it. */
export const HUMAN_ACTIVE_MS = 30 * 60_000;
/** Loop guard: more than this many completed runs in one chat inside the window pauses rules for that chat. */
export const LOOP_LIMITS = [
  { windowMs: 10 * 60_000, max: 6 },
  { windowMs: 60 * 60_000, max: 30 },
] as const;
const SKIP_LOG_REPEAT_MS = 10 * 60_000;
const DETAIL_MAX = 480;

export type TriggerEvent = {
  type: TriggerType;
  tenantId: string;
  contactId: string;
  conversationId: string | null;
  at: Date;
  message?: { text: string; messageType: string; newChat: boolean; silentMinutes: number | null; phoneNumberId: string; /** Who already answered this message, so customer-facing actions stay quiet. */ answeredBy: "bot" | "rule" | null };
  tags?: string[];
  attribute?: string;
  status?: { from: string | null; to: string };
  /** Run only this rule (schedules and waiting-time checks pick their rule themselves). */
  ruleId?: string;
  /** Do not run when the rule already completed for this chat or contact since this time. */
  dedupeSince?: Date;
  /** A scheduled run's bulk hold (docs/SPEND-CONTROLS-SPEC.md 4.9): its template sends take their estimate from it. */
  reservationId?: string;
};

export type FireResult = { fired: number; replied: boolean };

export type RuleRow = {
  id: string;
  name: string;
  phoneNumberId: string | null;
  priority: number;
  cooldownMinutes: number;
  stopAfterMatch: boolean;
  createdAt: Date;
  updatedAt?: Date;
  version?: number;
  enabled?: boolean;
  trigger: unknown;
  filters: unknown;
  actions: unknown;
};

export type StoredRule = RuleRow & { tenantId: string };

const CUSTOMER_FACING: readonly Action["type"][] = ["send_text", "send_template", "send_material", "start_chatbot", "start_ai_agent"];
const isCustomerFacing = (a: Action) => CUSTOMER_FACING.includes(a.type);

function triggerAccepts(def: RuleDefinition, rule: RuleRow, event: TriggerEvent): boolean {
  const t = def.trigger;
  if (t.type !== event.type) return false;
  if (event.ruleId && event.ruleId !== rule.id) return false;
  switch (t.type) {
    case "tag_added":
    case "tag_removed":
      return t.tag === null || (event.tags ?? []).some((x) => x.toLowerCase() === t.tag!.toLowerCase());
    case "attribute_changed":
      return event.attribute?.toLowerCase() === t.attribute.toLowerCase();
    case "status_changed":
      return t.to === null || event.status?.to === t.to;
    case "no_customer_response":
    case "scheduled":
      return event.ruleId === rule.id;
    default:
      return true;
  }
}

type Loaded = { contact: EnvContact & { optedOutAt: Date | null; createdAt: Date }; conversation: EnvConversation | null };

async function load(event: TriggerEvent): Promise<Loaded | null> {
  const { tenantId } = event;
  const [contact, conversation] = await Promise.all([
    prisma.contact.findFirst({ where: { id: event.contactId, tenantId }, select: { id: true, name: true, phone: true, tags: true, attributes: true, optIn: true, optedOutAt: true, createdAt: true } }),
    event.conversationId
      ? prisma.conversation.findFirst({ where: { id: event.conversationId, tenantId }, select: { id: true, phoneNumberId: true, assignedToId: true, tags: true, teamId: true, lastInboundAt: true, status: true } })
      : Promise.resolve(null),
  ]);
  if (!contact) return null;
  const attributes = contact.attributes && typeof contact.attributes === "object" && !Array.isArray(contact.attributes) ? (contact.attributes as Record<string, unknown>) : {};
  return { contact: { ...contact, attributes }, conversation };
}

/** Why customer-facing rule actions should stay quiet in this chat right now, or null. Also used by holiday mode. */
export async function busyReason(tenantId: string, conversation: { id: string; assignedToId: string | null } | null, now: Date): Promise<string | null> {
  if (!conversation) return null;
  const session = await prisma.chatbotSession.findFirst({ where: { tenantId, conversationId: conversation.id, status: { in: ["waiting", "active"] } }, select: { id: true } });
  if (session) return "a chatbot is already talking with the customer";
  if (conversation.assignedToId) {
    const agent = await prisma.message.findFirst({
      where: { tenantId, conversationId: conversation.id, direction: "outbound", sentByUserId: { not: null }, createdAt: { gte: new Date(now.getTime() - HUMAN_ACTIVE_MS) } },
      select: { id: true },
    });
    if (agent) return "a person is handling this chat";
  }
  return null;
}

async function quietReason(tenantId: string, conversation: EnvConversation | null, event: TriggerEvent, now: Date): Promise<string | null> {
  if (!conversation) return null;
  if (event.message?.answeredBy === "bot") return "a chatbot or the AI agent is already answering";
  if (event.message?.answeredBy === "rule") return "another rule already replied to this message";
  return busyReason(tenantId, conversation, now);
}

async function ranRecently(tenantId: string, rule: RuleRow, def: RuleDefinition, event: TriggerEvent, now: Date): Promise<boolean> {
  const once = def.trigger.type === "contact_created";
  const cooldownMs = rule.cooldownMinutes * 60_000;
  if (!event.dedupeSince && !once && cooldownMs <= 0) return false;
  const since = event.dedupeSince ?? (once ? new Date(0) : new Date(now.getTime() - cooldownMs));
  const byContact = once || def.trigger.type === "scheduled" || !event.conversationId;
  const found = await prisma.ruleExecution.findFirst({
    where: { tenantId, ruleId: rule.id, outcome: { in: ["ok", "failed"] }, createdAt: { gte: since }, ...(byContact ? { contactId: event.contactId } : { conversationId: event.conversationId! }) },
    select: { id: true },
  });
  if (found) return true;
  if (byContact || !event.conversationId || cooldownMs <= 0 || event.dedupeSince) return false;
  // A rule converted from the classic format keeps its earlier runs in the old log, so its waiting time carries over.
  const classic = await prisma.automationRun.findFirst({ where: { tenantId, ruleId: rule.id, conversationId: event.conversationId, createdAt: { gte: since } }, select: { id: true } });
  return Boolean(classic);
}

async function loopGuardTripped(tenantId: string, conversationId: string | null, now: Date): Promise<boolean> {
  if (!conversationId) return false;
  for (const { windowMs, max } of LOOP_LIMITS) {
    const count = await prisma.ruleExecution.count({ where: { tenantId, conversationId, outcome: "ok", createdAt: { gte: new Date(now.getTime() - windowMs) } } });
    if (count >= max) return true;
  }
  return false;
}

/*
 * Rules with a waiting time, one-time rules and scheduled runs must not run twice for the same chat when two events are
 * processed at the same moment. A short lease row (the key is unique) is taken before the check and dropped after the log row
 * is written, so the second worker either sees the first run's log or backs off. A lease left behind by a crash expires.
 */
const LEASE_TTL_MS = 2 * 60_000;

function leaseFor(rule: RuleRow, def: RuleDefinition, event: TriggerEvent): string | null {
  const once = def.trigger.type === "contact_created";
  if (!once && !event.dedupeSince && rule.cooldownMinutes <= 0) return null;
  const byContact = once || def.trigger.type === "scheduled" || !event.conversationId;
  return `automation-lease:${rule.id}:${byContact ? `c-${event.contactId}` : `v-${event.conversationId}`}`;
}

async function takeLease(key: string): Promise<boolean> {
  const value = { at: new Date().toISOString() };
  try {
    await prisma.platformSetting.create({ data: { key, value } });
    return true;
  } catch {
    const taken = await prisma.platformSetting.updateMany({ where: { key, updatedAt: { lt: new Date(Date.now() - LEASE_TTL_MS) } }, data: { value } });
    return taken.count === 1;
  }
}

async function releaseLease(key: string): Promise<void> {
  try {
    await prisma.platformSetting.deleteMany({ where: { key } });
  } catch {
    // The lease expires by itself.
  }
}

async function record(tenantId: string, rule: RuleRow, event: TriggerEvent, outcome: "ok" | "skipped" | "failed", detail: string) {
  await prisma.ruleExecution.create({ data: { tenantId, ruleId: rule.id, conversationId: event.conversationId, contactId: event.contactId, outcome, detail: detail.slice(0, DETAIL_MAX) } });
}

async function recordSkip(tenantId: string, rule: RuleRow, event: TriggerEvent, detail: string, now: Date) {
  const key = event.conversationId ? { conversationId: event.conversationId } : { contactId: event.contactId };
  const earlier = await prisma.ruleExecution.findFirst({ where: { tenantId, ruleId: rule.id, outcome: "skipped", ...key, createdAt: { gte: new Date(now.getTime() - SKIP_LOG_REPEAT_MS) } }, select: { id: true } });
  if (!earlier) await record(tenantId, rule, event, "skipped", detail);
}

function summarise(actions: Action[], results: ActionResult[]): string {
  return results.map((r, i) => `${ACTION_LABEL[actions[i].type]}: ${r.status}${r.note ? ` (${r.note})` : ""}`).join("; ");
}

async function execute(rule: RuleRow, def: RuleDefinition, env: ActionEnv, quiet: string | null): Promise<{ results: ActionResult[]; outcome: "ok" | "skipped" | "failed" }> {
  const results: ActionResult[] = [];
  for (const action of def.actions) {
    results.push(quiet && isCustomerFacing(action) ? { status: "skipped", note: quiet } : await runAction(action, env));
  }
  const outcome = results.some((r) => r.status === "failed") ? "failed" : results.some((r) => r.status === "ok") ? "ok" : "skipped";
  return { results, outcome };
}

function buildContext(event: TriggerEvent, loaded: Loaded, segments: ReadonlySet<string>): RuleContext {
  return {
    now: event.at,
    text: event.message?.text ?? "",
    messageType: event.message?.messageType ?? "text",
    newChat: event.message?.newChat ?? false,
    silentMinutes: event.message?.silentMinutes ?? null,
    phone: loaded.contact.phone ?? "",
    contactTags: loaded.contact.tags,
    chatTags: loaded.conversation?.tags ?? [],
    attributes: loaded.contact.attributes,
    assignedToId: loaded.conversation?.assignedToId ?? null,
    segments,
  };
}

/**
 * Runs every enabled v2 rule that starts from this event, in priority order. Never throws for expected skips.
 * `rules` can be passed in when the caller already loaded the workspace's rules.
 */
export async function fireRules(event: TriggerEvent, preloaded?: RuleRow[]): Promise<FireResult> {
  const result: FireResult = { fired: 0, replied: false };
  const { tenantId } = event;
  const now = event.at;

  const rows = preloaded ?? ((await prisma.automationRule.findMany({ where: { tenantId, enabled: true, version: 2 } })) as RuleRow[]);
  const candidates = rows
    .filter((r) => (r.version ?? 2) === 2 && r.enabled !== false)
    .sort(byPriority)
    .flatMap((rule) => {
      const parsed = parseDefinition({ trigger: rule.trigger, filters: rule.filters, actions: rule.actions });
      return parsed.ok && triggerAccepts(parsed.value, rule, event) ? [{ rule, def: parsed.value }] : [];
    });
  if (candidates.length === 0) return result;
  if (!(await tenantMayRunBackground(tenantId))) return result;

  const loaded = await load(event);
  // An opt-out stops marketing only (lib/contacts/opt-out.ts): rules still run for the contact, and a step that sends a marketing
  // template is skipped for them (actions.ts sendTemplateAction, then the central gate in inbox/service.ts).
  if (!loaded) return result;
  if (loaded.conversation?.status === "blocked") return result;

  const lineOk = (rule: RuleRow) => !rule.phoneNumberId || !loaded.conversation || loaded.conversation.phoneNumberId === rule.phoneNumberId;
  const ids = [...new Set(candidates.flatMap((c) => segmentIds(c.def.filters.root)))];
  const segments = await segmentMembership(tenantId, loaded.contact.id, ids, now);
  const ctx = buildContext(event, loaded, segments);
  const mode: RunMode = (await getAutomationSettings(tenantId)).mode;
  const quiet = await quietReason(tenantId, loaded.conversation, event, now);
  let budget = await remainingTriggers(tenantId, now);

  for (const { rule, def } of candidates) {
    if (!lineOk(rule) || !filtersMatch(def.filters, ctx)) continue;
    const lease = leaseFor(rule, def, event);
    if (lease && !(await takeLease(lease))) continue;
    try {
      if (await ranRecently(tenantId, rule, def, event, now)) continue;
      if (budget !== null && budget <= 0) {
        await recordSkip(tenantId, rule, event, "Not run: this month's automation allowance is used up", now);
        continue;
      }
      if (await loopGuardTripped(tenantId, event.conversationId, now)) {
        await recordSkip(tenantId, rule, event, "Paused for this chat: too many rule runs in a short time", now);
        continue;
      }

      const quietNow = def.filters.options.allowWhenHumanActive && quiet?.startsWith("a person") ? null : quiet;
      const env: ActionEnv = {
        tenantId,
        rule: { id: rule.id, name: rule.name, phoneNumberId: rule.phoneNumberId },
        contact: loaded.contact,
        conversation: loaded.conversation,
        inbound: event.message ? { text: event.message.text, messageType: event.message.messageType, phoneNumberId: event.message.phoneNumberId, receivedAt: event.at } : null,
        now,
        ...(event.reservationId ? { reservationId: event.reservationId } : {}),
      };
      const { results, outcome } = await execute(rule, def, env, quietNow);
      loaded.conversation = env.conversation;
      ctx.assignedToId = env.conversation?.assignedToId ?? null;
      ctx.chatTags = env.conversation?.tags ?? [];
      ctx.contactTags = env.contact.tags;
      ctx.attributes = env.contact.attributes;

      const detail = summarise(def.actions, results);
      if (outcome === "skipped") {
        await recordSkip(tenantId, rule, event, detail, now);
        continue;
      }
      await record(tenantId, rule, { ...event, conversationId: env.conversation?.id ?? event.conversationId }, outcome, detail);
      result.fired += 1;
      if (outcome === "ok" && budget !== null) budget -= 1;
      const replied = results.some((r) => r.replied);
      result.replied ||= replied;
      if (rule.stopAfterMatch || (mode === "first_match" && replied)) break;
    } finally {
      if (lease) await releaseLease(lease);
    }
  }
  return result;
}

/** fireRules for callers that run in the background: errors are logged by class only and never propagate. */
export async function fireRulesSafely(event: TriggerEvent, preloaded?: RuleRow[]): Promise<FireResult> {
  try {
    return await fireRules(event, preloaded);
  } catch (error) {
    console.error("[automation] rules could not run:", describeError(error));
    return { fired: 0, replied: false };
  }
}

export type SimulationInput = { text: string; messageType: string; newChat: boolean; silentMinutes: number | null; at: Date; phone: string; tags: string[]; attributes: Record<string, unknown>; phoneNumberId?: string };

/** Dry run: which message-received rules would fire for a sample message. Ignores cooldowns, suppression and limits; sends nothing. */
export function simulate(rows: RuleRow[], input: SimulationInput): { id: string; name: string; summary: RuleDefinition }[] {
  const ctx: RuleContext = {
    now: input.at,
    text: input.text,
    messageType: input.messageType,
    newChat: input.newChat,
    silentMinutes: input.silentMinutes,
    phone: input.phone,
    contactTags: input.tags,
    chatTags: [],
    attributes: input.attributes,
    assignedToId: null,
    segments: new Set(),
  };
  const out: { id: string; name: string; summary: RuleDefinition }[] = [];
  for (const rule of [...rows].sort(byPriority)) {
    const parsed = parseDefinition({ trigger: rule.trigger, filters: rule.filters, actions: rule.actions });
    if (!parsed.ok || parsed.value.trigger.type !== "message_received") continue;
    if (rule.phoneNumberId && input.phoneNumberId && rule.phoneNumberId !== input.phoneNumberId) continue;
    if (filtersMatch(parsed.value.filters, ctx)) out.push({ id: rule.id, name: rule.name, summary: parsed.value });
  }
  return out;
}
