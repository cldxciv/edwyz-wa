import { markAiPaused, STOP_TAG as AI_STOP_TAG } from "@/lib/ai-agent/pause";
import { emitAttributeChanges, emitTagChanges } from "@/lib/automation/v2/emit";
import { prisma } from "@/lib/db";
import { emitEvent } from "@/lib/integrations/events";
import { contactOptedOutPayload } from "@/lib/integrations/payloads";
import { sendText, sendTemplateMessage } from "@/lib/inbox/service";
import { buildList, buildReplyButtons, INTERACTIVE_LIMITS, sendInteractive, type InteractiveOption } from "@/lib/inbox/interactive";
import { bodyText, cleanVariable, fillTemplate, variableCount } from "@/lib/inbox/template-vars";
import { isWithinServiceWindow } from "@/lib/inbox/window";
import { describeError } from "@/lib/safe-error";
import { mayReceive, optedOutSince, sendKindForCategory } from "@/lib/contacts/opt-out";
import { HttpError } from "@/lib/tenancy";
import { tenantMayRunBackground } from "@/lib/tenant-state";
import { backgroundGate } from "@/lib/tenant-lifecycle-state";
import { asRec } from "@/lib/webhooks/payload";
import type { Prisma } from "@/generated/prisma/client";
import { classifyWithAi, DEFAULT_ESCALATION_MESSAGE, detectEscalation, type EscalationSignal } from "./escalation";
import { parseSettings, TEAM_QUEUE, validateFlow, type BotSettings, type FlowDefinition, type FlowNode } from "./flow";
import { callWebhook } from "./http";
import { getSeams } from "./seams";
import { buildTemplateComponents as buildSharedTemplate } from "./template-build";
import { evaluateCondition, interpolate, resolveValue, validateAnswer, type VarContext } from "./vars";

export const MAX_STEPS_PER_RUN = 200;
export const MAX_BOT_MESSAGES_PER_MINUTE = 20;
export const SESSION_TTL_MS = 24 * 60 * 60 * 1000;
const RATE_WINDOW_MS = 60_000;
const OPTION_RETRIES = 2;
const BODY_MAX = 4096;

export type SessionRow = {
  id: string;
  tenantId: string;
  chatbotId: string;
  conversationId: string;
  contactId: string;
  status: string;
  currentNodeId: string | null;
  waitingNodeId: string | null;
  wakeAt: Date | null;
  variables: unknown;
  updatedAt: Date;
  startedAt?: Date;
};

type FinalStatus = "completed" | "handed_off" | "expired";
type Outcome = { kind: "next"; label?: string } | { kind: "wait" } | { kind: "sleep"; wakeAt: Date } | { kind: "finish"; status: FinalStatus };

type State = {
  session: SessionRow;
  flow: FlowDefinition;
  nodes: Map<string, FlowNode>;
  vars: Record<string, unknown>;
  /** optedOut and optedOutAt: the contact opted out of marketing (lib/contacts/opt-out.ts); optedOutAt is when, so a STOP sent during this session ends it. */
  contact: { id: string; name: string | null; phone: string | null; attributes: Record<string, unknown>; tags: string[]; optedOut: boolean; optedOutAt: Date | null; optIn: boolean };
  settings: BotSettings;
  phoneNumberId: string;
  wabaRefId: string | null;
  blocked: boolean;
  /** When the customer last wrote: free messages are allowed for 24 hours after it. */
  lastInboundAt: Date | null;
  /** Set when a wait ends after the 24-hour window closed: the first free message hands the chat over instead (see windowClosedNow). */
  windowClosed: boolean;
  steps: number;
};

/** Session variable naming the wait step the bot is sleeping in, so a customer message during the wait follows that step's setting. */
export const SLEEPING_AT = "__sleepingAt";

class StopRun extends Error {
  /** aborted: the session was ended from outside (teammate, block), so nothing else may run, not even a hand-over. */
  constructor(public status: FinalStatus, public aborted = false) {
    super("stop");
  }
}

/** Reads a published flow for running. Publish-only checks added later are skipped, so a bot that went live before them keeps working. */
export function parseFlow(value: unknown): FlowDefinition | null {
  const result = validateFlow(value, { published: true });
  return result.ok && result.flow ? result.flow : null;
}

const ctxOf = (s: State): VarContext => ({ variables: s.vars, contact: { name: s.contact.name, phone: s.contact.phone, attributes: s.contact.attributes } });
const text = (s: State, template: string) => interpolate(template, ctxOf(s)).slice(0, BODY_MAX);
const norm = (v: string) => v.normalize("NFKC").trim().toLowerCase();

