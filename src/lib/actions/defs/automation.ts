/**
 * Automation definitions (docs/EDDY-SPEC.md 4.6, 6.9, 12.1a decision 9): list what runs automatically, dry-run a message
 * against the rules, turn an automation off (a lowering: instant, Undo is a card) and turn one on (a card).
 *
 * enable_automation in v1 covers only a rule or chatbot that sends free text. The check is transitive (critic 4): a rule's
 * start_chatbot step includes that bot's flow, a send_material that is a template counts as a template, and a chatbot whose
 * AI escalation check is on counts as AI spend. Templates, lead sequences and cart reminders spend from `messaging`; the AI
 * agent and AI escalation spend `ai`. Both arm automation, so v1 refuses them with `not_yet` (4.3 G10) and the member turns
 * them on by hand.
 */
import { HttpError, type Actor } from "@/lib/tenancy";
import type { Effects } from "../types";
import { actorOf, asRecord, bool, db, define, id, iso, notFound, obj, oneOf, preview, str, tagList, u, UNDO_MS, warnings } from "./shared";

export const AUTOMATION_KINDS = ["rule", "chatbot", "ai_agent", "lead_sequence", "cart_reminders"] as const;
export type AutomationKind = (typeof AUTOMATION_KINDS)[number];

/** What turning an automation on would do, read without running it. */
export type AutomationProfile = { kind: AutomationKind; id: string; name: string; enabled: boolean; sends: "text" | "chatbot" | "template" | "ai_agent" | "lead_sequence" | "cart_reminder"; spends: "none" | "messaging" | "ai"; updatedAt: string };

const flowNodes = (flow: unknown): Record<string, unknown>[] => {
  const nodes = asRecord(flow).nodes;
  return Array.isArray(nodes) ? nodes.map((n) => asRecord(n)) : [];
};

/** chatbots/flow.ts: escalation is on by default and its AI check is off by default; the AI check calls the model on inbound messages. */
const escalationUsesAi = (flow: unknown): boolean => {
  const escalation = asRecord(asRecord(asRecord(flow).settings).escalation);
  return escalation.enabled !== false && escalation.useAi === true;
};

export function chatbotSpend(flow: unknown): "none" | "messaging" | "ai" {
  if (flowNodes(flow).some((n) => n.type === "send_template")) return "messaging";
  return escalationUsesAi(flow) ? "ai" : "none";
}

const worse = (a: "none" | "messaging" | "ai", b: "none" | "messaging" | "ai") => (a === "messaging" || b === "messaging" ? "messaging" : a === "ai" || b === "ai" ? "ai" : "none");

