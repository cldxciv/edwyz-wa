import { reserveCredits } from "@/lib/billing/limits";
import { aiRepliesPerHour, noteHourlyCapHit, type HourlyAllowance } from "@/lib/billing/ai-hourly";
import { prisma } from "@/lib/db";
import { listAllowedTools } from "@/lib/byo-mcp";
import { listCustomerTools } from "@/lib/byo-mcp/exposure";
import { assignConversation, getSettings as getRoutingSettings, isWithinWorkingHours } from "@/lib/routing";
import { sendText } from "@/lib/inbox/service";
import { emitStatusChanged } from "@/lib/integrations/emitters";
import { isWithinServiceWindow } from "@/lib/inbox/window";
import { describeError } from "@/lib/safe-error";
import { AI_AGENT_ACTOR, isAiQuotaError, isAiRefusal, type AiFeature, type AiHold } from "@/lib/spend/exec/ai";
import { SpendBlockedError } from "@/lib/spend/errors";
import type { SpendActor, SpendRole } from "@/lib/spend/types";
import { HttpError } from "@/lib/tenancy";
import { tenantMayRunBackground } from "@/lib/tenant-state";
import { isStopMessage, stopSourceOf } from "@/lib/webhooks/payload";
import { mayReceive } from "@/lib/contacts/opt-out";
import { CREDIT_COST } from "@/lib/usage";
import { AI_REPLY_REF, parseActivation } from "./agents";
import { buildHistory, generateReply, type GenerateMeter, type GenerateResult } from "./generate";
import { liftAiPause, markAiPaused, PAUSE_ACTIONS, PAUSED_ACTION, RESUMED_ACTION, STOP_TAG } from "./pause";
import { chunkText, pickKnowledge, type Chunk } from "./text";

export { registerAiAgentSeams, resetAiAgentSeams } from "./seams";
/** The pause tag and its audit rows live in ./pause, so chatbots can pause the agent without loading it. A pause lasts one episode: see pauseLapsed. */
export { LIFTED_ACTION, PAUSED_ACTION, RESUMED_ACTION, STOP_TAG } from "./pause";

/** startedBy "rule": an automation rule's "Let the AI agent answer" step asked for this reply, so the agent's Reply when setting does not apply. */
export type AiInboundInput = {
  tenantId: string;
  phoneNumberId: string;
  conversationId: string;
  contactId: string;
  text: string;
  receivedAt: Date;
  startedBy?: "rule";
  /** The inbound message's type and tapped reply id: the business's own button text is not read as a STOP word (stopSourceOf). */
  messageType?: string;
  replyId?: string;
};

const REOPENED_ACTION = "inbox.status.reopened";
const FRESH_START_ACTIONS = [REOPENED_ACTION, RESUMED_ACTION];
const DAY_MS = 24 * 60 * 60 * 1000;
/** Customer messages read when judging whether a pause lapsed. A paused chat rarely has more; the newest one is always checked. */
const PAUSE_SCAN_MAX = 500;
export const UNSENT_REF = "ai_reply_unsent";
export const COOLDOWN_MS = 5_000;
export const DEFAULT_MAX_REPLIES_PER_HOUR = 60;
export const HANDOFF_NOTE = "Thanks for your message. I am connecting you with a member of our team who will reply here shortly.";

/**
 * The AI agent's sends are automated, origin `ai_reply` (docs/SPEND-CONTROLS-SPEC.md 4.9, WP-11/WP-13). Spread into every
 * send input of the agent (the reply and the hand-off note). The WhatsApp gate then holds them under a stop or a quality drop,
 * and when the WhatsApp limit is used up the chat is handed to the team instead (decision 2.3.12). The origin field is
 * required, so a new send path of the agent without this stamp does not compile.
 */
export const AI_REPLY_SEND: { readonly origin: "ai_reply" } = Object.freeze({ origin: "ai_reply" as const });

const inFlight = new Set<string>();

