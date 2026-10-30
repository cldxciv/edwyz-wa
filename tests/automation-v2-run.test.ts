import { beforeEach, describe, expect, it, vi } from "vitest";

const db = vi.hoisted(() => {
  const model = () => ({ findFirst: vi.fn(), findMany: vi.fn(), findUnique: vi.fn(), create: vi.fn(), update: vi.fn(), updateMany: vi.fn(), upsert: vi.fn(), count: vi.fn(), deleteMany: vi.fn(), groupBy: vi.fn() });
  return {
    automationRule: model(),
    contact: model(),
    conversation: model(),
    chatbotSession: model(),
    message: model(),
    ruleExecution: model(),
    automationRun: model(),
    platformSetting: model(),
    segment: model(),
    membership: model(),
    team: model(),
    teamMember: model(),
    agentAvailability: model(),
    note: model(),
    replyMaterial: model(),
    template: model(),
    leadSequence: model(),
    leadSequenceRun: model(),
    lead: model(),
    phoneNumber: model(),
    plan: model(),
  };
});
const svc = vi.hoisted(() => ({ sendText: vi.fn(), sendMedia: vi.fn(), sendTemplateMessage: vi.fn() }));
const hooks = vi.hoisted(() => ({
  assignConversation: vi.fn(),
  startChatbot: vi.fn(),
  handleInboundForAiAgent: vi.fn(),
  queueEmail: vi.fn(),
  processRun: vi.fn(),
  billing: vi.fn(),
  mayRun: vi.fn(),
}));
vi.mock("@/lib/db", () => ({ prisma: db }));
vi.mock("@/lib/inbox/service", () => svc);
vi.mock("@/lib/routing", () => ({ assignConversation: hooks.assignConversation }));
vi.mock("@/lib/chatbots", () => ({ startChatbot: hooks.startChatbot }));
vi.mock("@/lib/ai-agent", () => ({ handleInboundForAiAgent: hooks.handleInboundForAiAgent, STOP_TAG: "ai:stopped" }));
vi.mock("@/lib/email", () => ({ queueEmail: hooks.queueEmail }));
vi.mock("@/lib/leads/runner", () => ({ processRun: hooks.processRun }));
vi.mock("@/lib/billing/status", () => ({ getBillingStatus: hooks.billing }));
vi.mock("@/lib/tenant-state", () => ({ tenantMayRunBackground: hooks.mayRun }));

import { busyReason, fireRules, LOOP_LIMITS, simulate, type RuleRow, type TriggerEvent } from "@/lib/automation/v2/run";
import { resetMeteringCache } from "@/lib/automation/v2/metering";
import type { Action, Filters, Trigger } from "@/lib/automation/v2/model";

const NOW = new Date("2026-10-27T10:00:00Z");
let seq = 0;
const rule = (over: Partial<RuleRow> & { actions: Action[]; trigger?: Trigger; filters?: Filters["root"]["items"]; allowHuman?: boolean }): RuleRow => {
  const { actions, trigger, filters, allowHuman, ...rest } = over;
  seq += 1;
  return {
    id: `r${seq}`,
    name: `Rule ${seq}`,
    phoneNumberId: null,
    priority: seq * 10,
    cooldownMinutes: 5,
    stopAfterMatch: false,
    createdAt: new Date(2026, 0, seq),
    version: 2,
    enabled: true,
    trigger: trigger ?? { type: "message_received" },
    filters: { root: { type: "group", op: "and", items: filters ?? [] }, options: { allowWhenHumanActive: allowHuman ?? false } },
    actions,
    ...rest,
  };
};
const text = (t: string): Action => ({ type: "send_text", text: t });
const keyword = (...k: string[]) => ({ type: "keyword" as const, mode: "contains" as const, keywords: k });

const event = (over: Partial<TriggerEvent> = {}): TriggerEvent => ({
  type: "message_received",
  tenantId: "t1",
  contactId: "c1",
  conversationId: "cv1",
  at: NOW,
  message: { text: "what is the price", messageType: "text", newChat: false, silentMinutes: 5, phoneNumberId: "ph1", answeredBy: null },
  ...over,
});

const contactRow = { id: "c1", name: "Asha Rao", phone: "+919876543210", tags: [] as string[], attributes: {} as Record<string, unknown>, optIn: true, optedOutAt: null as Date | null, createdAt: new Date("2026-01-01") };
let conversationRow: Record<string, unknown>;