/** The profile of one automation, transitive over chatbots and materials. Throws the route's 404 when it is not there. */
export async function automationProfile(actor: Actor, kind: AutomationKind, automationId: string): Promise<AutomationProfile> {
  const prisma = await db();
  const tenantId = actor.tenantId;
  if (kind === "rule") {
    const rule = (await prisma.automationRule.findFirst({ where: { id: automationId, tenantId } })) as Record<string, unknown> | null;
    if (!rule) throw notFound("Rule");
    let spends: "none" | "messaging" | "ai" = "none";
    let sends: AutomationProfile["sends"] = "text";
    if (rule.version === 2) {
      // Classified from the stored steps themselves, valid or not, so an unusual rule fails closed (it never reads as free text).
      for (const action of Array.isArray(rule.actions) ? rule.actions : []) {
        const a = asRecord(action) as { type?: string; materialId?: string; chatbotId?: string };
        if (a.type === "send_template" || a.type === "start_lead_sequence") {
          spends = worse(spends, "messaging");
          sends = a.type === "send_template" ? "template" : "lead_sequence";
        } else if (a.type === "start_ai_agent") {
          spends = worse(spends, "ai");
          if (sends === "text") sends = "ai_agent";
        } else if (a.type === "send_material" && a.materialId) {
          const material = (await prisma.replyMaterial.findFirst({ where: { id: a.materialId, tenantId }, select: { kind: true } })) as { kind: string } | null;
          if (material?.kind === "template") {
            spends = worse(spends, "messaging");
            sends = "template";
          }
        } else if (a.type === "start_chatbot" && a.chatbotId) {
          const bot = (await prisma.chatbot.findFirst({ where: { id: a.chatbotId, tenantId }, select: { flow: true, publishedFlow: true } })) as { flow: unknown; publishedFlow: unknown } | null;
          spends = worse(spends, chatbotSpend(bot?.publishedFlow ?? bot?.flow));
          if (sends === "text") sends = "chatbot";
        }
      }
    }
    return { kind, id: automationId, name: String(rule.name ?? "Rule"), enabled: rule.enabled === true, sends, spends, updatedAt: iso(rule.updatedAt as Date | null) ?? "-" };
  }
  if (kind === "chatbot") {
    const bot = (await prisma.chatbot.findFirst({ where: { id: automationId, tenantId }, select: { id: true, name: true, status: true, flow: true, publishedFlow: true, updatedAt: true } })) as
      | { id: string; name: string; status: string; flow: unknown; publishedFlow: unknown; updatedAt: Date }
      | null;
    if (!bot) throw notFound("Chatbot");
    return { kind, id: automationId, name: bot.name, enabled: bot.status === "published", sends: "chatbot", spends: worse(chatbotSpend(bot.flow), chatbotSpend(bot.publishedFlow)), updatedAt: iso(bot.updatedAt) ?? "-" };
  }
  if (kind === "ai_agent") {
    const agent = (await prisma.aiAgent.findFirst({ where: { id: automationId, tenantId }, select: { name: true, enabled: true, updatedAt: true } })) as { name: string; enabled: boolean; updatedAt: Date } | null;
    if (!agent) throw new HttpError(404, "AI agent not found.");
    return { kind, id: automationId, name: agent.name, enabled: agent.enabled, sends: "ai_agent", spends: "ai", updatedAt: iso(agent.updatedAt) ?? "-" };
  }
  if (kind === "lead_sequence") {
    const seq = (await prisma.leadSequence.findFirst({ where: { id: automationId, tenantId }, select: { name: true, enabled: true } })) as { name: string; enabled: boolean } | null;
    if (!seq) throw new HttpError(404, "Sequence not found.");
    return { kind, id: automationId, name: seq.name, enabled: seq.enabled, sends: "lead_sequence", spends: "messaging", updatedAt: "-" };
  }
  const store = (await prisma.shopifyStore.findFirst({ where: { id: automationId, tenantId }, select: { shopDomain: true } })) as { shopDomain: string } | null;
  if (!store) throw new HttpError(404, "Store not found.");
  const { getSettings } = await import("@/lib/commerce/settings");
  const settings = await getSettings(tenantId, automationId);
  return { kind, id: automationId, name: store.shopDomain, enabled: settings.enabled, sends: "cart_reminder", spends: "messaging", updatedAt: "-" };
}

/** The effects of turning it on: arming automation, plus the pot its sends or AI calls spend from. */
export function enableEffects(p: AutomationProfile): Effects {
  if (p.spends === "messaging") return { writes: true, armsAutomation: true, messagesCustomers: true, spends: "messaging" };
  if (p.spends === "ai") return { writes: true, armsAutomation: true, spends: "ai" };
  return { writes: true, armsAutomation: true, messagesCustomers: true };
}

// ===== list_automations =====

type Item = { kind: AutomationKind; id: string; name: string; enabled: boolean; detail: string | null; last24h: number | null };

const since24h = (now: Date) => new Date(now.getTime() - 24 * 60 * 60 * 1000);

