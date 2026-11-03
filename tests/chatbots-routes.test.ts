import { beforeEach, describe, expect, it, vi } from "vitest";

const db = vi.hoisted(() => {
  const model = () => ({ findFirst: vi.fn(), findMany: vi.fn(), create: vi.fn(), updateMany: vi.fn(), deleteMany: vi.fn(), count: vi.fn() });
  return { chatbot: model(), chatbotSession: model(), phoneNumber: model(), contact: model(), team: model() };
});
const auth = vi.hoisted(() => ({ role: "admin" as "agent" | "admin" | "owner" }));
vi.mock("@/lib/db", () => ({ prisma: db }));
vi.mock("@/lib/auth", () => ({ getActor: async () => ({ userId: "u1", tenantId: "t1", role: auth.role }) }));
const visibility = vi.hoisted(() => ({
  scope: null as Record<string, unknown> | null,
  mask: false,
  visible: null as Set<string> | null,
}));
vi.mock("@/lib/teams/visibility", () => ({
  conversationScopeFor: async () => visibility.scope,
  shouldMaskFor: async () => visibility.mask,
  visibleConversationIds: async (_viewer: unknown, ids: string[]) => visibility.visible ?? new Set(ids),
  maskContact: (contact: { phone?: string } | null, on: boolean) => (on && contact ? { ...contact, phone: "+91*****0000" } : contact),
}));

import { GET as list, POST as create } from "@/app/api/chatbots/route";
import { DELETE as remove, GET as getOne, PATCH as patch } from "@/app/api/chatbots/[id]/route";
import { POST as publish } from "@/app/api/chatbots/[id]/publish/route";
import { POST as unpublish } from "@/app/api/chatbots/[id]/unpublish/route";
import { POST as archive } from "@/app/api/chatbots/[id]/archive/route";
import { POST as duplicate } from "@/app/api/chatbots/[id]/duplicate/route";
import { POST as testRun } from "@/app/api/chatbots/[id]/test-run/route";
import { GET as sessions } from "@/app/api/chatbots/[id]/sessions/route";

const ORIGIN = "https://wa.edwyz.com";
const call = (path: string, body?: unknown, method = "POST", origin: string | null = ORIGIN) =>
  new Request(`${ORIGIN}${path}`, { method, headers: { "content-type": "application/json", ...(origin ? { origin } : {}) }, body: body === undefined ? undefined : JSON.stringify(body) });
const ctx = { params: Promise.resolve({ id: "b1" }) };

const goodFlow = {
  version: 1,
  start: "a",
  nodes: [{ id: "a", type: "send_text", position: { x: 0, y: 0 }, data: { text: "hi" } }],
  edges: [],
};
const bot = (extra: Record<string, unknown> = {}) => ({ id: "b1", tenantId: "t1", name: "Bot", status: "draft", triggerType: "keyword", triggerKeywords: ["hi"], flow: goodFlow, publishedFlow: null, version: 1, ...extra });

beforeEach(() => {
  vi.clearAllMocks();
  auth.role = "admin";
  db.chatbot.count.mockResolvedValue(0);
  db.chatbot.findFirst.mockResolvedValue(bot());
  db.chatbot.create.mockImplementation(async ({ data }) => ({ id: "new", ...data }));
  db.chatbot.updateMany.mockResolvedValue({ count: 1 });
  db.chatbot.deleteMany.mockResolvedValue({ count: 1 });
  db.chatbotSession.updateMany.mockResolvedValue({ count: 0 });
  db.contact.findMany.mockResolvedValue([]);
});