beforeEach(() => {
  vi.clearAllMocks();
  resetMeteringCache();
  conversationRow = { id: "cv1", phoneNumberId: "ph1", assignedToId: null, tags: [], teamId: null, lastInboundAt: new Date(NOW.getTime() - 60_000), status: "open" };
  db.contact.findFirst.mockImplementation(async () => ({ ...contactRow, tags: [...contactRow.tags], attributes: { ...contactRow.attributes } }));
  db.conversation.findFirst.mockImplementation(async () => ({ ...conversationRow }));
  db.chatbotSession.findFirst.mockResolvedValue(null);
  db.message.findFirst.mockResolvedValue(null);
  db.ruleExecution.findFirst.mockResolvedValue(null);
  db.ruleExecution.count.mockResolvedValue(0);
  db.ruleExecution.create.mockResolvedValue({});
  db.platformSetting.findUnique.mockResolvedValue(null);
  db.segment.findMany.mockResolvedValue([]);
  db.contact.updateMany.mockResolvedValue({ count: 1 });
  db.conversation.updateMany.mockResolvedValue({ count: 1 });
  db.platformSetting.create.mockResolvedValue({});
  db.platformSetting.deleteMany.mockResolvedValue({ count: 1 });
  db.automationRun.findFirst.mockResolvedValue(null);
  hooks.mayRun.mockResolvedValue(true);
  hooks.billing.mockResolvedValue({ state: "exempt", planId: null });
  svc.sendText.mockResolvedValue({ id: "m1" });
  hooks.processRun.mockResolvedValue(true);
});

const logged = () => db.ruleExecution.create.mock.calls.map(([a]) => a.data as { ruleId: string; outcome: string; detail: string });

describe("matching and running", () => {
  it("runs the actions of a rule whose conditions fit and logs it for the tenant", async () => {
    const r = rule({ filters: [keyword("price")], actions: [text("Hi {{first_name}}, see our prices.")] });
    const result = await fireRules(event(), [r]);
    expect(result).toEqual({ fired: 1, replied: true });
    expect(svc.sendText).toHaveBeenCalledWith({ tenantId: "t1", conversationId: "cv1", body: "Hi Asha, see our prices.", origin: "automation" });
    expect(logged()).toEqual([expect.objectContaining({ ruleId: r.id, outcome: "ok" })]);
    expect(db.ruleExecution.create.mock.calls[0][0].data).toMatchObject({ tenantId: "t1", contactId: "c1", conversationId: "cv1" });
    expect(db.contact.findFirst).toHaveBeenCalledWith(expect.objectContaining({ where: { id: "c1", tenantId: "t1" } }));
  });

  it("does nothing when the conditions do not fit or the rule is for another trigger", async () => {
    const r = rule({ filters: [keyword("refund")], actions: [text("x")] });
    const tagRule = rule({ trigger: { type: "tag_added", tag: "vip" }, actions: [text("y")] });
    expect(await fireRules(event(), [r, tagRule])).toEqual({ fired: 0, replied: false });
    expect(svc.sendText).not.toHaveBeenCalled();
    expect(logged()).toEqual([]);
  });

  it("skips rules tied to another WhatsApp number", async () => {
    const r = rule({ phoneNumberId: "ph2", actions: [text("x")] });
    expect((await fireRules(event(), [r])).fired).toBe(0);
  });

  it("never runs for opted-out contacts, blocked chats or suspended workspaces", async () => {
    const r = rule({ actions: [text("x")] });
    contactRow.optedOutAt = new Date();
    expect((await fireRules(event(), [r])).fired).toBe(0);
    contactRow.optedOutAt = null;
    conversationRow.status = "blocked";
    expect((await fireRules(event(), [r])).fired).toBe(0);
    conversationRow.status = "open";
    hooks.mayRun.mockResolvedValue(false);
    expect((await fireRules(event(), [r])).fired).toBe(0);
    expect(svc.sendText).not.toHaveBeenCalled();
  });

  it("tag and status triggers match on their parameters", async () => {
    const r = rule({ trigger: { type: "tag_added", tag: "VIP" }, actions: [{ type: "update_attribute", name: "tier", value: "gold", remove: false }] });
    const other = rule({ trigger: { type: "status_changed", to: "solved" }, actions: [{ type: "add_tag", tag: "done", scope: "contact" }] });
    const added = event({ type: "tag_added", tags: ["vip"], message: undefined });
    expect((await fireRules(added, [r, other])).fired).toBe(1);
    expect(db.contact.updateMany).toHaveBeenCalledWith({ where: { id: "c1", tenantId: "t1" }, data: { attributes: { tier: "gold" } } });
    const status = event({ type: "status_changed", status: { from: "open", to: "pending" }, message: undefined });
    expect((await fireRules(status, [r, other])).fired).toBe(0);
    expect((await fireRules(event({ type: "status_changed", status: { from: "open", to: "solved" }, message: undefined }), [r, other])).fired).toBe(1);
  });
});

