import { beforeEach, describe, expect, it, vi } from "vitest";

const db = vi.hoisted(() => {
  const model = () => ({ findFirst: vi.fn(), findMany: vi.fn(), findUnique: vi.fn(), create: vi.fn(), updateMany: vi.fn(), deleteMany: vi.fn(), count: vi.fn(), groupBy: vi.fn(), upsert: vi.fn() });
  return {
    automationRule: model(),
    automationRun: model(),
    ruleExecution: model(),
    replyMaterial: model(),
    phoneNumber: model(),
    template: model(),
    chatbot: model(),
    replyMaterialDummy: model(),
    membership: model(),
    team: model(),
    leadSequence: model(),
    segment: model(),
    contact: model(),
    plan: model(),
    platformSetting: model(),
    $transaction: vi.fn(async (ops: unknown[]) => Promise.all(ops)),
  };
});
const auth = vi.hoisted(() => ({ role: "admin" as "agent" | "admin" | "owner" }));
const billing = vi.hoisted(() => vi.fn());
vi.mock("@/lib/db", () => ({ prisma: db }));
vi.mock("@/lib/auth", () => ({ getActor: async () => ({ userId: "u1", tenantId: "t1", role: auth.role }) }));
vi.mock("@/lib/billing/status", () => ({ getBillingStatus: billing }));

import { GET as listRoute, POST as createRoute } from "@/app/api/automation/route";
import { GET as getRoute, PATCH as patchRoute, DELETE as deleteRoute } from "@/app/api/automation/[id]/route";
import { POST as convertRoute } from "@/app/api/automation/[id]/convert/route";
import { POST as moveRoute } from "@/app/api/automation/[id]/move/route";
import { GET as settingsGet, PATCH as settingsPatch } from "@/app/api/automation/settings/route";
import { GET as executionsRoute } from "@/app/api/automation/executions/route";
import { GET as optionsRoute } from "@/app/api/automation/options/route";
import { GET as materialsGet, POST as materialsPost } from "@/app/api/automation/materials/route";
import { GET as materialGet, PATCH as materialPatch, DELETE as materialDelete } from "@/app/api/automation/materials/[id]/route";
import { POST as testRoute } from "@/app/api/automation/test/route";
import { resetMeteringCache } from "@/lib/automation/v2/metering";

const ORIGIN = "https://wa.edwyz.com";
const call = (path: string, body?: unknown, method = "POST", origin: string | null = ORIGIN) =>
  new Request(`${ORIGIN}${path}`, { method, headers: { "content-type": "application/json", ...(origin ? { origin } : {}) }, body: body === undefined ? undefined : JSON.stringify(body) });
const ctx = (id = "r1") => ({ params: Promise.resolve({ id }) });

const v2Body = {
  version: 2,
  name: "Price question",
  trigger: { type: "message_received" },
  filters: { root: { type: "group", op: "and", items: [{ type: "keyword", mode: "contains", keywords: ["price"] }] } },
  actions: [{ type: "send_text", text: "See our prices." }],
};
const v2Row = { id: "r1", tenantId: "t1", version: 2, name: "Price question", enabled: true, priority: 10, type: "keyword", trigger: v2Body.trigger, filters: { ...v2Body.filters, options: { allowWhenHumanActive: false } }, actions: v2Body.actions };

beforeEach(() => {
  vi.clearAllMocks();
  resetMeteringCache();
  auth.role = "admin";
  billing.mockResolvedValue({ state: "exempt", planId: null });
  db.automationRule.count.mockResolvedValue(0);
  db.automationRule.findFirst.mockResolvedValue(null);
  db.automationRule.findMany.mockResolvedValue([]);
  db.automationRule.create.mockImplementation(async ({ data }) => ({ id: "r1", ...data }));
  db.automationRule.updateMany.mockResolvedValue({ count: 1 });
  for (const m of [db.template, db.chatbot, db.replyMaterial, db.membership, db.team, db.leadSequence, db.segment]) m.count.mockResolvedValue(0);
  db.ruleExecution.findMany.mockResolvedValue([]);
  db.ruleExecution.groupBy.mockResolvedValue([]);
  db.automationRun.findMany.mockResolvedValue([]);
  db.automationRun.groupBy.mockResolvedValue([]);
  db.ruleExecution.count.mockResolvedValue(0);
});