describe("permissions and origin", () => {
  it("agents can read but not write", async () => {
    auth.role = "agent";
    db.chatbot.findMany.mockResolvedValue([]);
    expect((await list(new Request(`${ORIGIN}/api/chatbots`))).status).toBe(200);
    expect((await getOne(new Request(`${ORIGIN}/api/chatbots/b1`), ctx)).status).toBe(200);
    db.chatbotSession.findMany.mockResolvedValue([]);
    expect((await sessions(new Request(`${ORIGIN}/api/chatbots/b1/sessions`), ctx)).status).toBe(200);
    const writes = [
      create(call("/api/chatbots", { name: "x" })),
      patch(call("/api/chatbots/b1", { name: "x" }, "PATCH"), ctx),
      remove(call("/api/chatbots/b1", undefined, "DELETE"), ctx),
      publish(call("/api/chatbots/b1/publish"), ctx),
      unpublish(call("/api/chatbots/b1/unpublish"), ctx),
      archive(call("/api/chatbots/b1/archive"), ctx),
      duplicate(call("/api/chatbots/b1/duplicate"), ctx),
      testRun(call("/api/chatbots/b1/test-run", {}), ctx),
    ];
    for (const res of await Promise.all(writes)) expect(res.status).toBe(403);
    expect(db.chatbot.create).not.toHaveBeenCalled();
    expect(db.chatbot.updateMany).not.toHaveBeenCalled();
  });

  it("rejects cross-origin and origin-less writes", async () => {
    expect((await create(call("/api/chatbots", { name: "x" }, "POST", "https://evil.example"))).status).toBe(403);
    expect((await publish(call("/api/chatbots/b1/publish", undefined, "POST", null), ctx)).status).toBe(403);
    expect((await remove(call("/api/chatbots/b1", undefined, "DELETE", "https://evil.example"), ctx)).status).toBe(403);
  });

  it("rejects oversized bodies", async () => {
    const big = { name: "x", flow: { nodes: [], pad: "x".repeat(600 * 1024) } };
    expect((await create(call("/api/chatbots", big))).status).toBe(413);
  });
});

describe("create and update", () => {
  it("creates a draft scoped to the tenant with a starter flow", async () => {
    const res = await create(call("/api/chatbots", { name: " Welcome ", triggerKeywords: ["hi", "hi", "hello"] }));
    expect(res.status).toBe(201);
    const data = db.chatbot.create.mock.calls[0][0].data;
    expect(data).toMatchObject({ tenantId: "t1", name: "Welcome", triggerType: "keyword", triggerKeywords: ["hi", "hello"], createdByUserId: "u1" });
    expect(data.flow.nodes).toHaveLength(1);
  });

  it("validates input", async () => {
    expect((await create(call("/api/chatbots", {}))).status).toBe(400);
    expect((await create(call("/api/chatbots", { name: "x", triggerType: "bogus" }))).status).toBe(400);
    expect((await create(call("/api/chatbots", { name: "x", triggerKeywords: "hi" }))).status).toBe(400);
    expect((await create(call("/api/chatbots", { name: "x", flow: "nope" }))).status).toBe(400);
    expect((await create(call("/api/chatbots", { name: "x", flow: { nodes: Array(101).fill({}) } }))).status).toBe(400);
  });

  it("limits chatbots per workspace", async () => {
    db.chatbot.count.mockResolvedValue(50);
    expect((await create(call("/api/chatbots", { name: "x" }))).status).toBe(409);
  });

  it("refuses a phone number from another tenant", async () => {
    db.phoneNumber.findFirst.mockResolvedValue(null);
    expect((await create(call("/api/chatbots", { name: "x", phoneNumberId: "p9" }))).status).toBe(400);
    expect(db.phoneNumber.findFirst.mock.calls[0][0].where).toEqual({ id: "p9", tenantId: "t1" });
  });

  it("patches the draft only, tenant scoped, and does not touch publishedFlow", async () => {
    const res = await patch(call("/api/chatbots/b1", { name: "Renamed", flow: goodFlow }, "PATCH"), ctx);
    expect(res.status).toBe(200);
    const arg = db.chatbot.updateMany.mock.calls[0][0];
    expect(arg.where).toMatchObject({ id: "b1", tenantId: "t1" });
    expect(arg.data.name).toBe("Renamed");
    expect(arg.data).not.toHaveProperty("publishedFlow");
  });

  it("returns 404 for another tenant's chatbot", async () => {
    db.chatbot.findFirst.mockResolvedValue(null);
    expect((await getOne(new Request(`${ORIGIN}/api/chatbots/b1`), ctx)).status).toBe(404);
    expect(db.chatbot.findFirst.mock.calls[0][0].where).toEqual({ id: "b1", tenantId: "t1" });
    expect((await patch(call("/api/chatbots/b1", { name: "x" }, "PATCH"), ctx)).status).toBe(404);
  });

  it("deletes scoped to tenant", async () => {
    expect((await remove(call("/api/chatbots/b1", undefined, "DELETE"), ctx)).status).toBe(200);
    expect(db.chatbot.deleteMany).toHaveBeenCalledWith({ where: { id: "b1", tenantId: "t1" } });
    db.chatbot.deleteMany.mockResolvedValue({ count: 0 });
    expect((await remove(call("/api/chatbots/b1", undefined, "DELETE"), ctx)).status).toBe(404);
  });
});

