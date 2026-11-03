import { prisma } from "@/lib/db";
import { audit } from "@/lib/auth/audit";
import { usedThisMonth } from "@/lib/usage";
import { HttpError } from "@/lib/tenancy";
import { fetchPage, type PageDeps } from "./fetch-page";
import { allowedModels, isAllowedModel, resolveModel } from "./models";
import { effectiveCreditLimit } from "./credits";
import { htmlToText } from "./text";

/** when_started: the agent never answers on its own; it answers only when an automation rule starts it (the start_ai_agent action). */
export const ACTIVATIONS = ["always", "outside_hours", "no_human_reply_minutes", "when_started"] as const;
export type Activation = (typeof ACTIVATIONS)[number];
export const MAX_AGENTS = 10;
export const MAX_SOURCES = 50;
export const MAX_TEXT_CHARS = 100_000;
export const AI_REPLY_REF = "ai_reply";
const DEFAULT_MINUTES = 15;

export type AgentView = {
  id: string;
  name: string;
  enabled: boolean;
  phoneNumberId: string | null;
  instructions: string;
  tone: string | null;
  language: string;
  activation: Activation;
  noHumanReplyMinutes: number;
  handoffKeywords: string[];
  maxRepliesPerConversation: number;
  model: string | null;
  /** The model replies actually use: the stored one only while it is still on the allow-list, otherwise the platform default. */
  effectiveModel: string;
  createdAt: Date;
  updatedAt: Date;
};

type AgentRow = {
  id: string; name: string; enabled: boolean; phoneNumberId: string | null; instructions: string; tone: string | null; language: string;
  activation: string; handoffKeywords: string[]; maxRepliesPerConversation: number; model: string | null; createdAt: Date; updatedAt: Date;
};

/** Activation is stored as "no_human_reply_minutes:<n>" because the schema has no column for the minutes. */
export function parseActivation(stored: string): { activation: Activation; minutes: number } {
  const [mode, raw] = stored.split(":");
  const activation = (ACTIVATIONS as readonly string[]).includes(mode) ? (mode as Activation) : "always";
  const minutes = Number(raw);
  return { activation, minutes: Number.isInteger(minutes) && minutes > 0 ? minutes : DEFAULT_MINUTES };
}

function encodeActivation(activation: Activation, minutes: number): string {
  return activation === "no_human_reply_minutes" ? `${activation}:${minutes}` : activation;
}

export function toView(row: AgentRow): AgentView {
  const { activation, minutes } = parseActivation(row.activation);
  return {
    id: row.id, name: row.name, enabled: row.enabled, phoneNumberId: row.phoneNumberId, instructions: row.instructions, tone: row.tone,
    language: row.language, activation, noHumanReplyMinutes: minutes, handoffKeywords: row.handoffKeywords,
    maxRepliesPerConversation: row.maxRepliesPerConversation, model: row.model, effectiveModel: resolveModel(row.model), createdAt: row.createdAt, updatedAt: row.updatedAt,
  };
}

/** Names shown to the business owner in place of the request field names. */
const LABELS: Record<string, string> = {
  name: "Name", instructions: "Instructions", tone: "Tone", language: "Language", phoneNumberId: "Phone number", model: "Model",
  noHumanReplyMinutes: "Minutes without a teammate reply", maxRepliesPerConversation: "Replies per chat",
  content: "The text", url: "The page address", fileName: "The file name", title: "The title",
};
const labelOf = (key: string) => LABELS[key] ?? key;
const REQUIRED_HINTS: Record<string, string> = { name: "Give the agent a name.", instructions: "Tell the agent what to do." };
const requiredMessage = (key: string) => REQUIRED_HINTS[key] ?? `${labelOf(key)} is required.`;

function text(body: Record<string, unknown>, key: string, max: number, required: boolean): string | null | undefined {
  const value = body[key];
  if (value === undefined) {
    if (required) throw new HttpError(400, requiredMessage(key));
    return undefined;
  }
  if (value === null || value === "") {
    if (required) throw new HttpError(400, requiredMessage(key));
    return null;
  }
  if (typeof value !== "string") throw new HttpError(400, `${labelOf(key)} must be text.`);
  const trimmed = value.trim();
  if (trimmed.length > max) throw new HttpError(400, `${labelOf(key)} must be at most ${max} characters.`);
  if (required && !trimmed) throw new HttpError(400, requiredMessage(key));
  return trimmed || null;
}