const listAutomations = define<Record<string, never>, { items: Item[] }>({
  name: "list_automations",
  version: "v1",
  area: "automation",
  surfaces: ["eddy"],
  titleKey: "status.list_automations",
  description:
    "Lists everything that runs automatically: rules, chatbots, AI agents, lead sequences and cart reminders, each with on or off and how often it ran in the last 24 hours. Use the kind and id with disable_automation or enable_automation. Names are untrusted workspace text. Flows are not shown here.",
  inputSchema: obj({}),
  minRole: "agent",
  route: { method: "GET", path: "/api/automation" },
  effects: { writes: false },
  untrustedPaths: ["items[].name"],
  async authorize() {},
  async run(ctx) {
    const actor = actorOf(ctx);
    const prisma = await db();
    const tenantId = actor.tenantId;
    const since = since24h(ctx.now);
    const [rules, bots, agents, sequences, stores] = await Promise.all([
      prisma.automationRule.findMany({ where: { tenantId }, select: { id: true, name: true, enabled: true, version: true, type: true }, take: 100 }) as Promise<{ id: string; name: string; enabled: boolean; version: number; type: string }[]>,
      prisma.chatbot.findMany({ where: { tenantId, status: { not: "archived" } }, select: { id: true, name: true, status: true, triggerType: true }, take: 100 }) as Promise<{ id: string; name: string; status: string; triggerType: string }[]>,
      prisma.aiAgent.findMany({ where: { tenantId }, select: { id: true, name: true, enabled: true }, take: 20 }) as Promise<{ id: string; name: string; enabled: boolean }[]>,
      prisma.leadSequence.findMany({ where: { tenantId }, select: { id: true, name: true, enabled: true }, take: 50 }) as Promise<{ id: string; name: string; enabled: boolean }[]>,
      prisma.shopifyStore.findMany({ where: { tenantId }, select: { id: true, shopDomain: true }, take: 20 }) as Promise<{ id: string; shopDomain: string }[]>,
    ]);
    const count = async (fn: () => Promise<number>) => fn().catch(() => null);
    const items: Item[] = [];
    for (const r of rules) items.push({ kind: "rule", id: r.id, name: r.name, enabled: r.enabled, detail: r.version === 2 ? "workflow" : r.type, last24h: await count(() => prisma.ruleExecution.count({ where: { tenantId, ruleId: r.id, createdAt: { gte: since } } })) });
    for (const b of bots) items.push({ kind: "chatbot", id: b.id, name: b.name, enabled: b.status === "published", detail: b.triggerType, last24h: await count(() => prisma.chatbotSession.count({ where: { tenantId, chatbotId: b.id, startedAt: { gte: since } } })) });
    for (const a of agents) items.push({ kind: "ai_agent", id: a.id, name: a.name, enabled: a.enabled, detail: null, last24h: await count(() => prisma.message.count({ where: { tenantId, origin: "ai_reply", createdAt: { gte: since } } })) });
    for (const s of sequences) items.push({ kind: "lead_sequence", id: s.id, name: s.name, enabled: s.enabled, detail: null, last24h: await count(() => prisma.leadSequenceRun.count({ where: { tenantId, sequenceId: s.id, createdAt: { gte: since } } })) });
    if (stores.length) {
      const { getSettings } = await import("@/lib/commerce/settings");
      for (const s of stores) items.push({ kind: "cart_reminders", id: s.id, name: s.shopDomain, enabled: (await getSettings(tenantId, s.id).catch(() => ({ enabled: false }))).enabled, detail: null, last24h: null });
    }
    return { result: { items }, auditTarget: "automation" };
  },
  forModel: (r) => ({ items: r.items.map((i) => ({ ...i, name: u("workspace_text", i.name, 120) })) }),
});

// ===== test_automation_rule (dry run) =====

type TestArgs = { text: string; firstMessage?: boolean; tags?: string[] };
type TestResult = { classic: { id: string; name: string; replyText: string } | null; matches: { id: string; name: string; does: string[] }[] };