describe("creating v2 rules", () => {
  it("creates a rule scoped to the tenant at the end of the running order", async () => {
    db.automationRule.findFirst.mockResolvedValueOnce({ priority: 30 });
    const res = await createRoute(call("/api/automation", v2Body));
    expect(res.status).toBe(201);
    const data = db.automationRule.create.mock.calls[0][0].data;
    expect(data).toMatchObject({ tenantId: "t1", version: 2, priority: 40, name: "Price question", enabled: true, stopAfterMatch: false, cooldownMinutes: 5 });
    expect(data.trigger).toEqual({ type: "message_received" });
    expect(data.filters.options).toEqual({ allowWhenHumanActive: false });
    expect(data.actions).toEqual([{ type: "send_text", text: "See our prices." }]);
  });

  it("agents can read but never change rules", async () => {
    auth.role = "agent";
    expect((await listRoute(new Request(`${ORIGIN}/api/automation`))).status).toBe(200);
    expect((await createRoute(call("/api/automation", v2Body))).status).toBe(403);
    expect((await patchRoute(call("/api/automation/r1", { enabled: false }, "PATCH"), ctx())).status).toBe(403);
    expect((await convertRoute(call("/api/automation/r1/convert"), ctx())).status).toBe(403);
    expect((await moveRoute(call("/api/automation/r1/move", { direction: "up" }), ctx())).status).toBe(403);
    expect((await settingsPatch(call("/api/automation/settings", { mode: "all_matching" }, "PATCH"))).status).toBe(403);
    expect((await materialsPost(call("/api/automation/materials", { name: "x", kind: "text", body: "y" }))).status).toBe(403);
    expect(db.automationRule.create).not.toHaveBeenCalled();
  });

  it("blocks cross-origin writes on every state-changing route", async () => {
    const evil = "https://evil.example";
    expect((await createRoute(call("/api/automation", v2Body, "POST", evil))).status).toBe(403);
    expect((await patchRoute(call("/api/automation/r1", {}, "PATCH", evil), ctx())).status).toBe(403);
    expect((await deleteRoute(call("/api/automation/r1", undefined, "DELETE", null), ctx())).status).toBe(403);
    expect((await convertRoute(call("/api/automation/r1/convert", undefined, "POST", evil), ctx())).status).toBe(403);
    expect((await moveRoute(call("/api/automation/r1/move", { direction: "up" }, "POST", evil), ctx())).status).toBe(403);
    expect((await settingsPatch(call("/api/automation/settings", {}, "PATCH", evil))).status).toBe(403);
    expect((await materialsPost(call("/api/automation/materials", {}, "POST", evil))).status).toBe(403);
    expect((await materialPatch(call("/api/automation/materials/m1", {}, "PATCH", evil), ctx("m1"))).status).toBe(403);
    expect((await materialDelete(call("/api/automation/materials/m1", undefined, "DELETE", evil), ctx("m1"))).status).toBe(403);
    expect((await testRoute(call("/api/automation/test", { text: "x" }, "POST", evil))).status).toBe(403);
  });

  it("explains what is wrong in plain words", async () => {
    const bad = async (patch: Record<string, unknown>) => {
      const res = await createRoute(call("/api/automation", { ...v2Body, ...patch }));
      return { status: res.status, error: ((await res.json()) as { error?: string }).error ?? "" };
    };
    expect(await bad({ name: "  " })).toMatchObject({ status: 400, error: expect.stringMatching(/name/) });
    expect(await bad({ trigger: { type: "wat" } })).toMatchObject({ status: 400, error: expect.stringMatching(/starts/) });
    expect(await bad({ actions: [] })).toMatchObject({ status: 400, error: expect.stringMatching(/at least one/) });
    expect(await bad({ actions: [{ type: "send_text", text: "" }] })).toMatchObject({ status: 400 });
    expect(await bad({ cooldownMinutes: -1 })).toMatchObject({ status: 400 });
    expect(await bad({ trigger: { type: "tag_added", tag: "x" } })).toMatchObject({ status: 400, error: expect.stringMatching(/new message/) });
    expect(await bad({ filters: null, trigger: { type: "scheduled", repeat: "once", date: "2020-01-01", time: "09:00", timezone: "UTC" } })).toMatchObject({ status: 400, error: expect.stringMatching(/today or later/) });
    expect(db.automationRule.create).not.toHaveBeenCalled();
  });

  it("refuses to point at things from another workspace", async () => {
    db.template.count.mockResolvedValue(0);
    const res = await createRoute(call("/api/automation", { ...v2Body, actions: [{ type: "send_template", templateId: "foreign", variables: [] }] }));
    expect(res.status).toBe(400);
    expect(((await res.json()) as { error: string }).error).toMatch(/template/);
    expect(db.template.count).toHaveBeenCalledWith({ where: { tenantId: "t1", id: { in: ["foreign"] } } });
    db.chatbot.count.mockResolvedValue(1);
    expect((await createRoute(call("/api/automation", { ...v2Body, actions: [{ type: "start_chatbot", chatbotId: "bot1" }] }))).status).toBe(201);
  });

  it("limits a workspace to 50 rules and checks the phone number belongs to it", async () => {
    db.automationRule.count.mockResolvedValue(50);
    expect((await createRoute(call("/api/automation", v2Body))).status).toBe(409);
    db.automationRule.count.mockResolvedValue(0);
    db.phoneNumber.findFirst.mockResolvedValue(null);
    expect((await createRoute(call("/api/automation", { ...v2Body, phoneNumberId: "foreign" }))).status).toBe(404);
  });

  it("old three-type rules still create as version 1", async () => {
    const res = await createRoute(call("/api/automation", { type: "keyword", name: "Prices", keywords: ["price"], replyText: "See prices." }));
    expect(res.status).toBe(201);
    expect(db.automationRule.create.mock.calls[0][0].data).not.toHaveProperty("version");
  });
});