const HUMAN_REQUEST = [
  /\b(talk|speak|chat|connect|transfer|escalate)\w*\s+(me\s+)?(to|with)\s+(a\s+|an\s+|the\s+|some\s*one\s+)?(human|person|agent|representative|manager|operator|someone|real)/i,
  /\b(human|real person|live agent|customer care|representative)\b/i,
];

export const asksForHuman = (text: string) => HUMAN_REQUEST.some((re) => re.test(text));

export function matchesHandoffKeyword(text: string, keywords: string[]): boolean {
  const lower = text.toLowerCase();
  return keywords.some((k) => {
    const escaped = k.toLowerCase().replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    return new RegExp(`(^|[^\\p{L}\\p{N}])${escaped}($|[^\\p{L}\\p{N}])`, "u").test(lower);
  });
}

/** Chunks every ready source of the agent (newest first) and returns the knowledge to send for the query: all of it when it fits, see pickKnowledge. */
export async function retrieveChunks(tenantId: string, agentId: string, query: string): Promise<Chunk[]> {
  const sources = await prisma.aiKnowledgeSource.findMany({ where: { tenantId, agentId, status: "ready" }, orderBy: { createdAt: "desc" }, select: { id: true, title: true, content: true } });
  const all = sources.flatMap((s) => chunkText(s.content).map((text) => ({ sourceId: s.id, title: s.title, text })));
  return pickKnowledge(query, all);
}

type AgentRow = NonNullable<Awaited<ReturnType<typeof pickAgent>>>;

async function pickAgent(tenantId: string, phoneNumberId: string) {
  const agents = await prisma.aiAgent.findMany({
    where: { tenantId, enabled: true, OR: [{ phoneNumberId: null }, { phoneNumberId }] },
    orderBy: { createdAt: "asc" },
  });
  return agents.find((a) => a.phoneNumberId === phoneNumberId) ?? agents[0] ?? null;
}

async function activationAllows(agent: AgentRow, input: AiInboundInput): Promise<boolean> {
  const { activation, minutes } = parseActivation(agent.activation);
  if (activation === "when_started") return false;
  if (activation === "outside_hours") return !isWithinWorkingHours(await getRoutingSettings(input.tenantId), input.receivedAt);
  if (activation === "no_human_reply_minutes") {
    const since = new Date(input.receivedAt.getTime() - minutes * 60_000);
    const human = await prisma.message.findFirst({
      where: { tenantId: input.tenantId, conversationId: input.conversationId, direction: "outbound", sentByUserId: { not: null }, createdAt: { gte: since } },
      select: { id: true },
    });
    return !human;
  }
  return true;
}

async function handOff(tenantId: string, conversationId: string, note: string | null): Promise<void> {
  const before = await prisma.conversation.findFirst({ where: { id: conversationId, tenantId }, select: { status: true, contactId: true } });
  await prisma.conversation.updateMany({ where: { id: conversationId, tenantId }, data: { status: "open", statusChangedAt: new Date(), tags: { push: STOP_TAG } } });
  await markAiPaused(tenantId, conversationId);
  try {
    await emitStatusChanged(tenantId, { conversationId, contactId: before?.contactId ?? null, from: before?.status ?? null, to: "open", source: "system" });
  } catch (error) {
    console.error("[ai-agent] status event could not be queued:", describeError(error));
  }
  if (note) {
    try {
      await sendText({ tenantId, conversationId, body: note, ...AI_REPLY_SEND });
    } catch {
      // window closed or send refused: the handoff still stands
    }
  }
  try {
    await assignConversation(tenantId, conversationId);
  } catch {
    // unassigned conversations stay visible in the open queue
  }
}

/**
 * AI_MAX_REPLIES_PER_HOUR: the platform's hourly cap on AI replies, workspace-wide whatever the number of conversations. Since
 * owner decision 3 it is only the fallback: the workspace's plan sets the cap (repliesPerHourFor), and this applies when no plan
 * value can be found.
 */