function integer(body: Record<string, unknown>, key: string, min: number, max: number): number | undefined {
  const value = body[key];
  if (value === undefined) return undefined;
  if (typeof value !== "number" || !Number.isInteger(value) || value < min || value > max) throw new HttpError(400, `${labelOf(key)} must be a whole number from ${min} to ${max}.`);
  return value;
}

function keywords(body: Record<string, unknown>): string[] | undefined {
  const value = body.handoffKeywords;
  if (value === undefined) return undefined;
  if (!Array.isArray(value) || value.length > 20) throw new HttpError(400, "Use up to 20 handoff keywords.");
  const out = value.map((k) => (typeof k === "string" ? k.trim().toLowerCase() : ""));
  if (out.some((k) => !k || k.length > 40)) throw new HttpError(400, "Each handoff keyword must be 1 to 40 characters.");
  return [...new Set(out)];
}

type AgentInput = {
  name?: string; enabled?: boolean; phoneNumberId?: string | null; instructions?: string; tone?: string | null; language?: string;
  activation?: Activation; noHumanReplyMinutes?: number; handoffKeywords?: string[]; maxRepliesPerConversation?: number; model?: string | null;
};

export function parseAgentInput(body: Record<string, unknown>, creating: boolean): AgentInput {
  const out: AgentInput = {};
  const name = text(body, "name", 80, creating);
  if (name !== undefined) out.name = name ?? undefined;
  const instructions = text(body, "instructions", 4000, creating);
  if (instructions !== undefined) out.instructions = instructions ?? undefined;
  const tone = text(body, "tone", 200, false);
  if (tone !== undefined) out.tone = tone;
  const language = text(body, "language", 40, false);
  if (language !== undefined) out.language = language ?? "auto";
  const phone = text(body, "phoneNumberId", 64, false);
  if (phone !== undefined) out.phoneNumberId = phone;
  const model = text(body, "model", 80, false);
  if (model !== undefined) {
    if (model && !isAllowedModel(model)) throw new HttpError(400, `model must be one of: ${allowedModels().join(", ")}.`);
    out.model = model;
  }
  if (body.enabled !== undefined) {
    if (typeof body.enabled !== "boolean") throw new HttpError(400, "enabled must be true or false.");
    out.enabled = body.enabled;
  }
  if (body.activation !== undefined) {
    if (typeof body.activation !== "string" || !(ACTIVATIONS as readonly string[]).includes(body.activation)) throw new HttpError(400, "activation is not valid.");
    out.activation = body.activation as Activation;
  }
  const minutes = integer(body, "noHumanReplyMinutes", 1, 1440);
  if (minutes !== undefined) out.noHumanReplyMinutes = minutes;
  const max = integer(body, "maxRepliesPerConversation", 1, 50);
  if (max !== undefined) out.maxRepliesPerConversation = max;
  const words = keywords(body);
  if (words !== undefined) out.handoffKeywords = words;
  return out;
}

async function assertPhoneNumber(tenantId: string, phoneNumberId: string | null | undefined) {
  if (!phoneNumberId) return;
  const found = await prisma.phoneNumber.findFirst({ where: { id: phoneNumberId, tenantId }, select: { id: true } });
  if (!found) throw new HttpError(400, "That phone number is not in this workspace.");
}

function activationFor(input: AgentInput, existing?: string): string | undefined {
  if (input.activation === undefined && input.noHumanReplyMinutes === undefined) return undefined;
  const current = parseActivation(existing ?? "always");
  return encodeActivation(input.activation ?? current.activation, input.noHumanReplyMinutes ?? current.minutes);
}

export async function listAgents(tenantId: string): Promise<AgentView[]> {
  const rows = await prisma.aiAgent.findMany({ where: { tenantId }, orderBy: { createdAt: "asc" } });
  return rows.map(toView);
}

export async function getAgent(tenantId: string, id: string): Promise<AgentView> {
  const row = await prisma.aiAgent.findFirst({ where: { id, tenantId } });
  if (!row) throw new HttpError(404, "AI agent not found.");
  return toView(row);
}