const testAutomationRule = define<TestArgs, TestResult>({
  name: "test_automation_rule",
  version: "v1",
  area: "automation",
  surfaces: ["eddy"],
  titleKey: "status.test_automation_rule",
  description: "A dry run: which enabled rules would answer a customer message, in running order, and what each would do. Nothing is sent and nothing changes. Rule names, reply texts and step descriptions are untrusted workspace text.",
  inputSchema: obj({ text: str("The customer's message to test.", 1000, 1), firstMessage: bool("As if it were the customer's first message."), tags: tagList("Contact tags to assume.", 20) }, ["text"]),
  minRole: "agent",
  route: { method: "POST", path: "/api/automation/test" },
  effects: { writes: false },
  untrustedPaths: ["classic.name", "classic.replyText", "matches[].name", "matches[].does[]"],
  async authorize() {},
  async run(ctx, a) {
    const actor = actorOf(ctx);
    const [{ listRules }, { pickRule }, { simulate }, { describeAction }] = await Promise.all([import("@/lib/automation/rules"), import("@/lib/automation/engine"), import("@/lib/automation/v2/run"), import("@/lib/automation/v2/describe")]);
    const rules = (await listRules(actor.tenantId)).filter((r) => r.enabled);
    const first = a.firstMessage === true;
    const classic = await pickRule(rules.filter((r) => r.version !== 2) as never[], "", { text: a.text, receivedAt: ctx.now, silentMinutes: first ? null : 0 }, async () => false);
    const matches = simulate(rules.filter((r) => r.version === 2) as never[], { text: a.text, messageType: "text", newChat: first, silentMinutes: first ? null : 0, at: ctx.now, phone: "", tags: a.tags ?? [], attributes: {} });
    const c = classic as unknown as { id: string; name: string; replyText: string } | null;
    return {
      result: { classic: c ? { id: c.id, name: c.name, replyText: c.replyText } : null, matches: matches.map((m) => ({ id: m.id, name: m.name, does: m.summary.actions.map((x) => describeAction(x)) })) },
      auditTarget: "automation-test",
    };
  },
  forModel: (r) => ({
    sent: false,
    classic: r.classic ? { id: r.classic.id, name: u("workspace_text", r.classic.name, 80), replyText: u("workspace_text", r.classic.replyText, 500) } : null,
    matches: r.matches.map((m) => ({ id: m.id, name: u("workspace_text", m.name, 80), does: m.does.map((d) => u("workspace_text", d, 200)) })),
  }),
});

// ===== disable_automation (lowering) / enable_automation (card) =====

type KindArgs = { kind: string; id: string };
const kindSchema = obj({ kind: oneOf("What it is.", AUTOMATION_KINDS), id: id("Its id (from list_automations).") }, ["kind", "id"]);

async function setEnabled(actor: Actor, kind: AutomationKind, automationId: string, enabled: boolean): Promise<void> {
  const tenantId = actor.tenantId;
  if (kind === "rule") {
    const { updateRule } = await import("@/lib/automation/rules");
    await updateRule(tenantId, automationId, { enabled });
  } else if (kind === "chatbot") {
    const svc = await import("@/lib/chatbots/service");
    if (enabled) await svc.publishChatbot(tenantId, automationId);
    else await svc.unpublishChatbot(tenantId, automationId);
  } else if (kind === "ai_agent") {
    const { updateAgent } = await import("@/lib/ai-agent/agents");
    await updateAgent(tenantId, actor.userId, automationId, { enabled });
  } else if (kind === "lead_sequence") {
    const { updateSequence } = await import("@/lib/leads/service");
    await updateSequence(actor, automationId, { enabled });
  } else {
    const { saveSettings } = await import("@/lib/commerce/settings");
    await saveSettings(tenantId, automationId, { enabled });
  }
}

