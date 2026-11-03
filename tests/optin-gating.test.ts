import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";

/*
 * Marketing opt-in gating, end to end through the real central gate (sendTemplateMessage in src/lib/inbox/service.ts).
 * This file drives the gate itself, broadcasts, automation rules and the public/compat/MCP API. optin-paths.test.ts drives lead
 * sequences, abandoned-cart reminders, approval resend and the inbox template sender, and optin-chatbots.test.ts the chatbot
 * template node, all through the same real gate. The path list is in docs/ops.md ("Opt-in gating"); the last describe keeps
 * that list honest.
 */

const db = vi.hoisted(() => {
  const model = () => ({ findUnique: vi.fn(), findFirst: vi.fn(), findMany: vi.fn(), create: vi.fn(), update: vi.fn(), updateMany: vi.fn(), deleteMany: vi.fn(), upsert: vi.fn() });
  return {
    conversation: model(),
    message: model(),
    phoneNumber: model(),
    contact: model(),
    template: model(),
    broadcastRecipient: model(),
    auditLog: model(),
  };
});
const enqueue = vi.hoisted(() => vi.fn());
vi.mock("@/lib/db", () => ({ prisma: db }));
vi.mock("@/lib/queue", () => ({ enqueue }));
vi.mock("@/lib/tenant-state", () => ({ tenantMayRunBackground: async () => true }));
vi.mock("@/lib/tenant-lifecycle-state", () => ({ backgroundGate: async () => "ok" }));
vi.mock("@/lib/billing", () => ({ assertWithinLimit: async () => undefined, assertTenantCanWrite: async () => undefined }));
vi.mock("@/lib/auth/audit", () => ({ audit: vi.fn(async () => undefined) }));
vi.mock("@/lib/integrations/events", () => ({ emitEvent: async () => undefined }));
vi.mock("@/lib/integrations/emitters", () => ({ emitBroadcastCompleted: async () => undefined, emitStatusChanged: async () => undefined }));
vi.mock("@/lib/chatbots/human-reply", () => ({ stopBotsOnHumanReply: async () => undefined }));
vi.mock("@/lib/routing", () => ({ onConversationAssigned: async () => undefined, assignConversation: async () => undefined }));
vi.mock("@/lib/automation/v2/emit", () => ({ emitTagChanges: async () => undefined }));
vi.mock("@/lib/chatbots", () => ({ startChatbot: async () => undefined }));
vi.mock("@/lib/ai-agent", () => ({ handleInboundForAiAgent: async () => false, STOP_TAG: "stop-ai" }));
vi.mock("@/lib/email", () => ({ queueEmail: async () => undefined, sendEmail: async () => undefined }));
vi.mock("@/lib/leads/runner", () => ({ processRun: async () => false }));

import { runAction, type ActionEnv } from "@/lib/automation/v2/actions";
import { sendOne } from "@/lib/broadcasts/process";
import { sendTemplateMessage } from "@/lib/inbox/service";
import { sendMessageV1 } from "@/lib/integrations/v1-service";

const T = "t1";
const marketing = { category: "MARKETING", name: "promo", language: "en", status: "approved", components: [{ type: "BODY", text: "Hello" }] };

function arrange(contact: Record<string, unknown>, template: Record<string, unknown> | null = marketing) {
  db.phoneNumber.findFirst.mockResolvedValue({ id: "ph1", wabaRefId: "w1" });
  db.contact.findFirst.mockResolvedValue({ id: "c1", tenantId: T, phone: "+919876543210", bsuid: null, optIn: false, optedOutAt: null, ...contact });
  db.template.findFirst.mockResolvedValue(template);
  db.conversation.upsert.mockResolvedValue({ id: "cv1", lastInboundAt: null });
  db.message.create.mockImplementation(async ({ data }: { data: object }) => ({ id: "m1", ...data }));
}

const nothingQueued = () => {
  expect(db.message.create).not.toHaveBeenCalled();
  expect(enqueue).not.toHaveBeenCalled();
};

beforeEach(() => {
  vi.clearAllMocks();
  db.broadcastRecipient.updateMany.mockResolvedValue({ count: 1 });
  db.broadcastRecipient.update.mockResolvedValue({});
});