export function maxRepliesPerHour(): number {
  const raw = Number(process.env.AI_MAX_REPLIES_PER_HOUR);
  return process.env.AI_MAX_REPLIES_PER_HOUR?.trim() && Number.isInteger(raw) && raw >= 0 ? raw : DEFAULT_MAX_REPLIES_PER_HOUR;
}

/** The workspace's AI replies per hour: its plan's value (Starter 60, Growth 200, Agency 600 by default), else maxRepliesPerHour(). */
export function repliesPerHourFor(tenantId: string): Promise<HourlyAllowance> {
  return aiRepliesPerHour(tenantId, { fallback: maxRepliesPerHour() });
}

/** AI replies sent in the last 60 minutes: the count the hourly cap is checked against. */
const repliesInLastHour = (tenantId: string, now = Date.now()) =>
  prisma.usageLedger.count({ where: { tenantId, meter: "ai_credits", refType: AI_REPLY_REF, createdAt: { gte: new Date(now - 3_600_000) } } });

export type HourlyReplyUse = { used: number; limit: number; source: HourlyAllowance["source"] };

/** The hour's use against the allowance, for the AI agent screen. The same count and the same allowance as the reply admission. */
export async function hourlyReplyUse(tenantId: string, now = Date.now()): Promise<HourlyReplyUse> {
  const [used, allowance] = await Promise.all([repliesInLastHour(tenantId, now), repliesPerHourFor(tenantId)]);
  return { used, limit: allowance.limit, source: allowance.source };
}

/** Hourly reply slots taken in this process by replies that have not finished yet (AI_MAX_REPLIES_PER_HOUR). */
const reserved = new Map<string, number>();
const finished = new Map<string, number>();

/** Test hook: forget the in-process hourly slots. (AI credits are held in the database by the AI gateway.) */
export function resetAiReservations() {
  reserved.clear();
  finished.clear();
}

type Admission =
  | { ok: true; hold: AiHold; release: () => void }
  | { ok: false; reason: "budget" | "frozen" | "hourly"; error?: SpendBlockedError; used?: number; limit?: number };

/**
 * Decides whether one more reply may start. The hourly reply cap stays a per-process slot count over the hour's
 * ai_reply rows (a completion while the count was read triggers a re-read). The credit is then held through
 * reserveCredits(), which is the AI gateway's cross-process reservation (docs/SPEND-CONTROLS-SPEC.md 4.10): parallel
 * conversations, Creative Studio, suggestions and escalation checks in every process share the same counters, so together
 * they cannot pass the daily or monthly AI limit. A refusal (limit used up, or spending stopped for automatic AI) says why.
 */
async function admit(tenantId: string, opts: { hourly: boolean; feature: AiFeature; actor: SpendActor }): Promise<Admission> {
  let slot = false;
  if (opts.hourly) {
    const now = Date.now();
    // The plan's allowance (read once per admission; the lookup is cached for a minute per workspace).
    const cap = (await repliesPerHourFor(tenantId)).limit;
    for (let attempt = 0; ; attempt++) {
      const seen = finished.get(tenantId) ?? 0;
      const sent = await repliesInLastHour(tenantId, now);
      if ((finished.get(tenantId) ?? 0) !== seen && attempt < 2) continue;
      const pending = reserved.get(tenantId) ?? 0;
      if (sent + pending >= cap) return { ok: false, reason: "hourly", used: sent, limit: cap };
      reserved.set(tenantId, pending + 1);
      slot = true;
      break;
    }
  }
  const freeSlot = () => {
    if (!slot) return;
    slot = false;
    const left = (reserved.get(tenantId) ?? 1) - 1;
    if (left > 0) reserved.set(tenantId, left);
    else reserved.delete(tenantId);
    finished.set(tenantId, (finished.get(tenantId) ?? 0) + 1);
    if (finished.size > 5000) finished.clear();
  };
  let credits: Awaited<ReturnType<typeof reserveCredits>>;
  try {
    credits = await reserveCredits(tenantId, CREDIT_COST.text, { feature: opts.feature, actor: opts.actor });
  } catch (error) {
    freeSlot();
    if (isAiRefusal(error)) return { ok: false, reason: isAiQuotaError(error) ? "budget" : "frozen", error };
    throw error;
  }
  if (!credits.hold) {
    credits();
    freeSlot();
    throw new Error("The AI credit hold is missing.");
  }
  let released = false;
  return {
    ok: true,
    hold: credits.hold,
    release: () => {
      if (released) return;
      released = true;
      credits();
      freeSlot();
    },
  };
}

