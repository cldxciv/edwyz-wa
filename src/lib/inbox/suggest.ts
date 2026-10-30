import { retrieveChunks } from "@/lib/ai-agent";
import { buildHistory, generateReply, type AgentPrompt, type GenerateMeter } from "@/lib/ai-agent/generate";
import { reserveCredits } from "@/lib/billing/limits";
import { createLimiter } from "@/lib/ratelimit";
import { prisma } from "@/lib/db";
import { isAiConfigured } from "@/lib/spend/exec/ai";
import type { SpendActor, SpendRole } from "@/lib/spend/types";
import { HttpError } from "@/lib/tenancy";
import { tenantMayRunBackground } from "@/lib/tenant-state";
import { CREDIT_COST } from "@/lib/usage";

export const SUGGEST_PER_MINUTE = 10;
export const MAX_DRAFTS = 3;
export const MAX_DRAFT_CHARS = 600;
export const SUGGEST_REF = "inbox_suggest";
const HISTORY_ROWS = 12;
const FOLLOW_UP_PROMPT = "(The customer has not written since the last reply. Draft a short, polite follow-up.)";

const limiter = createLimiter(SUGGEST_PER_MINUTE, 60_000, "inbox-suggest");
export const resetSuggestLimits = () => limiter.clear();

export function checkSuggestLimit(tenantId: string, userId: string): void {
  if (!limiter.consume(`${tenantId}:${userId}`)) throw new HttpError(429, "You are asking for suggestions too quickly. Wait a moment and try again.");
}

const DRAFTING_RULES = [
  "You are drafting reply options for a human support agent who will review and edit them. Nothing you write is sent automatically.",
  `Write up to ${MAX_DRAFTS} different reply options, each under 400 characters, plain text for WhatsApp.`,
  "If the knowledge does not cover the question, still write safe options that ask for the missing detail or say you will check. Never invent prices, dates, policies or promises, and do not call handoff_to_human.",
  'Respond with only a JSON array of strings, for example ["First option","Second option"], and no other text.',
];

export function suggestInstructions(base: string | null): string {
  return [base?.trim() || "You help a small business answer customers on WhatsApp.", ...DRAFTING_RULES].join("\n");
}

type Row = { direction: string; body: string | null; type?: string };

/** The customer's latest message when it is the newest text in the thread; otherwise a follow-up cue. */
export function pickPromptText(rows: Row[]): string {
  const texts = rows.filter((r) => r.body && (r.type === undefined || r.type === "text"));
  const last = texts[texts.length - 1];
  return last && last.direction === "inbound" ? (last.body as string).trim() : FOLLOW_UP_PROMPT;
}

const LIST_MARKER = /^(\d+[.)]|[-*•])\s+/;

/** Accepts a JSON array (optionally fenced), or falls back to splitting plain text on blank lines. */
export function parseDrafts(text: string): string[] {
  const trimmed = text.trim().replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, "");
  let items: unknown[] = [];
  const start = trimmed.indexOf("[");
  const end = trimmed.lastIndexOf("]");
  if (start >= 0 && end > start) {
    try {
      const parsed: unknown = JSON.parse(trimmed.slice(start, end + 1));
      if (Array.isArray(parsed)) items = parsed;
    } catch {
      items = [];
    }
  }
  if (items.length === 0 && trimmed && !trimmed.startsWith("[")) items = trimmed.split(/\n{2,}/).map((part) => part.trim().replace(LIST_MARKER, ""));
  const seen = new Set<string>();
  const drafts: string[] = [];
  for (const item of items) {
    if (typeof item !== "string") continue;
    const draft = item.trim().slice(0, MAX_DRAFT_CHARS);
    if (!draft || seen.has(draft.toLowerCase())) continue;
    seen.add(draft.toLowerCase());
    drafts.push(draft);
    if (drafts.length === MAX_DRAFTS) break;
  }
  return drafts;
}

type AgentRow = { id: string; name: string; enabled: boolean; phoneNumberId: string | null; instructions: string; tone: string | null; language: string; model: string | null };