async function loadState(session: SessionRow, flow: FlowDefinition): Promise<State | null> {
  const [contact, conversation] = await Promise.all([
    prisma.contact.findFirst({ where: { id: session.contactId, tenantId: session.tenantId } }),
    prisma.conversation.findFirst({ where: { id: session.conversationId, tenantId: session.tenantId }, select: { phoneNumberId: true, status: true, lastInboundAt: true, phoneNumber: { select: { wabaRefId: true } } } }),
  ]);
  if (!contact || !conversation) return null;
  return {
    session,
    flow,
    nodes: new Map(flow.nodes.map((n) => [n.id, n])),
    vars: { ...asRec(session.variables) },
    contact: {
      id: contact.id,
      name: contact.name,
      phone: contact.phone,
      attributes: { ...asRec(contact.attributes) },
      tags: contact.tags ?? [],
      optedOut: Boolean(contact.optedOutAt),
      optedOutAt: contact.optedOutAt ?? null,
      optIn: Boolean(contact.optIn),
    },
    settings: parseSettings(flow.settings),
    phoneNumberId: conversation.phoneNumberId,
    wabaRefId: conversation.phoneNumber?.wabaRefId ?? null,
    blocked: conversation.status === "blocked",
    lastInboundAt: conversation.lastInboundAt ?? null,
    windowClosed: false,
    steps: 0,
  };
}

async function save(s: State, data: Record<string, unknown>) {
  // Only a session that is still running is written: a teammate reply or an opt-out may have ended it while this run was working.
  await prisma.chatbotSession.updateMany({
    where: { id: s.session.id, tenantId: s.session.tenantId, status: "active" },
    data: { variables: s.vars as Prisma.InputJsonValue, ...data },
  });
}

async function finish(s: State, status: FinalStatus) {
  await save(s, { status, endedAt: new Date(), waitingNodeId: null, wakeAt: null });
}

export async function endSession(session: SessionRow, status: FinalStatus) {
  await prisma.chatbotSession.updateMany({
    where: { id: session.id, tenantId: session.tenantId, status: { in: ["active", "waiting"] } },
    data: { status, endedAt: new Date(), waitingNodeId: null, wakeAt: null },
  });
}

function recentSends(s: State, now: number): number[] {
  const list = Array.isArray(s.vars.__sent) ? (s.vars.__sent as unknown[]).filter((t): t is number => typeof t === "number") : [];
  return list.filter((t) => now - t < RATE_WINDOW_MS);
}

/**
 * Called before every message the bot sends. A teammate reply, an opt-out or a block may have ended the session (or blocked the chat)
 * while this run was working, and the run itself does not see that. Nothing is sent once the session is no longer running.
 */
async function assertStillRunning(s: State) {
  const { tenantId } = s.session;
  const [running, conversation] = await Promise.all([
    prisma.chatbotSession.findFirst({ where: { id: s.session.id, tenantId, status: "active" }, select: { id: true } }),
    prisma.conversation.findFirst({ where: { id: s.session.conversationId, tenantId }, select: { status: true } }),
  ]);
  if (!running) throw new StopRun("handed_off", true);
  if (conversation?.status === "blocked") throw new StopRun("expired", true);
}

function reserveSend(s: State) {
  // The bot answers the customer, which an opt-out never blocks (lib/contacts/opt-out.ts); a marketing template is refused in
  // sendTemplateNode. An opt-out made during this session (a STOP, or this bot's own Stop messages step) ends it: nothing more is sent.
  if (!mayReceive(s.contact, "service") || optedOutSince(s.contact, s.session.startedAt)) throw new StopRun("completed");
  const now = Date.now();
  const recent = recentSends(s, now);
  if (recent.length >= MAX_BOT_MESSAGES_PER_MINUTE) throw new StopRun("expired");
  s.vars.__sent = [...recent, now];
}

async function emit(s: State, body: string) {
  if (!body.trim()) return;
  await assertStillRunning(s);
  reserveSend(s);
  await sendText({ tenantId: s.session.tenantId, conversationId: s.session.conversationId, body, origin: "chatbot" });
}

function optionsText(lines: string[]) {
  return lines.map((line, i) => `${i + 1}. ${line}`).join("\n");
}

type Menu = { kind: "buttons" | "list"; body: string; items: InteractiveOption[]; buttonLabel?: string; header?: string; footer?: string };

/**
 * Sends the options as real WhatsApp reply buttons or a list. When the bot has interactive messages switched off, or the options
 * break a WhatsApp limit (for example two buttons with the same title), the same options go out as a numbered text message instead.
 */
async function emitMenu(s: State, menu: Menu) {
  const numbered = () => emit(s, `${menu.body}\n\n${optionsText(menu.items.map((i) => i.title))}`);
  if (!s.settings.interactive) return numbered();
  const body = menu.body.slice(0, INTERACTIVE_LIMITS.body);
  let interactive;
  try {
    interactive =
      menu.kind === "buttons"
        ? buildReplyButtons({ body, buttons: menu.items, header: menu.header, footer: menu.footer })
        : buildList({ body, buttonLabel: menu.buttonLabel ?? "Choose", rows: menu.items, header: menu.header, footer: menu.footer });
  } catch (error) {
    if (error instanceof HttpError && error.status === 400) return numbered();
    throw error;
  }
  await assertStillRunning(s);
  reserveSend(s);
  await sendInteractive({ tenantId: s.session.tenantId, conversationId: s.session.conversationId, interactive, origin: "chatbot" });
}