describe("lifecycle", () => {
  it("publishes a valid draft: copies flow, bumps version", async () => {
    const res = await publish(call("/api/chatbots/b1/publish"), ctx);
    expect(res.status).toBe(200);
    const arg = db.chatbot.updateMany.mock.calls[0][0];
    expect(arg.where).toEqual({ id: "b1", tenantId: "t1" });
    expect(arg.data).toMatchObject({ status: "published", version: 2 });
    expect(arg.data.publishedFlow.nodes).toHaveLength(1);
  });

  it("refuses to publish an invalid flow with details", async () => {
    db.chatbot.findFirst.mockResolvedValue(bot({ flow: { ...goodFlow, start: "missing" } }));
    const res = await publish(call("/api/chatbots/b1/publish"), ctx);
    expect(res.status).toBe(422);
    const body = await res.json();
    expect(body.errors.length).toBeGreaterThan(0);
    expect(db.chatbot.updateMany).not.toHaveBeenCalled();
  });

  it("requires keywords for keyword triggers and refuses archived bots", async () => {
    db.chatbot.findFirst.mockResolvedValue(bot({ triggerKeywords: [] }));
    expect((await publish(call("/api/chatbots/b1/publish"), ctx)).status).toBe(422);
    db.chatbot.findFirst.mockResolvedValue(bot({ status: "archived" }));
    expect((await publish(call("/api/chatbots/b1/publish"), ctx)).status).toBe(409);
  });

  it("unpublish and archive expire live sessions for that tenant", async () => {
    expect((await unpublish(call("/api/chatbots/b1/unpublish"), ctx)).status).toBe(200);
    expect(db.chatbot.updateMany.mock.calls[0][0].data).toEqual({ status: "draft" });
    expect(db.chatbotSession.updateMany.mock.calls[0][0].where).toMatchObject({ tenantId: "t1", chatbotId: "b1" });
    expect((await archive(call("/api/chatbots/b1/archive"), ctx)).status).toBe(200);
    expect(db.chatbot.updateMany.mock.calls[1][0].data).toEqual({ status: "archived" });
    expect(db.chatbotSession.updateMany).toHaveBeenCalledTimes(2);
  });

  it("duplicates the draft as a new draft", async () => {
    const res = await duplicate(call("/api/chatbots/b1/duplicate"), ctx);
    expect(res.status).toBe(201);
    expect(db.chatbot.create.mock.calls[0][0].data).toMatchObject({ tenantId: "t1", name: "Bot (copy)", flow: goodFlow });
    expect(db.chatbot.create.mock.calls[0][0].data).not.toHaveProperty("status");
  });
});