/** Prefers an enabled agent bound to this number, then any enabled agent, then any agent that could apply. */
export function pickSuggestAgent<T extends Pick<AgentRow, "enabled" | "phoneNumberId">>(agents: T[], phoneNumberId: string): T | null {
  const applies = agents.filter((a) => a.phoneNumberId === null || a.phoneNumberId === phoneNumberId);
  const rank = (a: T) => (a.enabled ? 2 : 0) + (a.phoneNumberId === phoneNumberId ? 1 : 0);
  return [...applies].sort((x, y) => rank(y) - rank(x))[0] ?? null;
}

export type Suggestions = { drafts: string[]; handoff: boolean; grounded: boolean; agentName: string | null };

const SPEND_ROLES: readonly string[] = ["owner", "admin", "agent"];

/** The member who asked, as the AI gateway records it; a caller without a known role is recorded as the suggestions job. */
export function suggestActor(actor: { userId: string; role?: string | null }): SpendActor {
  return actor.role && SPEND_ROLES.includes(actor.role) ? { type: "user", userId: actor.userId, role: actor.role as SpendRole } : { type: "system", job: SUGGEST_REF };
}

/**
 * Drafts for the agent to edit. Never sends anything. One text credit per call, through the AI gateway
 * (docs/SPEND-CONTROLS-SPEC.md 4.10): feature `inbox_suggest`, which a person asked for, so it keeps working while spending
 * is stopped, within the AI limit. The credit is held across every process before the model runs (402 ai_quota with the
 * plain copy when the limit is used up), charged with the tokens and model when the drafts come back, and given back when
 * the model call fails.
 */
export async function suggestReplies(actor: { tenantId: string; userId: string; role?: string | null }, conversationId: string): Promise<Suggestions> {
  const { tenantId } = actor;
  if (!isAiConfigured()) throw new HttpError(503, "AI is not configured.");
  checkSuggestLimit(tenantId, actor.userId);
  if (!(await tenantMayRunBackground(tenantId))) throw new HttpError(403, "AI suggestions are not available for this workspace right now.");

  const conversation = await prisma.conversation.findFirst({
    where: { id: conversationId, tenantId },
    select: { id: true, phoneNumberId: true, contact: { select: { name: true } } },
  });
  if (!conversation) throw new HttpError(404, "Conversation not found.");
  const spendActor = suggestActor(actor);
  const release = await reserveCredits(tenantId, CREDIT_COST.text, { feature: "inbox_suggest", actor: spendActor });
  try {
    if (!release.hold) throw new Error("The AI credit hold is missing.");
    return await draftFor(tenantId, conversationId, conversation, { feature: "inbox_suggest", actor: spendActor, hold: release.hold });
  } finally {
    release();
  }
}

async function draftFor(tenantId: string, conversationId: string, conversation: { phoneNumberId: string; contact: { name: string | null } }, meter: GenerateMeter): Promise<Suggestions> {
  const [agents, newestFirst] = await Promise.all([
    prisma.aiAgent.findMany({ where: { tenantId, OR: [{ phoneNumberId: null }, { phoneNumberId: conversation.phoneNumberId }] }, orderBy: { createdAt: "asc" } }),
    prisma.message.findMany({
      where: { tenantId, conversationId },
      orderBy: { createdAt: "desc" },
      take: HISTORY_ROWS,
      select: { direction: true, body: true, type: true },
    }),
  ]);
  const rows = newestFirst.reverse();
  if (rows.length === 0) throw new HttpError(409, "There are no messages to reply to yet.");
  const agent = pickSuggestAgent(agents, conversation.phoneNumberId);
  const userText = pickPromptText(rows);
  const chunks = agent ? await retrieveChunks(tenantId, agent.id, userText) : [];

  const prompt: AgentPrompt = {
    instructions: suggestInstructions(agent?.instructions ?? null),
    tone: agent?.tone ?? null,
    language: agent?.language ?? "auto",
    model: agent?.model ?? null,
  };
  const result = await generateReply({
    tenantId,
    agent: prompt,
    chunks,
    contactName: conversation.contact.name,
    history: buildHistory(rows, userText),
    userText,
    meter,
  });
  // The hold already carries every round's tokens and model; the release in the caller's finally then does nothing.
  await meter.hold.settle({ credits: CREDIT_COST.text, ref: { type: SUGGEST_REF, id: conversationId } });
  return { drafts: parseDrafts(result.text), handoff: result.handoff, grounded: chunks.length > 0, agentName: agent?.name ?? null };
}