/** Charges one reply's credit under its hold, with the reference the outcome needs (sent, handed off, or not sent). */
async function charge(hold: AiHold, ref: { type: string; id: string }): Promise<void> {
  await hold.settle({ credits: CREDIT_COST.text, ref });
}

const isMessagingLimit = (error: unknown) => error instanceof SpendBlockedError && error.code === "spend.messaging_limit";

/** Tools the customer-facing agent may use: allowed by the admin, and risky ones only when explicitly exposed to customers. */
async function customerFacingTools(tenantId: string) {
  try {
    return await listCustomerTools(tenantId, await listAllowedTools(tenantId));
  } catch {
    return [];
  }
}

async function generateFor(input: AiInboundInput, agent: AgentRow, contactName: string | null, meter: GenerateMeter): Promise<GenerateResult> {
  const [chunks, rows, tools] = await Promise.all([
    retrieveChunks(input.tenantId, agent.id, input.text),
    prisma.message.findMany({
      where: { tenantId: input.tenantId, conversationId: input.conversationId },
      orderBy: { createdAt: "desc" },
      take: 10,
      select: { direction: true, body: true, type: true },
    }),
    customerFacingTools(input.tenantId),
  ]);
  return generateReply({
    tenantId: input.tenantId,
    agent,
    chunks,
    contactName,
    history: buildHistory(rows.reverse(), input.text),
    userText: input.text,
    tools,
    meter,
  });
}

const CHATBOT_SESSION_TTL_MS = 24 * 60 * 60 * 1000;

/** One bot or AI agent per contact: while a chatbot session is running (waiting for an answer or sleeping) in this chat, or in another chat of the same contact, the AI agent stays quiet. */
async function chatbotIsRunning(tenantId: string, conversationId: string, contactId: string): Promise<boolean> {
  try {
    const live = { in: ["waiting", "active"] as ("waiting" | "active")[] };
    return (await prisma.chatbotSession.count({ where: { tenantId, status: live, OR: [{ conversationId }, { contactId, updatedAt: { gt: new Date(Date.now() - CHATBOT_SESSION_TTL_MS) } }] } })) > 0;
  } catch {
    return false;
  }
}

/**
 * When the pause began: the latest hand-over that paused the agent here (PAUSED_ACTION). When the latest row ends a pause instead,
 * or there is none, the tag came from a hand-over that writes no row (the WhatsApp-limit hand-over, or one from before these rows
 * existed); those stamp statusChangedAt when they pause, so the pause is dated by that, never before the agent was last let back
 * in. Null when nothing dates it.
 */
async function pauseBegan(tenantId: string, conversationId: string, statusChangedAt: Date | null): Promise<Date | null> {
  const row = await prisma.auditLog.findFirst({ where: { tenantId, target: conversationId, action: { in: PAUSE_ACTIONS } }, orderBy: { createdAt: "desc" }, select: { action: true, createdAt: true } });
  if (row?.action === PAUSED_ACTION) return row.createdAt;
  const dates = [row?.createdAt, statusChangedAt].filter((d): d is Date => d instanceof Date);
  return dates.length ? new Date(Math.max(...dates.map((d) => d.getTime()))) : null;
}

