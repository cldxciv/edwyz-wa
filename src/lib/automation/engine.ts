import { prisma } from "@/lib/db";
import { sendText } from "@/lib/inbox/service";
import { isStopMessage, stopSourceOf } from "@/lib/webhooks/payload";
import { mayReceive } from "@/lib/contacts/opt-out";
import { isWithinOpenHours, matchesKeywords, parseSchedule } from "./match";
import { answerWithHolidayMode } from "./v2/holiday";
import { busyReason, fireRulesSafely, type RuleRow } from "./v2/run";

export type RuleLike = {
  id: string;
  type: "welcome" | "away" | "keyword";
  phoneNumberId: string | null;
  keywords: string[];
  matchMode: string;
  replyText: string;
  schedule: unknown;
  cooldownMinutes: number;
  createdAt: Date;
};

export type MatchContext = {
  text: string;
  receivedAt: Date;
  /** Minutes since the previous inbound message in this conversation, or null when this is the first one. */
  silentMinutes: number | null;
};

const TYPE_ORDER = { keyword: 0, welcome: 1, away: 2 } as const;
/** No two automatic replies in one conversation closer than this, whatever the rules say. Stops bot-to-bot loops. */
export const GLOBAL_GUARD_MS = 60_000;

export function ruleMatches(rule: RuleLike, ctx: MatchContext): boolean {
  switch (rule.type) {
    case "keyword":
      return matchesKeywords(ctx.text, rule.keywords, rule.matchMode);
    case "welcome":
      return ctx.silentMinutes === null || ctx.silentMinutes >= rule.cooldownMinutes;
    case "away": {
      const schedule = parseSchedule(rule.schedule);
      return schedule !== null && !isWithinOpenHours(schedule, ctx.receivedAt);
    }
  }
}

export function orderRules<T extends RuleLike>(rules: T[]): T[] {
  return [...rules].sort((a, b) => TYPE_ORDER[a.type] - TYPE_ORDER[b.type] || a.createdAt.getTime() - b.createdAt.getTime());
}

/** First rule, in priority order, that applies to this number, matches, and is not cooling down. */
export async function pickRule<T extends RuleLike>(
  rules: T[],
  phoneNumberId: string,
  ctx: MatchContext,
  onCooldown: (rule: T) => Promise<boolean>,
): Promise<T | null> {
  for (const rule of orderRules(rules)) {
    if (phoneNumberId && rule.phoneNumberId && rule.phoneNumberId !== phoneNumberId) continue;
    if (!rule.replyText.trim() || !ruleMatches(rule, ctx)) continue;
    if (await onCooldown(rule)) continue;
    return rule;
  }
  return null;
}

export type InboundInput = {
  tenantId: string;
  /** Our PhoneNumber.id. */
  phoneNumberId: string;
  conversationId: string;
  contactId: string;
  text: string;
  receivedAt: Date;
  /** Kind of the incoming message: text, image, audio and so on. Defaults to text. */
  messageType?: string;
  /** Id of the tapped reply button or list row. Its title, like a template button's text, is the business's wording, not a STOP (stopSourceOf). */
  replyId?: string;
  /** True when a chatbot or the AI agent already answered this message. */
  botHandled?: boolean;
};

export type AutomationResult = { replied: boolean; ruleId?: string; skipped?: string };

/** A contact created this recently by their first message counts as new. */
const NEW_CONTACT_MS = 5 * 60_000;

type StoredRuleLike = RuleLike & { version?: number };

/**
 * Entry point for every incoming message, after chatbots and the AI agent. In order: holiday mode, rules v2 (a new contact's
 * rules, then message rules), then the classic welcome, away and keyword replies. At most one automatic reply per message.
 * Never throws for expected skips; callers should still catch.
 */