describe("updating, moving and converting", () => {
  it("updates only v2 rows of the tenant and merges the current definition", async () => {
    db.automationRule.findFirst.mockResolvedValue(v2Row);
    const res = await patchRoute(call("/api/automation/r1", { actions: [{ type: "add_tag", tag: "asked", scope: "contact" }] }, "PATCH"), ctx());
    expect(res.status).toBe(200);
    expect(db.automationRule.updateMany).toHaveBeenCalledWith({ where: { id: "r1", tenantId: "t1", version: 2 }, data: expect.objectContaining({ actions: [{ type: "add_tag", tag: "asked", scope: "contact" }] }) });
    expect(db.automationRule.findFirst.mock.calls[0][0].where).toEqual({ id: "r1", tenantId: "t1", version: 2 });
  });

  it("rejects an update that breaks the combination of trigger and conditions", async () => {
    db.automationRule.findFirst.mockResolvedValue(v2Row);
    const res = await patchRoute(call("/api/automation/r1", { trigger: { type: "contact_created" } }, "PATCH"), ctx());
    expect(res.status).toBe(400);
    expect(db.automationRule.updateMany).not.toHaveBeenCalled();
  });

  it("switching a rule on or off uses the shared path for both versions", async () => {
    const res = await patchRoute(call("/api/automation/r1", { enabled: false }, "PATCH"), ctx());
    expect(res.status).toBe(200);
    expect(db.automationRule.updateMany).toHaveBeenCalledWith({ where: { id: "r1", tenantId: "t1" }, data: { enabled: false } });
  });

  it("moves a rule one place and renumbers priorities", async () => {
    db.automationRule.findMany.mockResolvedValue([
      { id: "a", priority: 10, createdAt: new Date(1) },
      { id: "b", priority: 20, createdAt: new Date(2) },
      { id: "c", priority: 30, createdAt: new Date(3) },
    ]);
    expect((await moveRoute(call("/api/automation/c/move", { direction: "up" }), ctx("c"))).status).toBe(200);
    expect(db.automationRule.updateMany.mock.calls.map(([a]) => [a.where.id, a.data.priority])).toEqual([["c", 20], ["b", 30]]);
    expect(db.automationRule.updateMany.mock.calls.every(([a]) => a.where.tenantId === "t1")).toBe(true);
    db.automationRule.updateMany.mockClear();
    await moveRoute(call("/api/automation/a/move", { direction: "up" }), ctx("a"));
    expect(db.automationRule.updateMany).not.toHaveBeenCalled();
    expect((await moveRoute(call("/api/automation/a/move", { direction: "sideways" }), ctx("a"))).status).toBe(400);
    expect((await moveRoute(call("/api/automation/zzz/move", { direction: "up" }), ctx("zzz"))).status).toBe(404);
  });

  it("converts a classic rule in place, keeping what customers receive", async () => {
    db.automationRule.findFirst
      .mockResolvedValueOnce({ id: "k", tenantId: "t1", version: 1, type: "keyword", keywords: ["price"], matchMode: "contains", replyText: "Prices!", schedule: null, cooldownMinutes: 5 })
      .mockResolvedValueOnce({ priority: 40 })
      .mockResolvedValueOnce({ id: "k", version: 2 });
    const res = await convertRoute(call("/api/automation/k/convert"), ctx("k"));
    expect(res.status).toBe(200);
    expect(db.automationRule.updateMany).toHaveBeenCalledWith({
      where: { id: "k", tenantId: "t1", version: 1 },
      data: expect.objectContaining({ version: 2, priority: 50, trigger: { type: "message_received" }, actions: [{ type: "send_text", text: "Prices!" }] }),
    });
    const converted = db.automationRule.updateMany.mock.calls[0][0].data.filters as { options: { allowWhenHumanActive: boolean } };
    expect(converted.options.allowWhenHumanActive).toBe(true);
    db.automationRule.findFirst.mockResolvedValueOnce({ id: "k", tenantId: "t1", version: 2 });
    expect((await convertRoute(call("/api/automation/k/convert"), ctx("k"))).status).toBe(409);
    db.automationRule.updateMany.mockClear();
    db.automationRule.findFirst.mockResolvedValueOnce({ id: "aw", tenantId: "t1", version: 1, type: "away", keywords: [], matchMode: "contains", replyText: "Closed", schedule: null, cooldownMinutes: 720 });
    const noHours = await convertRoute(call("/api/automation/aw/convert"), ctx("aw"));
    expect(noHours.status).toBe(409);
    expect(((await noHours.json()) as { error: string }).error).toMatch(/opening hours/);
    expect(db.automationRule.updateMany).not.toHaveBeenCalled();
    db.automationRule.findFirst.mockResolvedValueOnce(null);
    expect((await convertRoute(call("/api/automation/nope/convert"), ctx("nope"))).status).toBe(404);
  });

  it("returns one rule and lists all rules with their last run and 30-day count", async () => {
    db.automationRule.findFirst.mockResolvedValue(v2Row);
    expect(((await (await getRoute(new Request(`${ORIGIN}/api/automation/r1`), ctx())).json()) as { rule: { id: string } }).rule.id).toBe("r1");
    db.automationRule.findFirst.mockResolvedValue(null);
    expect((await getRoute(new Request(`${ORIGIN}/api/automation/zz`), ctx("zz"))).status).toBe(404);

    const at = new Date("2026-10-27T09:00:00Z");
    db.automationRule.findMany.mockResolvedValue([
      { id: "classic", version: 1, type: "welcome", priority: 0, createdAt: new Date(1) },
      { id: "r2", version: 2, priority: 20, createdAt: new Date(2) },
      { id: "r1", version: 2, priority: 10, createdAt: new Date(3) },
    ]);
    db.ruleExecution.findMany.mockResolvedValue([{ ruleId: "r1", createdAt: at, outcome: "ok", detail: "Send text: ok" }]);
    db.ruleExecution.groupBy.mockResolvedValue([{ ruleId: "r1", _count: { _all: 4 } }]);
    db.automationRun.findMany.mockResolvedValue([{ ruleId: "classic", createdAt: at }]);
    db.automationRun.groupBy.mockResolvedValue([{ ruleId: "classic", _count: { _all: 2 } }]);
    const body = (await (await listRoute(new Request(`${ORIGIN}/api/automation`))).json()) as { rules: { id: string; runs30d: number; lastRun: { outcome: string } | null }[] };
    expect(body.rules.map((r) => r.id)).toEqual(["r1", "r2", "classic"]);
    expect(body.rules.map((r) => r.runs30d)).toEqual([4, 0, 2]);
    expect(body.rules[0].lastRun).toMatchObject({ outcome: "ok" });
    expect(body.rules[1].lastRun).toBeNull();
    expect(db.ruleExecution.findMany.mock.calls[0][0].where.tenantId).toBe("t1");
  });
});