/**
 * A pause belongs to one episode of the chat, so a customer who once asked for a person is not left without the AI for good.
 * It lapses when, since the pause began, the customer went quiet for more than a day and then wrote again (they are starting
 * something new), or a solved chat was reopened by the customer. Judged from the pause's start, not only from this message, so
 * a first message that a chatbot answered, that had no text, or that the agent left alone still ends the old pause.
 */
async function pauseLapsed(input: AiInboundInput, conversation: { status: string; statusChangedAt?: Date | null }): Promise<boolean> {
  const { tenantId, conversationId, receivedAt } = input;
  // This message reopened a solved chat (the reopen stamps statusChangedAt with the message's own time).
  if (conversation.status === "open" && conversation.statusChangedAt && conversation.statusChangedAt.getTime() >= receivedAt.getTime()) return true;
  const since = await pauseBegan(tenantId, conversationId, conversation.statusChangedAt ?? null);
  if (!since) {
    // Nothing dates the pause: this message alone decides, by the customer's message before it.
    const previous = await prisma.message.findFirst({ where: { tenantId, conversationId, direction: "inbound", createdAt: { lt: receivedAt } }, orderBy: { createdAt: "desc" }, select: { createdAt: true } });
    return Boolean(previous?.createdAt) && receivedAt.getTime() - previous!.createdAt.getTime() > DAY_MS;
  }
  const [reopened, inbound] = await Promise.all([
    prisma.auditLog.findFirst({ where: { tenantId, action: REOPENED_ACTION, target: conversationId, createdAt: { gt: since } }, select: { id: true } }),
    prisma.message.findMany({
      where: { tenantId, conversationId, direction: "inbound", createdAt: { gt: since, lte: receivedAt } },
      orderBy: { createdAt: "asc" },
      take: PAUSE_SCAN_MAX,
      select: { createdAt: true },
    }),
  ]);
  if (reopened) return true;
  // Silence is counted from the pause's start, so a customer who had been quiet before a teammate paused the agent is not "new".
  let previous = since.getTime();
  for (const message of inbound) {
    if (message.createdAt.getTime() - previous > DAY_MS) return true;
    previous = message.createdAt.getTime();
  }
  // This message, in case it is not stored yet (with a full page, the newest messages were not read, so the gap is unknown).
  return inbound.length < PAUSE_SCAN_MAX && receivedAt.getTime() - previous > DAY_MS;
}

/** When the chat last started afresh within the window (the customer wrote into a solved chat, or a teammate let the AI answer again). */
async function freshStart(tenantId: string, conversationId: string, since: Date): Promise<Date | null> {
  try {
    const row = await prisma.auditLog.findFirst({ where: { tenantId, action: { in: FRESH_START_ACTIONS }, target: conversationId, createdAt: { gte: since } }, orderBy: { createdAt: "desc" }, select: { createdAt: true } });
    return row?.createdAt ?? null;
  } catch {
    return null;
  }
}

/**
 * The AI replies that count toward "Max AI replies per chat": those of the last 24 hours, or only those since the chat started
 * afresh. The fresh start is looked up only when the day's count already reaches the limit, so a normal reply costs no extra query.
 */
async function repliesCounted(tenantId: string, conversationId: string, receivedAt: Date, max: number): Promise<number> {
  const since = new Date(receivedAt.getTime() - DAY_MS);
  const where = { tenantId, meter: "ai_credits", refType: AI_REPLY_REF, refId: conversationId };
  const inDay = await prisma.usageLedger.count({ where: { ...where, createdAt: { gte: since } } });
  if (inDay < max) return inDay;
  const fresh = await freshStart(tenantId, conversationId, since);
  return fresh ? prisma.usageLedger.count({ where: { ...where, createdAt: { gte: fresh } } }) : inDay;
}