describe("order, modes and stopping", () => {
  const settings = (mode: "first_match" | "all_matching") => db.platformSetting.findUnique.mockResolvedValue({ value: { mode } });

  it("runs rules by priority and stops after the first reply in first-match mode", async () => {
    const late = rule({ priority: 50, actions: [text("late")] });
    const early = rule({ priority: 5, actions: [text("early")] });
    const result = await fireRules(event(), [late, early]);
    expect(result.fired).toBe(1);
    expect(svc.sendText).toHaveBeenCalledTimes(1);
    expect(svc.sendText).toHaveBeenCalledWith(expect.objectContaining({ body: "early" }));
  });

  it("rules that only tag never block the ones below in first-match mode", async () => {
    const tagger = rule({ priority: 1, actions: [{ type: "add_tag", tag: "asked", scope: "contact" }] });
    const replier = rule({ priority: 2, actions: [text("reply")] });
    expect((await fireRules(event(), [replier, tagger])).fired).toBe(2);
    expect(svc.sendText).toHaveBeenCalledTimes(1);
  });

  it("all-matching mode runs every matching rule, unless one says stop here", async () => {
    settings("all_matching");
    const a = rule({ priority: 1, actions: [text("a")] });
    const b = rule({ priority: 2, actions: [text("b")], stopAfterMatch: true });
    const c = rule({ priority: 3, actions: [text("c")] });
    expect((await fireRules(event(), [c, b, a])).fired).toBe(2);
    expect(svc.sendText.mock.calls.map(([x]) => x.body)).toEqual(["a", "b"]);
  });

  it("falls through to the next rule when the first is cooling down", async () => {
    const a = rule({ priority: 1, actions: [text("a")] });
    const b = rule({ priority: 2, actions: [text("b")] });
    db.ruleExecution.findFirst.mockImplementation(async ({ where }) => (where.ruleId === a.id ? { id: "old" } : null));
    await fireRules(event(), [a, b]);
    expect(svc.sendText.mock.calls.map(([x]) => x.body)).toEqual(["b"]);
    const since = db.ruleExecution.findFirst.mock.calls.find(([x]) => x.where.ruleId === a.id)![0].where.createdAt.gte as Date;
    expect(NOW.getTime() - since.getTime()).toBe(5 * 60_000);
  });

  it("a new contact rule runs once per contact ever", async () => {
    const r = rule({ trigger: { type: "contact_created" }, actions: [text("welcome")] });
    db.ruleExecution.findFirst.mockResolvedValue({ id: "earlier" });
    expect((await fireRules(event({ type: "contact_created" }), [r])).fired).toBe(0);
    const where = db.ruleExecution.findFirst.mock.calls[0][0].where;
    expect(where).toMatchObject({ ruleId: r.id, contactId: "c1" });
    expect((where.createdAt.gte as Date).getTime()).toBe(0);
  });
});

