/**
 * Automation activity (docs/EDDY-SPEC.md 6.7, 6.9):
 * - the `automation_digest` notice (for your information, admins): "AI agent replied to 34 chats today and handed 5 to your
 *   team." One per workspace day (`digest:<day>`), counts updated in place, only when something ran;
 * - teamActivity(): the data of Menu > Team activity, one item per automation (AI agent, chatbots, rules, lead follow-ups,
 *   cart reminders) with its on/off state, a 24-hour summary, what is waiting for the team and its Settings page;
 * - turnOffAutomation(): turning something off from Team activity is instant (lowering), through the same services the
 *   Settings pages use, and audited. Turning something on is a card, never done here: the member asks Eddy, and the
 *   enable_automation card (built fresh on the server) shows what it will do before anything starts.
 * Read only apart from turnOffAutomation. Counts and ids only: no message text, no customer data.
 */
import { audit } from "@/lib/auth/audit";
import { prisma } from "@/lib/db";
import { dayKey, startOfLocalDay } from "@/lib/spend/periods";
import { HttpError, requireRole, type Actor } from "@/lib/tenancy";
import { act, dedupe } from "../kinds";
import type { NoticeProducer } from "../scan";
import { workspaceTimezone } from "./failures";

/** The AI agent's hand-over tag (src/lib/ai-agent/index.ts STOP_TAG). */
export const AI_HANDOFF_TAG = "ai:stopped";
const DAY_MS = 24 * 60 * 60_000;

export type DigestCounts = { ai: number; handoff: number; bots: number; rules: number };

/** Today's automation counts in the workspace's day (since local midnight). */
export async function digestCounts(tenantId: string, since: Date): Promise<DigestCounts> {
  const [aiChats, handoff, bots, rules] = await Promise.all([
    prisma.message.findMany({ where: { tenantId, origin: "ai_reply", createdAt: { gte: since } }, select: { conversationId: true }, take: 5000 }) as Promise<{ conversationId: string }[]>,
    prisma.conversation.count({ where: { tenantId, tags: { has: AI_HANDOFF_TAG }, statusChangedAt: { gte: since } } }) as Promise<number>,
    prisma.chatbotSession.count({ where: { tenantId, startedAt: { gte: since } } }) as Promise<number>,
    prisma.ruleExecution.count({ where: { tenantId, createdAt: { gte: since } } }) as Promise<number>,
  ]);
  return { ai: new Set(aiChats.map((m) => m.conversationId)).size, handoff, bots, rules };
}

export const producer: NoticeProducer = {
  name: "activity",
  kinds: ["automation_digest"],
  async run(ctx) {
    const tz = await workspaceTimezone(ctx.tenantId);
    const day = dayKey(ctx.now, tz);
    const counts = await digestCounts(ctx.tenantId, startOfLocalDay(day, tz));
    if (counts.ai + counts.handoff + counts.bots + counts.rules === 0) return { published: 0 };
    const r = await ctx.publish({
      kind: "automation_digest",
      severity: "fyi",
      dedupeKey: dedupe.digest(day),
      audience: { minRole: "admin" },
      payload: { day, ai: counts.ai, handoff: counts.handoff, bots: counts.bots, rules: counts.rules },
      count: counts.ai + counts.bots + counts.rules,
      actions: [act.go("/app/automation", "btn.open")],
    });
    return { published: r.outcome === "created" || r.outcome === "reopened" || r.outcome === "updated" ? 1 : 0 };
  },
};

// ===== Team activity (6.9) =====

export const AUTOMATION_KINDS = ["ai_agent", "chatbot", "rule", "lead_sequence", "cart_reminders"] as const;
export type AutomationKind = (typeof AUTOMATION_KINDS)[number];
export const isAutomationKind = (v: unknown): v is AutomationKind => typeof v === "string" && (AUTOMATION_KINDS as readonly string[]).includes(v);

export type ActivityItem = {
  kind: AutomationKind;
  id: string;
  /** The automation's own name, written by the workspace (shown as plain text). */
  name: string;
  enabled: boolean;
  /** How often it ran in the last 24 hours; null when that is not counted. */
  last24h: number | null;
  /** Items waiting for the team (the AI agent's hand-overs still open). */
  waiting: number;
  /** Its Settings page (an /app path). */
  settingsPath: string;
};

const CONTROL = /[\u0000-\u001f\u007f​-‏‪-‮⁦-⁩]/g;
const clip = (s: string) => s.replace(CONTROL, "").trim().slice(0, 80);

export function settingsPathFor(kind: AutomationKind, id: string): string {
  switch (kind) {
    case "rule":
      return `/app/automation/rules/${id}`;
    case "chatbot":
      return `/app/automation/chatbots/${id}`;
    case "ai_agent":
      return "/app/automation/ai-agent";
    case "lead_sequence":
      return "/app/leads/sequences";
    default:
      return "/app/commerce";
  }
}

/** Kinds whose Settings pages and lists are for admins and the owner only (lead follow-ups, cart reminders). */
export const ADMIN_ONLY_ACTIVITY_KINDS: readonly AutomationKind[] = ["lead_sequence", "cart_reminders"];

/**
 * The activity a member may see. Admins and the owner get everything. A team member sees only the automations they can open
 * themselves, without the workspace-wide counts (chats the AI agent answered, hand-overs, runs): those cover chats outside
 * their own, which get_activity never shows them either. Pure.
 */