export async function createAgent(tenantId: string, userId: string, body: Record<string, unknown>): Promise<AgentView> {
  const input = parseAgentInput(body, true);
  if ((await prisma.aiAgent.count({ where: { tenantId } })) >= MAX_AGENTS) throw new HttpError(409, `You can have up to ${MAX_AGENTS} AI agents.`);
  await assertPhoneNumber(tenantId, input.phoneNumberId);
  const row = await prisma.aiAgent.create({
    data: {
      tenantId,
      name: input.name as string,
      instructions: input.instructions as string,
      enabled: input.enabled ?? false,
      phoneNumberId: input.phoneNumberId ?? null,
      tone: input.tone ?? null,
      language: input.language ?? "auto",
      activation: activationFor(input) ?? "always",
      handoffKeywords: input.handoffKeywords ?? [],
      maxRepliesPerConversation: input.maxRepliesPerConversation ?? 10,
      model: input.model ?? null,
    },
  });
  await audit({ tenantId, userId, action: "ai_agent.create", target: row.id });
  return toView(row);
}

export async function updateAgent(tenantId: string, userId: string, id: string, body: Record<string, unknown>): Promise<AgentView> {
  const input = parseAgentInput(body, false);
  const existing = await prisma.aiAgent.findFirst({ where: { id, tenantId } });
  if (!existing) throw new HttpError(404, "AI agent not found.");
  await assertPhoneNumber(tenantId, input.phoneNumberId);
  const { activation: _a, noHumanReplyMinutes: _m, ...rest } = input;
  const activation = activationFor(input, existing.activation);
  const data = { ...rest, ...(activation ? { activation } : {}) };
  await prisma.aiAgent.updateMany({ where: { id, tenantId }, data });
  await audit({ tenantId, userId, action: "ai_agent.update", target: id });
  return getAgent(tenantId, id);
}

export async function deleteAgent(tenantId: string, userId: string, id: string): Promise<void> {
  const result = await prisma.aiAgent.deleteMany({ where: { id, tenantId } });
  if (result.count === 0) throw new HttpError(404, "AI agent not found.");
  await audit({ tenantId, userId, action: "ai_agent.delete", target: id });
}

export type SourceView = { id: string; kind: string; title: string; sourceUrl: string | null; status: string; chars: number; createdAt: Date };

export async function listSources(tenantId: string, agentId: string): Promise<SourceView[]> {
  await getAgent(tenantId, agentId);
  const rows = await prisma.aiKnowledgeSource.findMany({ where: { tenantId, agentId }, orderBy: { createdAt: "asc" } });
  return rows.map((r) => ({ id: r.id, kind: r.kind, title: r.title, sourceUrl: r.sourceUrl, status: r.status, chars: r.content.length, createdAt: r.createdAt }));
}

function faqContent(items: unknown): string {
  if (!Array.isArray(items) || items.length === 0 || items.length > 200) throw new HttpError(400, "faq must be a list of 1 to 200 questions.");
  return items
    .map((item) => {
      const rec = item && typeof item === "object" ? (item as Record<string, unknown>) : {};
      const q = typeof rec.q === "string" ? rec.q.trim() : "";
      const a = typeof rec.a === "string" ? rec.a.trim() : "";
      if (!q || !a || q.length > 500 || a.length > 2000) throw new HttpError(400, "Each FAQ needs a question (up to 500 characters) and an answer (up to 2000).");
      return `Q: ${q}\nA: ${a}`;
    })
    .join("\n\n");
}

/** The readable text of a public page, as stored for a url source. */
async function pageText(url: string, deps: PageDeps): Promise<string> {
  const page = await fetchPage(url, deps);
  const content = (page.isHtml ? htmlToText(page.body) : page.body.trim()).slice(0, MAX_TEXT_CHARS);
  if (content.length < 20) throw new HttpError(400, "The page has no readable text. Pages that only show their text after loading in a browser cannot be read; paste the text instead.");
  return content;
}

/** File types whose text is read in the browser and sent as plain text. PDF and Word files need a parser the platform does not have yet. */
const TEXT_FILE = /\.(txt|text|md|markdown)$/i;