describe("suppression and guards", () => {
  it("customer-facing steps wait while a person is handling the chat, but tagging still happens", async () => {
    conversationRow.assignedToId = "u1";
    db.message.findFirst.mockResolvedValue({ id: "agent-reply" });
    const r = rule({ actions: [text("auto"), { type: "add_tag", tag: "seen", scope: "contact" }] });
    const result = await fireRules(event(), [r]);
    expect(result).toEqual({ fired: 1, replied: false });
    expect(svc.sendText).not.toHaveBeenCalled();
    expect(db.contact.updateMany).toHaveBeenCalled();
    expect(logged()[0].detail).toContain("Send text: skipped (a person is handling this chat)");
  });

  it("replies during a human chat when the rule allows it", async () => {
    conversationRow.assignedToId = "u1";
    db.message.findFirst.mockResolvedValue({ id: "agent-reply" });
    await fireRules(event(), [rule({ allowHuman: true, actions: [text("auto")] })]);
    expect(svc.sendText).toHaveBeenCalled();
  });

  it("an assigned chat where the agent has not replied recently is not treated as handled", async () => {
    conversationRow.assignedToId = "u1";
    await fireRules(event(), [rule({ actions: [text("auto")] })]);
    expect(svc.sendText).toHaveBeenCalled();
  });

  it("stays quiet while a chatbot session is live or when a bot already answered", async () => {
    db.chatbotSession.findFirst.mockResolvedValue({ id: "s1" });
    const r = rule({ actions: [text("auto")] });
    expect((await fireRules(event(), [r])).replied).toBe(false);
    db.chatbotSession.findFirst.mockResolvedValue(null);
    const answered = event({ message: { text: "hi", messageType: "text", newChat: false, silentMinutes: 1, phoneNumberId: "ph1", answeredBy: "bot" } });
    expect((await fireRules(answered, [r])).replied).toBe(false);
    expect(svc.sendText).not.toHaveBeenCalled();
    expect(logged().every((l) => l.outcome === "skipped")).toBe(true);
  });

  it("does not repeat a skipped log line within ten minutes", async () => {
    db.chatbotSession.findFirst.mockResolvedValue({ id: "s1" });
    db.ruleExecution.findFirst.mockImplementation(async ({ where }) => (where.outcome === "skipped" ? { id: "skip" } : null));
    await fireRules(event(), [rule({ actions: [text("auto")] })]);
    expect(db.ruleExecution.create).not.toHaveBeenCalled();
  });

  it("loop guard pauses a chat that has had too many runs", async () => {
    const [short] = LOOP_LIMITS;
    db.ruleExecution.count.mockImplementation(async ({ where }) => ((where.createdAt.gte as Date).getTime() >= NOW.getTime() - short.windowMs ? short.max : 0));
    const result = await fireRules(event(), [rule({ actions: [text("auto")] })]);
    expect(result.fired).toBe(0);
    expect(svc.sendText).not.toHaveBeenCalled();
    expect(logged()[0]).toMatchObject({ outcome: "skipped", detail: expect.stringContaining("too many") });
  });

  it("stops running when the plan's monthly runs are used up", async () => {
    hooks.billing.mockResolvedValue({ state: "active", planId: "p1" });
    db.plan.findUnique.mockResolvedValue({ features: { automationTriggersMonthly: 10 } });
    db.ruleExecution.count.mockImplementation(async ({ where }) => (where.conversationId ? 0 : 10));
    expect((await fireRules(event(), [rule({ actions: [text("auto")] })])).fired).toBe(0);
    db.ruleExecution.count.mockImplementation(async ({ where }) => (where.conversationId ? 0 : 9));
    resetMeteringCache();
    expect((await fireRules(event(), [rule({ actions: [text("auto")] })])).fired).toBe(1);
  });
});