export function activityForViewer(items: readonly ActivityItem[], canManage: boolean): ActivityItem[] {
  if (canManage) return [...items];
  return items.filter((i) => !ADMIN_ONLY_ACTIVITY_KINDS.includes(i.kind)).map((i) => ({ ...i, last24h: null, waiting: 0 }));
}

/** One item per automation, AI agent first. Counts that cannot be read are null, never a guess. */
export async function teamActivity(tenantId: string, now: Date = new Date()): Promise<ActivityItem[]> {
  const since = new Date(now.getTime() - DAY_MS);
  const [rules, bots, agents, sequences, stores] = await Promise.all([
    prisma.automationRule.findMany({ where: { tenantId }, select: { id: true, name: true, enabled: true }, orderBy: { name: "asc" }, take: 100 }) as Promise<{ id: string; name: string; enabled: boolean }[]>,
    prisma.chatbot.findMany({ where: { tenantId, status: { not: "archived" } }, select: { id: true, name: true, status: true }, orderBy: { name: "asc" }, take: 100 }) as Promise<{ id: string; name: string; status: string }[]>,
    prisma.aiAgent.findMany({ where: { tenantId }, select: { id: true, name: true, enabled: true }, take: 20 }) as Promise<{ id: string; name: string; enabled: boolean }[]>,
    prisma.leadSequence.findMany({ where: { tenantId }, select: { id: true, name: true, enabled: true }, orderBy: { name: "asc" }, take: 50 }) as Promise<{ id: string; name: string; enabled: boolean }[]>,
    prisma.shopifyStore.findMany({ where: { tenantId }, select: { id: true, shopDomain: true }, take: 20 }) as Promise<{ id: string; shopDomain: string }[]>,
  ]);
  const count = (p: Promise<number>) => p.catch(() => null);
  const items: ActivityItem[] = [];
  if (agents.length) {
    const [aiChats, waiting] = await Promise.all([
      prisma.message.findMany({ where: { tenantId, origin: "ai_reply", createdAt: { gte: since } }, select: { conversationId: true }, take: 5000 }).then((rows: { conversationId: string }[]) => new Set(rows.map((r) => r.conversationId)).size).catch(() => null),
      count(prisma.conversation.count({ where: { tenantId, status: "open", tags: { has: AI_HANDOFF_TAG }, statusChangedAt: { gte: since } } })),
    ]);
    for (const a of agents) items.push({ kind: "ai_agent", id: a.id, name: clip(a.name), enabled: a.enabled, last24h: aiChats, waiting: waiting ?? 0, settingsPath: settingsPathFor("ai_agent", a.id) });
  }
  for (const b of bots) items.push({ kind: "chatbot", id: b.id, name: clip(b.name), enabled: b.status === "published", last24h: await count(prisma.chatbotSession.count({ where: { tenantId, chatbotId: b.id, startedAt: { gte: since } } })), waiting: 0, settingsPath: settingsPathFor("chatbot", b.id) });
  for (const r of rules) items.push({ kind: "rule", id: r.id, name: clip(r.name), enabled: r.enabled, last24h: await count(prisma.ruleExecution.count({ where: { tenantId, ruleId: r.id, createdAt: { gte: since } } })), waiting: 0, settingsPath: settingsPathFor("rule", r.id) });
  for (const s of sequences) items.push({ kind: "lead_sequence", id: s.id, name: clip(s.name), enabled: s.enabled, last24h: await count(prisma.leadSequenceRun.count({ where: { tenantId, sequenceId: s.id, createdAt: { gte: since } } })), waiting: 0, settingsPath: settingsPathFor("lead_sequence", s.id) });
  if (stores.length) {
    const { getSettings } = await import("@/lib/commerce/settings");
    for (const s of stores) items.push({ kind: "cart_reminders", id: s.id, name: clip(s.shopDomain), enabled: (await getSettings(tenantId, s.id).catch(() => ({ enabled: false }))).enabled, last24h: null, waiting: 0, settingsPath: settingsPathFor("cart_reminders", s.id) });
  }
  return items;
}

/**
 * Turns one automation off (lowering, so it is instant): the same services the Settings pages call, for admins and the
 * owner, audited as `eddy.team_activity.off`. Turning on is never done here (it is a card).
 */
export async function turnOffAutomation(actor: Actor, kind: AutomationKind, id: string): Promise<void> {
  requireRole(actor, "admin");
  const tenantId = actor.tenantId;
  if (kind === "rule") {
    const { updateRule } = await import("@/lib/automation/rules");
    await updateRule(tenantId, id, { enabled: false });
  } else if (kind === "chatbot") {
    const { unpublishChatbot } = await import("@/lib/chatbots/service");
    await unpublishChatbot(tenantId, id);
  } else if (kind === "ai_agent") {
    const { updateAgent } = await import("@/lib/ai-agent/agents");
    await updateAgent(tenantId, actor.userId, id, { enabled: false });
  } else if (kind === "lead_sequence") {
    const { updateSequence } = await import("@/lib/leads/service");
    await updateSequence(actor, id, { enabled: false });
  } else if (kind === "cart_reminders") {
    const { saveSettings } = await import("@/lib/commerce/settings");
    await saveSettings(tenantId, id, { enabled: false });
  } else {
    throw new HttpError(400, "Unknown automation.");
  }
  await audit({ tenantId, userId: actor.userId, action: "eddy.team_activity.off", target: id, meta: { kind } });
}