const disableAutomation = define<KindArgs, { kind: string; id: string; name: string; wasEnabled: boolean }>({
  name: "disable_automation",
  version: "v1",
  area: "automation",
  surfaces: ["eddy"],
  titleKey: "status.disable_automation",
  description: "Turns an automation off at once: a rule, a chatbot (back to draft), an AI agent, a lead sequence or a store's cart reminders. Turning things off always works, even when spending is stopped. Undo turns it back on through a preview card. Owners and admins only.",
  inputSchema: kindSchema,
  minRole: "admin",
  route: { method: "PATCH", path: "/api/automation/[id]" },
  effects: { writes: true, lowersActivity: true },
  untrustedPaths: ["name"],
  async authorize(ctx, a) {
    await automationProfile(actorOf(ctx), a.kind as AutomationKind, a.id);
  },
  async run(ctx, a) {
    const actor = actorOf(ctx);
    const p = await automationProfile(actor, a.kind as AutomationKind, a.id);
    if (p.enabled) await setEnabled(actor, p.kind, a.id, false);
    return {
      result: { kind: a.kind, id: a.id, name: p.name, wasEnabled: p.enabled },
      ...(p.enabled ? { undo: { kind: "automation_off", target: a.id, before: { kind: a.kind, enabled: true }, after: { enabled: false } } } : {}),
      auditTarget: a.id,
    };
  },
  undo: {
    windowMs: UNDO_MS,
    async stillApplies(ctx, un) {
      const kind = String(asRecord(un.before).kind) as AutomationKind;
      return !(await automationProfile(actorOf(ctx), kind, un.target)).enabled;
    },
    /** Never called: turning it back on is the enable_automation card (inverseAction). */
    async inverse() {
      throw new HttpError(409, "Turning it back on needs its own preview.");
    },
    inverseAction: "enable_automation",
    inverseArgs: (un) => ({ kind: String(asRecord(un.before).kind), id: un.target }),
  },
  forModel: (r) => ({ ...r, name: u("workspace_text", r.name, 120), note: r.wasEnabled ? "Turned off." : "It was already off." }),
});

const SENDS_KEY: Record<AutomationProfile["sends"], string> = {
  text: "card.fact.automation.text",
  chatbot: "card.fact.automation.chatbot",
  template: "card.fact.automation.template",
  ai_agent: "card.fact.automation.ai_agent",
  lead_sequence: "card.fact.automation.lead_sequence",
  cart_reminder: "card.fact.automation.template",
};

const enableAutomation = define<KindArgs, { kind: string; id: string; name: string }>({
  name: "enable_automation",
  version: "v1",
  area: "automation",
  surfaces: ["eddy"],
  titleKey: "status.enable_automation",
  description:
    "Turns on a rule or chatbot that replies with free text, after a preview card. Automations that send templates, start an AI agent, use AI escalation, run a lead sequence or send cart reminders spend money, so Eddy can't turn them on yet: tell the member to do it on its page. Owners and admins only.",
  inputSchema: kindSchema,
  minRole: "admin",
  route: { method: "PATCH", path: "/api/automation/[id]" },
  effects: async (a, ctx) => enableEffects(await automationProfile(actorOf(ctx), a.kind as AutomationKind, a.id)),
  risk: "confirm",
  untrustedPaths: ["name"],
  async authorize(ctx, a) {
    const p = await automationProfile(actorOf(ctx), a.kind as AutomationKind, a.id);
    if (p.enabled) throw new HttpError(409, "It is already on.");
  },
  async preview(ctx, a) {
    const p = await automationProfile(actorOf(ctx), a.kind as AutomationKind, a.id);
    return preview({
      titleKey: "card.enable_automation.title",
      confirmLabelKey: "card.enable_automation.confirm",
      vars: { automation: u("workspace_text", p.name, 120) },
      facts: [
        { labelKey: "fact.automation", value: u("workspace_text", p.name, 120) },
        { labelKey: "fact.sends", value: u("workspace_text", p.sends, 40) },
        { labelKey: SENDS_KEY[p.sends], value: u("workspace_text", p.name, 120) },
      ],
      warnings: warnings("arms_automation"),
      material: { targetId: a.id, kind: a.kind, updatedAt: p.updatedAt, spends: p.spends },
    });
  },
  async run(ctx, a) {
    const actor = actorOf(ctx);
    const p = await automationProfile(actor, a.kind as AutomationKind, a.id);
    if (p.spends !== "none") throw new HttpError(409, "This automation spends money, so turn it on yourself on its page.");
    await setEnabled(actor, p.kind, a.id, true);
    return { result: { kind: a.kind, id: a.id, name: p.name }, auditTarget: a.id };
  },
  forModel: (r) => ({ ...r, name: u("workspace_text", r.name, 120) }),
});

export const AUTOMATION_DEFS = [disableAutomation, enableAutomation, listAutomations, testAutomationRule];