describe("allowance, leases and converted rules", () => {
  const tag = (name: string): Action => ({ type: "add_tag", tag: name, scope: "contact" });

  it("leaves a visible trace when the monthly allowance blocks a rule, and stops mid-event when it runs out", async () => {
    hooks.billing.mockResolvedValue({ state: "active", planId: "p1" });
    db.plan.findUnique.mockResolvedValue({ features: { automationTriggersMonthly: 10 } });
    db.ruleExecution.count.mockImplementation(async ({ where }) => (where.conversationId ? 0 : 10));
    const a = rule({ actions: [text("auto")] });
    expect((await fireRules(event(), [a])).fired).toBe(0);
    expect(logged()).toEqual([expect.objectContaining({ ruleId: a.id, outcome: "skipped", detail: expect.stringContaining("allowance") })]);

    db.ruleExecution.create.mockClear();
    resetMeteringCache();
    db.ruleExecution.count.mockImplementation(async ({ where }) => (where.conversationId ? 0 : 9));
    const first = rule({ priority: 1, actions: [tag("one")] });
    const second = rule({ priority: 2, actions: [tag("two")] });
    expect((await fireRules(event(), [first, second])).fired).toBe(1);
    expect(logged().map((l) => [l.ruleId, l.outcome])).toEqual([[first.id, "ok"], [second.id, "skipped"]]);
  });

  it("takes a lease before a rule with a waiting time runs and gives it back afterwards", async () => {
    const r = rule({ actions: [text("hi")] });
    expect((await fireRules(event(), [r])).fired).toBe(1);
    expect(db.platformSetting.create).toHaveBeenCalledWith({ data: expect.objectContaining({ key: `automation-lease:${r.id}:v-cv1` }) });
    expect(db.platformSetting.deleteMany).toHaveBeenCalledWith({ where: { key: `automation-lease:${r.id}:v-cv1` } });
  });

  it("does not run a second time while another worker holds the lease, but takes over a stale one", async () => {
    const r = rule({ actions: [text("hi")] });
    db.platformSetting.create.mockRejectedValue(Object.assign(new Error("dup"), { code: "P2002" }));
    db.platformSetting.updateMany.mockResolvedValue({ count: 0 });
    expect((await fireRules(event(), [r])).fired).toBe(0);
    expect(svc.sendText).not.toHaveBeenCalled();
    const stale = db.platformSetting.updateMany.mock.calls[0][0].where.updatedAt.lt as Date;
    expect(Date.now() - stale.getTime()).toBeGreaterThan(60_000);
    db.platformSetting.updateMany.mockResolvedValue({ count: 1 });
    expect((await fireRules(event(), [r])).fired).toBe(1);
  });

  it("needs no lease for a rule that is allowed to run every time", async () => {
    const r = rule({ cooldownMinutes: 0, actions: [text("hi")] });
    expect((await fireRules(event(), [r])).fired).toBe(1);
    expect(db.platformSetting.create).not.toHaveBeenCalled();
  });

  it("a converted rule honours the waiting time recorded in the old log", async () => {
    const r = rule({ actions: [text("welcome back")] });
    db.automationRun.findFirst.mockResolvedValue({ id: "old-run" });
    expect((await fireRules(event(), [r])).fired).toBe(0);
    expect(db.automationRun.findFirst).toHaveBeenCalledWith(expect.objectContaining({ where: expect.objectContaining({ tenantId: "t1", ruleId: r.id, conversationId: "cv1" }) }));
    expect(svc.sendText).not.toHaveBeenCalled();
  });

  it("busyReason tells holiday mode and rules when a chatbot or a recent agent reply owns the chat", async () => {
    expect(await busyReason("t1", null, NOW)).toBeNull();
    expect(await busyReason("t1", { id: "cv1", assignedToId: null }, NOW)).toBeNull();
    db.chatbotSession.findFirst.mockResolvedValue({ id: "s1" });
    expect(await busyReason("t1", { id: "cv1", assignedToId: null }, NOW)).toMatch(/chatbot/);
    db.chatbotSession.findFirst.mockResolvedValue(null);
    db.message.findFirst.mockResolvedValue({ id: "m" });
    expect(await busyReason("t1", { id: "cv1", assignedToId: "u1" }, NOW)).toMatch(/person/);
    expect(db.message.findFirst.mock.calls.at(-1)![0].where).toMatchObject({ tenantId: "t1", conversationId: "cv1", direction: "outbound" });
  });
});

