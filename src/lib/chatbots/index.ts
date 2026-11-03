import { markAiPaused, STOP_TAG as AI_STOP_TAG } from "@/lib/ai-agent/pause";
import { prisma } from "@/lib/db";
import { matchesKeywords } from "@/lib/automation/match";
import { isWithinServiceWindow } from "@/lib/inbox/window";
import { describeError } from "@/lib/safe-error";
import { mayReceive, OPTED_OUT_OF_MARKETING, optedOutSince } from "@/lib/contacts/opt-out";
import { HttpError } from "@/lib/tenancy";
import { asRec, isStopMessage, stopSourceOf } from "@/lib/webhooks/payload";
import { beginSession, endSession, parseFlow, resumeSession, SESSION_TTL_MS, sleepingStep, stepsAsideForHuman, wakeSession, type SessionRow } from "./engine";
import { parseSettings, type BotSettings, type FlowDefinition } from "./flow";

export { validateFlow } from "./flow";
export type { FlowDefinition } from "./flow";
export { registerChatbotSeams } from "./seams";

export type ChatbotInbound = {
  tenantId: string;
  /** Our PhoneNumber.id. */
  phoneNumberId: string;
  conversationId: string;
  contactId: string;
  text: string;
  receivedAt: Date;
  /** Id of the tapped reply button or list row, when the customer tapped one. */
  replyId?: string;
  /** The inbound message's type (text, button and so on): a template button's text is read as STOP only for unambiguous words. */
  messageType?: string;
};

type ChatbotRow = { id: string; triggerType: string; triggerKeywords: string[]; publishedFlow: unknown; createdAt: Date; phoneNumberId?: string | null };

const TRIGGER_ORDER = ["keyword", "first_message", "any_message"];
const LIVE = ["waiting", "active"] as const;
/** A running session that has not moved for this long (and is not sleeping in a delay) is a crashed run, not a bot still working. */
const STALE_RUN_MS = 10 * 60_000;
/** Same value as the AI agent module's AI_REPLY_REF; not imported so the bot code stays light and free of import cycles (the pause has its own small module). */
const AI_REPLY_REF = "ai_reply";

type Stamp = { id: string; startedAt: Date };
const earlier = (a: Stamp, b: Stamp) => a.startedAt.getTime() - b.startedAt.getTime() || (a.id < b.id ? -1 : 1);

/**
 * The database has no unique rule for "one live session per chat or contact", so two near-simultaneous starts (two inbound messages,
 * or a rule racing a message) can both get past their checks. After creating its session each start looks at the live sessions of the chat:
 * the earliest one wins and the others end as expired before sending anything. With replace (a teammate or rule starting a bot on
 * purpose) the newer start wins instead and ends the older sessions. Returns false when this start lost.
 */
async function claimChat(session: Stamp, tenantId: string, conversationId: string, contactId: string, replace: boolean): Promise<boolean> {
  const rivals = ((await prisma.chatbotSession.findMany({
    where: {
      tenantId,
      status: { in: [...LIVE] },
      id: { not: session.id },
      OR: [{ conversationId }, { contactId, updatedAt: { gt: new Date(Date.now() - SESSION_TTL_MS) } }],
    },
    select: { id: true, startedAt: true },
  })) ?? []) as Stamp[];
  const lost = rivals.some((r) => (replace ? earlier(r, session) > 0 : earlier(r, session) < 0));
  if (lost) return false;
  const doomed = replace ? rivals.map((r) => r.id) : [];
  if (doomed.length) {
    await prisma.chatbotSession.updateMany({
      where: { tenantId, id: { in: doomed }, status: { in: [...LIVE] } },
      data: { status: "expired", endedAt: new Date(), waitingNodeId: null, wakeAt: null },
    });
  }
  return true;
}