describe("test run and sessions", () => {
  it("validates the posted flow, or the saved draft with an empty body", async () => {
    const bad = await testRun(call("/api/chatbots/b1/test-run", { flow: { version: 1, start: "x", nodes: [], edges: [] } }), ctx);
    expect((await bad.json()).ok).toBe(false);
    const saved = await testRun(new Request(`${ORIGIN}/api/chatbots/b1/test-run`, { method: "POST", headers: { origin: ORIGIN } }), ctx);
    expect(await saved.json()).toMatchObject({ ok: true, nodeCount: 1 });
  });

  it("lists sessions without variables, paginated and tenant scoped", async () => {
    const rows = [1, 2, 3].map((i) => ({ id: `s${i}`, status: "waiting" }));
    db.chatbotSession.findMany.mockResolvedValue(rows);
    const res = await sessions(new Request(`${ORIGIN}/api/chatbots/b1/sessions?limit=2&status=waiting`), ctx);
    const body = await res.json();
    expect(body.items).toHaveLength(2);
    expect(body.nextCursor).toBe("s2");
    const arg = db.chatbotSession.findMany.mock.calls[0][0];
    expect(arg.where).toEqual({ tenantId: "t1", chatbotId: "b1", status: "waiting" });
    expect(arg.select).not.toHaveProperty("variables");
    expect((await sessions(new Request(`${ORIGIN}/api/chatbots/b1/sessions?status=weird`), ctx)).status).toBe(400);
  });

  it("an agent sees only sessions of chats the inbox lets them see, with phone numbers masked when the inbox masks them", async () => {
    auth.role = "agent";
    visibility.scope = { OR: [{ assignedToId: "u1" }] };
    visibility.mask = true;
    visibility.visible = new Set(["cv1", "cv3"]);
    const rows = [1, 2, 3].map((i) => ({ id: `s${i}`, status: "waiting", conversationId: `cv${i}`, contactId: "k1" }));
    db.chatbotSession.findMany.mockResolvedValue(rows);
    db.contact.findMany.mockResolvedValue([{ id: "k1", name: "Asha", phone: "+919876543210" }]);
    const body = await (await sessions(new Request(`${ORIGIN}/api/chatbots/b1/sessions?limit=5`), ctx)).json();
    expect(body.items.map((i: { id: string }) => i.id)).toEqual(["s1", "s3"]);
    expect(body.items[0].contact).toEqual({ name: "Asha", phone: "+91*****0000" });
    expect(body.nextCursor).toBeNull();
    visibility.scope = null;
    visibility.mask = false;
    visibility.visible = null;
  });

  it("keeps scanning so a restricted agent still gets a full page when most sessions belong to other teams", async () => {
    auth.role = "agent";
    visibility.scope = { OR: [{ assignedToId: "u1" }] };
    visibility.visible = new Set(["mine"]);
    const hidden = (n: number) => Array.from({ length: 3 }, (_, i) => ({ id: `h${n}${i}`, status: "waiting", conversationId: "other", contactId: "k1" }));
    db.chatbotSession.findMany
      .mockResolvedValueOnce(hidden(1))
      .mockResolvedValueOnce([{ id: "m1", status: "waiting", conversationId: "mine", contactId: "k1" }, ...hidden(2).slice(0, 1)]);
    const body = await (await sessions(new Request(`${ORIGIN}/api/chatbots/b1/sessions?limit=2`), ctx)).json();
    expect(body.items.map((i: { id: string }) => i.id)).toEqual(["m1"]);
    expect(db.chatbotSession.findMany).toHaveBeenCalledTimes(2);
    visibility.scope = null;
    visibility.visible = null;
  });
});

describe("what an agent may read of a chatbot", () => {
  const webhookFlow = {
    version: 1,
    start: "w",
    nodes: [{ id: "w", type: "webhook", position: { x: 0, y: 0 }, data: { url: "https://api.example.com/secret-path", method: "POST", bodyTemplate: '{"token":"abc"}', saveAs: "r" } }],
    edges: [],
  };

  it("admins see the whole flow", async () => {
    db.chatbot.findFirst.mockResolvedValue(bot({ flow: webhookFlow, publishedFlow: webhookFlow }));
    const body = await (await getOne(new Request(`${ORIGIN}/api/chatbots/b1`), ctx)).json();
    expect(body.chatbot.flow.nodes[0].data.url).toBe("https://api.example.com/secret-path");
  });

  it("agents get the flow without webhook addresses and bodies", async () => {
    auth.role = "agent";
    db.chatbot.findFirst.mockResolvedValue(bot({ flow: webhookFlow, publishedFlow: webhookFlow }));
    const text = await (await getOne(new Request(`${ORIGIN}/api/chatbots/b1`), ctx)).text();
    expect(text).not.toContain("secret-path");
    expect(text).not.toContain("abc");
    expect(JSON.parse(text).chatbot.publishedFlow.nodes[0].type).toBe("webhook");
  });
});