describe("actions", () => {
  it("skips free-form text outside the 24-hour window but still sends approved templates", async () => {
    conversationRow.lastInboundAt = new Date(NOW.getTime() - 30 * 3_600_000);
    db.template.findFirst.mockResolvedValue({ id: "tp1", name: "promo", language: "en", category: "UTILITY", status: "approved", components: [{ type: "BODY", text: "Hello {{1}}" }] });
    svc.sendTemplateMessage.mockResolvedValue({ id: "m2" });
    const r = rule({ actions: [text("free"), { type: "send_template", templateId: "tp1", variables: ["{{first_name}}"] }] });
    const result = await fireRules(event(), [r]);
    expect(result.fired).toBe(1);
    expect(svc.sendText).not.toHaveBeenCalled();
    expect(svc.sendTemplateMessage).toHaveBeenCalledWith(
      expect.objectContaining({ tenantId: "t1", phoneNumberId: "ph1", contactId: "c1", templateName: "promo", conversationId: "cv1", components: [{ type: "body", parameters: [{ type: "text", text: "Asha" }] }] }),
    );
    expect(db.template.findFirst).toHaveBeenCalledWith({ where: { id: "tp1", tenantId: "t1" } });
  });

  it("does not send marketing templates to contacts who never opted in, and skips unapproved templates", async () => {
    contactRow.optIn = false;
    db.template.findFirst.mockResolvedValue({ id: "tp1", name: "promo", language: "en", category: "MARKETING", status: "approved", components: [{ type: "BODY", text: "Hi" }] });
    const r = rule({ actions: [{ type: "send_template", templateId: "tp1", variables: [] }] });
    const result = await fireRules(event(), [r]);
    expect(result.fired).toBe(0);
    expect(svc.sendTemplateMessage).not.toHaveBeenCalled();
    expect(logged()[0].detail).toContain("not agreed to marketing");
    contactRow.optIn = true;
    db.template.findFirst.mockResolvedValue({ id: "tp1", name: "promo", language: "en", category: "UTILITY", status: "pending", components: [] });
    await fireRules(event(), [rule({ actions: [{ type: "send_template", templateId: "tp1", variables: [] }] })]);
    expect(svc.sendTemplateMessage).not.toHaveBeenCalled();
  });

  it("sends reply materials: text with placeholders and media as links", async () => {
    db.replyMaterial.findFirst.mockResolvedValueOnce({ id: "m1", name: "Greeting", kind: "text", body: "Hello {{name}}", mediaKey: null, mediaMime: null });
    await fireRules(event(), [rule({ actions: [{ type: "send_material", materialId: "m1" }] })]);
    expect(svc.sendText).toHaveBeenCalledWith({ tenantId: "t1", conversationId: "cv1", body: "Hello Asha Rao", origin: "automation" });
    db.replyMaterial.findFirst.mockResolvedValueOnce({ id: "m2", name: "Brochure", kind: "document", body: "Our brochure", mediaKey: "https://files.example.com/brochure.pdf", mediaMime: "application/pdf" });
    await fireRules(event(), [rule({ actions: [{ type: "send_material", materialId: "m2" }] })]);
    expect(svc.sendMedia).toHaveBeenCalledWith({ tenantId: "t1", conversationId: "cv1", mediaType: "document", media: "https://files.example.com/brochure.pdf", caption: "Our brochure", filename: "brochure.pdf", mime: "application/pdf", origin: "automation" });
    expect(db.replyMaterial.findFirst).toHaveBeenCalledWith({ where: { id: "m1", tenantId: "t1" } });
  });

  it("a deleted material is logged as a failure, not an exception", async () => {
    db.replyMaterial.findFirst.mockResolvedValue(null);
    const result = await fireRules(event(), [rule({ actions: [{ type: "send_material", materialId: "gone" }] })]);
    expect(result.fired).toBe(1);
    expect(logged()[0]).toMatchObject({ outcome: "failed", detail: expect.stringContaining("deleted") });
  });

  it("assigns to a person only when they belong to the workspace", async () => {
    db.membership.findFirst.mockResolvedValueOnce({ user: { disabledAt: null } });
    await fireRules(event(), [rule({ actions: [{ type: "assign_user", userId: "u9" }] })]);
    expect(db.membership.findFirst).toHaveBeenCalledWith(expect.objectContaining({ where: { tenantId: "t1", userId: "u9" } }));
    expect(db.conversation.updateMany).toHaveBeenCalledWith({ where: { id: "cv1", tenantId: "t1" }, data: { assignedToId: "u9", assignedAt: NOW } });
    db.conversation.updateMany.mockClear();
    db.membership.findFirst.mockResolvedValueOnce(null);
    await fireRules(event(), [rule({ actions: [{ type: "assign_user", userId: "ghost" }] })]);
    expect(db.conversation.updateMany).not.toHaveBeenCalled();
  });

  it("assigns to a team and picks the agent who was assigned longest ago", async () => {
    db.team.findFirst.mockResolvedValue({ id: "tm1" });
    db.teamMember.findMany.mockResolvedValue([{ userId: "u1" }, { userId: "u2" }, { userId: "u3" }]);
    db.membership.findMany.mockResolvedValue([
      { userId: "u1", user: { disabledAt: null } },
      { userId: "u2", user: { disabledAt: null } },
      { userId: "u3", user: { disabledAt: new Date() } },
    ]);
    db.agentAvailability.findMany.mockResolvedValue([
      { userId: "u1", available: true, lastAssignedAt: new Date("2026-10-27T09:00:00Z") },
      { userId: "u2", available: true, lastAssignedAt: new Date("2026-10-27T08:00:00Z") },
    ]);
    await fireRules(event(), [rule({ actions: [{ type: "assign_team", teamId: "tm1", pickAgent: true }] })]);
    expect(db.team.findFirst).toHaveBeenCalledWith(expect.objectContaining({ where: { id: "tm1", tenantId: "t1" } }));
    expect(db.conversation.updateMany).toHaveBeenCalledWith({ where: { id: "cv1", tenantId: "t1" }, data: { teamId: "tm1" } });
    expect(db.conversation.updateMany).toHaveBeenCalledWith({ where: { id: "cv1", tenantId: "t1", assignedToId: null }, data: { assignedToId: "u2", assignedAt: NOW } });
  });

  it("round robin uses routing, and does nothing to a chat that already has an agent", async () => {
    hooks.assignConversation.mockResolvedValue({ assignedToId: "u5", reason: "assigned" });
    await fireRules(event(), [rule({ actions: [{ type: "assign_round_robin" }] })]);
    expect(hooks.assignConversation).toHaveBeenCalledWith("t1", "cv1", { force: true, at: NOW });
    hooks.assignConversation.mockClear();
    conversationRow.assignedToId = "u1";
    await fireRules(event(), [rule({ actions: [{ type: "assign_round_robin" }] })]);
    expect(hooks.assignConversation).not.toHaveBeenCalled();
  });

  it("updates and clears contact details, matching the existing key case-insensitively", async () => {
    contactRow.attributes = { City: "Delhi", plan: "free" };
    await fireRules(event(), [rule({ actions: [{ type: "update_attribute", name: "city", value: "{{attribute.plan}}-user", remove: false }, { type: "update_attribute", name: "plan", value: "", remove: true }] })]);
    const writes = db.contact.updateMany.mock.calls.map(([a]) => a.data.attributes);
    expect(writes[0]).toEqual({ City: "free-user", plan: "free" });
    expect(writes[1]).toEqual({ City: "free-user" });
    contactRow.attributes = {};
  });

  it("adds and removes tags on the contact, the chat or both without duplicates", async () => {
    contactRow.tags = ["old"];
    conversationRow.tags = ["Old", "keep"];
    await fireRules(event(), [rule({ actions: [{ type: "add_tag", tag: "new", scope: "both" }, { type: "remove_tag", tag: "old", scope: "both" }, { type: "add_tag", tag: "NEW", scope: "chat" }] })]);
    const contactWrites = db.contact.updateMany.mock.calls.map(([a]) => a.data.tags);
    const chatWrites = db.conversation.updateMany.mock.calls.map(([a]) => a.data.tags);
    expect(contactWrites).toEqual([["old", "new"], ["new"]]);
    expect(chatWrites).toEqual([["Old", "keep", "new"], ["keep", "new"]]);
    contactRow.tags = [];
  });

  it("sets the chat status", async () => {
    await fireRules(event(), [rule({ actions: [{ type: "set_status", status: "pending" }] })]);
    expect(db.conversation.updateMany).toHaveBeenCalledWith({ where: { id: "cv1", tenantId: "t1" }, data: { status: "pending", statusChangedAt: NOW } });
  });

  it("notifies with an internal note and an email to the right people", async () => {
    db.membership.findMany.mockResolvedValue([{ user: { email: "boss@example.com", disabledAt: null } }, { user: { email: "gone@example.com", disabledAt: new Date() } }]);
    await fireRules(event(), [rule({ name: "VIP asks", actions: [{ type: "notify", target: "admins", userId: null, message: "{{first_name}} needs help" }] })]);
    expect(db.note.create).toHaveBeenCalledWith({ data: { tenantId: "t1", conversationId: "cv1", authorId: "automation", body: 'Rule "VIP asks": Asha needs help' } });
    expect(hooks.queueEmail).toHaveBeenCalledTimes(1);
    expect(hooks.queueEmail).toHaveBeenCalledWith(expect.objectContaining({ to: "boss@example.com", subject: "Needs attention: VIP asks" }));
    expect(db.membership.findMany).toHaveBeenCalledWith(expect.objectContaining({ where: { tenantId: "t1", role: { in: ["owner", "admin"] } } }));
  });

  it("starts a chatbot and the AI agent, clearing a stopped-AI marker first", async () => {
    hooks.startChatbot.mockResolvedValue({ sessionId: "s1" });
    await fireRules(event(), [rule({ actions: [{ type: "start_chatbot", chatbotId: "bot1" }] })]);
    expect(hooks.startChatbot).toHaveBeenCalledWith({ tenantId: "t1" }, "bot1", "cv1");

    conversationRow.tags = ["ai:stopped", "x"];
    hooks.handleInboundForAiAgent.mockResolvedValue(true);
    const result = await fireRules(event(), [rule({ actions: [{ type: "start_ai_agent" }] })]);
    expect(result.replied).toBe(true);
    expect(db.conversation.updateMany).toHaveBeenCalledWith({ where: { id: "cv1", tenantId: "t1" }, data: { tags: ["x"] } });
    expect(hooks.handleInboundForAiAgent).toHaveBeenCalledWith(expect.objectContaining({ tenantId: "t1", conversationId: "cv1", contactId: "c1", text: "what is the price" }));
  });

  it("starts a follow-up sequence for the contact's lead, creating a lead when there is none", async () => {
    db.leadSequence.findFirst.mockResolvedValue({ id: "sq1" });
    db.lead.findFirst.mockResolvedValue(null);
    db.lead.create.mockResolvedValue({ id: "l1" });
    db.leadSequenceRun.create.mockResolvedValue({ id: "run1" });
    await fireRules(event(), [rule({ actions: [{ type: "start_lead_sequence", sequenceId: "sq1" }] })]);
    expect(db.leadSequence.findFirst).toHaveBeenCalledWith(expect.objectContaining({ where: { id: "sq1", tenantId: "t1", enabled: true } }));
    expect(db.lead.create).toHaveBeenCalledWith(expect.objectContaining({ data: expect.objectContaining({ tenantId: "t1", contactId: "c1" }) }));
    expect(hooks.processRun).toHaveBeenCalledWith("run1", NOW);
    db.leadSequenceRun.create.mockRejectedValue(Object.assign(new Error("dup"), { code: "P2002" }));
    const again = await fireRules(event(), [rule({ actions: [{ type: "start_lead_sequence", sequenceId: "sq1" }] })]);
    expect(again.fired).toBe(0);
  });

  it("a crashing action is logged as failed without leaking details or stopping the other steps", async () => {
    svc.sendText.mockRejectedValue(new Error("db password is hunter2 for +919876543210"));
    const spy = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const r = rule({ actions: [text("auto"), { type: "add_tag", tag: "x", scope: "contact" }] });
    const result = await fireRules(event(), [r]);
    expect(result.fired).toBe(1);
    expect(logged()[0]).toMatchObject({ outcome: "failed", detail: "Send text: failed (something went wrong); Add tag: ok" });
    expect(JSON.stringify(spy.mock.calls)).not.toContain("hunter2");
    spy.mockRestore();
  });
});

