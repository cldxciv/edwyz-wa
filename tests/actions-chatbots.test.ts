import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { FakeActionsDb } from "./helpers/fake-actions-db";

/**
 * Eddy builds and changes chatbots in the chat (2026-10-30), through the real executor (invoke.ts) over the in-memory
 * database and the real chatbot service and flow validation:
 * - create_chatbot and update_chatbot save drafts only (the live bot keeps its publishedFlow), validate in full, and Undo;
 * - Eddy never writes a webhook step: get_chatbot hides them, update_chatbot keeps the saved ones, a new one is refused;
 * - publish_chatbot is a card, refused for bots that cost money and for a live bot with nothing new.
 */
const h = vi.hoisted(() => ({ db: null as unknown as FakeActionsDb }));

vi.mock("@/lib/db", async () => {
  const { createFakeActionsDb } = await import("./helpers/fake-actions-db");
  h.db = createFakeActionsDb();
  return { prisma: h.db.prisma };
});

import { confirmAction, proposeAction, resetInvokeState, undoAction } from "@/lib/actions/invoke";
import { clearPrincipalMemo, eddyPrincipal } from "@/lib/actions/principal";
import { isUntrustedText } from "@/lib/actions/untrusted";
import { ADMIN, AGENT, T1, seedMembers, testDeps } from "./helpers/action-fixtures";

vi.setConfig({ testTimeout: 30_000 });
beforeAll(async () => {
  await Promise.all([import("@/lib/chatbots/service"), import("@/lib/chatbots/flow"), import("@/components/chatbots/layout"), import("@/lib/auth/audit"), import("@/lib/actions/canonical")]);
}, 120_000);

const eddy = (actor: { userId: string; tenantId: string; role: "agent" | "admin" | "owner" } = ADMIN) =>
  eddyPrincipal({ actor, emailVerified: true, conversationId: "cv_eddy", lang: "en", turnId: `turn_${Math.random()}` });

const FLOW = {
  start: "welcome",
  nodes: [
    { id: "welcome", type: "send_buttons", data: { text: "Hi {{contact.name}}, how can we help?", buttons: [{ id: "book", title: "Book a table" }, { id: "menu", title: "See the menu" }] } },
    { id: "ask_name", type: "ask", data: { text: "What name should the booking be under?", variable: "name", validate: "text" } },
    { id: "menu_text", type: "send_text", data: { text: "Our menu changes daily." } },
    { id: "handover", type: "handoff", data: { message: "Thanks {{name}}, a teammate will confirm.", teamId: "team_sales" } },
  ],
  edges: [
    { from: "welcome", to: "ask_name", label: "book" },
    { from: "welcome", to: "menu_text", label: "menu" },
    { from: "ask_name", to: "handover" },
    { from: "menu_text", to: "handover" },
  ],
};
const args = (over: Record<string, unknown> = {}) => ({ name: "Table bookings", triggerType: "keyword", triggerKeywords: ["book", "menu"], flow: JSON.stringify(FLOW), ...over });
const bot = (id: string) => h.db.rows("chatbot").find((b) => b.id === id)!;
const detail = (out: Awaited<ReturnType<typeof proposeAction>>) => (out.model as { detail?: { text: string } }).detail?.text ?? "";

async function created(): Promise<string> {
  const out = await proposeAction(eddy(), "create_chatbot", args(), {}, testDeps());
  expect(out.model, JSON.stringify(out.model)).toMatchObject({ status: "done", undoAvailable: true });
  return (out.model as { result: { chatbotId: string } }).result.chatbotId;
}

beforeEach(() => {
  h.db.reset();
  seedMembers(h.db);
  h.db.insert("team", { id: "team_sales", tenantId: T1, name: "Sales", isDefault: false });
  resetInvokeState();
  clearPrincipalMemo();
});