async function run(input: AiInboundInput): Promise<boolean> {
  const { tenantId, conversationId } = input;
  if (!input.text.trim() || isStopMessage(input.text, [], stopSourceOf(input.messageType, input.replyId))) return false;
  if (!(await tenantMayRunBackground(tenantId))) return false;
  const [conversation, contact] = await Promise.all([
    prisma.conversation.findFirst({ where: { id: conversationId, tenantId }, select: { status: true, statusChangedAt: true, tags: true, lastInboundAt: true, contactId: true } }),
    prisma.contact.findFirst({ where: { id: input.contactId, tenantId }, select: { name: true, optedOutAt: true } }),
  ]);
  if (!conversation || !contact || conversation.contactId !== input.contactId) return false;
  if (conversation.status === "blocked" || !mayReceive(contact, "service")) return false;
  const agent = await pickAgent(tenantId, input.phoneNumberId);
  if (!agent) return false;

  // The pause is decided first, and once: a new episode lifts it here, before the chatbot, Reply when, window and cooldown checks,
  // so a message the agent then leaves alone (outside its hours, say) still ends the old pause.
  let pausedCount: number | null = null;
  if (conversation.tags.includes(STOP_TAG)) {
    if (!(await pauseLapsed(input, conversation))) return false;
    pausedCount = await repliesCounted(tenantId, conversationId, input.receivedAt, agent.maxRepliesPerConversation);
    // A new episode, but the chat already used its AI replies for the day: the team keeps it, with no second hand-off note.
    if (pausedCount >= agent.maxRepliesPerConversation) return false;
    await liftAiPause(tenantId, conversationId, conversation.tags);
  }
  if (await chatbotIsRunning(tenantId, conversationId, input.contactId)) return false;
  // A rule's "Let the AI agent answer" step is an explicit request, so the agent's own Reply when setting does not apply to it.
  if (input.startedBy !== "rule" && !(await activationAllows(agent, input))) return false;
  if (!isWithinServiceWindow(conversation.lastInboundAt ?? input.receivedAt)) return false;

  const [latest, replyCount, replies] = await Promise.all([
    prisma.message.findFirst({ where: { tenantId, conversationId }, orderBy: { createdAt: "desc" }, select: { direction: true, createdAt: true } }),
    pausedCount ?? repliesCounted(tenantId, conversationId, input.receivedAt, agent.maxRepliesPerConversation),
    prisma.usageLedger.findFirst({ where: { tenantId, meter: "ai_credits", refType: AI_REPLY_REF, refId: conversationId }, orderBy: { createdAt: "desc" }, select: { createdAt: true } }),
  ]);
  if (latest && latest.direction === "outbound" && latest.createdAt >= input.receivedAt) return false;
  if (replies) {
    if (replies.createdAt >= input.receivedAt) return true;
    if (Date.now() - replies.createdAt.getTime() < COOLDOWN_MS) return false;
  }

  if (matchesHandoffKeyword(input.text, agent.handoffKeywords) || asksForHuman(input.text) || replyCount >= agent.maxRepliesPerConversation) {
    await handOff(tenantId, conversationId, HANDOFF_NOTE);
    return true;
  }
  const admission = await admit(tenantId, { hourly: true, feature: "agent_reply", actor: AI_AGENT_ACTOR });
  if (!admission.ok) {
    if (admission.reason === "hourly") {
      // The message waits for the team. The admins get one notice for the hour (it never fails the reply path).
      await noteHourlyCapHit(tenantId, { used: admission.used ?? admission.limit ?? 0, limit: admission.limit ?? 0 });
      return false;
    }
    // The AI limit is used up, or spending is stopped: the chat goes to a person, never left unanswered (4.10, 6.4).
    await handOff(tenantId, conversationId, HANDOFF_NOTE);
    return true;
  }
  try {
    return await reply(input, agent, contact.name, admission.hold);
  } catch (error) {
    // Spending stopped (or the limit ran out) between the admission and a model round.
    if (!isAiRefusal(error)) throw error;
    await handOff(tenantId, conversationId, HANDOFF_NOTE);
    return true;
  } finally {
    admission.release();
  }
}