async function startRun(tenantId: string, chatbot: ChatbotRow, conversationId: string, contactId: string, triggerText: string, replace = false) {
  const flow = parseFlow(chatbot.publishedFlow);
  if (!flow) return null;
  const session = (await prisma.chatbotSession.create({
    data: { tenantId, chatbotId: chatbot.id, conversationId, contactId, status: "active", currentNodeId: flow.start, variables: {} },
  })) as SessionRow;
  if (!(await claimChat({ id: session.id, startedAt: session.startedAt ?? new Date() }, tenantId, conversationId, contactId, replace))) {
    await endSession(session, "expired");
    return null;
  }
  await beginSession(session, flow, triggerText);
  return session;
}

type Candidate = { bot: ChatbotRow; settings: BotSettings };

/** Lowest priority number first, then keyword before first-message before any-message, then a bot tied to this number, then oldest. */
function byPrecedence(a: Candidate, b: Candidate): number {
  return (
    a.settings.priority - b.settings.priority ||
    TRIGGER_ORDER.indexOf(a.bot.triggerType) - TRIGGER_ORDER.indexOf(b.bot.triggerType) ||
    Number(Boolean(b.bot.phoneNumberId)) - Number(Boolean(a.bot.phoneNumberId)) ||
    a.bot.createdAt.getTime() - b.bot.createdAt.getTime()
  );
}

async function pickChatbot(input: ChatbotInbound, assigned: boolean): Promise<ChatbotRow | null> {
  const bots = (await prisma.chatbot.findMany({
    where: {
      tenantId: input.tenantId,
      status: "published",
      triggerType: { in: TRIGGER_ORDER },
      OR: [{ phoneNumberId: null }, { phoneNumberId: input.phoneNumberId }],
    },
    orderBy: { createdAt: "asc" },
  })) as ChatbotRow[];
  const candidates = bots
    .map((bot) => ({ bot, settings: parseSettings(asRec(bot.publishedFlow).settings) }))
    .filter((c) => !(assigned && c.settings.skipAssignedChats))
    .sort(byPrecedence);
  let firstMessage: boolean | undefined;
  for (const { bot, settings } of candidates) {
    if (bot.triggerType === "keyword" && matchesKeywords(input.text, bot.triggerKeywords, settings.keywordMatch)) return bot;
    if (bot.triggerType === "first_message") {
      firstMessage ??= (await prisma.message.count({ where: { tenantId: input.tenantId, conversationId: input.conversationId, direction: "inbound" } })) <= 1;
      if (firstMessage) return bot;
    }
    if (bot.triggerType === "any_message") return bot;
  }
  return null;
}

/** The inactivity limit of the bot running this session. Never longer than the 24 hour customer service window. */
export const timeoutMs = (flow: FlowDefinition) => Math.min(parseSettings(flow.settings).timeoutMinutes * 60_000, SESSION_TTL_MS);

/**
 * Feeds the customer's message to the session's bot. Returns "expired" when the bot's own inactivity limit has passed, so the
 * caller can let a new bot start for this message, and "ended" when the bot no longer exists.
 */
async function resumeLive(input: ChatbotInbound, session: SessionRow): Promise<boolean | "expired"> {
  const chatbot = await prisma.chatbot.findFirst({ where: { id: session.chatbotId, tenantId: input.tenantId, status: "published" }, select: { publishedFlow: true } });
  const flow = chatbot ? parseFlow(chatbot.publishedFlow) : null;
  if (!flow) {
    await endSession(session, "expired");
    return false;
  }
  if (input.receivedAt.getTime() - session.updatedAt.getTime() > timeoutMs(flow)) {
    await endSession(session, "expired");
    return "expired";
  }
  return resumeSession(session, flow, input.text, input.replyId);
}