/** Short answer lists of a question become tap targets: up to 3 as buttons, up to 10 as a list, otherwise numbered text. */
function choiceMenu(choices: string[]): Pick<Menu, "kind" | "items"> | null {
  const titles = choices.map((c) => c.trim());
  const items = titles.map((title, i) => ({ id: `c${i + 1}`, title }));
  if (items.length >= 1 && items.length <= INTERACTIVE_LIMITS.buttons && titles.every((t) => t.length <= INTERACTIVE_LIMITS.buttonTitle)) return { kind: "buttons", items };
  if (items.length >= 1 && items.length <= INTERACTIVE_LIMITS.rows && titles.every((t) => t.length <= INTERACTIVE_LIMITS.rowTitle)) return { kind: "list", items };
  return null;
}

async function emitQuestion(s: State, body: string, choices: string[] | undefined) {
  const menu = choices?.length ? choiceMenu(choices) : null;
  if (menu) return emitMenu(s, { ...menu, body });
  await emit(s, choices?.length ? `${body}\n\n${optionsText(choices)}` : body);
}

function edgeTarget(s: State, nodeId: string, label?: string): string | null {
  const edge = s.flow.edges.find((e) => e.from === nodeId && (label === undefined ? !e.label : e.label === label));
  return edge?.to ?? null;
}

function hasEdge(s: State, nodeId: string, label: string) {
  return s.flow.edges.some((e) => e.from === nodeId && e.label === label);
}

type TemplateBuild = { components: unknown[] } | { error: string };

/** The step's values filled from saved answers, built by the shared template builder (also used by automation rules). */
function buildTemplateComponents(s: State, node: Extract<FlowNode, { type: "send_template" }>, templateComponents: unknown): TemplateBuild {
  const hasBody = Array.isArray(templateComponents) && templateComponents.some((c) => Boolean(c) && typeof c === "object" && String((c as { type?: unknown }).type).toUpperCase() === "BODY");
  const needed = variableCount(bodyText(templateComponents));
  const keys = Object.keys(node.data.variables).sort((a, b) => Number(a) - Number(b));
  const body = (hasBody ? keys.slice(0, needed) : keys).map((key) => cleanVariable(text(s, node.data.variables[key])).slice(0, 1024) || "-");
  const built = buildSharedTemplate(templateComponents, {
    header: text(s, node.data.headerVariable ?? ""),
    headerMediaUrl: interpolate(node.data.headerMediaUrl ?? "", ctxOf(s)),
    body,
    button: text(s, node.data.buttonVariable ?? ""),
  });
  // Problems are reported in the order of the template: the header, then the text values, then the button.
  if ("error" in built && built.error !== "missing_button_value") return built;
  if (keys.length < needed) return { error: "missing_variables" };
  return built;
}

/** Sends the approved template with its header, body and button values filled from saved answers. Returns an error code instead of throwing for problems the flow can route around. */
async function sendTemplateNode(s: State, node: Extract<FlowNode, { type: "send_template" }>): Promise<string | null> {
  // A template belongs to one WhatsApp Business account; the number this chat runs on must be in the same one, or Meta rejects the send.
  if (!s.wabaRefId) return "template_unavailable";
  const template = await prisma.template.findFirst({ where: { id: node.data.templateId, tenantId: s.session.tenantId, wabaRefId: s.wabaRefId, status: "approved" } });
  if (!template) return "template_unavailable";
  // An opt-out blocks marketing only: a utility or login-code template still goes to a contact who opted out.
  if (!mayReceive(s.contact, sendKindForCategory(template.category))) return "opted_out";
  if (template.category === "MARKETING" && !s.contact.optIn) return "no_opt_in";
  const built = buildTemplateComponents(s, node, template.components);
  if ("error" in built) return built.error;
  await assertStillRunning(s);
  reserveSend(s);
  let message;
  try {
    message = await sendTemplateMessage({
      tenantId: s.session.tenantId,
      phoneNumberId: s.phoneNumberId,
      contactId: s.contact.id,
      conversationId: s.session.conversationId,
      templateName: template.name,
      language: template.language,
      components: built.components,
      origin: "chatbot",
    });
  } catch (error) {
    if (error instanceof HttpError) return "template_rejected";
    throw error;
  }
  const values = node.data.variables;
  const rendered = fillTemplate(bodyText(template.components), Object.keys(values).sort((a, b) => Number(a) - Number(b)).map((k) => cleanVariable(text(s, values[k])))).slice(0, 4096);
  if (message?.id && rendered) await prisma.message.updateMany({ where: { id: message.id, tenantId: s.session.tenantId }, data: { body: rendered } });
  return null;
}