describe("settings, history and options", () => {
  it("reads settings and usage; saves with validation", async () => {
    billing.mockResolvedValue({ state: "active", planId: "p1" });
    db.plan.findUnique.mockResolvedValue({ features: { automationTriggersMonthly: 100 } });
    db.ruleExecution.count.mockResolvedValue(82);
    const body = (await (await settingsGet(new Request(`${ORIGIN}/api/automation/settings`))).json()) as { settings: { mode: string }; usage: { used: number; limit: number; percent: number } };
    expect(body.settings.mode).toBe("first_match");
    expect(body.usage).toMatchObject({ used: 82, limit: 100, percent: 82 });
    expect(db.ruleExecution.count.mock.calls[0][0].where).toMatchObject({ tenantId: "t1", outcome: "ok" });
    expect((await settingsPatch(call("/api/automation/settings", { mode: "nope" }, "PATCH"))).status).toBe(400);
    expect((await settingsPatch(call("/api/automation/settings", { mode: "all_matching" }, "PATCH"))).status).toBe(200);
  });

  it("lists the history of this tenant with names, never returning other tenants' rows", async () => {
    db.ruleExecution.findMany.mockResolvedValue([
      { id: "e1", ruleId: "r1", conversationId: "cv1", contactId: "c1", outcome: "skipped", detail: "x", createdAt: new Date("2026-10-27T10:00:00Z") },
      { id: "e2", ruleId: "holiday", conversationId: "cv1", contactId: "gone", outcome: "ok", detail: "Holiday mode reply sent", createdAt: new Date("2026-10-27T09:00:00Z") },
    ]);
    db.automationRule.findMany.mockResolvedValue([{ id: "r1", name: "Price" }]);
    db.contact.findMany.mockResolvedValue([{ id: "c1", name: null, phone: "+919876543210" }]);
    const res = await executionsRoute(new Request(`${ORIGIN}/api/automation/executions?ruleId=r1&outcome=skipped&limit=2`));
    const body = (await res.json()) as { items: { ruleName: string; contactName: string | null }[]; nextCursor: string | null };
    expect(body.items.map((i) => [i.ruleName, i.contactName])).toEqual([["Price", "Contact ending 3210"], ["Holiday mode", "Deleted contact"]]);
    expect(db.ruleExecution.findMany.mock.calls[0][0].where).toEqual({ tenantId: "t1", ruleId: "r1", outcome: "skipped" });
    expect(db.automationRule.findMany.mock.calls[0][0].where).toMatchObject({ tenantId: "t1" });
    expect(db.contact.findMany.mock.calls[0][0].where).toMatchObject({ tenantId: "t1" });
  });

  it("gathers the builder choices from this workspace only", async () => {
    db.template.findMany.mockResolvedValue([{ id: "tp1", name: "promo", language: "en", category: "UTILITY", components: [{ type: "BODY", text: "Hi {{1}} {{2}}" }] }]);
    db.chatbot.findMany.mockResolvedValue([{ id: "b1", name: "Bot" }]);
    db.leadSequence.findMany.mockResolvedValue([]);
    db.team.findMany.mockResolvedValue([]);
    db.membership.findMany.mockResolvedValue([{ userId: "u1", user: { name: "", email: "boss@example.com" } }]);
    db.segment.findMany.mockResolvedValue([]);
    db.replyMaterial.findMany.mockResolvedValue([{ id: "m1", name: "Price list", kind: "document" }]);
    db.phoneNumber.findMany.mockResolvedValue([]);
    const body = (await (await optionsRoute(new Request(`${ORIGIN}/api/automation/options`))).json()) as { templates: { variables: number }[]; members: { name: string }[] };
    expect(body.templates[0].variables).toBe(2);
    expect(body.members[0].name).toBe("boss@example.com");
    expect(db.template.findMany.mock.calls[0][0].where).toEqual({ tenantId: "t1", status: "approved" });
    expect(db.chatbot.findMany.mock.calls[0][0].where).toEqual({ tenantId: "t1", status: "published" });
  });
});

