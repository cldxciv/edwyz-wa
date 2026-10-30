import { reserveCredits } from "@/lib/billing/limits";
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
import { isStopMessage } from "@/lib/webhooks/payload";
import { CREDIT_COST } from "@/lib/usage";
import { AI_REPLY_REF, parseActivation } from "./agents";
import { buildHistory, generateReply, type GenerateMeter, type GenerateResult } from "./generate";
import { chunkText, topChunks, type Chunk } from "./text";

export { registerAiAgentSeams, resetAiAgentSeams } from "./seams";

export type AiInboundInput = { tenantId: string; phoneNumberId: string; conversationId: string; contactId: string; text: string; receivedAt: Date };

export const STOP_TAG = "ai:stopped";
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

/** Chunks every ready source of the agent and returns the best matches for the query. */
export async function retrieveChunks(tenantId: string, agentId: string, query: string): Promise<Chunk[]> {
  const sources = await prisma.aiKnowledgeSource.findMany({ where: { tenantId, agentId, status: "ready" }, select: { id: true, title: true, content: true } });
  const all = sources.flatMap((s) => chunkText(s.content).map((text) => ({ sourceId: s.id, title: s.title, text })));
  return topChunks(query, all);
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

/** AI_MAX_REPLIES_PER_HOUR: workspace-wide hourly cap on AI replies, whatever the number of conversations. */
export function maxRepliesPerHour(): number {
  const raw = Number(process.env.AI_MAX_REPLIES_PER_HOUR);
  return process.env.AI_MAX_REPLIES_PER_HOUR?.trim() && Number.isInteger(raw) && raw >= 0 ? raw : DEFAULT_MAX_REPLIES_PER_HOUR;
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
  | { ok: false; reason: "budget" | "frozen" | "hourly"; error?: SpendBlockedError };

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
    const since = new Date(Date.now() - 3_600_000);
    for (let attempt = 0; ; attempt++) {
      const seen = finished.get(tenantId) ?? 0;
      const sent = await prisma.usageLedger.count({ where: { tenantId, meter: "ai_credits", refType: AI_REPLY_REF, createdAt: { gte: since } } });
      if ((finished.get(tenantId) ?? 0) !== seen && attempt < 2) continue;
      const pending = reserved.get(tenantId) ?? 0;
      if (sent + pending >= maxRepliesPerHour()) return { ok: false, reason: "hourly" };
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

async function run(input: AiInboundInput): Promise<boolean> {
  const { tenantId, conversationId } = input;
  if (!input.text.trim() || isStopMessage(input.text)) return false;
  if (!(await tenantMayRunBackground(tenantId))) return false;
  const [conversation, contact] = await Promise.all([
    prisma.conversation.findFirst({ where: { id: conversationId, tenantId }, select: { status: true, tags: true, lastInboundAt: true, contactId: true } }),
    prisma.contact.findFirst({ where: { id: input.contactId, tenantId }, select: { name: true, optedOutAt: true } }),
  ]);
  if (!conversation || !contact || conversation.contactId !== input.contactId) return false;
  if (conversation.status === "blocked" || contact.optedOutAt || conversation.tags.includes(STOP_TAG)) return false;
  if (await chatbotIsRunning(tenantId, conversationId, input.contactId)) return false;

  const agent = await pickAgent(tenantId, input.phoneNumberId);
  if (!agent || !(await activationAllows(agent, input))) return false;
  if (!isWithinServiceWindow(conversation.lastInboundAt ?? input.receivedAt)) return false;

  const [latest, replyCount, replies] = await Promise.all([
    prisma.message.findFirst({ where: { tenantId, conversationId }, orderBy: { createdAt: "desc" }, select: { direction: true, createdAt: true } }),
    prisma.usageLedger.count({ where: { tenantId, meter: "ai_credits", refType: AI_REPLY_REF, refId: conversationId } }),
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
    if (admission.reason === "hourly") return false;
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