describe("create_chatbot", () => {
  it("saves a draft that messages nobody, laid out for the builder, and Undo deletes it", async () => {
    const deps = testDeps();
    const out = await proposeAction(eddy(), "create_chatbot", args(), {}, deps);
    expect(out.model).toMatchObject({ status: "done", undoAvailable: true });
    const result = (out.model as { result: { chatbotId: string; steps: number; note: string } }).result;
    expect(result.steps).toBe(4);
    expect(result.note).toMatch(/draft/);
    expect(out.ui).toEqual({ kind: "navigate", path: `/app/automation/chatbots/${result.chatbotId}`, labelKey: "btn.open_page" });
    const row = bot(result.chatbotId);
    expect(row).toMatchObject({ tenantId: T1, name: "Table bookings", status: "draft", publishedFlow: null, triggerKeywords: ["book", "menu"] });
    const flow = row.flow as { nodes: { id: string; position: { x: number; y: number } }[]; edges: { id: string }[] };
    // The builder's layered layout: the start step in the first column, the two branches in the next.
    const at = Object.fromEntries(flow.nodes.map((n) => [n.id, n.position]));
    expect(at.welcome.x).toBeLessThan(at.ask_name.x);
    expect(at.ask_name.x).toBe(at.menu_text.x);
    expect(at.ask_name.y).not.toBe(at.menu_text.y);
    expect(flow.edges.map((e) => e.id)).toEqual(["e1", "e2", "e3", "e4"]);
    expect(h.db.rows("auditLog").map((a) => a.action)).toContain("chatbot.created");

    const undone = await undoAction({ principal: eddy(), actionId: out.actionId! }, deps);
    expect(undone).toMatchObject({ status: 200, state: "undone" });
    expect(h.db.rows("chatbot")).toHaveLength(0);
  });

  it("sends a flow that would not publish back to the model with the problems to fix, and saves nothing", async () => {
    const broken = { ...FLOW, nodes: [{ ...FLOW.nodes[0], data: { text: "Hi", buttons: [{ id: "book", title: "A button title that is far too long" }] } }, ...FLOW.nodes.slice(1)] };
    const bad = await proposeAction(eddy(), "create_chatbot", args({ flow: JSON.stringify(broken) }), {}, testDeps());
    expect(bad.model).toMatchObject({ status: "failed", code: "invalid" });
    expect(detail(bad)).toMatch(/Step welcome: Each button title must be 1 to 20 characters/);
    const notJson = await proposeAction(eddy(), "create_chatbot", args({ flow: "{nodes:" }), {}, testDeps());
    expect(detail(notJson)).toBe("The flow is not valid JSON.");
    const noKeyword = await proposeAction(eddy(), "create_chatbot", args({ triggerKeywords: [] }), {}, testDeps());
    expect(detail(noKeyword)).toMatch(/at least one keyword/);
    expect(h.db.rows("chatbot")).toHaveLength(0);
  });

  it("never writes a webhook step, and is for owners and admins only", async () => {
    const hook = { ...FLOW, nodes: [...FLOW.nodes.slice(0, 3), { id: "hook", type: "webhook", data: { url: "https://example.com/x", method: "POST" } }, FLOW.nodes[3]] };
    const out = await proposeAction(eddy(), "create_chatbot", args({ flow: JSON.stringify(hook) }), {}, testDeps());
    expect(out.model).toMatchObject({ status: "failed" });
    expect(detail(out)).toMatch(/Webhook steps can only be added on the chatbot page/);
    expect((await proposeAction(eddy(AGENT), "create_chatbot", args(), {}, testDeps())).model).toMatchObject({ status: "refused", code: "role" });
    expect(h.db.rows("chatbot")).toHaveLength(0);
  });
});

describe("get_chatbot", () => {
  it("shows the draft flow as untrusted JSON in the update shape, with webhook details hidden and the problems listed", async () => {
    h.db.insert("chatbot", {
      id: "bot_hook",
      tenantId: T1,
      name: "Leads",
      status: "draft",
      triggerType: "keyword",
      triggerKeywords: [],
      flow: { version: 1, start: "a", nodes: [{ id: "a", type: "webhook", position: { x: 1, y: 2 }, data: { url: "https://secret.example.com/hook", method: "POST", bodyTemplate: "{{phone}}" } }], edges: [] },
    });
    const out = await proposeAction(eddy(AGENT), "get_chatbot", { chatbotId: "bot_hook" }, {}, testDeps());
    expect(out.model.status).toBe("done");
    const r = (out.model as { result: { flow: unknown; problems: unknown[]; name: unknown; unpublishedChanges: boolean } }).result;
    expect(isUntrustedText(r.flow)).toBe(true);
    expect(isUntrustedText(r.name)).toBe(true);
    const flowText = (r.flow as { text: string }).text;
    expect(JSON.parse(flowText)).toEqual({ start: "a", nodes: [{ id: "a", type: "webhook", data: {} }], edges: [] });
    expect(JSON.stringify(out.model)).not.toContain("secret.example.com");
    expect(r.problems.map((p) => (p as { text: string }).text)).toContain("Add at least one keyword, or choose another trigger.");
    expect(r.unpublishedChanges).toBe(false);
  });
});