describe("a published bot's trigger is part of the draft until it is published (P5)", () => {
  const live = (extra: Record<string, unknown> = {}) => bot({ status: "published", publishedFlow: goodFlow, phoneNumberId: null, ...extra });
  const written = () => db.chatbot.updateMany.mock.calls[0][0].data;

  it("Save draft keeps a new trigger, words and number in the draft, and leaves the live columns alone", async () => {
    db.chatbot.findFirst.mockResolvedValue(live());
    db.phoneNumber.findFirst.mockResolvedValue({ id: "pn2" });
    const res = await patch(call("/api/chatbots/b1", { name: "Bot", triggerType: "any_message", triggerKeywords: [], phoneNumberId: "pn2", flow: goodFlow }, "PATCH"), ctx);
    expect(res.status).toBe(200);
    expect(written()).not.toHaveProperty("triggerType");
    expect(written()).not.toHaveProperty("triggerKeywords");
    expect(written()).not.toHaveProperty("phoneNumberId");
    expect(written().flow).toMatchObject({ ...goodFlow, trigger: { triggerType: "any_message", triggerKeywords: [], phoneNumberId: "pn2" } });
  });

  it("a draft that puts the trigger back as it is live carries no pending trigger", async () => {
    db.chatbot.findFirst.mockResolvedValue(live({ flow: { ...goodFlow, trigger: { triggerType: "any_message", triggerKeywords: [], phoneNumberId: null } } }));
    await patch(call("/api/chatbots/b1", { triggerType: "keyword", triggerKeywords: ["hi"] }, "PATCH"), ctx);
    expect(written().flow).toEqual(goodFlow);
  });

  it("refuses to save a published word-triggered bot without words", async () => {
    db.chatbot.findFirst.mockResolvedValue(live());
    const res = await patch(call("/api/chatbots/b1", { triggerKeywords: [] }, "PATCH"), ctx);
    expect(res.status).toBe(400);
    expect(((await res.json()) as { error: string }).error).toMatch(/needs at least one word/);
    expect(db.chatbot.updateMany).not.toHaveBeenCalled();
    // A draft bot may be saved half-done; the words are only needed to publish.
    db.chatbot.findFirst.mockResolvedValue(bot());
    expect((await patch(call("/api/chatbots/b1", { triggerKeywords: [] }, "PATCH"), ctx)).status).toBe(200);
    expect(written()).toMatchObject({ triggerType: "keyword", triggerKeywords: [] });
  });

  it("publishing copies the pending trigger live and clears it from the draft", async () => {
    const pending = { triggerType: "first_message", triggerKeywords: [], phoneNumberId: "pn2" };
    db.chatbot.findFirst.mockResolvedValue(live({ flow: { ...goodFlow, trigger: pending } }));
    // The number chosen in the draft was removed meanwhile: publishing says so instead of failing.
    db.phoneNumber.findFirst.mockResolvedValue(null);
    expect((await publish(call("/api/chatbots/b1/publish"), ctx)).status).toBe(422);
    expect(db.chatbot.updateMany).not.toHaveBeenCalled();
    db.phoneNumber.findFirst.mockResolvedValue({ id: "pn2" });
    expect((await publish(call("/api/chatbots/b1/publish"), ctx)).status).toBe(200);
    expect(db.phoneNumber.findFirst.mock.calls.at(-1)![0].where).toEqual({ id: "pn2", tenantId: "t1" });
    expect(written()).toMatchObject({ status: "published", triggerType: "first_message", triggerKeywords: [], phoneNumberId: "pn2", flow: goodFlow });
    expect(written().publishedFlow).not.toHaveProperty("trigger");
  });

  it("publishing checks the draft trigger's words, not the live ones", async () => {
    db.chatbot.findFirst.mockResolvedValue(live({ flow: { ...goodFlow, trigger: { triggerType: "keyword", triggerKeywords: [], phoneNumberId: null } } }));
    expect((await publish(call("/api/chatbots/b1/publish"), ctx)).status).toBe(422);
  });

  it("refuses to publish a free message after a wait of a day", async () => {
    const longWait = {
      version: 1,
      start: "w",
      nodes: [
        { id: "w", type: "delay", position: { x: 0, y: 0 }, data: { minutes: 1440 } },
        { id: "t", type: "send_text", position: { x: 0, y: 0 }, data: { text: "Still there?" } },
      ],
      edges: [{ id: "e1", from: "w", to: "t" }],
    };
    db.chatbot.findFirst.mockResolvedValue(bot({ flow: longWait }));
    const res = await publish(call("/api/chatbots/b1/publish"), ctx);
    expect(res.status).toBe(422);
    expect(((await res.json()) as { errors: { nodeId?: string; message: string }[] }).errors[0]).toMatchObject({ nodeId: "w", message: expect.stringMatching(/Send template/) });
  });

  it("a copy starts from the source's draft trigger", async () => {
    db.chatbot.findFirst.mockResolvedValue(live({ flow: { ...goodFlow, trigger: { triggerType: "manual", triggerKeywords: [], phoneNumberId: null } } }));
    await duplicate(call("/api/chatbots/b1/duplicate"), ctx);
    expect(db.chatbot.create.mock.calls[0][0].data).toMatchObject({ triggerType: "manual", triggerKeywords: [], flow: goodFlow });
  });
});