async function reply(input: AiInboundInput, agent: AgentRow, contactName: string | null, hold: AiHold): Promise<boolean> {
  const { tenantId, conversationId } = input;
  const result = await generateFor(input, agent, contactName, { feature: "agent_reply", actor: AI_AGENT_ACTOR, hold });
  if (result.handoff) {
    await charge(hold, { type: AI_REPLY_REF, id: conversationId });
    await handOff(tenantId, conversationId, result.text || HANDOFF_NOTE);
    return true;
  }
  try {
    await sendText({ tenantId, conversationId, body: result.text, ...AI_REPLY_SEND });
  } catch (error) {
    await charge(hold, { type: UNSENT_REF, id: conversationId });
    // Decision 2.3.12: when the WhatsApp limit is used up, the team takes the chat over instead of it waiting.
    if (isMessagingLimit(error)) {
      await handOff(tenantId, conversationId, null);
      return true;
    }
    throw error;
  }
  await charge(hold, { type: AI_REPLY_REF, id: conversationId });
  return true;
}

/**
 * A teammate lets the AI agent answer a paused chat again ("Let the AI answer again" in the inbox). The pause ends now, and the
 * audit row it leaves starts the chat's reply count afresh, so the next customer message gets an AI reply. Returns false when the
 * chat was not paused (nothing changes then).
 */
export async function resumeAiAgent(tenantId: string, conversationId: string, userId: string): Promise<boolean> {
  const conversation = await prisma.conversation.findFirst({ where: { id: conversationId, tenantId }, select: { tags: true } });
  if (!conversation) throw new HttpError(404, "Conversation not found.");
  const tags = Array.isArray(conversation.tags) ? conversation.tags : [];
  if (!tags.includes(STOP_TAG)) return false;
  await liftAiPause(tenantId, conversationId, tags, { action: RESUMED_ACTION, userId });
  return true;
}

/** True when the AI agent consumed the message (a reply was sent or a handoff happened). Never throws. */
export async function handleInboundForAiAgent(input: AiInboundInput): Promise<boolean> {
  const key = `${input.tenantId}:${input.conversationId}`;
  if (inFlight.has(key)) return false;
  inFlight.add(key);
  try {
    return await run(input);
  } catch (error) {
    console.error("[ai-agent] inbound handling failed:", describeError(error));
    return false;
  } finally {
    inFlight.delete(key);
  }
}

/**
 * Runs the generator against sample text. Nothing is sent and no tools are called; credits are still used. A person asked,
 * so it works while spending is stopped, within the AI limit (feature ai_test); a used-up limit is 402 ai_quota.
 */
export async function testAgent(
  tenantId: string,
  agentId: string,
  sample: string,
  requestedBy?: { userId: string; role: SpendRole },
): Promise<{ text: string; handoff: boolean; sources: string[] }> {
  const agent = await prisma.aiAgent.findFirst({ where: { id: agentId, tenantId } });
  if (!agent) throw new HttpError(404, "AI agent not found.");
  const actor: SpendActor = requestedBy ? { type: "user", userId: requestedBy.userId, role: requestedBy.role } : { type: "system", job: "ai_test" };
  const admission = await admit(tenantId, { hourly: false, feature: "ai_test", actor });
  if (!admission.ok) throw admission.error ?? new HttpError(402, "This month's AI limit is used up.");
  try {
    const chunks = await retrieveChunks(tenantId, agent.id, sample);
    const result = await generateReply({
      tenantId,
      agent,
      chunks,
      contactName: null,
      history: buildHistory([], sample),
      userText: sample,
      meter: { feature: "ai_test", actor, hold: admission.hold },
    });
    await charge(admission.hold, { type: "ai_test", id: agent.id });
    return { text: result.text, handoff: result.handoff, sources: [...new Set(chunks.map((c) => c.title))] };
  } finally {
    admission.release();
  }
}