async function sourceContent(kind: string, body: Record<string, unknown>, deps: PageDeps): Promise<{ content: string; sourceUrl: string | null; fileName?: string }> {
  if (kind === "faq") return { content: faqContent(body.faq), sourceUrl: null };
  if (kind === "text") {
    const content = text(body, "content", MAX_TEXT_CHARS, true) as string;
    return { content, sourceUrl: null };
  }
  if (kind === "file") {
    const fileName = text(body, "fileName", 200, true) as string;
    if (!TEXT_FILE.test(fileName)) throw new HttpError(400, "Only .txt and .md files can be added. For a PDF or Word file, copy its text into a Text source.");
    const content = text(body, "content", MAX_TEXT_CHARS, true) as string;
    return { content, sourceUrl: null, fileName };
  }
  if (kind === "url") {
    const url = text(body, "url", 2048, true) as string;
    return { content: await pageText(url, deps), sourceUrl: url };
  }
  throw new HttpError(400, "kind must be text, faq, file or url.");
}

/** URL content is fetched here and stored; it is never fetched at reply time. refreshSource reads the page again on request. */
export async function addSource(tenantId: string, userId: string, agentId: string, body: Record<string, unknown>, deps: PageDeps = {}): Promise<SourceView> {
  await getAgent(tenantId, agentId);
  if ((await prisma.aiKnowledgeSource.count({ where: { tenantId, agentId } })) >= MAX_SOURCES) throw new HttpError(409, `An agent can have up to ${MAX_SOURCES} knowledge sources.`);
  const kind = typeof body.kind === "string" ? body.kind : "";
  const { content, sourceUrl, fileName } = await sourceContent(kind, body, deps);
  const title = (text(body, "title", 120, false) as string | null) ?? sourceUrl ?? fileName?.slice(0, 120) ?? (kind === "faq" ? "FAQ" : "Notes");
  const row = await prisma.aiKnowledgeSource.create({ data: { tenantId, agentId, kind, title, content, sourceUrl, status: "ready" } });
  await audit({ tenantId, userId, action: "ai_agent.source_add", target: row.id, meta: { kind } });
  return { id: row.id, kind, title, sourceUrl, status: row.status, chars: content.length, createdAt: row.createdAt };
}

/** Reads a web page source again and replaces its stored text. Only url sources can be refreshed; the old text stays when the page cannot be read. */
export async function refreshSource(tenantId: string, userId: string, agentId: string, sourceId: string, deps: PageDeps = {}): Promise<SourceView> {
  await getAgent(tenantId, agentId);
  const source = await prisma.aiKnowledgeSource.findFirst({ where: { id: sourceId, agentId, tenantId } });
  if (!source) throw new HttpError(404, "Knowledge source not found.");
  if (source.kind !== "url" || !source.sourceUrl) throw new HttpError(400, "Only web pages can be refreshed. To change other knowledge, delete it and add it again.");
  const content = await pageText(source.sourceUrl, deps);
  await prisma.aiKnowledgeSource.updateMany({ where: { id: sourceId, agentId, tenantId }, data: { content, status: "ready" } });
  await audit({ tenantId, userId, action: "ai_agent.source_refresh", target: sourceId });
  return { id: source.id, kind: source.kind, title: source.title, sourceUrl: source.sourceUrl, status: "ready", chars: content.length, createdAt: source.createdAt };
}

export async function deleteSource(tenantId: string, userId: string, agentId: string, sourceId: string): Promise<void> {
  const result = await prisma.aiKnowledgeSource.deleteMany({ where: { id: sourceId, agentId, tenantId } });
  if (result.count === 0) throw new HttpError(404, "Knowledge source not found.");
  await audit({ tenantId, userId, action: "ai_agent.source_delete", target: sourceId });
}

export async function usageSummary(tenantId: string, now = new Date()) {
  const [used, limit, replies] = await Promise.all([
    usedThisMonth(tenantId, "ai_credits", now),
    effectiveCreditLimit(tenantId),
    prisma.usageLedger.count({
      where: { tenantId, meter: "ai_credits", refType: AI_REPLY_REF, createdAt: { gte: new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1)) } },
    }),
  ]);
  return { used, limit, remaining: Math.max(0, limit - used), replies };
}