async function updateContact(s: State, data: { attributes?: Record<string, unknown>; tags?: string[] }, before: { attributes: Record<string, unknown>; tags: string[] }) {
  await prisma.contact.updateMany({
    where: { id: s.contact.id, tenantId: s.session.tenantId },
    data: { ...(data.attributes ? { attributes: data.attributes as Prisma.InputJsonValue } : {}), ...(data.tags ? { tags: data.tags } : {}) },
  });
  const base = { tenantId: s.session.tenantId, contactId: s.contact.id, conversationId: s.session.conversationId };
  if (data.tags) void emitTagChanges(base, before.tags, data.tags);
  if (data.attributes) void emitAttributeChanges(base, before.attributes, data.attributes);
}

function menuOf(s: State, node: Extract<FlowNode, { type: "send_buttons" | "send_list" }>): Menu {
  const header = node.data.header ? text(s, node.data.header).slice(0, INTERACTIVE_LIMITS.headerText) : undefined;
  const footer = node.data.footer ? text(s, node.data.footer).slice(0, INTERACTIVE_LIMITS.footer) : undefined;
  const body = text(s, node.data.text);
  if (node.type === "send_buttons") return { kind: "buttons", body, items: node.data.buttons, header, footer };
  return { kind: "list", body, items: node.data.rows, buttonLabel: node.data.buttonLabel, header, footer };
}

/** Notes when the chat was last assigned by this bot's own step, so a later check can tell that apart from a teammate taking the chat. */
async function rememberOwnAssignment(s: State) {
  const row = await prisma.conversation.findFirst({ where: { id: s.session.conversationId, tenantId: s.session.tenantId }, select: { assignedAt: true } });
  if (row?.assignedAt) s.vars.__assignedAt = row.assignedAt.toISOString();
}

const REASON_TEXT: Record<string, string> = {
  human_request: "The customer asked to talk to a person.",
  frustration: "The customer seemed frustrated.",
};

function summaryNote(s: State, reason: string): string {
  const lines = Object.entries(s.vars)
    .filter(([key, value]) => !key.startsWith("__") && key !== "last_reply" && key !== "trigger_message" && value !== "" && value !== null && typeof value !== "object")
    .slice(0, 12)
    .map(([key, value]) => `${key}: ${String(value).slice(0, 200)}`);
  return `Chatbot hand-over. ${reason}${lines.length ? `\nWhat the bot collected:\n${lines.join("\n")}` : ""}`.slice(0, 1800);
}

/**
 * Passes the chat to people: marks it open, gives it to the chosen team or teammate (or lets routing pick), pauses the AI agent so
 * the two never answer together, and leaves a private note with what the bot collected. Problems here never strand the customer.
 */
async function handOver(s: State, opts: { teamId?: string; userId?: string; note: boolean; reason: string }) {
  const { tenantId, conversationId } = s.session;
  const seams = getSeams();
  const queueOnly = Boolean(opts.teamId) && opts.userId === TEAM_QUEUE;
  // A blocked chat stays blocked and a session a teammate already ended hands over nothing: the bot never reopens a chat or routes it.
  await assertStillRunning(s);
  await seams.setStatus(tenantId, conversationId, "open");
  try {
    if (opts.teamId) await seams.assignTeam(tenantId, conversationId, opts.teamId, queueOnly ? null : opts.userId || "round_robin");
    else if (opts.userId && opts.userId !== TEAM_QUEUE) await seams.assign(tenantId, conversationId, opts.userId);
  } catch {
    // an unknown team or teammate must not stop the hand-over
  }
  await seams.handoff(tenantId, conversationId, { queueOnly });
  try {
    const conversation = await prisma.conversation.findFirst({ where: { id: conversationId, tenantId }, select: { tags: true } });
    const tags = Array.isArray(conversation?.tags) ? conversation.tags : [];
    if (conversation && !tags.includes(AI_STOP_TAG)) await prisma.conversation.updateMany({ where: { id: conversationId, tenantId }, data: { tags: [...tags, AI_STOP_TAG] } });
    // Dated even when the chat was paused already: this hand-over starts the pause again, for this episode of the chat.
    if (conversation) await markAiPaused(tenantId, conversationId);
    if (opts.note) await prisma.note.create({ data: { tenantId, conversationId, authorId: "chatbot", body: summaryNote(s, opts.reason) } });
  } catch (error) {
    console.error("[chatbot] hand-over details could not be saved:", describeError(error));
  }
}

async function escalate(s: State, signal: EscalationSignal) {
  const esc = s.settings.escalation;
  s.vars.escalation_reason = signal.kind;
  s.vars.escalation_source = signal.source;
  try {
    await emit(s, text(s, esc.message ?? DEFAULT_ESCALATION_MESSAGE));
  } catch (error) {
    if (error instanceof StopRun && error.aborted) throw error;
    if (!(error instanceof StopRun)) console.error("[chatbot] escalation message failed:", describeError(error));
  }
  await handOver(s, { teamId: esc.teamId, userId: esc.userId, note: true, reason: REASON_TEXT[signal.kind] });
  await finish(s, "handed_off");
}