/** A bot still talking to this contact in another chat (another number) counts as busy, so one contact never has two bots at once. */
async function busyElsewhere(tenantId: string, contactId: string, conversationId: string, at: Date): Promise<boolean> {
  const other = await prisma.chatbotSession.findFirst({
    where: {
      tenantId,
      contactId,
      conversationId: { not: conversationId },
      status: { in: [...LIVE] },
      updatedAt: { gt: new Date(at.getTime() - SESSION_TTL_MS) },
    },
    select: { id: true },
  });
  return Boolean(other);
}

/** One bot or AI agent per contact: the AI agent counts as talking in a chat when it replied there in the last 24 hours and has not been paused. */
async function aiAgentIsTalking(tenantId: string, conversationId: string, tags: string[], at: Date): Promise<boolean> {
  if (tags.includes(AI_STOP_TAG)) return false;
  const reply = await prisma.usageLedger.findFirst({
    where: { tenantId, meter: "ai_credits", refType: AI_REPLY_REF, refId: conversationId, createdAt: { gt: new Date(at.getTime() - SESSION_TTL_MS) } },
    select: { id: true },
  });
  return Boolean(reply);
}

async function pauseAiAgent(tenantId: string, conversationId: string, tags: string[]) {
  if (!tags.includes(AI_STOP_TAG)) await prisma.conversation.updateMany({ where: { id: conversationId, tenantId }, data: { tags: [...tags, AI_STOP_TAG] } });
  await markAiPaused(tenantId, conversationId);
}

/**
 * Returns true when a bot consumed the message (the caller must then skip other auto-replies). Resumes a waiting
 * session first; otherwise starts the published chatbot whose trigger matches. Never throws.
 */
export async function handleInboundForChatbots(input: ChatbotInbound): Promise<boolean> {
  try {
    const { tenantId, conversationId, contactId } = input;
    const [live, contact, conversation] = await Promise.all([
      prisma.chatbotSession.findFirst({ where: { tenantId, conversationId, status: { in: [...LIVE] } }, orderBy: { updatedAt: "desc" } }) as Promise<SessionRow | null>,
      prisma.contact.findFirst({ where: { id: contactId, tenantId }, select: { optedOutAt: true } }),
      prisma.conversation.findFirst({ where: { id: conversationId, tenantId }, select: { status: true, assignedToId: true, tags: true } }),
    ]);

    // The title of a tapped button or list row is the business's own wording ("Cancel", "End"), so it is never read as STOP, and a
    // template's quick-reply button counts only for the unambiguous words (stopSourceOf).
    if (isStopMessage(input.text, [], stopSourceOf(input.messageType, input.replyId))) {
      if (live) await endSession(live, "completed");
      return false;
    }
    // A blocked chat never gets a bot message, so a session still waiting or sleeping there ends now. An opt-out stops marketing only
    // (lib/contacts/opt-out.ts): the bot still answers a contact who opted out, and refuses only a marketing template step. A session
    // that was running when they opted out ends instead of answering: their STOP answered it.
    const stopped = !!live && !!contact && optedOutSince(contact, live.startedAt);
    if (!contact || !mayReceive(contact, "service") || stopped || !conversation || conversation.status === "blocked") {
      if (live) await endSession(live, stopped || (contact && !mayReceive(contact, "service")) ? "completed" : "expired");
      return false;
    }
    if (live?.status === "active") {
      const age = input.receivedAt.getTime() - live.updatedAt.getTime();
      const crashed = !live.wakeAt && age > STALE_RUN_MS;
      if (age > SESSION_TTL_MS || crashed) await endSession(live, "expired");
      else {
        // The bot is sleeping in a delay (or busy right now) and still owns this chat. By default the message is reported as handled,
        // which keeps routing, holiday mode and classic rules from acting beside it; a person who took the chat over ends the bot
        // instead. A wait step can choose otherwise: "continue" ends the wait now, "pass" lets routing and rules see the message
        // (routing may give the chat to a teammate, rules may tag or assign it); nothing replies, as the bot still owns the chat.
        const owner = await prisma.chatbot.findFirst({ where: { id: live.chatbotId, tenantId, status: "published" }, select: { publishedFlow: true } });
        const flow = owner ? parseFlow(owner.publishedFlow) : null;
        if (!flow) {
          await endSession(live, "expired");
          return false;
        }
        if (await stepsAsideForHuman(live, flow)) {
          await endSession(live, "handed_off");
          return false;
        }
        const onReply = live.wakeAt ? sleepingStep(live, flow)?.data.onReply : undefined;
        if (onReply === "pass") return false;
        if (onReply === "continue") await wakeSession(live, flow, { reply: input.text });
        return true;
      }
    } else if (live) {
      if (input.receivedAt.getTime() - live.updatedAt.getTime() <= SESSION_TTL_MS) {
        const resumed = await resumeLive(input, live);
        if (resumed !== "expired") return resumed;
      } else await endSession(live, "expired");
    }

    const chatbot = await pickChatbot(input, Boolean(conversation.assignedToId));
    if (!chatbot) return false;
    if (await aiAgentIsTalking(tenantId, conversationId, conversation.tags ?? [], input.receivedAt)) return false;
    if (await busyElsewhere(tenantId, contactId, conversationId, input.receivedAt)) return false;
    return (await startRun(tenantId, chatbot, conversationId, contactId, input.text)) !== null;
  } catch (error) {
    console.error("[chatbot] inbound handling failed:", describeError(error));
    return false;
  }
}