describe("scheduled runs without a chat", () => {
  it("sends a template to a contact with no chat yet, creating the chat on the first connected number", async () => {
    db.template.findFirst.mockResolvedValue({ id: "tp1", name: "promo", language: "en", category: "UTILITY", status: "approved", components: [{ type: "BODY", text: "Hi" }] });
    db.conversation.findFirst.mockResolvedValue(null);
    db.phoneNumber.findFirst.mockResolvedValue({ id: "ph1" });
    svc.sendTemplateMessage.mockResolvedValue({ id: "m3" });
    const r = rule({ trigger: { type: "scheduled", repeat: "daily", time: "10:00", days: [], timezone: "UTC" }, actions: [text("free"), { type: "send_template", templateId: "tp1", variables: [] }] });
    const e = event({ type: "scheduled", conversationId: null, message: undefined, ruleId: r.id, dedupeSince: new Date("2026-10-27T10:00:00Z") });
    const result = await fireRules(e, [r]);
    expect(result.fired).toBe(1);
    expect(svc.sendText).not.toHaveBeenCalled();
    expect(svc.sendTemplateMessage).toHaveBeenCalledWith(expect.objectContaining({ phoneNumberId: "ph1", contactId: "c1" }));
    expect(db.phoneNumber.findFirst).toHaveBeenCalledWith(expect.objectContaining({ where: { tenantId: "t1", status: "connected" } }));
  });

  it("a schedule or waiting-time rule only runs when it was picked by id", async () => {
    const r = rule({ trigger: { type: "no_customer_response", minutes: 60 }, actions: [{ type: "add_tag", tag: "cold", scope: "contact" }] });
    expect((await fireRules(event({ type: "no_customer_response", message: undefined }), [r])).fired).toBe(0);
    expect((await fireRules(event({ type: "no_customer_response", message: undefined, ruleId: r.id }), [r])).fired).toBe(1);
  });
});

describe("dry run", () => {
  it("lists the message rules that fit a sample in running order", () => {
    const a = rule({ priority: 20, filters: [keyword("price")], actions: [text("a")] });
    const b = rule({ priority: 10, filters: [], actions: [text("b")] });
    const c = rule({ priority: 5, trigger: { type: "contact_created" }, actions: [text("c")] });
    const d = rule({ priority: 1, filters: [keyword("refund")], actions: [text("d")] });
    const hits = simulate([a, b, c, d], { text: "the price please", messageType: "text", newChat: false, silentMinutes: 0, at: NOW, phone: "", tags: [], attributes: {} });
    expect(hits.map((h) => h.id)).toEqual([b.id, a.id]);
  });
});