const WINDOW_CLOSED_REASON = "The 24-hour window closed while the chatbot was waiting, so it could not send its next message. Send an approved template to reach the customer.";

/** The bot's next message is a free one, but the 24-hour window closed during a wait, so WhatsApp would refuse it: the team takes the chat, with a note. */
async function handOverClosedWindow(s: State): Promise<Outcome> {
  await handOver(s, { note: true, reason: WINDOW_CLOSED_REASON });
  return { kind: "finish", status: "handed_off" };
}

const AI_MIN_WORDS = 4;
const wordsIn = (text: string) => text.split(/\s+/).filter(Boolean).length;

type EscalationContext = {
  /** The reply fits what the question asked for (an offered option, a valid email, any text for an unchecked question). */
  fits: boolean;
  /** The reply is one of the offered options, so it is never read as a request for a person. */
  offeredChoice: boolean;
  /** The question accepts any text, so every reply fits and the words themselves are the only sign of frustration. */
  freeText: boolean;
};

/**
 * Smart escalation. A clear request for a person always escalates (unless the reply is one of the offered choices). Frustration
 * words and shouting count in every reply that is not an offered choice, including answers to free-text questions, where every
 * reply "fits". Single words such as "agent" only count when the reply did not fit the question. The optional AI check reads a reply
 * that did not fit, and a free-text answer of a few words, when no keyword matched.
 */
async function maybeEscalate(s: State, reply: string, ctx: EscalationContext): Promise<boolean> {
  const esc = s.settings.escalation;
  if (!esc.enabled || ctx.offeredChoice) return false;
  let signal = detectEscalation(reply, { keywords: esc.keywords, loose: !ctx.fits, frustration: true });
  if (!signal && esc.useAi && (!ctx.fits || (ctx.freeText && wordsIn(reply) >= AI_MIN_WORDS))) signal = await classifyWithAi(s.session.tenantId, reply);
  if (!signal) return false;
  await escalate(s, signal);
  return true;
}

/** Records the customer's agreement to receive marketing, with a note of where it was given. A contact who sent STOP stays opted out. */
async function subscribeContact(s: State, source: string | undefined) {
  if (s.contact.optedOut) return;
  // Already opted in: keep the source and time of the first consent rather than overwriting the proof.
  if (s.contact.optIn) return;
  const { tenantId } = s.session;
  const note = (source?.trim() || "Chatbot").slice(0, 100);
  await prisma.contact.updateMany({ where: { id: s.contact.id, tenantId, optedOutAt: null }, data: { optIn: true, optInSource: note, optInAt: new Date() } });
  s.contact.optIn = true;
  await prisma.auditLog.create({ data: { tenantId, action: "contact.consent_recorded", target: s.contact.id, meta: { source: note, via: "chatbot" } } });
}

/** Opts the contact out of marketing the way a STOP reply does (lib/contacts/opt-out.ts): no marketing template, broadcast or follow-up reaches them again. */
async function unsubscribeContact(s: State) {
  const { tenantId } = s.session;
  const optedOutAt = new Date();
  const before = await prisma.contact.findFirst({ where: { id: s.contact.id, tenantId }, select: { id: true, phone: true, bsuid: true, waId: true, username: true, name: true, optedOutAt: true } });
  await prisma.contact.updateMany({ where: { id: s.contact.id, tenantId }, data: { optedOutAt: before?.optedOutAt ?? optedOutAt, optIn: false } });
  s.contact.optedOut = true;
  s.contact.optedOutAt = optedOutAt;
  await prisma.auditLog.create({ data: { tenantId, action: "contact.opted_out", target: s.contact.id, meta: { via: "chatbot", source: "Chatbot unsubscribe step" } } });
  // Tell subscribed integrations once; a contact who had already opted out is not announced again. Never let a webhook failure break the flow.
  if (before && !before.optedOutAt) {
    try {
      await emitEvent(tenantId, "contact.opted_out", contactOptedOutPayload({ contact: before, optedOutAt, source: "chatbot" }));
    } catch (error) {
      console.error("[chatbot] opt-out event could not be queued:", describeError(error));
    }
  }
}

async function runWebhook(s: State, node: Extract<FlowNode, { type: "webhook" }>): Promise<Outcome> {
  const body = node.data.method === "POST" ? interpolate(node.data.bodyTemplate ?? "{}", ctxOf(s), { json: true }) : undefined;
  const result = await callWebhook({ url: node.data.url, method: node.data.method, body });
  s.vars.webhook_status = result.status;
  if (result.ok && node.data.saveAs) s.vars[node.data.saveAs] = result.data;
  return !result.ok && hasEdge(s, node.id, "error") ? { kind: "next", label: "error" } : { kind: "next" };
}