export type StartSource = "manual" | "rule" | "api";

/**
 * Starts a chatbot on a conversation. Replaces any live session in it. Throws HttpError for caller mistakes.
 * "manual" is a teammate pressing the button in the inbox, who may start a bot on a chat they own. "rule" and "api" are automatic
 * and respect the bot's "skip chats a teammate owns" setting.
 */
export async function startChatbot(who: { tenantId: string }, chatbotId: string, conversationId: string, opts: { source?: StartSource } = {}): Promise<{ sessionId: string; status: string }> {
  const { tenantId } = who;
  const source = opts.source ?? "api";
  const [chatbot, conversation] = await Promise.all([
    prisma.chatbot.findFirst({ where: { id: chatbotId, tenantId } }),
    prisma.conversation.findFirst({
      where: { id: conversationId, tenantId },
      select: { id: true, contactId: true, status: true, assignedToId: true, phoneNumberId: true, lastInboundAt: true, tags: true, contact: { select: { optedOutAt: true } } },
    }),
  ]);
  if (!chatbot) throw new HttpError(404, "Chatbot not found.");
  if (!conversation) throw new HttpError(404, "Conversation not found.");
  const flow = chatbot.status === "published" ? parseFlow(chatbot.publishedFlow) : null;
  if (!flow) throw new HttpError(409, "Publish the chatbot before starting it.");
  if (chatbot.phoneNumberId && chatbot.phoneNumberId !== conversation.phoneNumberId) throw new HttpError(409, "This chatbot is set up for a different WhatsApp number.");
  if (!mayReceive(conversation.contact, "service")) throw new HttpError(409, OPTED_OUT_OF_MARKETING);
  if (conversation.status === "blocked") throw new HttpError(409, "This conversation is blocked.");
  if (source !== "manual" && conversation.assignedToId && flow.settings?.skipAssignedChats !== false) {
    throw new HttpError(409, "A teammate owns this chat, so the chatbot was not started.");
  }
  const startsWithTemplate = flow.nodes.find((n) => n.id === flow.start)?.type === "send_template";
  if (conversation.lastInboundAt !== undefined && !startsWithTemplate && !isWithinServiceWindow(conversation.lastInboundAt)) {
    throw new HttpError(409, "The 24-hour customer service window is closed. Send an approved template message first.");
  }

  if (await busyElsewhere(tenantId, conversation.contactId, conversationId, new Date())) {
    throw new HttpError(409, "A chatbot is already talking to this contact in another chat. Stop it there first.");
  }
  const tags = Array.isArray(conversation.tags) ? conversation.tags : [];
  if (await aiAgentIsTalking(tenantId, conversationId, tags, new Date())) {
    // A teammate starting a bot on purpose takes the chat over from the AI agent; a rule or the API does not.
    if (source !== "manual") throw new HttpError(409, "The AI agent is already talking in this chat, so the chatbot was not started.");
    await pauseAiAgent(tenantId, conversationId, tags);
  }
  await prisma.chatbotSession.updateMany({
    where: { tenantId, conversationId, status: { in: [...LIVE] } },
    data: { status: "expired", endedAt: new Date(), waitingNodeId: null, wakeAt: null },
  });
  const session = await startRun(tenantId, chatbot as ChatbotRow, conversationId, conversation.contactId, "", true);
  if (!session) throw new HttpError(409, "Another chatbot started in this chat at the same moment. Try again.");
  const latest = await prisma.chatbotSession.findFirst({ where: { id: session.id, tenantId }, select: { status: true } });
  return { sessionId: session.id, status: latest?.status ?? session.status };
}

