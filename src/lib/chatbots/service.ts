import { prisma } from "@/lib/db";
import type { Prisma } from "@/generated/prisma/client";
import { conversationScopeFor, maskContact, shouldMaskFor, visibleConversationIds } from "@/lib/teams/visibility";
import { HttpError, type Actor } from "@/lib/tenancy";
import { FLOW_LIMITS, parseSettings, validateFlow, type FlowValidation } from "./flow";

export const TRIGGER_TYPES = ["keyword", "first_message", "any_message", "manual"] as const;
export const SESSION_STATUSES = ["active", "waiting", "completed", "handed_off", "expired"] as const;
export const MAX_CHATBOTS_PER_TENANT = 50;
export const FLOW_BODY_LIMIT = 512 * 1024;

type Rec = Record<string, unknown>;

export const STARTER_FLOW = {
  version: 1,
  start: "start",
  nodes: [{ id: "start", type: "send_text", position: { x: 0, y: 0 }, data: { text: "Hi {{contact.name}}, how can we help?" } }],
  edges: [],
};

const SUMMARY = {
  id: true,
  name: true,
  status: true,
  triggerType: true,
  triggerKeywords: true,
  phoneNumberId: true,
  version: true,
  createdAt: true,
  updatedAt: true,
} as const;

function name(body: Rec): string | undefined {
  if (body.name === undefined) return undefined;
  if (typeof body.name !== "string" || !body.name.trim() || body.name.length > 100) throw new HttpError(400, "Name is required and must be at most 100 characters.");
  return body.name.trim();
}

function trigger(body: Rec): string | undefined {
  if (body.triggerType === undefined) return undefined;
  if (typeof body.triggerType !== "string" || !(TRIGGER_TYPES as readonly string[]).includes(body.triggerType)) throw new HttpError(400, `triggerType must be one of ${TRIGGER_TYPES.join(", ")}.`);
  return body.triggerType;
}

function keywords(body: Rec): string[] | undefined {
  if (body.triggerKeywords === undefined) return undefined;
  const list = body.triggerKeywords;
  if (!Array.isArray(list) || list.length > 20 || list.some((k) => typeof k !== "string" || !k.trim() || k.length > 64)) {
    throw new HttpError(400, "triggerKeywords must be up to 20 keywords of at most 64 characters.");
  }
  return [...new Set((list as string[]).map((k) => k.trim()))];
}

async function phoneNumber(tenantId: string, body: Rec): Promise<string | null | undefined> {
  if (body.phoneNumberId === undefined) return undefined;
  if (body.phoneNumberId === null) return null;
  if (typeof body.phoneNumberId !== "string") throw new HttpError(400, "phoneNumberId is invalid.");
  const found = await prisma.phoneNumber.findFirst({ where: { id: body.phoneNumberId, tenantId }, select: { id: true } });
  if (!found) throw new HttpError(400, "That phone number is not in this workspace.");
  return found.id;
}

/** Drafts may be incomplete; only the shape and size limits are enforced until publish. */
function draftFlow(value: unknown): Prisma.InputJsonValue {
  const flow = value as Rec;
  if (!flow || typeof flow !== "object" || Array.isArray(flow)) throw new HttpError(400, "flow must be an object.");
  if (!Array.isArray(flow.nodes) || flow.nodes.length > FLOW_LIMITS.nodes) throw new HttpError(400, `A flow can have at most ${FLOW_LIMITS.nodes} steps.`);
  if (flow.edges !== undefined && (!Array.isArray(flow.edges) || flow.edges.length > FLOW_LIMITS.edges)) throw new HttpError(400, `A flow can have at most ${FLOW_LIMITS.edges} connections.`);
  const settings = flow.settings === undefined ? undefined : parseSettings(flow.settings, (message) => { throw new HttpError(400, message); });
  return { version: 1, start: typeof flow.start === "string" ? flow.start : "", nodes: flow.nodes, edges: flow.edges ?? [], ...(settings ? { settings } : {}) } as unknown as Prisma.InputJsonValue;
}