async function runNode(s: State, node: FlowNode): Promise<Outcome> {
  const tenantId = s.session.tenantId;
  const conversationId = s.session.conversationId;
  // After a wait that outlived the 24-hour window, steps that send nothing and templates run as usual; the first free message
  // hands over instead, and a hand-over or Stop messages step does its job without its own message.
  switch (node.type) {
    case "send_text": {
      const body = text(s, node.data.text);
      if (s.windowClosed && body.trim()) return handOverClosedWindow(s);
      await emit(s, body);
      return { kind: "next" };
    }
    case "send_buttons":
    case "send_list": {
      if (s.windowClosed) return handOverClosedWindow(s);
      await emitMenu(s, menuOf(s, node));
      s.vars.__retries = 0;
      return { kind: "wait" };
    }
    case "send_template": {
      const failure = await sendTemplateNode(s, node);
      s.vars.template_error = failure ?? "";
      return failure && hasEdge(s, node.id, "error") ? { kind: "next", label: "error" } : { kind: "next" };
    }
    case "ask": {
      if (s.windowClosed) return handOverClosedWindow(s);
      await emitQuestion(s, text(s, node.data.text), node.data.choices);
      s.vars.__retries = 0;
      return { kind: "wait" };
    }
    case "condition": {
      const expected = node.data.value === undefined ? undefined : interpolate(node.data.value, ctxOf(s));
      return { kind: "next", label: evaluateCondition(node.data.operator, resolveValue(node.data.variable, ctxOf(s)), expected) ? "yes" : "no" };
    }
    case "set_attribute": {
      const beforeAttributes = { ...s.contact.attributes };
      s.contact.attributes[node.data.attribute] = text(s, node.data.value).slice(0, 512);
      await updateContact(s, { attributes: s.contact.attributes }, { attributes: beforeAttributes, tags: s.contact.tags });
      return { kind: "next" };
    }
    case "add_tag":
    case "remove_tag": {
      const tag = text(s, node.data.tag).trim().slice(0, 64);
      const tags = node.type === "add_tag" ? [...new Set([...s.contact.tags, tag])] : s.contact.tags.filter((t) => t !== tag);
      if (tag) await updateContact(s, { tags }, { attributes: s.contact.attributes, tags: s.contact.tags });
      s.contact.tags = tags;
      return { kind: "next" };
    }
    case "delay": {
      const wakeAt = new Date(Date.now() + node.data.minutes * 60_000);
      return { kind: "sleep", wakeAt };
    }
    case "webhook":
      return runWebhook(s, node);
    case "assign":
      try {
        if (node.data.teamId) await getSeams().assignTeam(tenantId, conversationId, node.data.teamId, node.data.userId || null);
        else await getSeams().assign(tenantId, conversationId, node.data.userId);
      } catch {
        // an unknown assignee or team must not stop the conversation
      }
      await rememberOwnAssignment(s);
      return { kind: "next" };
    case "set_status":
      await getSeams().setStatus(tenantId, conversationId, node.data.status);
      return { kind: "next" };
    case "handoff": {
      const unsent = Boolean(node.data.message) && s.windowClosed;
      if (node.data.message && !unsent) await emit(s, text(s, node.data.message));
      const reason = unsent ? "The chatbot reached a hand-over step. Its message was not sent because the 24-hour window had closed." : "The chatbot reached a hand-over step.";
      await handOver(s, { teamId: node.data.teamId, userId: node.data.userId, note: node.data.note !== false, reason });
      return { kind: "finish", status: "handed_off" };
    }
    case "subscribe":
      await subscribeContact(s, node.data.source);
      return { kind: "next" };
    case "unsubscribe":
      if (node.data.message && !s.windowClosed) await emit(s, text(s, node.data.message));
      await unsubscribeContact(s);
      return { kind: "finish", status: "completed" };
    case "end":
      return { kind: "finish", status: "completed" };
  }
}

/** Runs nodes from startId until the flow waits, sleeps, or ends. Never throws: failures end the session as expired. */
export async function execute(s: State, startId: string | null): Promise<void> {
  try {
    let nodeId = startId;
    while (nodeId) {
      if (++s.steps > MAX_STEPS_PER_RUN) throw new StopRun("expired");
      const node = s.nodes.get(nodeId);
      if (!node) break;
      const outcome = await runNode(s, node);
      if (outcome.kind === "finish") return await finish(s, outcome.status);
      if (outcome.kind === "wait") return await save(s, { status: "waiting", currentNodeId: node.id, waitingNodeId: node.id, wakeAt: null });
      const next = edgeTarget(s, node.id, outcome.kind === "next" ? outcome.label : undefined);
      if (outcome.kind === "sleep") {
        if (!next) break;
        s.vars[SLEEPING_AT] = node.id;
        return await save(s, { status: "active", currentNodeId: next, waitingNodeId: null, wakeAt: outcome.wakeAt });
      }
      nodeId = next;
      s.session.currentNodeId = nodeId;
    }
    await finish(s, "completed");
  } catch (error) {
    if (!(error instanceof StopRun)) console.error("[chatbot] run failed:", describeError(error));
    await finish(s, error instanceof StopRun ? error.status : "expired").catch(() => undefined);
  }
}