describe("reply materials", () => {
  const text = { name: "Greeting", kind: "text", body: "Hello {{name}}" };

  it("creates, lists and scopes by tenant", async () => {
    db.replyMaterial.count.mockResolvedValue(0);
    db.replyMaterial.create.mockImplementation(async ({ data }) => ({ id: "m1", ...data }));
    const res = await materialsPost(call("/api/automation/materials", text));
    expect(res.status).toBe(201);
    expect(db.replyMaterial.create.mock.calls[0][0].data).toMatchObject({ tenantId: "t1", name: "Greeting", kind: "text", body: "Hello {{name}}", mediaKey: null });
    db.replyMaterial.findMany.mockResolvedValue([]);
    auth.role = "agent";
    expect((await materialsGet(new Request(`${ORIGIN}/api/automation/materials`))).status).toBe(200);
    expect(db.replyMaterial.findMany.mock.calls[0][0].where).toEqual({ tenantId: "t1" });
  });

  it("checks what each kind needs", async () => {
    const bad = async (body: unknown) => (await materialsPost(call("/api/automation/materials", body))).status;
    expect(await bad({ name: "x", kind: "text" })).toBe(400);
    expect(await bad({ name: "x", kind: "media" })).toBe(400);
    expect(await bad({ name: "x", kind: "document", mediaKey: "http://insecure.example/a.pdf" })).toBe(400);
    expect(await bad({ name: "x", kind: "document", mediaKey: "https://user:pw@example.com/a.pdf" })).toBe(400);
    expect(await bad({ name: "x", kind: "video" })).toBe(400);
    expect(await bad({ name: "", kind: "text", body: "y" })).toBe(400);
    expect(await bad({ name: "x", kind: "text", body: "y".repeat(1025) })).toBe(400);
    db.replyMaterial.count.mockResolvedValue(0);
    db.replyMaterial.create.mockImplementation(async ({ data }) => ({ id: "m", ...data }));
    expect(await bad({ name: "Brochure", kind: "document", mediaKey: "https://files.example.com/b.pdf", mediaMime: "application/pdf" })).toBe(201);
    expect(await bad({ name: "Library photo", kind: "media", mediaKey: "a".repeat(32) + ".jpg", mediaMime: "image/jpeg" })).toBe(201);
  });

  it("turns a duplicate name into a friendly conflict and caps the library", async () => {
    db.replyMaterial.count.mockResolvedValue(0);
    db.replyMaterial.create.mockRejectedValue(Object.assign(new Error("unique"), { code: "P2002" }));
    expect((await materialsPost(call("/api/automation/materials", text))).status).toBe(409);
    db.replyMaterial.count.mockResolvedValue(200);
    expect((await materialsPost(call("/api/automation/materials", text))).status).toBe(409);
  });

  it("shows which rules use a material, updates and deletes inside the tenant", async () => {
    db.replyMaterial.findFirst.mockResolvedValue({ id: "m1", tenantId: "t1", name: "Greeting", kind: "text", body: "Hi", mediaKey: null, mediaMime: null });
    db.automationRule.findMany.mockResolvedValue([{ name: "Welcome", actions: [{ type: "send_material", materialId: "m1" }] }, { name: "Other", actions: [{ type: "send_text", text: "x" }] }]);
    const got = (await (await materialGet(new Request(`${ORIGIN}/api/automation/materials/m1`), ctx("m1"))).json()) as { usedBy: string[] };
    expect(got.usedBy).toEqual(["Welcome"]);
    expect(db.automationRule.findMany.mock.calls[0][0].where).toEqual({ tenantId: "t1", version: 2 });
    db.replyMaterial.updateMany.mockResolvedValue({ count: 1 });
    expect((await materialPatch(call("/api/automation/materials/m1", { body: "Hello again" }, "PATCH"), ctx("m1"))).status).toBe(200);
    expect(db.replyMaterial.updateMany).toHaveBeenCalledWith({ where: { id: "m1", tenantId: "t1" }, data: expect.objectContaining({ body: "Hello again" }) });
    expect((await materialPatch(call("/api/automation/materials/m1", { kind: "media" }, "PATCH"), ctx("m1"))).status).toBe(400);
    db.replyMaterial.deleteMany.mockResolvedValue({ count: 0 });
    expect((await materialDelete(call("/api/automation/materials/zz", undefined, "DELETE"), ctx("zz"))).status).toBe(404);
    expect(db.replyMaterial.deleteMany).toHaveBeenCalledWith({ where: { id: "zz", tenantId: "t1" } });
  });
});

describe("dry run", () => {
  it("returns the classic rule and the v2 rules that would run for a sample", async () => {
    db.automationRule.findMany.mockResolvedValue([
      { id: "c1", version: 1, enabled: true, type: "keyword", name: "Classic", keywords: ["price"], matchMode: "contains", replyText: "Classic reply", schedule: null, cooldownMinutes: 5, phoneNumberId: null, createdAt: new Date(1) },
      { ...v2Row, enabled: true, cooldownMinutes: 5, phoneNumberId: null, createdAt: new Date(2) },
      { ...v2Row, id: "off", enabled: false, createdAt: new Date(3) },
    ]);
    const res = await testRoute(call("/api/automation/test", { text: "what is the price", firstMessage: true }));
    const body = (await res.json()) as { rule: { id: string } | null; matches: { id: string; does: string[] }[] };
    expect(body.rule?.id).toBe("c1");
    expect(body.matches).toEqual([{ id: "r1", name: "Price question", does: ["send a text reply"] }]);
    expect((await testRoute(call("/api/automation/test", { text: "x".repeat(1001) }))).status).toBe(400);
  });
});