export async function listChatbots(tenantId: string) {
  return prisma.chatbot.findMany({ where: { tenantId }, select: SUMMARY, orderBy: { updatedAt: "desc" }, take: 200 });
}

export async function getChatbot(tenantId: string, id: string) {
  const chatbot = await prisma.chatbot.findFirst({ where: { id, tenantId } });
  if (!chatbot) throw new HttpError(404, "Chatbot not found.");
  return chatbot;
}

function redactFlow(flow: unknown): unknown {
  if (!flow || typeof flow !== "object" || !Array.isArray((flow as Rec).nodes)) return flow;
  const nodes = ((flow as Rec).nodes as Rec[]).map((n) => (n && n.type === "webhook" ? { ...n, data: { method: (n.data as Rec | undefined)?.method, url: "", hidden: true } } : n));
  return { ...(flow as Rec), nodes };
}

/** What a teammate who is not an admin may see of a chatbot: the flow without webhook addresses, bodies and saved-reply names. */
export function redactForViewer<T extends { flow?: unknown; publishedFlow?: unknown }>(chatbot: T): T {
  return { ...chatbot, flow: redactFlow(chatbot.flow), publishedFlow: redactFlow(chatbot.publishedFlow) };
}

export async function createChatbot(tenantId: string, userId: string, body: Rec) {
  if ((await prisma.chatbot.count({ where: { tenantId, status: { not: "archived" } } })) >= MAX_CHATBOTS_PER_TENANT) {
    throw new HttpError(409, `A workspace can have at most ${MAX_CHATBOTS_PER_TENANT} chatbots.`);
  }
  const botName = name(body);
  if (!botName) throw new HttpError(400, "Name is required.");
  const triggerType = trigger(body) ?? "keyword";
  const triggerKeywords = keywords(body) ?? [];
  return prisma.chatbot.create({
    data: {
      tenantId,
      name: botName,
      triggerType,
      triggerKeywords,
      phoneNumberId: (await phoneNumber(tenantId, body)) ?? null,
      flow: body.flow === undefined ? (STARTER_FLOW as Prisma.InputJsonValue) : draftFlow(body.flow),
      createdByUserId: userId,
    },
  });
}

export async function updateChatbot(tenantId: string, id: string, body: Rec) {
  await getChatbot(tenantId, id);
  const data: Prisma.ChatbotUpdateManyMutationInput & { phoneNumberId?: string | null } = {};
  const botName = name(body);
  if (botName !== undefined) data.name = botName;
  const triggerType = trigger(body);
  if (triggerType !== undefined) data.triggerType = triggerType;
  const triggerKeywords = keywords(body);
  if (triggerKeywords !== undefined) data.triggerKeywords = triggerKeywords;
  const phone = await phoneNumber(tenantId, body);
  if (phone !== undefined) data.phoneNumberId = phone;
  if (body.flow !== undefined) data.flow = draftFlow(body.flow);
  await prisma.chatbot.updateMany({ where: { id, tenantId, status: { not: "archived" } }, data });
  return getChatbot(tenantId, id);
}

async function expireSessions(tenantId: string, chatbotId: string) {
  await prisma.chatbotSession.updateMany({
    where: { tenantId, chatbotId, status: { in: ["active", "waiting"] } },
    data: { status: "expired", endedAt: new Date(), waitingNodeId: null, wakeAt: null },
  });
}

export async function deleteChatbot(tenantId: string, id: string) {
  const { count } = await prisma.chatbot.deleteMany({ where: { id, tenantId } });
  if (count === 0) throw new HttpError(404, "Chatbot not found.");
}

export class FlowInvalidError extends HttpError {
  constructor(public validation: FlowValidation) {
    super(422, "The flow has problems that must be fixed before publishing.");
  }
}

function referencedTeamIds(flow: NonNullable<FlowValidation["flow"]>): string[] {
  const ids = new Set<string>();
  if (flow.settings?.escalation.teamId) ids.add(flow.settings.escalation.teamId);
  for (const node of flow.nodes) if ((node.type === "assign" || node.type === "handoff") && node.data.teamId) ids.add(node.data.teamId);
  return [...ids];
}