describe("update_chatbot", () => {
  it("changes the draft only: positions the member set are kept, the live steps are untouched, and Undo puts the old draft back", async () => {
    const id = await created();
    const row = bot(id);
    (row.flow as { nodes: { id: string; position: { x: number; y: number } }[] }).nodes.find((n) => n.id === "welcome")!.position = { x: 777, y: 555 };
    row.status = "published";
    row.publishedFlow = { marker: "live steps" };
    const before = JSON.parse(JSON.stringify(row.flow));

    const changed = { ...FLOW, nodes: [...FLOW.nodes, { id: "bye", type: "send_text", data: { text: "See you soon." } }], edges: [...FLOW.edges.filter((e) => e.from !== "menu_text"), { from: "menu_text", to: "bye" }] };
    const deps = testDeps();
    const out = await proposeAction(eddy(), "update_chatbot", { chatbotId: id, ...args({ name: "Bookings and menu", flow: JSON.stringify(changed) }) }, {}, deps);
    expect(out.model, JSON.stringify(out.model)).toMatchObject({ status: "done", undoAvailable: true });
    expect((out.model as { result: { live: boolean; note: string } }).result).toMatchObject({ live: true, note: expect.stringMatching(/still runs its old steps/) });
    const saved = bot(id).flow as { nodes: { id: string; position: { x: number; y: number } }[] };
    expect(saved.nodes.find((n) => n.id === "welcome")!.position).toEqual({ x: 777, y: 555 });
    expect(saved.nodes.map((n) => n.id)).toContain("bye");
    expect(bot(id).name).toBe("Bookings and menu");
    expect(bot(id).publishedFlow).toEqual({ marker: "live steps" });

    const undone = await undoAction({ principal: eddy(), actionId: out.actionId! }, deps);
    expect(undone).toMatchObject({ status: 200, state: "undone" });
    expect(bot(id).flow).toEqual(before);
    expect(bot(id).name).toBe("Table bookings");
  });

  it("keeps a saved webhook step by its id and refuses a new one", async () => {
    h.db.insert("chatbot", {
      id: "bot_w",
      tenantId: T1,
      name: "Leads",
      status: "draft",
      triggerType: "manual",
      triggerKeywords: [],
      flow: {
        version: 1,
        start: "hi",
        nodes: [
          { id: "hi", type: "send_text", position: { x: 0, y: 0 }, data: { text: "Hi" } },
          { id: "hook", type: "webhook", position: { x: 300, y: 0 }, data: { url: "https://crm.example.com/in", method: "POST" } },
        ],
        edges: [{ id: "e1", from: "hi", to: "hook" }],
      },
    });
    const flow = { start: "hi", nodes: [{ id: "hi", type: "send_text", data: { text: "Hello there" } }, { id: "hook", type: "webhook", data: {} }], edges: [{ from: "hi", to: "hook" }] };
    const out = await proposeAction(eddy(), "update_chatbot", { chatbotId: "bot_w", name: "Leads", triggerType: "manual", triggerKeywords: [], flow: JSON.stringify(flow) }, {}, testDeps());
    expect(out.model, JSON.stringify(out.model)).toMatchObject({ status: "done" });
    const nodes = (bot("bot_w").flow as { nodes: { id: string; data: Record<string, unknown> }[] }).nodes;
    expect(nodes.find((n) => n.id === "hook")!.data).toEqual({ url: "https://crm.example.com/in", method: "POST" });
    expect(nodes.find((n) => n.id === "hi")!.data).toEqual({ text: "Hello there" });

    const added = { ...flow, nodes: [...flow.nodes, { id: "hook2", type: "webhook", data: { url: "https://evil.example.com", method: "POST" } }], edges: [...flow.edges, { from: "hook", to: "hook2" }] };
    const refused = await proposeAction(eddy(), "update_chatbot", { chatbotId: "bot_w", name: "Leads", triggerType: "manual", triggerKeywords: [], flow: JSON.stringify(added) }, {}, testDeps());
    expect(detail(refused)).toMatch(/Webhook steps can only be added on the chatbot page/);
    expect(JSON.stringify(bot("bot_w").flow)).not.toContain("evil.example.com");
  });
});