function matchOption(node: FlowNode, reply: string, replyId?: string): { id: string; title: string } | null {
  const items = node.type === "send_buttons" ? node.data.buttons : node.type === "send_list" ? node.data.rows : [];
  if (replyId) {
    const tapped = items.find((i) => i.id === replyId);
    if (tapped) return tapped;
  }
  const raw = reply.trim();
  const byId = items.find((i) => i.id === raw);
  if (byId) return byId;
  const byTitle = items.find((i) => norm(i.title) === norm(raw));
  if (byTitle) return byTitle;
  const index = /^\d{1,2}$/.test(raw) ? Number(raw) - 1 : -1;
  return index >= 0 && index < items.length ? items[index] : null;
}

const FALLBACK_TEXT = "Please reply with one of the options.";

async function reprompt(s: State, node: FlowNode, retryText: string | undefined) {
  s.vars.__retries = (Number(s.vars.__retries) || 0) + 1;
  const base = retryText ? text(s, retryText) : node.type === "ask" ? text(s, node.data.text) : text(s, s.settings.fallbackText ?? FALLBACK_TEXT);
  if (node.type === "send_buttons" || node.type === "send_list") await emitMenu(s, { ...menuOf(s, node), body: base, header: undefined, footer: undefined });
  else if (node.type === "ask") await emitQuestion(s, base, node.data.choices);
  else await emit(s, base);
  await save(s, { status: "waiting", waitingNodeId: node.id, currentNodeId: node.id });
}

async function resumeWaiting(s: State, node: FlowNode, reply: string, replyId?: string): Promise<void> {
  const retries = Number(s.vars.__retries) || 0;
  s.vars.last_reply = reply.slice(0, 1024);
  try {
    if (node.type === "ask") {
      const answer = validateAnswer(node.data.validate, reply, node.data.choices);
      if (await maybeEscalate(s, reply, { fits: answer.ok, offeredChoice: answer.ok && node.data.validate === "choice", freeText: node.data.validate === "text" })) return;
      if (answer.ok) {
        s.vars[node.data.variable] = answer.value;
        return await execute(s, edgeTarget(s, node.id));
      }
      if (retries < node.data.maxRetries) return await reprompt(s, node, node.data.retryText);
      return await execute(s, edgeTarget(s, node.id, "invalid"));
    }
    const match = matchOption(node, reply, replyId);
    if (await maybeEscalate(s, reply, { fits: Boolean(match), offeredChoice: Boolean(match), freeText: false })) return;
    if (match) {
      s.vars.last_choice = match.id;
      s.vars.last_choice_title = match.title;
      return await execute(s, edgeTarget(s, node.id, match.id));
    }
    if (retries < OPTION_RETRIES) return await reprompt(s, node, undefined);
    return await execute(s, edgeTarget(s, node.id, "default"));
  } catch (error) {
    if (!(error instanceof StopRun)) console.error("[chatbot] resume failed:", describeError(error));
    await finish(s, error instanceof StopRun ? error.status : "expired").catch(() => undefined);
  }
}

/**
 * True when a person has taken over the chat since the session started and the bot is set to step aside then: a teammate wrote in
 * it, or the chat was given to a teammate by someone other than this bot (a person, routing or a rule).
 */
export async function stepsAsideForHuman(session: SessionRow, flow: FlowDefinition): Promise<boolean> {
  if (!session.startedAt || !parseSettings(flow.settings).stopOnHumanReply) return false;
  const human = await prisma.message.findFirst({
    where: { tenantId: session.tenantId, conversationId: session.conversationId, direction: "outbound", sentByUserId: { not: null }, createdAt: { gt: session.startedAt } },
    select: { id: true },
  });
  if (human) return true;
  const chat = await prisma.conversation.findFirst({ where: { id: session.conversationId, tenantId: session.tenantId }, select: { assignedToId: true, assignedAt: true } });
  if (!chat?.assignedToId || !chat.assignedAt || chat.assignedAt.getTime() <= session.startedAt.getTime()) return false;
  return asRec(session.variables).__assignedAt !== chat.assignedAt.toISOString();
}