describe("central gate: sendTemplateMessage", () => {
  const send = () => sendTemplateMessage({ tenantId: T, origin: "unknown", phoneNumberId: "ph1", contactId: "c1", templateName: "promo", language: "en" });

  it("refuses a marketing template for a contact who never opted in", async () => {
    arrange({ optIn: false });
    await expect(send()).rejects.toMatchObject({ status: 422 });
    nothingQueued();
  });

  it("refuses it when the category is stored in lower case", async () => {
    arrange({ optIn: false }, { ...marketing, category: "marketing" });
    await expect(send()).rejects.toMatchObject({ status: 422 });
    nothingQueued();
  });

  it("refuses marketing to a contact who sent STOP, even one with an old opt-in", async () => {
    arrange({ optIn: true, optedOutAt: new Date() }, marketing);
    await expect(send()).rejects.toMatchObject({ status: 422 });
    nothingQueued();
  });

  it("lets a utility template through to a contact who sent STOP: an opt-out stops marketing only (owner default 1)", async () => {
    arrange({ optIn: false, optedOutAt: new Date() }, { ...marketing, category: "UTILITY" });
    await expect(send()).resolves.toBeTruthy();
  });

  it("fails closed for a template the workspace has no row for", async () => {
    arrange({ optIn: false }, null);
    await expect(send()).rejects.toMatchObject({ status: 422 });
    nothingQueued();
  });

  it("does not let a template that exists only under another WhatsApp account bypass opt-in", async () => {
    arrange({ optIn: false }, null);
    db.template.findFirst.mockResolvedValueOnce(null).mockResolvedValueOnce(marketing);
    await expect(send()).rejects.toMatchObject({ status: 422 });
    nothingQueued();
  });

  it("sends once the contact has opted in", async () => {
    arrange({ optIn: true });
    await expect(send()).resolves.toMatchObject({ type: "template" });
    expect(enqueue).toHaveBeenCalledTimes(1);
  });

  it("looks the contact up with the tenant id", async () => {
    arrange({ optIn: true });
    await send();
    expect(db.contact.findFirst).toHaveBeenCalledWith(expect.objectContaining({ where: { id: "c1", tenantId: T } }));
  });
});

describe("path: broadcasts", () => {
  const broadcast = { id: "b1", tenantId: T, phoneNumberId: "ph1", template: { name: "promo", language: "en", components: [{ type: "BODY", text: "Hello" }], category: "MARKETING" } };
  const recipient = (contact: Record<string, unknown>) => ({ id: "r1", attempts: 0, contact: { id: "c1", name: "A", phone: "+919876543210", attributes: {}, optIn: false, optedOutAt: null, ...contact } });

  it("skips a recipient who has not opted in without touching the send path", async () => {
    await sendOne(broadcast, recipient({ optIn: false }) as never);
    expect(db.broadcastRecipient.update).toHaveBeenCalledWith(expect.objectContaining({ data: { status: "skipped" } }));
    expect(db.phoneNumber.findFirst).not.toHaveBeenCalled();
    nothingQueued();
  });

  it("is refused by the central gate when the audience snapshot is stale (opted out after it was built)", async () => {
    arrange({ optIn: false });
    await sendOne(broadcast, recipient({ optIn: true }) as never);
    const update = db.broadcastRecipient.update.mock.calls[0][0].data;
    expect(update.status).toBe("failed");
    nothingQueued();
  });
});

describe("path: automation rules (send template action)", () => {
  const env = (optIn: boolean): ActionEnv => ({
    tenantId: T,
    rule: { id: "r1", name: "Promo", phoneNumberId: null },
    contact: { id: "c1", name: "Asha", phone: "+919876543210", tags: [], attributes: {}, optIn },
    conversation: { id: "cv1", phoneNumberId: "ph1", assignedToId: null, tags: [], teamId: null, lastInboundAt: null, status: "open" },
    inbound: null,
    now: new Date(),
  });
  const action = { type: "send_template", templateId: "tp1", variables: [] } as never;

  it("skips when the rule's own snapshot says the contact has not opted in", async () => {
    db.template.findFirst.mockResolvedValue({ id: "tp1", ...marketing });
    const result = await runAction(action, env(false));
    expect(result.status).toBe("skipped");
    expect(result.note).toMatch(/marketing/);
    nothingQueued();
  });

  it("is refused by the central gate when the snapshot is stale", async () => {
    db.template.findFirst.mockResolvedValue({ id: "tp1", ...marketing });
    db.phoneNumber.findFirst.mockResolvedValue({ id: "ph1", wabaRefId: "w1" });
    db.contact.findFirst.mockResolvedValue({ id: "c1", phone: "+919876543210", bsuid: null, optIn: false, optedOutAt: null });
    const result = await runAction(action, env(true));
    expect(result.status).toBe("failed");
    nothingQueued();
  });
});