/** A team that was deleted after the flow was built would silently drop the hand-over, so publishing stops until it is replaced. */
async function checkTeams(tenantId: string, flow: NonNullable<FlowValidation["flow"]>): Promise<FlowValidation | null> {
  const wanted = referencedTeamIds(flow);
  if (wanted.length === 0) return null;
  const found = await prisma.team.findMany({ where: { tenantId, id: { in: wanted } }, select: { id: true } });
  const known = new Set(found.map((t) => t.id));
  const missing = wanted.filter((id) => !known.has(id));
  if (missing.length === 0) return null;
  return { ok: false, errors: [{ message: "A team used in this chatbot no longer exists. Choose another team in the hand-over settings." }], warnings: [] };
}

export async function publishChatbot(tenantId: string, id: string) {
  const chatbot = await getChatbot(tenantId, id);
  if (chatbot.status === "archived") throw new HttpError(409, "Archived chatbots cannot be published. Duplicate it instead.");
  if (chatbot.triggerType === "keyword" && chatbot.triggerKeywords.length === 0) {
    throw new HttpError(422, "Add at least one trigger keyword before publishing.");
  }
  const validation = validateFlow(chatbot.flow);
  if (!validation.ok || !validation.flow) throw new FlowInvalidError(validation);
  const teamProblem = await checkTeams(tenantId, validation.flow);
  if (teamProblem) throw new FlowInvalidError(teamProblem);
  await prisma.chatbot.updateMany({
    where: { id, tenantId },
    data: { publishedFlow: validation.flow as unknown as Prisma.InputJsonValue, status: "published", version: chatbot.version + 1 },
  });
  return { chatbot: await getChatbot(tenantId, id), warnings: validation.warnings };
}

export async function unpublishChatbot(tenantId: string, id: string) {
  const chatbot = await getChatbot(tenantId, id);
  if (chatbot.status === "archived") throw new HttpError(409, "This chatbot is archived.");
  await prisma.chatbot.updateMany({ where: { id, tenantId }, data: { status: "draft" } });
  await expireSessions(tenantId, id);
  return getChatbot(tenantId, id);
}

export async function archiveChatbot(tenantId: string, id: string) {
  await getChatbot(tenantId, id);
  await prisma.chatbot.updateMany({ where: { id, tenantId }, data: { status: "archived" } });
  await expireSessions(tenantId, id);
  return getChatbot(tenantId, id);
}

export async function duplicateChatbot(tenantId: string, userId: string, id: string) {
  const source = await getChatbot(tenantId, id);
  if ((await prisma.chatbot.count({ where: { tenantId, status: { not: "archived" } } })) >= MAX_CHATBOTS_PER_TENANT) {
    throw new HttpError(409, `A workspace can have at most ${MAX_CHATBOTS_PER_TENANT} chatbots.`);
  }
  return prisma.chatbot.create({
    data: {
      tenantId,
      name: `${source.name} (copy)`.slice(0, 100),
      triggerType: source.triggerType,
      triggerKeywords: source.triggerKeywords,
      phoneNumberId: source.phoneNumberId,
      flow: source.flow as Prisma.InputJsonValue,
      createdByUserId: userId,
    },
  });
}

/** Dry validation of the posted flow, or of the saved draft when none is posted. Sends nothing and calls nothing. */
export async function testRunChatbot(tenantId: string, id: string, body: Rec) {
  const chatbot = await getChatbot(tenantId, id);
  const result = validateFlow(body.flow === undefined ? chatbot.flow : body.flow);
  return { ok: result.ok, errors: result.errors, warnings: result.warnings, nodeCount: result.flow?.nodes.length ?? 0 };
}

type SessionParams = { status?: string; cursor?: string; limit?: number };
type SessionViewer = Pick<Actor, "tenantId" | "userId" | "role">;
const SESSION_SELECT = { id: true, conversationId: true, contactId: true, status: true, currentNodeId: true, waitingNodeId: true, wakeAt: true, startedAt: true, updatedAt: true, endedAt: true } as const;
const MAX_SCAN_PAGES = 5;