export type LiveSession = { id: string; chatbotId: string; chatbotName: string; status: string; startedAt: Date; updatedAt: Date; endedAt: Date | null };

/** An AI agent that is switched on and may answer chats on this number. A failed read counts as none (the inbox then just hides the control). */
async function aiAgentAvailable(tenantId: string, phoneNumberId: string): Promise<boolean> {
  try {
    return (await prisma.aiAgent.count({ where: { tenantId, enabled: true, OR: [{ phoneNumberId: null }, { phoneNumberId }] } })) > 0;
  } catch {
    return false;
  }
}

/**
 * The most recent bot session of a conversation (running or finished), the bots a teammate can start on it, and aiPaused: the AI
 * agent handed this chat over (or was paused for a bot) and stays quiet here until a new episode or a teammate's "Let the AI answer again".
 */
export async function getConversationBotState(
  tenantId: string,
  conversationId: string,
): Promise<{ session: LiveSession | null; available: { id: string; name: string }[]; aiPaused: boolean }> {
  const conversation = await prisma.conversation.findFirst({ where: { id: conversationId, tenantId }, select: { phoneNumberId: true, tags: true } });
  if (!conversation) throw new HttpError(404, "Conversation not found.");
  const tags = Array.isArray(conversation.tags) ? conversation.tags : [];
  const aiPaused = tags.includes(AI_STOP_TAG) && (await aiAgentAvailable(tenantId, conversation.phoneNumberId));
  const [latest, bots] = await Promise.all([
    prisma.chatbotSession.findFirst({
      where: { tenantId, conversationId },
      orderBy: [{ startedAt: "desc" }, { id: "desc" }],
      select: { id: true, chatbotId: true, status: true, startedAt: true, updatedAt: true, endedAt: true },
    }),
    prisma.chatbot.findMany({
      where: { tenantId, status: "published", OR: [{ phoneNumberId: null }, { phoneNumberId: conversation.phoneNumberId }] },
      select: { id: true, name: true },
      orderBy: { name: "asc" },
      take: 100,
    }),
  ]);
  const name = latest ? (await prisma.chatbot.findFirst({ where: { id: latest.chatbotId, tenantId }, select: { name: true } }))?.name : undefined;
  return { session: latest ? { ...latest, chatbotName: name ?? "Chatbot" } : null, available: bots, aiPaused };
}

/** Ends the live bot session of a conversation (a teammate takes over). Returns whether one was running. */
export async function stopConversationBot(tenantId: string, conversationId: string): Promise<boolean> {
  const { count } = await prisma.chatbotSession.updateMany({
    where: { tenantId, conversationId, status: { in: [...LIVE] } },
    data: { status: "handed_off", endedAt: new Date(), waitingNodeId: null, wakeAt: null },
  });
  return count > 0;
}