/** Claims a waiting session (so a double delivery cannot run it twice) and feeds it the customer's reply. */
export async function resumeSession(session: SessionRow, flow: FlowDefinition, reply: string, replyId?: string): Promise<boolean> {
  // A reply to an inbound message of a confirmed suspended, deleted or locked workspace is not answered (agents are read-only
  // there). Answering would only queue a message that waits in the send queue and goes out stale, in a burst, after payment.
  // The session is not claimed: it stays waiting and expires normally. An unconfirmed state (a failed read) does not block.
  if ((await backgroundGate(session.tenantId)) === "blocked") return true;
  if (await stepsAsideForHuman(session, flow)) {
    await endSession(session, "handed_off");
    return false;
  }
  const claim = await prisma.chatbotSession.updateMany({
    where: { id: session.id, tenantId: session.tenantId, status: "waiting", updatedAt: session.updatedAt },
    data: { status: "active", waitingNodeId: null },
  });
  if (claim.count === 0) return true;
  const state = await loadState(session, flow);
  if (state && (!mayReceive(state.contact, "service") || optedOutSince(state.contact, session.startedAt))) {
    await endSession({ ...session, status: "active" }, "completed");
    return false;
  }
  if (state?.blocked) {
    await endSession({ ...session, status: "active" }, "expired");
    return false;
  }
  const node = session.waitingNodeId ? state?.nodes.get(session.waitingNodeId) : undefined;
  if (!state || !node) {
    // The step the customer was answering is gone (the bot was republished without it). The session ends, and the message is
    // not reported as handled: it goes on to the AI agent, routing and rules instead of getting no answer at all.
    await endSession({ ...session, status: "active" }, "completed");
    return false;
  }
  await resumeWaiting(state, node, reply, replyId);
  return true;
}

/**
 * The 24-hour window closed while this session ran: the customer was writing when it started or when this wait began, and is not
 * now. Its next free message would be refused, so the bot hands the chat over at that step instead of ending silently (see
 * runNode). A bot that a rule started on a customer whose window was already closed runs its steps as before.
 */
function windowClosedNow(s: State, session: SessionRow, now: Date): boolean {
  if (isWithinServiceWindow(s.lastInboundAt, now)) return false;
  return isWithinServiceWindow(s.lastInboundAt, session.startedAt ?? session.updatedAt) || isWithinServiceWindow(s.lastInboundAt, session.updatedAt);
}

/**
 * Continues a session whose delay has elapsed, or (with `reply`) a sleeping session the customer wrote to, when its wait step says
 * to go on at once. Returns false when another process already claimed it, or when the workspace is suspended, deleted or
 * billing-locked: then nothing is claimed or sent and the session keeps its wake time (see resumeDelayedSessions, which pushes it
 * back instead of dropping it).
 */
export async function wakeSession(session: SessionRow, flow: FlowDefinition, opts: { reply?: string } = {}): Promise<boolean> {
  if (!session.wakeAt) return false;
  if (!(await tenantMayRunBackground(session.tenantId))) return false;
  if (await stepsAsideForHuman(session, flow)) {
    await endSession(session, "handed_off");
    return true;
  }
  const claim = await prisma.chatbotSession.updateMany({
    where: { id: session.id, tenantId: session.tenantId, status: "active", wakeAt: session.wakeAt },
    data: { wakeAt: null },
  });
  if (claim.count === 0) return false;
  const state = await loadState(session, flow);
  if (!state) {
    await endSession(session, "expired");
    return true;
  }
  if (!mayReceive(state.contact, "service") || optedOutSince(state.contact, session.startedAt)) {
    await endSession(session, "completed");
    return true;
  }
  if (state.blocked) {
    await endSession(session, "expired");
    return true;
  }
  delete state.vars[SLEEPING_AT];
  if (opts.reply !== undefined) state.vars.last_reply = opts.reply.slice(0, 1024);
  state.windowClosed = windowClosedNow(state, session, new Date());
  await execute(state, session.currentNodeId);
  return true;
}

/** The wait step a sleeping session is in: the one it noted when it fell asleep, or (for older sessions) the wait that leads to its next step. */
export function sleepingStep(session: Pick<SessionRow, "variables" | "currentNodeId">, flow: FlowDefinition): Extract<FlowNode, { type: "delay" }> | null {
  const noted = asRec(session.variables)[SLEEPING_AT];
  const byNote = typeof noted === "string" ? flow.nodes.find((n) => n.id === noted) : undefined;
  if (byNote?.type === "delay") return byNote;
  const edge = flow.edges.find((e) => !e.label && e.to === session.currentNodeId && flow.nodes.find((n) => n.id === e.from)?.type === "delay");
  const node = edge ? flow.nodes.find((n) => n.id === edge.from) : undefined;
  return node?.type === "delay" ? node : null;
}

export async function beginSession(session: SessionRow, flow: FlowDefinition, triggerText: string): Promise<void> {
  // See resumeSession: no bot reply is created for a confirmed blocked workspace, so nothing stale waits in the send queue.
  if ((await backgroundGate(session.tenantId)) === "blocked") return endSession(session, "expired");
  const state = await loadState(session, flow);
  if (!state) return endSession(session, "expired");
  if (triggerText) state.vars.trigger_message = triggerText.slice(0, 1024);
  await execute(state, flow.start);
}