/**
 * Sessions of one chatbot, newest first. With a viewer, only sessions of chats that person may see are returned (the same team and
 * assigned-only rules as the inbox) and phone numbers are masked when the inbox masks them. The page is filled by scanning a few
 * pages ahead, so a restricted viewer still gets a full page when most sessions belong to other teams.
 */
export async function listSessions(tenantId: string, chatbotId: string, params: SessionParams, viewer?: SessionViewer) {
  await getChatbot(tenantId, chatbotId);
  if (params.status && !(SESSION_STATUSES as readonly string[]).includes(params.status)) throw new HttpError(400, "Invalid status filter.");
  const limit = Math.min(Math.max(Math.trunc(params.limit ?? 30), 1), 100);
  const scope = viewer ? await conversationScopeFor(viewer) : null;
  const mask = viewer ? await shouldMaskFor(viewer) : false;
  const where = { tenantId, chatbotId, ...(params.status ? { status: params.status as (typeof SESSION_STATUSES)[number] } : {}) };
  let cursor = params.cursor && (await prisma.chatbotSession.findFirst({ where: { id: params.cursor, tenantId, chatbotId }, select: { id: true } })) ? params.cursor : undefined;

  const page: Awaited<ReturnType<typeof fetchPage>> = [];
  let more = false;
  for (let i = 0; i < MAX_SCAN_PAGES && page.length < limit; i++) {
    const rows = await fetchPage(where, limit + 1, cursor);
    const seen = rows.slice(0, limit);
    const visible = scope && viewer ? await visibleConversationIds(viewer, [...new Set(seen.map((r) => r.conversationId))]) : null;
    for (const r of seen) if (!visible || visible.has(r.conversationId)) page.push(r);
    more = rows.length > limit;
    if (!more) break;
    cursor = seen[seen.length - 1].id;
  }
  const shown = page.slice(0, limit);
  const nextCursor = page.length > limit ? shown[limit - 1].id : more ? (cursor ?? null) : null;
  const contacts = shown.length ? await prisma.contact.findMany({ where: { tenantId, id: { in: [...new Set(shown.map((r) => r.contactId))] } }, select: { id: true, name: true, phone: true, bsuid: true, username: true } }) : [];
  const byId = new Map(contacts.map((c) => [c.id, c]));
  const items = shown.map((r) => {
    const c = byId.get(r.contactId);
    return { ...r, contact: c ? maskContact({ name: c.name, phone: c.phone, bsuid: c.bsuid, username: c.username }, mask) : null };
  });
  return { items, nextCursor };
}

function fetchPage(where: Record<string, unknown>, take: number, cursor: string | undefined) {
  return prisma.chatbotSession.findMany({
    where,
    select: SESSION_SELECT,
    orderBy: [{ startedAt: "desc" }, { id: "desc" }],
    take,
    ...(cursor ? { cursor: { id: cursor }, skip: 1 } : {}),
  });
}

const STATS_DAYS = 30;

/** Session counts by outcome for the last 30 days, plus the share that finished the flow and the share handed to people. */
export async function sessionStats(tenantId: string, chatbotId: string) {
  await getChatbot(tenantId, chatbotId);
  const since = new Date(Date.now() - STATS_DAYS * 86_400_000);
  const groups = await prisma.chatbotSession.groupBy({ by: ["status"], where: { tenantId, chatbotId, startedAt: { gte: since } }, _count: { _all: true } });
  const counts: Record<string, number> = Object.fromEntries(SESSION_STATUSES.map((st) => [st, 0]));
  for (const g of groups) counts[g.status] = g._count._all;
  const total = Object.values(counts).reduce((a, b) => a + b, 0);
  const pct = (n: number) => (total === 0 ? 0 : Math.round((n / total) * 100));
  return { days: STATS_DAYS, total, counts, completionPercent: pct(counts.completed), handoffPercent: pct(counts.handed_off), expiredPercent: pct(counts.expired) };
}