export async function runAutomationsForInbound(input: InboundInput): Promise<AutomationResult> {
  const { tenantId, conversationId, contactId } = input;
  if (isStopMessage(input.text, [], stopSourceOf(input.messageType, input.replyId))) return { replied: false, skipped: "opt-out message" };

  const [contact, conversation] = await Promise.all([
    prisma.contact.findFirst({ where: { id: contactId, tenantId }, select: { optedOutAt: true, createdAt: true } }),
    prisma.conversation.findFirst({ where: { id: conversationId, tenantId }, select: { status: true, assignedToId: true } }),
  ]);
  // Rules here answer the message the customer just sent, which an opt-out never blocks; a marketing template step is refused per action (v2/actions.ts).
  if (!contact || !mayReceive(contact, "service")) return { replied: false, skipped: "contact opted out" };
  if (conversation?.status === "blocked") return { replied: false, skipped: "conversation is blocked" };

  const rules = (await prisma.automationRule.findMany({ where: { tenantId, enabled: true } })) as StoredRuleLike[];
  const now = new Date();
  const previous = await prisma.message.findFirst({
    where: { tenantId, conversationId, direction: "inbound", createdAt: { lt: input.receivedAt } },
    orderBy: { createdAt: "desc" },
    select: { createdAt: true },
  });
  const silentMinutes = previous ? (input.receivedAt.getTime() - previous.createdAt.getTime()) / 60_000 : null;

  let answeredBy: "bot" | "rule" | null = input.botHandled ? "bot" : null;
  let replied = false;
  if (!input.botHandled) {
    const holiday = await answerWithHolidayMode({ tenantId, conversationId, contactId, now }).catch(() => "inactive" as const);
    if (holiday !== "inactive") {
      answeredBy = "rule";
      replied = holiday === "sent";
    }
  }

  const v2Rules = rules.filter((r) => r.version === 2) as unknown as RuleRow[];
  if (v2Rules.length > 0) {
    const message = (by: typeof answeredBy, newChat: boolean) => ({ text: input.text, messageType: input.messageType ?? "text", newChat, silentMinutes, phoneNumberId: input.phoneNumberId, answeredBy: by });
    const base = { tenantId, contactId, conversationId, at: input.receivedAt };
    if (silentMinutes === null && input.receivedAt.getTime() - contact.createdAt.getTime() < NEW_CONTACT_MS) {
      const created = await fireRulesSafely({ ...base, type: "contact_created", message: message(answeredBy, true) }, v2Rules);
      if (created.replied) {
        answeredBy = "rule";
        replied = true;
      }
    }
    const received = await fireRulesSafely({ ...base, type: "message_received", message: message(answeredBy, silentMinutes === null) }, v2Rules);
    replied ||= received.replied;
  }
  if (replied) return { replied: true };
  if (answeredBy) return { replied: false, skipped: answeredBy === "bot" ? "a chatbot or the AI agent answered" : "holiday mode answered" };

  const classic = rules.filter((r) => r.version !== 2);
  if (classic.length === 0) return { replied: false, skipped: "no rules" };

  const recent = await prisma.automationRun.findFirst({
    where: { tenantId, conversationId, createdAt: { gte: new Date(now.getTime() - GLOBAL_GUARD_MS) } },
    select: { id: true },
  });
  if (recent) return { replied: false, skipped: "automatic reply sent moments ago" };
  // Like rules v2: no classic auto-reply while a chatbot is talking or a teammate who owns the chat replied in the last minutes.
  const busy = await busyReason(tenantId, { id: conversationId, assignedToId: conversation?.assignedToId ?? null }, now);
  if (busy) return { replied: false, skipped: busy };

  const ctx: MatchContext = { text: input.text, receivedAt: input.receivedAt, silentMinutes };

  const onCooldown = async (rule: RuleLike) => {
    const since = new Date(now.getTime() - rule.cooldownMinutes * 60_000);
    const run = await prisma.automationRun.findFirst({ where: { tenantId, ruleId: rule.id, conversationId, createdAt: { gte: since } }, select: { id: true } });
    return Boolean(run);
  };

  const rule = await pickRule(classic, input.phoneNumberId, ctx, onCooldown);
  if (!rule) return { replied: false, skipped: "no matching rule" };

  const run = await prisma.automationRun.create({ data: { tenantId, ruleId: rule.id, conversationId } });
  try {
    await sendText({ tenantId, conversationId, body: rule.replyText, origin: "automation" });
  } catch (error) {
    await prisma.automationRun.deleteMany({ where: { id: run.id, tenantId } });
    throw error;
  }
  return { replied: true, ruleId: rule.id };
}