describe("path: public API, compat API and MCP (all call sendMessageV1)", () => {
  const actor = { tenantId: T, userId: "u1", role: "admin" } as never;
  const body = { to: "+919876543210", type: "template", template: { name: "promo", language: "en", components: [] } };

  it("422 for a marketing template to an existing contact without opt-in", async () => {
    db.phoneNumber.findFirst.mockResolvedValue({ id: "ph1", wabaRefId: "w1" });
    db.template.findFirst.mockResolvedValue({ category: "MARKETING" });
    db.contact.findFirst.mockResolvedValue({ id: "c1", phone: "+919876543210", optIn: false, optedOutAt: null });
    await expect(sendMessageV1(actor, body)).rejects.toMatchObject({ status: 422 });
    nothingQueued();
  });

  it("422 for a marketing template to a number that is not a contact yet, and creates no contact", async () => {
    db.phoneNumber.findFirst.mockResolvedValue({ id: "ph1", wabaRefId: "w1" });
    db.template.findFirst.mockResolvedValue({ category: "MARKETING" });
    db.contact.findFirst.mockResolvedValue(null);
    await expect(sendMessageV1(actor, body)).rejects.toMatchObject({ status: 422 });
    expect(db.contact.create).not.toHaveBeenCalled();
    nothingQueued();
  });

  it("422 for a marketing template to a contact who sent STOP, even with an old opt-in", async () => {
    db.phoneNumber.findFirst.mockResolvedValue({ id: "ph1", wabaRefId: "w1" });
    db.template.findFirst.mockResolvedValue({ category: "MARKETING" });
    db.contact.findFirst.mockResolvedValue({ id: "c1", phone: "+919876543210", optIn: true, optedOutAt: new Date() });
    await expect(sendMessageV1(actor, body)).rejects.toMatchObject({ status: 422 });
    nothingQueued();
  });

  it("a utility template still reaches a contact who sent STOP", async () => {
    db.phoneNumber.findFirst.mockResolvedValue({ id: "ph1", wabaRefId: "w1" });
    db.template.findFirst.mockResolvedValue({ category: "UTILITY" });
    db.contact.findFirst.mockResolvedValue({ id: "c1", phone: "+919876543210", optIn: false, optedOutAt: new Date() });
    await expect(sendMessageV1(actor, body)).resolves.toBeTruthy();
  });
});

/*
 * Structural guard. If a new feature starts sending templates it must go through sendTemplateMessage (which enforces the gate);
 * add it to this list, to docs/ops.md and give it a test above. Queueing a template message anywhere else fails this test.
 *
 * These checks read every source file (about 1,100). Under the full suite's parallel load that can pass vitest's 5 s default
 * although nothing is wrong, so the block gets a realistic 30 s budget, and each file is read once and shared by the three checks.
 */
describe("every template send goes through the central gate", { timeout: 30_000 }, () => {
  const SRC = path.join(process.cwd(), "src");
  const files: string[] = [];
  (function walk(dir: string) {
    for (const entry of readdirSync(dir)) {
      const full = path.join(dir, entry);
      if (entry === "generated") continue;
      if (statSync(full).isDirectory()) walk(full);
      else if (/\.tsx?$/.test(entry)) files.push(full);
    }
  })(SRC);
  const rel = (f: string) => path.relative(SRC, f).split(path.sep).join("/");
  const sources = new Map<string, string>();
  const read = (f: string) => {
    let source = sources.get(f);
    if (source === undefined) sources.set(f, (source = readFileSync(f, "utf8")));
    return source;
  };

  const CALLERS = [
    "lib/admin/service.ts",
    "lib/approvals/resend.ts",
    "lib/automation/v2/actions.ts",
    "lib/broadcasts/process.ts",
    "lib/chatbots/engine.ts",
    "lib/commerce/reminders.ts",
    "lib/inbox/template-send.ts",
    "lib/integrations/v1-service.ts",
    "lib/leads/runner.ts",
    "lib/spend/notify/platform-sender.ts",
  ];

  it("lists exactly the known callers of sendTemplateMessage", () => {
    const callers = files.filter((f) => /\bsendTemplateMessage\(/.test(read(f)) && rel(f) !== "lib/inbox/service.ts").map(rel).sort();
    expect(callers).toEqual([...CALLERS].sort());
  });

  it("only the inbox service creates outbound template messages", () => {
    const creators = files.filter((f) => /queueOutbound\(/.test(read(f))).map(rel);
    expect(creators).toEqual(["lib/inbox/service.ts"]);
  });

  it("the Cloud API template body is built in one place", () => {
    const builders = files.filter((f) => /type: "template", template: \{ name: str\(t\.name\)/.test(read(f))).map(rel);
    expect(builders).toEqual(["lib/inbox/send.ts"]);
  });
});