describe("publish_chatbot", () => {
  it("is a card that arms automation and publishes only on confirm; a live bot with nothing new is refused", async () => {
    const id = await created();
    const deps = testDeps();
    const out = await proposeAction(eddy(), "publish_chatbot", { chatbotId: id }, {}, deps);
    expect(out.model.status).toBe("preview_shown");
    expect(out.card!.preview.warnings).toContain("arms_automation");
    expect(bot(id).status).toBe("draft");
    const card = out.card!;
    const done = await confirmAction({ principal: eddy(), actionId: card.actionId, nonce: card.nonce, previewHash: card.previewHash }, deps);
    expect(done).toMatchObject({ status: 200, state: "done" });
    expect(bot(id).status).toBe("published");
    expect(bot(id).publishedFlow).toBeTruthy();

    const again = await proposeAction(eddy(), "publish_chatbot", { chatbotId: id }, {}, testDeps());
    expect(detail(again)).toBe("It is already live with these steps.");

    // A saved change makes it publishable again.
    const changed = { ...FLOW, nodes: FLOW.nodes.map((n) => (n.id === "menu_text" ? { ...n, data: { text: "Today: dosa and filter coffee." } } : n)) };
    await proposeAction(eddy(), "update_chatbot", { chatbotId: id, ...args({ flow: JSON.stringify(changed) }) }, {}, testDeps());
    expect((await proposeAction(eddy(), "publish_chatbot", { chatbotId: id }, {}, testDeps())).model.status).toBe("preview_shown");
  });

  it("puts a saved change of a live bot's keywords live: get_chatbot shows it and publish_chatbot offers it", async () => {
    const id = await created();
    const deps = testDeps();
    const first = (await proposeAction(eddy(), "publish_chatbot", { chatbotId: id }, {}, deps)).card!;
    await confirmAction({ principal: eddy(), actionId: first.actionId, nonce: first.nonce, previewHash: first.previewHash }, deps);
    expect(bot(id).status).toBe("published");

    // Only the words change. Customers keep the live words until the change is published.
    const saved = await proposeAction(eddy(), "update_chatbot", { chatbotId: id, ...args({ triggerKeywords: ["table"] }) }, {}, testDeps());
    expect(saved.model, JSON.stringify(saved.model)).toMatchObject({ status: "done" });
    expect(bot(id).triggerKeywords).toEqual(["book", "menu"]);
    const view = (await proposeAction(eddy(AGENT), "get_chatbot", { chatbotId: id }, {}, testDeps())).model as { result: { unpublishedChanges: boolean; triggerKeywords: { text: string }[] } };
    expect(view.result.unpublishedChanges).toBe(true);
    expect(view.result.triggerKeywords.map((k) => k.text)).toEqual(["table"]);

    const deps2 = testDeps();
    const again = await proposeAction(eddy(), "publish_chatbot", { chatbotId: id }, {}, deps2);
    expect(again.model.status, JSON.stringify(again.model)).toBe("preview_shown");
    expect(JSON.stringify(again.card!.preview)).toContain("table");
    const card = again.card!;
    expect(await confirmAction({ principal: eddy(), actionId: card.actionId, nonce: card.nonce, previewHash: card.previewHash }, deps2)).toMatchObject({ status: 200, state: "done" });
    expect(bot(id).triggerKeywords).toEqual(["table"]);
    expect(bot(id).flow).not.toHaveProperty("trigger");
    expect(detail(await proposeAction(eddy(), "publish_chatbot", { chatbotId: id }, {}, testDeps()))).toBe("It is already live with these steps.");
  });

  it("refuses a chatbot that costs money (a template step) and is for owners and admins only", async () => {
    const withTemplate = { ...FLOW, nodes: FLOW.nodes.map((n) => (n.id === "menu_text" ? { id: "menu_text", type: "send_template", data: { templateId: "tpl_1", variables: {} } } : n)) };
    const out = await proposeAction(eddy(), "create_chatbot", args({ flow: JSON.stringify(withTemplate) }), {}, testDeps());
    const id = (out.model as { result: { chatbotId: string } }).result.chatbotId;
    const refused = await proposeAction(eddy(), "publish_chatbot", { chatbotId: id }, {}, testDeps());
    expect(refused.model.status).not.toBe("preview_shown");
    expect(bot(id).status).toBe("draft");
    expect((await proposeAction(eddy(AGENT), "publish_chatbot", { chatbotId: id }, {}, testDeps())).model).toMatchObject({ status: "refused", code: "role" });
  });
});
